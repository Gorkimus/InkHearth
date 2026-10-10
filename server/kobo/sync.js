// Kobo device-link sync: pull reading state from Kobo's cloud as the device.
//
// The uploaded KoboReader.sqlite carries the device's own credentials (the
// `user` table's UserID/UserKey). With opt-in storage (kobo_links, migration
// 15) the app speaks the same sync protocol the device uses.
// Validated against a real Kobo account Sept 17, 2026. The wire facts that
// differ from the kobo-docker prior art:
//   • POST {storeapi}/v1/auth/device wants the kobodl-shaped body —
//     AffiliateName/AppVersion/ClientKey(base64 of PlatformId)/DeviceId(64
//     hex)/PlatformId/SerialNumber(32 hex)/UserKey. The old
//     DeviceModel/EmailAddress/... shape 400s.
//   • The device identity must be STABLE: derived here from the link's own
//     UserID so every sync presents the same device to Kobo.
//   • GET {storeapi}/v1/library/sync authorizes with just the Bearer token;
//     repeat it passing the returned x-kobo-synctoken to page through the
//     library until an empty batch.
//   • Real items nest the triple under `NewEntitlement`:
//     {NewEntitlement: {BookEntitlement, BookMetadata, ReadingState}} — the
//     triple also arrives top-level from some firmwares, so both are read.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../db.js';
import { config } from '../config.js';
import { runLibraryImport } from '../imports/library-import.js';
import { norm as hcNorm, authorListAgrees } from '../metadata/hardcover-import.js';

// ---- credentials from the uploaded device database ----

export function extractKoboDeviceLink(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    if (!tables.includes('user')) {
      throw new Error('no "user" table in this KoboReader.sqlite — device credentials unavailable');
    }
    const cols = db.prepare('PRAGMA table_info(user)').all().map((c) => c.name);
    const idCol = cols.find((c) => /^userid$/i.test(c));
    const keyCol = cols.find((c) => /^userkey$/i.test(c));
    if (!keyCol) throw new Error(`no UserKey column in the user table (${cols.join(', ')})`);
    const row = db.prepare('SELECT * FROM user LIMIT 1').get();
    const userKey = row?.[keyCol] ? String(row[keyCol]).trim() : '';
    if (!userKey) throw new Error('UserKey is empty — this device has never cloud-synced');
    return {
      kobo_user_id: idCol && row?.[idCol] ? String(row[idCol]) : null,
      user_key: userKey,
      api_endpoint: config.koboSync.endpoint,
    };
  } finally {
    db.close();
  }
}

// ---- protocol ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function koboFetch(url, { method = 'GET', body, accessToken, syncToken } = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(syncToken ? { 'x-kobo-synctoken': syncToken } : {}),
        },
        body: body && method !== 'GET' ? body : undefined,
        signal: AbortSignal.timeout(15000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        await sleep(1200 * attempt);
        continue;
      }
      if (res.status === 401) throw new Error('Kobo rejected the device credentials (HTTP 401) — re-upload KoboReader.sqlite and relink');
      if (!res.ok) throw new Error(`Kobo API HTTP ${res.status} for ${new URL(url).pathname}`);
      return res;
    } catch (err) {
      if (attempt >= tries || err.name === 'TimeoutError' || err.name === 'AbortError') {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('Kobo API timed out');
        throw err;
      }
      await sleep(1200 * attempt);
    }
  }
}

// Stable per-link device identity, derived from the device's own UserID —
// every sync presents the same "device" to Kobo instead of minting new ones.
const deviceIdentity = (link) => {
  const hex32 = createHash('md5').update(String(link.kobo_user_id || link.user_key)).digest('hex');
  return { deviceId: hex32 + hex32, serialNumber: hex32 + hex32.slice(0, 16) };
};

async function deviceAuth(link) {
  const platformId = config.koboSync.clientKey || '00000000-0000-0000-0000-000000000373';
  const { deviceId, serialNumber } = deviceIdentity(link);
  const body = JSON.stringify({
    AffiliateName: 'Kobo',
    AppVersion: '4.38.23171',
    ClientKey: Buffer.from(platformId).toString('base64'),
    DeviceId: deviceId,
    PlatformId: platformId,
    SerialNumber: serialNumber,
    UserKey: link.user_key,
  });
  const res = await koboFetch(`${link.api_endpoint}/v1/auth/device`, { method: 'POST', body });
  const out = await res.json();
  if (!out?.AccessToken) throw new Error('Kobo device auth returned no AccessToken');
  return out;
}

// ---- mapping: sync items → updates + import rows ----
//
// The feed sends TYPED top-level events (verified against a real account,
// Oct 2 2026 — three weeks of dropped finishes traced to this):
//   {NewEntitlement: {BookEntitlement, BookMetadata, ReadingState?}}  — full triple
//   {ChangedEntitlement: {BookEntitlement, BookMetadata, ReadingState?}} — same, revised
//   {ChangedReadingState: {ReadingState}} — state only, NO metadata/title
//   {NewTag/ChangedTag/DeletedTag/…}, {NewEntitlement: {BookSubscriptionEntitlement}}
// Kobo's ids: BookEntitlement.Id (== ReadingState.EntitlementId) is the
// entitlement namespace; BookEntitlement.RevisionId is the device ContentID
// namespace our books.source_id uses. Full triples carry both and upsert
// kobo_ent_map; state-only events resolve through it.

const numFrom = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ProgressPercent arrives as a 0..1 fraction on current firmware, but older
// payloads used whole percents — normalize by magnitude.
function percentFrom(state) {
  const raw = numFrom(state?.CurrentBookmark?.ProgressPercent);
  if (raw === null) return null;
  return Math.max(0, Math.min(100, Math.round(raw <= 1 ? raw * 100 : raw)));
}

const idsFromTriple = (ne) => ({
  entId: ne.BookEntitlement?.Id ? String(ne.BookEntitlement.Id)
    : ne.BookMetadata?.EntitlementId ? String(ne.BookMetadata.EntitlementId)
    : ne.BookEntitlement?.EntitlementId ? String(ne.BookEntitlement.EntitlementId) : null,
  revId: ne.BookEntitlement?.RevisionId ? String(ne.BookEntitlement.RevisionId) : null,
});

// Real metadata carries Contributors (no Author field) and `Isbn`; some
// firmwares send the older Author/ISBN shapes — read both.
function authorFromMeta(meta) {
  const legacy = (typeof meta.Author === 'string' && meta.Author) || meta.Author?.Name || null;
  if (legacy) return legacy;
  const names = (Array.isArray(meta.Contributors) ? meta.Contributors : [])
    .map((c) => (typeof c === 'string' ? c : c?.Name || c?.DisplayName)).filter(Boolean);
  return names.length ? names.slice(0, 2).join(', ') : null;
}

// A finish date comes from LastTimeFinished — StatusInfo.LastModified bumps
// on any touch (the cloud-side twin of the ABS act-4 lesson: a mass-touch
// day is not a read date).
const finishDateFrom = (state, percent) => {
  const status = String(state?.StatusInfo?.Status || '').toLowerCase();
  if (status !== 'finished' && (percent ?? 0) < 97) return null;
  const raw = state?.StatusInfo?.LastTimeFinished || state?.StatusInfo?.LastModified || null;
  return raw ? String(raw).slice(0, 10) : null;
};

// When the observation happened — gates OPENING a reading event (below).
const observedAtFrom = (state) => {
  const raw = state?.StatusInfo?.LastModified || state?.CurrentBookmark?.LastModified || null;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : null;
};

// Full triple → a row for the import runner (new books only; existing books
// go through applyReadingState instead, so a sync never re-imports).
function rowFromTriple(ne) {
  const meta = ne.BookMetadata || {};
  const state = ne.ReadingState || {};
  const title = String(meta.Title || '').trim();
  if (!title) return null;
  const ids = idsFromTriple(ne);
  const percent = percentFrom(state);
  const status = String(state.StatusInfo?.Status || '').toLowerCase();
  const isbn = (typeof meta.Isbn === 'string' && meta.Isbn) || (typeof meta.ISBN === 'string' && meta.ISBN) || meta.ISBN?.id || null;
  return {
    content_id: ids.revId || ids.entId || null,
    isbn: isbn ? String(isbn) : null,
    title,
    author: authorFromMeta(meta),
    percent: status === 'finished' ? 100 : percent,
    last_read: finishDateFrom(state, percent),
    status,
    observedAt: observedAtFrom(state),
    suggested_status:
      status === 'finished' || (percent ?? 0) >= 97 ? 'finished'
        : (percent ?? 0) >= 1 || status === 'reading' ? 'reading' : 'book',
  };
}

// State-only event → the same triple the direct-update path speaks.
const rowFromState = (state) => {
  const percent = percentFrom(state);
  return {
    status: String(state?.StatusInfo?.Status || '').toLowerCase(),
    percent,
    finishedAt: finishDateFrom(state, percent),
    observedAt: observedAtFrom(state),
  };
};

// A state-only delta for a book the shelf never adopted can still name the
// book — the entitlement triple stored its title/author in the id map
// (migration 46). Adopt it through the same conservative gate the triple
// path applies: finished, actively reading, or ≥5% only.
const stateImportRow = (st, mapRow) => {
  if (!mapRow?.title) return null;
  const suggested = st.status === 'finished' || (st.percent ?? 0) >= 97 ? 'finished'
    : (st.percent ?? 0) >= 1 || st.status === 'reading' ? 'reading' : 'book';
  if (suggested === 'book') return null;
  return {
    content_id: mapRow.revision_id || null,
    title: mapRow.title,
    author: mapRow.author || null,
    percent: st.status === 'finished' ? 100 : st.percent,
    last_read: st.finishedAt,
    status: st.status,
    observedAt: st.observedAt,
    suggested_status: suggested,
  };
};

const upsertEntMap = (uid, entId, revId, title, author) =>
  db.prepare(`INSERT INTO kobo_ent_map (user_id, entitlement_id, revision_id, title, author) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id, entitlement_id) DO UPDATE SET revision_id=excluded.revision_id,
      title=COALESCE(excluded.title, title), author=COALESCE(excluded.author, author)`)
    .run(uid, entId, revId, title ?? null, author ?? null);

const findBookByIds = (uid, revId, entId) => {
  const cands = [...new Set([revId, entId].filter(Boolean))];
  if (!cands.length) return null;
  return db.prepare(`SELECT id, source_id FROM books WHERE user_id=? AND source_provider='kobo'
    AND source_id IN (${cands.map(() => '?').join(',')}) LIMIT 1`).get(uid, ...cands) || null;
};

// Matching a cloud triple to an existing shelf row, in forgiving order —
// the alternative is duplicate rows, the very bug this sync repair is
// closing. Tiers: (1) exact normalized title + author, (2) a single
// same-title candidate when either side carries no author, (3) subtitle
// drift ("Out" vs "Out: A Novel" — the feed's raw title keeps what
// Hardcover canonicalization later strips) with author agreement. Author
// comparison tolerates contributor-list drift ("Natsuo Kirino, Stephen
// Snyder" vs the shelf's "Natsuo Kirino" — the Oct 4 replay duplicated
// Out + Butter exactly here); a DISAGREEING author never matches (same
// title + different author is a different book — God in the Machine ×2).
const findBookByTitle = (uid, row) => {
  const shelf = db.prepare('SELECT id, source_id, title, author FROM books WHERE user_id=?').all(uid);
  const t = hcNorm(row.title);
  const byTitle = shelf.filter((b) => hcNorm(b.title) === t);
  const exact = byTitle.find((b) => authorListAgrees(b.author, row.author));
  if (exact) return exact;
  if (byTitle.length === 1 && (!hcNorm(row.author) || !hcNorm(byTitle[0].author))) return byTitle[0];
  const minLen = Math.min(4, t.length);
  return shelf.find((b) => {
    const bt = hcNorm(b.title);
    if (bt.length < minLen || t.length < minLen) return false;
    const pre = bt.length <= t.length ? bt : t;
    const long = bt.length <= t.length ? t : bt;
    return long.startsWith(pre) && authorListAgrees(b.author, row.author);
  }) || null;
};

// Fold one reading-state observation into an existing book's events — the
// same in-place semantics the ABS sync uses: progress moves update the open
// reading event (stamping progress_at so streaks see the day), a finish
// closes an open reading event in place or mints one, and an existing
// finish is never re-dated whatever the feed says. OPENING a new reading
// event requires a fresh observation: Kobo keeps abandoned books as
// "Reading @ 30%" forever, and a full-library replay must not turn years-old
// stalls into currently-reading entries. Returns WHY nothing/something
// happened — 'changed' (progress or a new finish), 'unchanged' (no-op),
// 'stale' (reading observation too old to open), 'dup-finish' (the finish
// is already recorded on a sibling copy of the same book) — the runner
// counts each reason so the job result shows what the sync actually did.
const READING_OPEN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// A finish already recorded on ANOTHER row of the same book (hardcover
// anchor, or same normalized title with agreeing authors) means the device
// is replaying a state the household already logged by hand — minting a
// second finished event would double-count the book. The duplicate row
// itself stays (deleting books is the member's call); this only refuses to
// compound it.
function crossCopyFinish(uid, bookId) {
  const book = db.prepare('SELECT title, author, hardcover_id FROM books WHERE id=?').get(bookId);
  if (!book) return false;
  const finished = db.prepare(`SELECT b.id, b.title, b.author, b.hardcover_id FROM events e
      JOIN books b ON b.id = e.book_id
      WHERE e.user_id=? AND e.book_id<>? AND e.status='finished'`).all(uid, bookId);
  const t = hcNorm(book.title);
  return finished.some((b) => (book.hardcover_id && b.hardcover_id === book.hardcover_id)
    || (hcNorm(b.title) === t && authorListAgrees(b.author, book.author)));
}

function applyReadingState(uid, bookId, { status, percent, finishedAt, observedAt }) {
  if (status === 'finished' || (percent ?? 0) >= 97) {
    const prior = db.prepare("SELECT id FROM events WHERE book_id=? AND user_id=? AND status='finished' AND format='read' LIMIT 1")
      .get(bookId, uid);
    if (prior) return 'unchanged'; // recorded once, never re-dated
    if (crossCopyFinish(uid, bookId)) return 'dup-finish';
    const closed = db.prepare("UPDATE events SET status='finished', percent=NULL, progress_at=datetime('now'), finished_at=COALESCE(finished_at, ?) WHERE book_id=? AND user_id=? AND status='reading' AND format='read'")
      .run(finishedAt || null, bookId, uid);
    if (closed.changes) return 'changed';
    db.prepare("INSERT INTO events (user_id, book_id, format, medium, status, finished_at) VALUES (?,?,'read','kobo','finished',?)")
      .run(uid, bookId, finishedAt || null);
    return 'changed';
  }
  if (status === 'reading' || (percent ?? 0) >= 1) {
    const open = db.prepare("SELECT id, percent FROM events WHERE book_id=? AND user_id=? AND status='reading' AND format='read' ORDER BY id DESC LIMIT 1")
      .get(bookId, uid);
    const pct = percent == null ? null : Math.max(1, Math.min(99, Math.round(percent)));
    if (open) {
      if (open.percent === pct) return 'unchanged';
      db.prepare("UPDATE events SET percent=?, progress_at=datetime('now') WHERE id=?").run(pct, open.id);
      return 'changed';
    }
    if (observedAt == null || Date.now() - observedAt > READING_OPEN_WINDOW_MS) return 'stale'; // stale stall, not a fresh start
    db.prepare("INSERT INTO events (user_id, book_id, format, medium, status, percent, progress_at) VALUES (?,?,'read','kobo','reading',?, datetime('now'))")
      .run(uid, bookId, pct);
    return 'changed';
  }
  return 'unchanged'; // untouched — nothing to record
}

// ---- the job runner ----

export async function runKoboSync(payload, report, uid) {
  const link = db.prepare('SELECT * FROM kobo_links WHERE user_id=?').get(uid);
  if (!link) throw new Error('no linked Kobo device');

  try {
    report(2, 'Authenticating with Kobo…');
    const auth = await deviceAuth(link);

    report(8, 'Pulling reading state…');
    // Page through the library with the returned sync token until an empty
    // batch — the first call carries only the newest 100 entitlements.
    let syncToken = link.last_sync_token || undefined;
    const items = [];
    for (let page = 0; page < 25; page++) {
      const res = await koboFetch(`${link.api_endpoint}/v1/library/sync`, {
        accessToken: auth.AccessToken,
        syncToken,
      });
      const batch = await res.json().catch(() => null);
      if (!Array.isArray(batch) || !batch.length) break;
      items.push(...batch);
      const next = res.headers.get('x-kobo-synctoken');
      if (!next || next === syncToken) break;
      syncToken = next;
    }

    const result = {
      imported: 0, skipped: 0, hardcover_matched: 0, events_created: 0, tbr_queued: 0,
      state_updates: 0, skipped_unread: 0, unknown_state: 0, ignored_other: 0,
      ignored_titleless: 0, stale_skipped: 0, finished_deduped: 0,
      changed: items.length,
    };
    // Fold one resolved book's observation into the counters by reason.
    const fold = (bookId, st) => {
      const r = applyReadingState(uid, bookId, st);
      if (r === 'changed') result.state_updates++;
      else if (r === 'stale') result.stale_skipped++;
      else if (r === 'dup-finish') result.finished_deduped++;
    };
    const importRows = [];

    for (const [i, item] of items.entries()) {
      report(15 + Math.round((i / Math.max(items.length, 1)) * 55), `Processing sync item ${i + 1}/${items.length}…`);
      const ne = item.NewEntitlement || item.ChangedEntitlement || null;
      if (ne && ne.BookSubscriptionEntitlement) { result.ignored_other++; continue; }
      if (ne) {
        const { entId, revId } = idsFromTriple(ne);
        const meta = ne.BookMetadata || {};
        // The map upsert runs BEFORE the title gate: a title-less triple is
        // still an entitlement whose later state-only deltas (which never
        // carry a title) must resolve — and the map remembers the name.
        if (entId && revId) upsertEntMap(uid, entId, revId, String(meta.Title || '').trim() || null, authorFromMeta(meta));
        const row = rowFromTriple(ne);
        if (!row) { result.ignored_titleless++; continue; }
        const book = findBookByIds(uid, revId, entId) ?? findBookByTitle(uid, row);
        if (book) {
          // First cloud contact repairs the pre-fix rows the old mapper left
          // without an id (title-matched every sync, invisible to the index).
          if (!book.source_id && row.content_id) {
            db.prepare('UPDATE books SET source_id=? WHERE id=?').run(row.content_id, book.id);
          }
          fold(book.id, row);
        } else if (row.suggested_status === 'finished' || row.status === 'reading' || (row.percent ?? 0) >= 5) {
          // Auto-add only books with real activity: peeks at a sample, unread
          // purchases and library filler stay out until she imports a file.
          importRows.push(row);
        } else {
          result.skipped_unread++;
        }
      } else if (item.ChangedReadingState) {
        const state = item.ChangedReadingState.ReadingState || item.ChangedReadingState;
        const entId = state?.EntitlementId || item.ChangedReadingState.EntitlementId || null;
        const mapRow = entId
          ? db.prepare('SELECT revision_id, title, author FROM kobo_ent_map WHERE user_id=? AND entitlement_id=?').get(uid, entId)
          : null;
        const revId = mapRow?.revision_id || null;
        const book = (revId || entId) ? findBookByIds(uid, revId, entId) : null;
        if (book) {
          fold(book.id, rowFromState(state));
        } else {
          const row = stateImportRow(rowFromState(state), mapRow);
          if (row) {
            // A finish (or real progress) for a book the shelf skipped when
            // it was unread: adopt it now — this is the hole that silently
            // ate a member's "Writers and Lovers" finish (Oct 2026, a sync
            // with changed:1 / unknown_state:1 and nothing else).
            importRows.push(row);
          } else {
            // Expected after she deletes a tracked book, or before the first
            // full-triple pass builds the id map — logged, never fatal.
            result.unknown_state++;
            console.warn(`[kobo-sync] reading-state event for unknown book (entitlement ${entId || '?'}) — skipped`);
          }
        }
      } else {
        result.ignored_other++; // tags, shelves, deletions — not library state
      }
    }

    if (importRows.length) {
      report(70, `Importing ${importRows.length} new book${importRows.length === 1 ? '' : 's'}…`);
      const imp = await runLibraryImport({ uid, provider: 'kobo', rows: importRows, hardcover: true }, (p, label) =>
        report(70 + Math.round(((p || 0) / 100) * 28), label));
      result.imported = imp.imported;
      result.skipped = imp.skipped;
      result.hardcover_matched = imp.hardcover_matched;
      result.events_created = imp.events_created;
      result.tbr_queued = imp.tbr_queued;
    }

    // The token advances ONLY past a fully resolved window: a run that ends
    // with unresolved state events (unknown_state) holds the previous token
    // so Kobo re-sends the same window next run — an event dropped today
    // self-heals after a fix or a late match instead of being lost forever
    // (the Writers-and-Lovers failure needed a manual token-reset replay
    // because the old code advanced unconditionally). After three
    // consecutive holds the token advances anyway: a permanently
    // unresolvable event (the member deleted the book server-side) must not
    // loop the full pull forever. Replays are safe — every write above is
    // idempotent (finishes never re-dated, percents no-op when unchanged).
    const holds = result.unknown_state > 0 ? (link.sync_holds ?? 0) + 1 : 0;
    const advance = result.unknown_state === 0 || holds >= 3;
    result.token_held = !advance;
    result.sync_holds = advance ? 0 : holds;
    if (!advance) {
      console.warn(`[kobo-sync] holding sync token — ${result.unknown_state} unresolved state event(s), hold ${holds}/3`);
    }
    db.prepare("UPDATE kobo_links SET last_synced_at=datetime('now'), last_sync_token=?, last_error=NULL, sync_holds=? WHERE user_id=?")
      .run(advance ? syncToken : (link.last_sync_token ?? null), result.sync_holds, uid);
    return result;
  } catch (err) {
    db.prepare('UPDATE kobo_links SET last_error=? WHERE user_id=?').run(String(err.message || err), uid);
    throw err;
  }
}
