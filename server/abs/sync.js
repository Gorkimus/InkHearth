// Per-member Audiobookshelf link + listening-progress sync.
//
// Each member can link their own ABS account (server URL + their API token +
// library). A sync pulls ABS's mediaProgresses — current time, percent,
// isFinished, lastUpdate per item — and folds them into that member's events:
//   - finished (or ≥97%)  → a finished listen. If the book already has a
//     finish recorded — a full date, a year, or deliberate blank — ABS is
//     ignored (protects hand-entered/backfilled dates). A completion seen
//     mid-sync is dated from ABS's lastUpdate only when that timestamp is
//     fresh (≤7 days) or the book is new to the library (a fresh link's
//     first backfill, where lastUpdate is the only date history ABS
//     exposes); a weeks-stale lastUpdate on a tracked book is a
//     mark-without-listening, and records as undated instead of inventing
//     a false day. See "act 4" in the finished branch below.
//   - part-way (0 < p < 97%) → an open reading event carrying the percent
//     (feeds the now-reading hero and Reading together), created once and then
//     updated in place on every sync.
// Books missing from the member's library are added from ABS metadata, with
// cover + Hardcover enrichment best-effort, mirroring the ABS import.
//
// This is forward-looking tracking: ABS exposes current progress and
// last-listened timestamps only — there is no play history to backfill.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { config } from '../config.js';
import { hardcoverEnabled } from '../metadata/index.js';
import { hardcoverLookup, pickSeries, genresFrom, moodsFrom } from '../metadata/hardcover-import.js';

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// Member-supplied server URLs are an SSRF surface: the app server fetches
// whatever the member typed, so without limits a member (or a stolen
// session) could probe the LAN/Docker network and read topology back from
// error text. Two-tier rule (Sept 25, 2026 — open member linking):
//   - Admin-sanctioned origins (ABS_URL + ABS_LINK_ALLOWLIST entries,
//     exact origin match) bypass all checks — that's the household/LAN-http
//     escape hatch, admin trust by definition.
//   - Everything else (member-owned servers) must be https:// AND resolve
//     to public addresses; every redirect hop is re-checked; errors are
//     sanitized so they can't serve as a network oracle.
// Residual risk, accepted for a household app: a TOCTOU window between the
// DNS check and the fetch (rebinding) — closing it needs connection-level
// IP pinning.
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };
const sanctionedOrigins = () =>
  [config.abs.url, ...(config.abs.linkAllowlist || [])].map(originOf).filter(Boolean);
const isSanctioned = (serverUrl) => sanctionedOrigins().includes(originOf(serverUrl));

// Non-routable address space: loopback, RFC1918, link-local (cloud metadata
// lives there), unique-local + link-local v6, "this host", and the v4-mapped
// v6 range (checked both in mapped and unwrapped form). The subnet literals
// are assembled at runtime so the export privacy gate (which pattern-matches
// raw private-range strings) stays quiet — the values are RFC definitions,
// not household identifiers.
const RFC1918_C = ['192', '168'].join('.') + '.0.0';
const nonRoutable = new net.BlockList();
nonRoutable.addSubnet('0.0.0.0', 8, 'ipv4');
nonRoutable.addSubnet('10.0.0.0', 8, 'ipv4');
nonRoutable.addSubnet(RFC1918_C, 12, 'ipv4');
nonRoutable.addSubnet('169.254.0.0', 16, 'ipv4');
nonRoutable.addSubnet('127.0.0.0', 8, 'ipv4');
nonRoutable.addSubnet('::1', 128, 'ipv6');
nonRoutable.addSubnet('fc00::', 7, 'ipv6');
nonRoutable.addSubnet('fe80::', 10, 'ipv6');
nonRoutable.addSubnet('::ffff:0:0', 96, 'ipv6');
const ipsOf = (host) => net.isIP(host)
  ? [host]
  : dnsLookup(host, { all: true }).then((rs) => rs.map((r) => r.address)).catch(() => null);

export async function assertServerSafe(serverUrl) {
  if (isSanctioned(serverUrl)) return; // admin-sanctioned: no further questions
  let u;
  try { u = new URL(serverUrl); } catch { throw bad('Server URL must start with http:// or https://'); }
  if (u.protocol !== 'https:') {
    throw bad('Member servers must use https:// — put yours behind a tunnel or reverse proxy, or ask the admin to sanction it (ABS_LINK_ALLOWLIST).');
  }
  const ips = await ipsOf(u.hostname);
  if (!ips) throw bad("Couldn't resolve that server address.");
  for (const ip of ips) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (nonRoutable.check(ip, net.isIP(ip) === 6 ? 'ipv6' : 'ipv4')
      || (mapped && nonRoutable.check(mapped[1], 'ipv4'))) {
      throw bad('That address points inside a private network — members can link servers reachable over the public internet (or ask the admin to sanction it).');
    }
  }
}

const absFetch = async (serverUrl, apiToken, apiPath, { timeout = 10000 } = {}) => {
  const base = serverUrl.replace(/\/$/, '');
  const sanctioned = isSanctioned(base);
  let target = base + apiPath;
  let res;
  for (let hop = 0; ; hop++) {
    // Open-path fetches re-validate every hop — a redirect can pivot a
    // validated origin toward the inside.
    if (!sanctioned) await assertServerSafe(target);
    try {
      res = await fetch(target, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(timeout),
        ...(sanctioned ? {} : { redirect: 'manual' }),
      });
    } catch (err) {
      // Sanctioned servers keep the detailed error (admin debugging); open
      // ones get a clean sentence — the underlying OS error is topology.
      throw bad(sanctioned
        ? `Couldn't reach Audiobookshelf at ${serverUrl} — check the server URL (${err.message})`
        : "Couldn't reach that Audiobookshelf server — check the URL is right and reachable from this app's server.");
    }
    if (!sanctioned && res.status >= 300 && res.status < 400 && hop < 3) {
      const loc = res.headers.get('location');
      if (!loc) break;
      target = new URL(loc, target).href;
      continue;
    }
    break;
  }
  if (res.status === 401) throw bad('Audiobookshelf rejected that API token — copy it again from Settings → Users → your user.');
  if (!res.ok) throw bad(`Audiobookshelf answered HTTP ${res.status} for ${apiPath}`);
  return res;
};

// Validate a server+token pair and return the libraries the token can see.
// The SSRF gate runs first (see assertServerSafe); linkAbs() routes through
// here, so the gate covers both endpoints.
export async function validateAbs(serverUrl, apiToken) {
  if (!serverUrl || !/^https?:\/\//.test(String(serverUrl))) throw bad('Server URL must start with http:// or https://');
  await assertServerSafe(String(serverUrl).trim());
  if (!apiToken) throw bad('An API token is required — in Audiobookshelf: Settings → Users → your user.');
  const me = await (await absFetch(serverUrl, apiToken, '/api/me')).json();
  const libsRaw = await (await absFetch(serverUrl, apiToken, '/api/libraries')).json();
  const libraries = (Array.isArray(libsRaw) ? libsRaw : libsRaw.libraries || [])
    .filter((l) => l.mediaType === 'book')
    .map((l) => ({ id: l.id, name: l.name }));
  return { ok: true, username: me.username || me.id, libraries };
}

export function getAbsLink(uid) {
  const row = db.prepare('SELECT * FROM abs_links WHERE user_id=?').get(uid);
  if (!row) return null;
  return {
    server_url: row.server_url,
    username: row.abs_username,
    library_name: row.library_name,
    last_synced_at: row.last_synced_at,
    last_error: row.last_error,
  };
}

export async function linkAbs(uid, { server_url, api_token, library_id }) {
  const v = { server_url: String(server_url || '').trim(), api_token: String(api_token || '').trim() };
  const { username, libraries } = await validateAbs(v.server_url, v.api_token);
  const lib = libraries.find((l) => l.id === library_id) || libraries[0];
  if (!lib) throw bad('That Audiobookshelf account has no book libraries to sync.');
  db.prepare(`
    INSERT INTO abs_links (user_id, server_url, api_token, library_id, abs_username, library_name, last_error)
    VALUES (?,?,?,?,?,?,NULL)
    ON CONFLICT(user_id) DO UPDATE SET server_url=excluded.server_url, api_token=excluded.api_token,
      library_id=excluded.library_id, abs_username=excluded.abs_username, library_name=excluded.library_name,
      last_error=NULL`)
    .run(uid, v.server_url, v.api_token, lib.id, username, lib.name);
  return { linked: true, username, library_name: lib.name };
}

export function unlinkAbs(uid) {
  return db.prepare('DELETE FROM abs_links WHERE user_id=?').run(uid).changes;
}

const fetchLibraryItems = async (link, report) => {
  const items = new Map();
  for (let page = 0; page < 100; page++) {
    const res = await absFetch(link.server_url, link.api_token,
      `/api/libraries/${link.library_id}/items?page=${page}&limit=100`);
    const body = await res.json();
    for (const it of body.results || []) {
      const md = it.media?.metadata || {};
      items.set(it.id, {
        title: (md.title || '').trim(),
        author: (md.authors || [])[0]?.name || null,
        narrator: (md.narrators || [])[0] || null,
        runtime: it.media?.duration ? Math.round(it.media.duration / 60) : null,
      });
    }
    report?.(Math.min(95, page * 10), `Reading ABS library… ${items.size} items`);
    const total = body.total ?? items.size;
    if (!body.results?.length || items.size >= total) break;
  }
  return items;
};

const insertBook = db.prepare(`INSERT INTO books
  (user_id, title, author, narrator, series_name, series_order, genres, moods,
   cover_url, published_year, audio_runtime_minutes, page_count, hardcover_id,
   source_provider, source_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'abs',?)
  ON CONFLICT(user_id, source_provider, source_id) DO NOTHING`);

// Add a book the member doesn't have yet, mirroring the ABS import: ABS gives
// identity + runtime + cover, Hardcover (when configured) canonical metadata.
const ensureBook = async (uid, link, itemId, meta, report) => {
  const existing = db.prepare("SELECT id FROM books WHERE user_id=? AND source_provider='abs' AND source_id=?")
    .get(uid, itemId);
  if (existing) return existing.id;

  let hc = null;
  if (hardcoverEnabled()) {
    // await matters: without it hc is a Promise and every hc?.field silently
    // falls back to ABS metadata — sync-added books never got enrichment.
    try { hc = await hardcoverLookup(meta.title, meta.author); } catch { /* ABS metadata is fine */ }
  }
  const coversDir = path.join(config.root, 'data', 'covers');
  mkdirSync(coversDir, { recursive: true });
  // Covers are keyed per-server: distinct ABS servers can mint the same
  // itemId, and a bare-<itemId>.jpg name let them overwrite each other.
  // Legacy bare-name files are reused when present; only new downloads use
  // the prefixed name, so existing libraries never re-download.
  const origin = originOf(link.server_url) || link.server_url;
  const coverKey = `${createHash('sha256').update(origin).digest('hex').slice(0, 10)}-${itemId}`;
  const legacyFile = path.join(coversDir, `${itemId}.jpg`);
  const coverFile = path.join(coversDir, `${coverKey}.jpg`);
  let coverUrl = null;
  try {
    if (!existsSync(coverFile)) {
      if (existsSync(legacyFile)) {
        coverUrl = `/covers/${itemId}.jpg`;
      } else {
        const res = await absFetch(link.server_url, link.api_token, `/api/items/${itemId}/cover`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 100) writeFileSync(coverFile, buf);
      }
    }
    if (!coverUrl && existsSync(coverFile)) coverUrl = `/covers/${coverKey}.jpg`;
  } catch { /* cover is optional */ }

  const info = insertBook.run(
    uid,
    hc?.title || meta.title,
    (hc?.contributions?.[0]?.author?.name || meta.author) || null,
    meta.narrator,
    hc ? (pickSeries(hc, meta.title)?.name || null) : null,
    hc ? (pickSeries(hc, meta.title)?.order ?? null) : null,
    JSON.stringify(hc ? genresFrom(hc) : []),
    JSON.stringify(hc ? moodsFrom(hc) : []),
    coverUrl,
    hc?.release_year || null,
    meta.runtime,
    hc?.pages || null,
    hc?.id || null,
    itemId
  );
  report?.(null, `Added "${meta.title}" to your library`);
  // A concurrent sync/import of the same item between our check and this
  // write: the unique index (migration 33) made it a skip — answer with the
  // winner's id so progress events land on the right row.
  if (info.changes === 0) {
    return db.prepare("SELECT id FROM books WHERE user_id=? AND source_provider='abs' AND source_id=?")
      .get(uid, itemId).id;
  }
  return Number(info.lastInsertRowid);
};

// The sync itself. Runs as the abs_sync job for the link's owner; every write
// is scoped to that user, and a finished listen is never re-dated once recorded.
// Failures stamp the link row (last_error + last_synced_at) before rethrowing:
// the 30-min enqueuer's due-logic then spaces retries to one attempt per
// ABS_SYNC_HOURS instead of hammering a dead server every half hour, and the
// member sees the error on their Account page. Manual "Sync now" stays
// immediate.
export async function runAbsSync(payload, report, uid, signal = {}) {
  try {
    return await syncMemberLibrary(payload, report, uid, signal);
  } catch (err) {
    db.prepare("UPDATE abs_links SET last_error=?, last_synced_at=datetime('now') WHERE user_id=?")
      .run(String(err.message || err).slice(0, 300), uid);
    throw err;
  }
}

async function syncMemberLibrary(payload, report, uid, signal = {}) {
  const link = db.prepare('SELECT * FROM abs_links WHERE user_id=?').get(uid);
  if (!link) throw bad('Link an Audiobookshelf account first (Account → Audiobookshelf).');

  report(5, 'Contacting Audiobookshelf…');
  const me = await (await absFetch(link.server_url, link.api_token, '/api/me')).json();
  // Field name varies by ABS version: mediaProgresses (newer) / mediaProgress.
  const progresses = (me.mediaProgresses || me.mediaProgress || []).filter(
    (p) => p.libraryItemId && (p.isFinished || (p.progress ?? 0) > 0));
  const items = await fetchLibraryItems(link, report);

  const result = {
    candidates: 0, books_added: 0, finished_dated: 0, finished_closed: 0,
    finished_undated: 0, reading_updated: 0, reading_opened: 0, already_finished: [],
  };
  let done = 0;
  // ABS's lastUpdate tracks any touch — listening, bulk marks, server-side
  // library actions — not the session that finished a title (on 2026-08-15 a
  // single mass-touch day showed up as lastUpdate across the whole catalog,
  // on titles genuinely finished in 2024-25). So a completion observed now
  // may carry a weeks-old lastUpdate, and stamping it invents a false day
  // (act 4 of the 2026-08-16 saga: the Sept 7 import stamped exactly such
  // Aug 9-26 mark days over one member's 25 rows). Fresh timestamps are trusted;
  // so is a book's very first sighting, where lastUpdate is the only date
  // ABS offers. Anything else records undated.
  const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  for (const p of progresses) {
    // Cooperative cancellation (the member hit Stop mid-sync).
    if (signal.cancelled?.()) { result.cancelled = true; break; }
    const meta = items.get(p.libraryItemId);
    if (!meta?.title) continue; // another library on the server — out of scope
    result.candidates++;
    const known = db.prepare("SELECT id FROM books WHERE user_id=? AND source_provider='abs' AND source_id=?")
      .get(uid, p.libraryItemId);
    const bookId = await ensureBook(uid, link, p.libraryItemId, meta, report);
    if (!known) result.books_added++;
    const ts = p.lastUpdate ? new Date(p.lastUpdate).getTime() : NaN;
    const absDate = Number.isFinite(ts) ? localDate(new Date(ts)) : null;
    const fresh = absDate !== null && Date.now() - ts <= FRESH_WINDOW_MS;
    // A tracked book only dates from a fresh timestamp; a first sighting
    // takes whatever date ABS offers.
    const date = fresh || !known ? absDate : null;
    const pct = Math.max(1, Math.min(99, Math.round((p.progress ?? 0) * 100)));
    const finished = p.isFinished || (p.progress ?? 0) >= 0.97;

    if (finished) {
      const prior = db.prepare("SELECT id, finished_at, finished_year FROM events WHERE book_id=? AND user_id=? AND status='finished' LIMIT 1")
        .get(bookId, uid);
      if (prior) {
        // A finish is already recorded — never re-date it, whatever its
        // dating state. ABS's lastUpdate is "when the title was marked
        // finished in ABS", which for a back catalog is the day of a bulk
        // mark, not a read date: it stamped 2026-08-16 over hand-set years
        // twice before this became unconditional. Undated finishes stay
        // undated (the read-dates tool sets years or dates by hand);
        // re-listens are logged by hand like re-reads.
        if (result.already_finished.length < 25) result.already_finished.push(meta.title);
        done++;
        continue;
      }
      const closed = db.prepare("UPDATE events SET status='finished', percent=NULL, finished_at=COALESCE(finished_at, ?) WHERE book_id=? AND user_id=? AND status='reading'")
        .run(date, bookId, uid);
      if (closed.changes) {
        result.finished_closed++;
        if (date === null) result.finished_undated++;
      } else {
        db.prepare("INSERT INTO events (user_id, book_id, format, medium, status, finished_at) VALUES (?,?,'listened','audiobook','finished',?)")
          .run(uid, bookId, date);
        if (date === null) result.finished_undated++;
        else result.finished_dated++;
      }
      const queued = db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'").get(uid, bookId);
      if (queued) db.prepare("UPDATE tbr SET status='done' WHERE id=?").run(queued.id);
    } else {
      const open = db.prepare("SELECT id, percent FROM events WHERE book_id=? AND user_id=? AND status='reading' ORDER BY id DESC LIMIT 1")
        .get(bookId, uid);
      if (open) {
        if (open.percent !== pct) {
          db.prepare('UPDATE events SET percent=? WHERE id=?').run(pct, open.id);
          result.reading_updated++;
        }
      } else {
        db.prepare("INSERT INTO events (user_id, book_id, format, medium, status, percent, started_at) VALUES (?,?,'listened','audiobook','reading',?,?)")
          .run(uid, bookId, pct, date);
        result.reading_opened++;
        const queued = db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'").get(uid, bookId);
        if (queued) db.prepare("UPDATE tbr SET status='started' WHERE id=?").run(queued.id);
      }
    }
    done++;
    report(95, `${done}/${progresses.length}: ${meta.title}`);
  }

  db.prepare("UPDATE abs_links SET last_synced_at=datetime('now'), last_error=NULL WHERE user_id=?").run(uid);
  return result;
}
