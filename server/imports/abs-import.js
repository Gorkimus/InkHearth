// In-app Audiobookshelf import — the same hybrid logic as the CLI script:
//   ABS      → what you own: inventory ids, real file runtimes, cover files, narrators
//   Hardcover → what each book IS: canonical title, author, series + order, genres, pages
// Creates book records with NO read/listen events (ABS can't know what was
// finished on Audible before transfer). Re-running skips already-imported
// items (source_provider 'abs' + ABS item id). Runs as the abs_import job;
// scripts/import-abs.js is a thin CLI wrapper around this.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db, currentUserId } from '../db.js';
import { hardcoverLookup, pickSeries, genresFrom, moodsFrom, sequenceFromTitle } from '../metadata/hardcover-import.js';

export async function runAbsImport({ rematch, uid: uidOverride }, report = () => {}) {
  const abs = config.abs;
  if (!abs.url || !abs.token || !abs.libraryId) {
    throw new Error('ABS_URL / ABS_API_TOKEN / ABS_LIBRARY_ID missing in .env');
  }
  if (!config.hardcoverToken) {
    throw new Error('HARDCOVER_TOKEN missing in .env — the hybrid import needs it for canonical metadata');
  }
  // Job runners pass the owner explicitly; CLI callers fall back to the seed user.
  const uid = uidOverride ?? currentUserId();
  const coversDir = path.join(config.root, 'data', 'covers');
  mkdirSync(coversDir, { recursive: true });

  // Same never-hang contract as abs/sync.js's absFetch: the job worker runs
  // strictly one job at a time, so a stalled ABS fetch must become a fast
  // error (a per-item warning via inChunks, or a job error from the inventory
  // pages) — not an eternally 'running' job wedging the whole queue.
  // One retry on transient failures (network, 429, 5xx), 15s timeout each.
  const absFetch = async (url) => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${abs.token}` },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 1000)); continue; }
        throw new Error(`ABS unreachable (${err.message})`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return res;
    }
  };
  const absApi = async (p) => {
    const res = await absFetch(`${abs.url}/api${p}`);
    if (!res.ok) throw new Error(`ABS ${p} → ${res.status}`);
    return res.json();
  };

  const warnings = [];
  async function inChunks(items, fn, size) {
    const out = new Map();
    let done = 0;
    for (let i = 0; i < items.length; i += size) {
      await Promise.all(items.slice(i, i + size).map(async (it) => {
        try { out.set(it.key, await fn(it)); }
        catch (err) {
          warnings.push(`${it.label}: ${err.message}`);
          if (out.get(it.key) === undefined) out.set(it.key, null);
        }
      }));
      done += Math.min(size, items.length - i);
      report(Math.round((done / items.length) * 100), `${done}/${items.length}`);
    }
    return out;
  }

  // ---------- rematch mode: retry HC matching for existing unmatched rows ----------
  if (rematch) {
    const rows = db
      .prepare("SELECT id, title, author FROM books WHERE user_id=? AND source_provider='abs' AND hardcover_id IS NULL AND hardcover_excluded=0")
      .all(uid);
    const update = db.prepare(`UPDATE books SET
        title=?, author=COALESCE(author,?), series_name=?, series_order=?, genres=?, moods=?,
        published_year=COALESCE(published_year,?), page_count=COALESCE(page_count,?), hardcover_id=?
      WHERE id=?`);
    let matched = 0;
    const still = [];
    for (const [i, row] of rows.entries()) {
      report(Math.round((i / rows.length) * 100), `Re-matching "${row.title}" (${i + 1}/${rows.length})`);
      let hcBook = null;
      try { hcBook = await hardcoverLookup(row.title, row.author, null); }
      catch { /* keep local metadata */ }
      if (!hcBook) { still.push(row.title); continue; }
      const series = pickSeries(hcBook, row.title);
      update.run(
        hcBook.title,
        hcBook.contributions?.[0]?.author?.name || row.author,
        series?.name || null,
        series?.order ?? sequenceFromTitle(hcBook.title),
        JSON.stringify(genresFrom(hcBook)),
        JSON.stringify(moodsFrom(hcBook)),
        hcBook.release_year || null,
        hcBook.pages || null,
        hcBook.id,
        row.id
      );
      matched++;
    }
    return { rematch: true, candidates: rows.length, rematched: matched, still_unmatched: still };
  }

  // ---------- 1. ABS inventory ----------
  report(0, 'Fetching ABS inventory…');
  const list = [];
  for (let page = 0; ; page++) {
    const d = await absApi(`/libraries/${abs.libraryId}/items?limit=100&page=${page}`);
    list.push(...(d.results || []));
    if (!d.results?.length || list.length >= d.total) break;
  }

  // The list endpoint truncates metadata (authors null even expanded), so
  // fetch each item individually — that one has narrators and authors.
  const details = await inChunks(
    list.map((it) => ({ key: it.id, label: it.media?.metadata?.title, it })),
    async ({ it }) => (await absApi(`/items/${it.id}?minified=1`)),
    8
  );

  // ---------- 2. Covers (local files; URLs never embed the ABS token) ----------
  const covers = await inChunks(
    list.map((it) => ({ key: it.id, label: it.media?.metadata?.title, it })),
    async ({ it }) => {
      const file = path.join(coversDir, `${it.id}.jpg`);
      if (existsSync(file)) return `/covers/${it.id}.jpg`;
      const res = await absFetch(`${abs.url}/api/items/${it.id}/cover`);
      if (!res.ok) throw new Error(`cover HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) throw new Error('cover empty');
      writeFileSync(file, buf);
      return `/covers/${it.id}.jpg`;
    },
    8
  );

  // ---------- 3. Write ----------
  const insert = db.prepare(`INSERT INTO books
    (user_id, title, author, narrator, series_name, series_order, genres, moods, cover_url,
     published_year, audio_runtime_minutes, page_count, hardcover_id,
     source_provider, source_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'abs',?)
    ON CONFLICT(user_id, source_provider, source_id) DO NOTHING`);

  let imported = 0, skipped = 0, noRuntime = 0;
  const unmatchedList = [];

  for (const [i, it] of list.entries()) {
    report(Math.round((i / list.length) * 100), `Importing "${it.media?.metadata?.title}" (${i + 1}/${list.length})`);
    const detail = details.get(it.id);
    // The single-item endpoint omits duration in minified mode; the list
    // response always has it, so prefer whichever carries it.
    const media = detail?.media || it.media || {};
    const duration = media.duration ?? it.media?.duration;
    const md = media.metadata || {};
    const absTitle = md.title?.trim();
    if (!absTitle) { warnings.push(`item ${it.id} has no title, skipped`); continue; }

    const dup = db.prepare('SELECT id FROM books WHERE user_id=? AND source_provider=? AND source_id=?')
      .get(uid, 'abs', it.id);
    if (dup) { skipped++; continue; }

    const runtimeMin = duration ? Math.round(duration / 60) : null;
    if (!runtimeMin) noRuntime++;

    let hcBook = null;
    try { hcBook = await hardcoverLookup(absTitle, md.authors?.[0]?.name, md.isbn || md.asin); }
    catch { /* keep ABS metadata */ }

    const title = hcBook?.title || absTitle;
    // Hardcover's author is canonical when we have a match (ABS sometimes lists
    // the dramatization studio, e.g. "Graphic Audio LLC.").
    const author = (hcBook?.contributions?.[0]?.author?.name || md.authors?.[0]?.name) || null;
    const series = hcBook ? pickSeries(hcBook, absTitle) : null;
    const seriesOrder = series?.order ?? sequenceFromTitle(absTitle);
    const genres = hcBook ? genresFrom(hcBook) : md.genres || [];

    if (!hcBook) unmatchedList.push(absTitle);

    const info = insert.run(
      uid, title, author,
      md.narrators?.length ? md.narrators.join(', ') : null,
      series?.name || null,
      seriesOrder,
      JSON.stringify(genres),
      JSON.stringify(hcBook ? moodsFrom(hcBook) : []),
      covers.get(it.id) || null,
      hcBook?.release_year || parseInt(String(md.publishedYear || '').slice(0, 4)) || null,
      runtimeMin,
      hcBook?.pages || null,
      hcBook?.id || null,
      it.id
    );
    // A zero-change insert means a concurrent import created the same
    // (user, 'abs', item id) row between our dup check and this write —
    // migration 33's unique index turned a would-be duplicate into a skip.
    if (info.changes === 0) { skipped++; continue; }
    imported++;
  }

  return {
    imported,
    skipped,
    no_runtime: noRuntime,
    hardcover_matched: imported - unmatchedList.length,
    unmatched: unmatchedList,
    warnings,
  };
}
