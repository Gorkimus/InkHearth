import { Router, raw } from 'express';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db, currentUserId } from '../db.js';
import { config } from '../config.js';
import { searchMetadata, enrichWithHardcover, hardcoverEnabled, isNoiseTitle } from '../metadata/index.js';
import { fetchVolumes } from '../metadata/google-books.js';
import { seriesRosters } from '../metadata/hardcover.js';
import { bookInfo } from '../metadata/book-info.js';
import { hardcoverLookup, hardcoverByIsbn, pickSeries, genresFrom, moodsFrom, normTags } from '../metadata/hardcover-import.js';
import { mapGenres } from '../genres-vocab.js';
import { fetchJson } from '../metadata/fetch.js';
import { resolveLlm } from '../llm.js';
import { parseKoboDb } from '../kobo/parse.js';
import { parseJsonArr } from '../jsonarr.js';
import { extractKoboDeviceLink } from '../kobo/sync.js';
import { validateAbs, linkAbs, getAbsLink, unlinkAbs } from '../abs/sync.js';
import { runLibraryImport } from '../imports/library-import.js';
import { refreshBookMetadata, googleFallbackFill, stampRefreshed } from '../imports/book-refresh.js';
import { parseAudibleExport, tableFromRows } from '../audible/parse.js';
import { xlsxToTable, isZipFile } from '../audible/xlsx.js';
import { parseGoodreads } from '../goodreads/parse.js';
import { readingStreak } from '../streak.js';
import { createJob } from '../jobs.js';

const r = Router();
const TIERS = ['S', 'A', 'B', 'C', 'D'];
const FORMATS = ['read', 'listened'];
const STATUSES = ['finished', 'dnf', 'reading'];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const normTitle = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function parseBook(row) {
  if (!row) return row;
  return {
    ...row,
    genres: parseJsonArr(row.genres),
    moods: parseJsonArr(row.moods),
    tags: parseJsonArr(row.tags),
    // Missing Hardcover enrichment — a re-pull (POST /books/:id/refresh) can
    // still fetch cover, lengths, series, genres and moods. Surfaces as the
    // library's ↻ badge and the "Needs re-pull" filter. The flag defers to the
    // metadata stamp (set on every re-pull attempt): once sources have been
    // consulted and genuinely lack the data — HC entries with no lengths, no
    // mood tags, no cover — the badge would be permanent noise, so it stops.
    // Books marked hardcover_excluded have no HC profile at all (novellas,
    // niche editions) — they opt out of the flag entirely.
    needs_refresh: !row.hardcover_excluded && !row.metadata_refreshed_at && (!row.hardcover_id || !row.cover_url
      || (!row.page_count && !row.audio_runtime_minutes)),
    hardcover_excluded: !!row.hardcover_excluded,
  };
}

// ---------- meta ----------

r.get('/meta', (req, res) => {
  res.json({
    user: req.user ? { id: req.user.id, name: req.user.name, is_admin: !!req.user.is_admin } : null,
    hardcover_enabled: hardcoverEnabled(),
    // Can THIS signed-in user generate recommendations (own key or shared)?
    llm_enabled: !!resolveLlm(req.user?.id),
    build: config.startedAt, // changes on every server restart → SPA update toast
    // undefined on production → key omitted from the payload entirely
    label: config.instanceLabel || undefined,
  });
});

// ---------- search / books ----------

r.get('/search', async (req, res, next) => {
  // Quotes mean the member wants the full phrase — strip them and force the
  // exact (name-gated) paths for this search. Typed unquoted stays forgiving.
  const quoted = /^"(.+)"$/.exec((req.query.q || '').trim());
  const q = (quoted ? quoted[1] : (req.query.q || '')).trim();
  const exact = req.query.exact === '1' || Boolean(quoted);
  if (q.length < 2) return res.json({ results: [] });
  const SEARCH_FIELDS = ['all', 'title', 'author', 'series'];
  const field = SEARCH_FIELDS.includes(req.query.field) ? req.query.field : 'all';
  try {
    // Samples, anthologies and boxed sets are filtered out unless the client's
    // "collections & samples" toggle asks for them; owned books are hidden
    // unless the "include books already in library" toggle asks for them.
    const { results: found, noiseHidden } = await searchMetadata(q, {
      includeCollections: req.query.collections === '1',
      field,
      exact, // click-through deep links and quoted queries: name-gated
    });
    const uid = currentUserId();
    const hideOwned = req.query.owned !== '1';
    const ownedRows = hideOwned
      ? db.prepare('SELECT title, author, source_provider, source_id FROM books WHERE user_id=?').all(uid)
      : [];
    const bySource = new Set(ownedRows
      .filter((b) => b.source_provider && b.source_id)
      .map((b) => `${b.source_provider}|${b.source_id}`));
    const byTitleAuthor = new Set(ownedRows.map((b) => `${normTitle(b.title)}|${normTitle(b.author)}`));
    const results = found.filter((r) => {
      if (r.provider && r.source_id && bySource.has(`${r.provider}|${r.source_id}`)) return false;
      return !byTitleAuthor.has(`${normTitle(r.title)}|${normTitle(r.author)}`);
    });
    // Exact mode on the free-text fields keeps only full-phrase matches —
    // quotes are a promise that every word belongs together.
    const phrase = normTitle(q);
    const phraseOk = (r) => !exact || field === 'series' || field === 'author'
      || normTitle(r.title || '').includes(phrase) || normTitle(r.author || '').includes(phrase);
    const finalResults = results.filter(phraseOk);
    const hiddenOwned = hideOwned ? found.length - results.length : 0;
    res.json({
      results: finalResults,
      hidden: hideOwned ? hiddenOwned : 0,
      noise_hidden: noiseHidden,
    });
  } catch (err) {
    console.warn(`[search] "${q}" failed:`, err.message);
    next(Object.assign(new Error('Book search is unreachable right now — try again in a moment.'), { status: 502 }));
  }
});

r.post('/books', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.title?.trim()) throw bad('title required');
    const uid = currentUserId();

    // Dedupe: external provider id first, then normalized title+author.
    let existing = null;
    if (b.source_provider && b.source_id) {
      existing = db
        .prepare('SELECT * FROM books WHERE user_id=? AND source_provider=? AND source_id=?')
        .get(uid, b.source_provider, String(b.source_id));
    }
    if (!existing) {
      const candidates = db
        .prepare('SELECT * FROM books WHERE user_id=? AND lower(title)=lower(?)')
        .all(uid, b.title.trim());
      existing = candidates.find((c) => normTitle(c.author) === normTitle(b.author));
    }
    if (existing) return res.json({ book: parseBook(existing), existed: true });

    // A Hardcover-anchored draft (verified recs, quick-add HC results) carries
    // the id in source_id; promote it so compare and library matching can use
    // it directly.
    const hcAnchor = b.source_provider === 'hardcover' && /^\d+$/.test(String(b.source_id || ''))
      ? Number(b.source_id) : null;

  const info = db
    .prepare(`INSERT INTO books
      (user_id, title, author, narrator, series_name, series_order, page_count,
       genres, moods, tags, cover_url, published_year, audio_runtime_minutes,
       hardcover_id, source_provider, source_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      uid, b.title.trim(), b.author?.trim() || null, b.narrator?.trim() || null,
      b.series_name?.trim() || null, b.series_order || null, b.page_count || null,
      // Genres are provider-derived (search results, imports) — strict
      // canonical mapping. Manual genre edits go through the PATCH route,
      // which stays verbatim.
      JSON.stringify(mapGenres(b.genres)), JSON.stringify(normTags(b.moods)), JSON.stringify(normTags(b.tags)),
      b.cover_url || null,
      b.published_year || null, b.audio_runtime_minutes || null,
      hcAnchor, b.source_provider || 'manual',
      b.source_id ? String(b.source_id) : null
    );
    let book = db.prepare('SELECT * FROM books WHERE id=?').get(info.lastInsertRowid);

    // Fill any length fields the draft is missing from Hardcover (free API:
    // quality page counts + real audiobook runtimes; no word counts exist).
    // Drafts that arrived complete (e.g. from verified recs) skip the lookup.
    const enrich = (book.page_count && book.audio_runtime_minutes)
      ? null
      : await enrichWithHardcover(book);
    if (enrich && (enrich.page_count || enrich.audio_runtime_minutes)) {
      db.prepare(`UPDATE books SET
          page_count = COALESCE(page_count, ?),
          audio_runtime_minutes = COALESCE(audio_runtime_minutes, ?)
        WHERE id=?`)
        .run(enrich.page_count, enrich.audio_runtime_minutes, book.id);
      book = db.prepare('SELECT * FROM books WHERE id=?').get(book.id);
    }
    res.json({ book: parseBook(book), existed: false });
  } catch (err) {
    next(err);
  }
});

// Barcode scan: an ISBN → one book draft in the same shape /search returns.
// Google first (keyless, one call, includes a cover), Open Library as the
// fallback, then Hardcover for series/genres/moods — the same enrichments a
// quick-added search result carries.
const isbnNorm = (raw) => String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();

// Pre-2007 US books carry a 12-digit UPC-A (leading 0) instead of an EAN-13:
// digits 1-9 are the ISBN-10's first nine. Expand to a 978-prefixed ISBN-13
// with a recomputed check digit so the lookup sees a normal ISBN.
const isbnFromBarcode = (raw) => {
  const s = isbnNorm(raw);
  if (!/^\d{12}$/.test(s) || s[0] !== '0') return s;
  const base = '978' + s.slice(1, 10);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 ? 3 : 1);
  return base + ((10 - (sum % 10)) % 10);
};

r.get('/books/isbn/:isbn', async (req, res, next) => {
  try {
    const isbn = isbnFromBarcode(req.params.isbn);
    if (!/^(?:\d{9}[\dX]|\d{13})$/.test(isbn)) return res.status(400).json({ error: 'not an ISBN' });

    let result = null;
    let viaHc = false;
    // Open Library's edition endpoint leads: exact, keyless, and dependable —
    // the old books?bibkeys API now 404s empty-bodied, and Google 429s its
    // keyless quota on shared IPs. /isbn/X.json 302s to the canonical edition
    // record; the author's name hangs off the work record, one hop away.
    try {
      const ed = await fetchJson(`https://openlibrary.org/isbn/${isbn}.json`, { timeout: 8000, retries: 0 });
      let author = null;
      try {
        const wkey = (ed.works || [])[0]?.key;
        const work = wkey ? await fetchJson(`https://openlibrary.org${wkey}.json`, { timeout: 6000, retries: 0 }) : null;
        const akey = (work?.authors || [])[0]?.author?.key;
        if (akey) author = (await fetchJson(`https://openlibrary.org${akey}.json`, { timeout: 6000, retries: 0 })).name || null;
      } catch { /* author is optional metadata */ }
      const cover = (ed.covers || []).find((c) => Number.isInteger(c) && c > 0);
      result = {
        provider: 'openlibrary',
        source_id: ed.key?.split('/').pop() || `ol-isbn-${isbn}`,
        title: ed.title,
        author,
        page_count: ed.number_of_pages || null,
        published_year: parseInt(ed.publish_date, 10) || null,
        genres: [],
        cover_url: cover ? `https://covers.openlibrary.org/b/id/${cover}-M.jpg` : null,
      };
    } catch { /* OL miss/down — Hardcover and Google still get shots */ }
    // Hardcover by-ISBN fallback: HC's search matches bare ISBNs and carries
    // the richest record of the three (series, genres, moods, pages, cover) —
    // when OL and Google are both squeezed, scans still resolve.
    if (!result && hardcoverEnabled()) {
      try {
        const hc = await hardcoverByIsbn(isbn);
        if (hc) {
          viaHc = true;
          const series = pickSeries(hc, hc.title);
          result = {
            provider: 'hardcover',
            source_id: String(hc.id),
            title: hc.title,
            author: ((hc.contributions || [])[0] || {}).author?.name || null,
            page_count: hc.pages || null,
            published_year: hc.release_year || null,
            genres: genresFrom(hc),
            moods: moodsFrom(hc),
            cover_url: hc.cached_image || null,
            series_name: series?.name || null,
            series_order: series?.order ?? null,
          };
        }
      } catch { /* HC down too — Google is the last resort */ }
    }
    if (!result || config.googleBooksKey || config.googleBooksKey2) {
      try {
        const d = await fetchVolumes(`q=isbn:${isbn}&maxResults=5`, { timeout: 6000, retries: 0 });
        const it = (d.items || []).find((x) => x.volumeInfo?.title);
        if (it) {
          const v = it.volumeInfo;
          const g = {
            provider: 'google',
            source_id: it.id,
            title: v.title,
            author: (v.authors || [])[0] || null,
            page_count: v.pageCount || null,
            published_year: parseInt(v.publishedDate, 10) || null,
            genres: v.categories || [],
            cover_url: v.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
          };
          if (!result) result = g;
          else {
            // Google runs last and only fills gaps — genres here are the
            // coarse BISAC categories, weaker than HC's crowd tags.
            result.genres = result.genres.length ? result.genres : g.genres;
            result.cover_url = result.cover_url || g.cover_url;
            result.page_count = result.page_count || g.page_count;
            result.published_year = result.published_year || g.published_year;
            result.author = result.author || g.author;
          }
        }
      } catch { /* Google quota/route down — OL base stands */ }
    }
    if (!result) return res.status(404).json({ error: 'No book found for that ISBN' });

    if (hardcoverEnabled() && !viaHc) {
      try {
        const hc = await hardcoverLookup(result.title, result.author, isbn);
        if (hc) {
          const series = pickSeries(hc, result.title);
          result.series_name = series?.name || null;
          result.series_order = series?.order ?? null;
          result.genres = genresFrom(hc).length ? genresFrom(hc) : result.genres;
          result.moods = moodsFrom(hc);
        }
      } catch { /* local metadata is fine without HC */ }
    }

    // Already on the shelf? Same match rules the /search hider uses.
    const uid = currentUserId();
    const bySource = db.prepare('SELECT id FROM books WHERE user_id=? AND source_provider=? AND source_id=?')
      .get(uid, result.provider, result.source_id);
    const byTitle = db.prepare('SELECT author FROM books WHERE user_id=? AND lower(title)=lower(?)')
      .all(uid, result.title)
      .some((c) => normTitle(c.author) === normTitle(result.author));
    result.owned = Boolean(bySource || byTitle);
    res.json({ result });
  } catch (err) {
    next(err);
  }
});

// "More info" for a Log-a-book search/scan result in the confirm panel: the
// same shared book-info payload the recommendation cards use (paced HC call,
// 24h cache). Only Hardcover-sourced results (numeric source id) can fetch a
// description; other providers fall back to title+author search links
// client-side.
r.get('/books/hardcover-info/:id', async (req, res, next) => {
  try {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : null;
    const data = id ? await bookInfo(id) : null;
    res.json({ hardcover_id: id, ...(data || {}) });
  } catch (err) {
    next(err);
  }
});

r.get('/books', (req, res) => {  const uid = currentUserId();
  const { query = '', tier = '', format = '', tag = '' } = req.query;
  const rows = db
    .prepare(`SELECT b.*,
      (SELECT e.rating FROM events e WHERE e.book_id=b.id AND e.rating IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS rating,
      (SELECT e.format FROM events e WHERE e.book_id=b.id ORDER BY e.id DESC LIMIT 1) AS last_format,
      (SELECT e.status FROM events e WHERE e.book_id=b.id ORDER BY e.id DESC LIMIT 1) AS last_status,
      (SELECT COUNT(*) FROM events e WHERE e.book_id=b.id) AS event_count,
      (SELECT MAX(COALESCE(e.finished_at, CAST(e.finished_year AS TEXT))) FROM events e WHERE e.book_id=b.id) AS last_finished,
      (SELECT COUNT(*) FROM tbr t WHERE t.book_id=b.id AND t.status='queued') AS in_tbr
      FROM books b WHERE b.user_id=?
      ORDER BY b.created_at DESC, b.id DESC`)
    .all(uid);
  const books = rows.map(parseBook);
  // Whole-library count for the library's "Needs re-pull" toggle label; the
  // filtering itself happens client-side, like the label filters.
  const needs_refresh_count = books.filter((b) => b.needs_refresh).length;
  let shown = books;
  if (query) {
    const q = String(query).toLowerCase();
    shown = shown.filter((b) =>
      `${b.title} ${b.author || ''} ${b.series_name || ''} ${(b.tags || []).join(' ')}`.toLowerCase().includes(q));
  }
  if (tag) shown = shown.filter((b) => (b.tags || []).includes(String(tag)));
  if (tier === 'unrated') shown = shown.filter((b) => !b.rating && !b.in_tbr && !b.on_pause);
  else if (tier === 'tbr') shown = shown.filter((b) => b.in_tbr);
  else if (tier === 'paused') shown = shown.filter((b) => b.on_pause);
  else if (tier) shown = shown.filter((b) => b.rating === tier);
  if (format) shown = shown.filter((b) => b.last_format === format);
  res.json({ books: shown, needs_refresh_count });
});

r.get('/books/:id', (req, res) => {
  const uid = currentUserId();
  const book = db.prepare('SELECT * FROM books WHERE id=? AND user_id=?').get(req.params.id, uid);
  if (!book) return res.status(404).json({ error: 'not found' });
  const events = db
    .prepare('SELECT * FROM events WHERE book_id=? AND user_id=? ORDER BY id DESC')
    .all(req.params.id, uid);
  const in_tbr = !!db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'")
    .get(uid, book.id);
  res.json({ book: { ...parseBook(book), in_tbr }, events });
});

const BOOK_FIELDS = ['title', 'author', 'narrator', 'series_name', 'series_order', 'page_count',
  'genres', 'moods', 'tags', 'cover_url', 'published_year', 'audio_runtime_minutes', 'on_pause',
  'hardcover_excluded'];

// PUT is member-facing and the books table is not STRICT, so validate here —
// POST already does, and an unvalidated PUT could null out NOT NULL title or
// store "abc" as a page count.
const TEXT_CAPS = { title: 500, author: 300, narrator: 300, series_name: 300, cover_url: 2000 };
const INT_RANGES = {
  series_order: [0, 10000],
  page_count: [0, 100000],
  published_year: [-2000, 2100],
  audio_runtime_minutes: [0, 100000],
};

r.put('/books/:id', (req, res) => {
  const uid = currentUserId();
  const book = db.prepare('SELECT * FROM books WHERE id=? AND user_id=?').get(req.params.id, uid);
  if (!book) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if ('title' in b) {
    b.title = String(b.title ?? '').trim();
    if (!b.title) throw bad('title required');
  }
  for (const [f, cap] of Object.entries(TEXT_CAPS)) {
    if (f in b && b[f] != null && String(b[f]).length > cap) throw bad(`${f} too long (max ${cap})`);
  }
  for (const [f, [min, max]] of Object.entries(INT_RANGES)) {
    if (!(f in b) || b[f] === '' || b[f] === null) continue;
    const n = Number(b[f]);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${f} must be an integer ${min}-${max}`);
    b[f] = n;
  }
  if ('on_pause' in b) b.on_pause = b.on_pause ? 1 : 0; // boolean-ish in, 0/1 stored
  if ('hardcover_excluded' in b) b.hardcover_excluded = b.hardcover_excluded ? 1 : 0;
  const sets = [], vals = [];
  for (const f of BOOK_FIELDS) {
    if (f in b) {
      if (f === 'genres' || f === 'moods' || f === 'tags') sets.push(`${f}=?`), vals.push(JSON.stringify(normTags(b[f] || [])));
      else sets.push(`${f}=?`), vals.push(b[f] === '' ? null : b[f]);
    }
  }
  if (sets.length) {
    vals.push(book.id);
    db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id=?`).run(...vals);
  }
  res.json({ book: parseBook(db.prepare('SELECT * FROM books WHERE id=?').get(book.id)) });
});

r.delete('/books/:id', (req, res) => {
  const uid = currentUserId();
  const info = db.prepare('DELETE FROM books WHERE id=? AND user_id=?').run(req.params.id, uid);
  res.json({ deleted: info.changes > 0 });
});

// Bulk read-date fixup: library imports stamp the import day onto books that
// were actually finished long before, and the real dates are gone. Two modes:
// no year → the selected books' entries lose their dates entirely ("date
// unknown"); with a year → finished_at is dropped and finished_year set, so
// the entries land in that year's stats without claiming a day. Both keep the
// entries themselves (ratings, formats, all-time counts) and only ever touch
// finished/DNF entries on the caller's own books — open 'reading' events have
// no finish date, and no entries are created.
r.post('/books/read-dates-set', (req, res) => {
  const uid = currentUserId();
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : [])
    .map((n) => +n).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5000);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  let year = null;
  if (b.year !== undefined && b.year !== null && b.year !== '') {
    year = +b.year;
    // Same rule cleanEvent enforces on single-entry edits, so a bulk-set year
    // can never be rejected by a later edit of the same entry.
    if (!Number.isInteger(year) || year <= 1900 || year > 2100) {
      return res.status(400).json({ error: 'year must be a 4-digit year (1901-2100)' });
    }
  }
  const owned = db.prepare(`SELECT id FROM books WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(uid, ...ids).map((x) => x.id);
  if (!owned.length) return res.json({ books: 0, events: 0, year });
  const bookPh = owned.map(() => '?').join(',');
  let info;
  if (year === null) {
    // Only entries actually carrying a date change — keeps the returned count
    // honest for the toast (already-unknown entries are no-ops, not changes).
    info = db.prepare(`UPDATE events SET finished_at=NULL, finished_year=NULL
      WHERE user_id=? AND book_id IN (${bookPh})
        AND (finished_at IS NOT NULL OR finished_year IS NOT NULL)`)
      .run(uid, ...owned);
  } else {
    // Year mode must catch entries with NO date at all — e.g. books blanked by
    // an earlier "date unknown" pass — which a has-a-date filter would skip.
    info = db.prepare(`UPDATE events SET finished_at=NULL, finished_year=?
      WHERE user_id=? AND book_id IN (${bookPh}) AND status IN ('finished','dnf')`)
      .run(year, uid, ...owned);
  }
  res.json({ books: owned.length, events: info.changes, year });
});

// Bulk "mark as read" — the member-shelf ✅ Read button, batched. Books that
// already carry a finished entry are skipped (same guard the single-book flow
// applies), an open 'reading' entry closes in place (keeping its format and
// start date), and everything else gets a minimal finished entry dated today
// — dates stay fixable afterwards with the read-dates tools above. TBR rows
// drain and pauses clear, exactly like the single-book quick status.
r.post('/books/mark-read', (req, res) => {
  const uid = currentUserId();
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : [])
    .map((n) => +n).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 5000);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const owned = db.prepare(`SELECT * FROM books WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`)
    .all(uid, ...ids);
  const today = localToday();
  const hasFinished = db.prepare("SELECT id FROM events WHERE book_id=? AND user_id=? AND status='finished' LIMIT 1");
  const openReading = db.prepare("SELECT id FROM events WHERE book_id=? AND user_id=? AND status='reading' ORDER BY id DESC");
  const closeReading = db.prepare("UPDATE events SET status='finished', percent=NULL, finished_at=COALESCE(finished_at, ?) WHERE id=?");
  const lastFormat = db.prepare('SELECT format FROM events WHERE book_id=? ORDER BY id DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO events (user_id, book_id, format, status, finished_at) VALUES (?,?,?,?,?)');
  const drainTbr = db.prepare("UPDATE tbr SET status='done' WHERE user_id=? AND book_id=? AND status='queued'");
  let created = 0, closed = 0, skipped = 0;
  db.exec('BEGIN');
  try {
    for (const book of owned) {
      if (hasFinished.get(book.id, uid)) { skipped++; continue; }
      const open = openReading.all(book.id, uid);
      if (open.length) {
        for (const ev of open) closeReading.run(today, ev.id);
        closed++;
      } else {
        const last = lastFormat.get(book.id);
        const format = last?.format || (book.audio_runtime_minutes && !book.page_count ? 'listened' : 'read');
        insert.run(uid, book.id, format, 'finished', today);
        created++;
      }
      drainTbr.run(uid, book.id);
      db.prepare('UPDATE books SET on_pause=0 WHERE id=?').run(book.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ books: owned.length, created, closed, skipped });
});

// ---------- tbr queue ----------

r.get('/tbr', (req, res) => {
  const uid = currentUserId();
  const entries = db
    .prepare(`SELECT t.book_id, t.source, t.is_next_up, t.added_at,
        b.title, b.author, b.series_name, b.series_order, b.cover_url, b.audio_runtime_minutes, b.moods
      FROM tbr t JOIN books b ON b.id = t.book_id
      WHERE t.user_id=? AND t.status='queued'
      ORDER BY t.is_next_up DESC, t.added_at DESC`)
    .all(uid);
  res.json({ entries: entries.map((e) => ({ ...e, moods: parseJsonArr(e.moods) })) });
});

r.post('/tbr', (req, res) => {
  const uid = currentUserId();
  const body = req.body || {};
  const book = db.prepare('SELECT id FROM books WHERE id=? AND user_id=?').get(body.book_id, uid);
  if (!book) return res.status(404).json({ error: 'book not found' });
  // TBR means "queued for later": close any open 'reading' events so the book
  // stops showing as in progress. Deleting loses nothing — an open event has
  // no stats weight, and a real restart logs a fresh one.
  db.prepare("DELETE FROM events WHERE user_id=? AND book_id=? AND status='reading'")
    .run(uid, book.id);
  const existing = db.prepare("SELECT * FROM tbr WHERE user_id=? AND book_id=? AND status='queued'")
    .get(uid, book.id);
  if (existing) return res.json({ entry: existing, existed: true });
  const info = db.prepare('INSERT INTO tbr (user_id, book_id, source) VALUES (?,?,?)')
    .run(uid, book.id, body.source || null);
  res.json({ entry: db.prepare('SELECT * FROM tbr WHERE id=?').get(info.lastInsertRowid) });
});

r.post('/tbr/next-up', (req, res) => {
  const uid = currentUserId();
  const row = db.prepare("SELECT id, is_next_up FROM tbr WHERE user_id=? AND book_id=? AND status='queued'")
    .get(uid, req.body?.book_id);
  if (!row) return res.status(404).json({ error: 'not in tbr' });
  const next = row.is_next_up ? 0 : 1;
  if (next) db.prepare('UPDATE tbr SET is_next_up=0 WHERE user_id=?').run(uid); // only one next up
  db.prepare('UPDATE tbr SET is_next_up=? WHERE id=?').run(next, row.id);
  res.json({ is_next_up: next });
});

r.delete('/tbr/book/:bookId', (req, res) => {
  const uid = currentUserId();
  const info = db.prepare('DELETE FROM tbr WHERE user_id=? AND book_id=?').run(uid, req.params.bookId);
  res.json({ deleted: info.changes > 0 });
});

// ---------- kobo import ----------

const uploadsDir = path.join(config.root, 'data', 'uploads');

// Raw-bytes upload of KoboReader.sqlite (the client sends the file body as-is).
// Stored per user so "keep this device linked" can re-read the credentials
// from THIS upload without racing another member's upload.
r.post('/kobo/parse', raw({ type: 'application/octet-stream', limit: '300mb' }), (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'empty upload' });
    mkdirSync(uploadsDir, { recursive: true });
    const dbPath = path.join(uploadsDir, `kobo-${currentUserId()}-last.sqlite`);
    writeFileSync(dbPath, req.body);
    const parsed = parseKoboDb(dbPath);
    // The same file usually carries the device's cloud credentials — their
    // presence is what makes the "keep linked" offer possible.
    let device_link_available = false;
    try { extractKoboDeviceLink(dbPath); device_link_available = true; } catch { /* no creds */ }
    res.json({ ...parsed, device_link_available });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- kobo device link (pull reading state from Kobo's cloud) ----------

const koboUpload = () => path.join(uploadsDir, `kobo-${currentUserId()}-last.sqlite`);

r.get('/kobo/link', (req, res) => {
  const link = db.prepare('SELECT api_endpoint, kobo_user_id, last_synced_at, last_error FROM kobo_links WHERE user_id=?')
    .get(currentUserId());
  res.json({ link: link || null });
});

// Opt in: store the device credentials from the most recent upload. The key
// never round-trips to the client.
r.post('/kobo/link', (req, res) => {
  const uid = currentUserId();
  const file = koboUpload();
  if (!existsSync(file)) return res.status(400).json({ error: 'upload a KoboReader.sqlite first' });
  let creds;
  try {
    creds = extractKoboDeviceLink(file);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  db.prepare(`
    INSERT INTO kobo_links (user_id, api_endpoint, user_key, kobo_user_id)
    VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET api_endpoint=excluded.api_endpoint,
      user_key=excluded.user_key, kobo_user_id=excluded.kobo_user_id,
      last_error=NULL`)
    .run(uid, creds.api_endpoint, creds.user_key, creds.kobo_user_id);
  res.json({ linked: true, api_endpoint: creds.api_endpoint, kobo_user_id: creds.kobo_user_id });
});

r.delete('/kobo/link', (req, res) => {
  const info = db.prepare('DELETE FROM kobo_links WHERE user_id=?').run(currentUserId());
  res.json({ unlinked: info.changes > 0 });
});

// Manual sync — runs as a pollable job (Hardcover matching paces ~400ms/book).
r.post('/kobo/sync', (req, res) => {
  const id = createJob(currentUserId(), 'kobo_sync', {});
  res.json({ id });
});

// ---------- per-member Audiobookshelf link (listening-progress sync) ----------

// Each member links their own ABS server + API token + library (Account →
// Audiobookshelf). A sync folds ABS's mediaProgresses into their events:
// part-way listens become/refresh an open reading event with the percent,
// finishes become a finished listen dated to ABS's lastUpdate. The token is
// stored server-side only and never round-trips to the client.
r.get('/abs/link', (req, res) => {
  res.json({ link: getAbsLink(currentUserId()) });
});

// Boot-time sync notice: just the last-sync timestamp for the signed-in
// member, so the client can toast "synced while you were away" once per
// unseen sync. Deliberately bare — the full link payload isn't needed here.
r.get('/abs/notice', (req, res) => {
  const link = getAbsLink(currentUserId());
  res.json({ last_synced_at: link?.last_synced_at || null });
});

r.post('/abs/validate', async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await validateAbs(String(b.server_url || '').trim(), String(b.api_token || '').trim()));
  } catch (err) { next(err); }
});

r.post('/abs/link', async (req, res, next) => {
  try {
    res.json(await linkAbs(currentUserId(), req.body || {}));
  } catch (err) { next(err); }
});

r.delete('/abs/link', (req, res) => {
  res.json({ unlinked: unlinkAbs(currentUserId()) > 0 });
});

// Manual sync — pollable job, same as the Kobo sync.
r.post('/abs/sync', (req, res) => {
  res.json({ id: createJob(currentUserId(), 'abs_sync', {}) });
});

r.post('/kobo/import', async (req, res, next) => {
  try {
    // Kept for small imports + the smoke test; the UI uses the pollable job
    // (POST /api/jobs, kind kobo_import) so big libraries get progress.
    const result = await runLibraryImport({
      provider: 'kobo',
      hardcover: Boolean(req.body?.hardcover),
      rows: req.body?.rows || [],
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ---------- audible import (file-based, no credentials) ----------

// Audible has no first-party export; users bring CSV/JSON produced by helper
// apps (Libation, OpenAudible, Audible Library Extractor, audible-cli, or
// Amazon's "Request My Data" archive). We parse defensively and never see
// their Amazon login.
r.post('/audible/parse', raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'empty upload' });
    // Libation also exports xlsx (a zip container) — read it as a table and
    // share the CSV's alias-matching tail.
    const parsed = isZipFile(req.body)
      ? tableFromRows(xlsxToTable(req.body), 'xlsx')
      : parseAudibleExport(req.body.toString('utf8'));
    res.json(parsed);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

r.post('/goodreads/parse', raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'empty upload' });
    res.json({ books: parseGoodreads(req.body.toString('utf8')) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

r.post('/audible/import', async (req, res, next) => {
  try {
    const result = await runLibraryImport({
      provider: 'audible',
      hardcover: Boolean(req.body?.hardcover),
      rows: req.body?.rows || [],
    });
    res.json(result);
  } catch (err) { next(err); }
});

// Re-pull a book's objective metadata from Hardcover (series, genres, year,
// lengths, cover). Series/genres/year are overwritten, lengths fill gaps, and
// the cover IS replaced — an explicit re-pull on one book means "this data is
// wrong, fix it". Never touches title/author/tags/tiers. Books with no
// Hardcover profile (hardcover_excluded) skip the HC lookup entirely and fall
// straight through to Google Books, which fills only what's missing.
// HC-matched books whose HC entry lacks lengths also get the Google fallback —
// otherwise a matched book with no lengths anywhere could never clear the
// needs-re-pull flag. Every attempt stamps the book either way.
r.post('/books/:id/refresh', async (req, res, next) => {
  try {
    const uid = currentUserId();
    const book = db.prepare('SELECT * FROM books WHERE id=? AND user_id=?').get(req.params.id, uid);
    if (!book) return res.status(404).json({ error: 'book not found' });
    let result = { matched: false, changed: [] };
    let fallback_changed = [];
    if (!book.hardcover_excluded) {
      result = await refreshBookMetadata(book, { overwriteCover: true });
      if (result.matched) {
        const fresh = db.prepare('SELECT * FROM books WHERE id=?').get(book.id);
        if (!fresh.page_count && !fresh.audio_runtime_minutes) {
          fallback_changed = await googleFallbackFill(fresh);
        }
      } else {
        fallback_changed = await googleFallbackFill(book);
      }
      stampRefreshed(book.id);
    } else {
      // Excluded books short-circuit without a HC attempt and stay unstamped:
      // if one is ever un-excluded, the badge comes back until a real
      // re-pull runs.
      fallback_changed = await googleFallbackFill(book);
    }
    res.json({ ...result, excluded: !!book.hardcover_excluded, fallback_changed });
  } catch (err) { next(err); }
});

// ---------- series journey ----------

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('hardcover timeout')), ms);
  p.then(resolve, reject).finally(() => clearTimeout(timer));
});

// Roster lookup: global cache holding ALL same-named series (HC has many:
// "Witness" = Erikson's trilogy AND Rebecca Forster's legal thrillers).
// Non-empty rosters hold for 7 days; EMPTY ones only for a day. An empty
// candidate list is almost always Hardcover flakiness, not truth — phantom
// same-named rows crowding the real series out of the fetch window — and
// serving it as fresh blanked the card into a false "you're up to date" for
// the whole week (The Wheel of Time, Harry Potter, Malazan all hit this).
// A cold or expired cache fetches HC with a time budget and falls back to a
// stale entry (or null = unknown) so the dashboard never blocks on
// Hardcover. Failures are NEVER cached — they return null untouched. An
// empty refetch likewise never overwrites a good stale roster: genuine
// absence gets written only when there is nothing better to serve.
// Old cache entries hold a single roster array; they normalize to one
// candidate.
async function seriesRosterCached(name) {
  // Curly and straight apostrophes name the same series ("Hoid's") — the
  // journey title link already collapses them, the cache key must too.
  const key = name.toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim();
  const normalize = (parsed) => {
    if (!Array.isArray(parsed) || !parsed.length) return [];
    return Array.isArray(parsed[0]?.roster) ? parsed
      : [{ id: null, name, roster: parsed.filter((r) => r && Number.isFinite(r.position)) }];
  };
  const loadCached = (expiredOk = false) => {
    const row = db.prepare('SELECT books, fetched_at FROM series_cache WHERE series_key=?').get(key);
    if (!row) return null;
    let parsed;
    try { parsed = normalize(JSON.parse(row.books)); } catch { return null; } // corrupt row = refetch
    const days = parsed.length ? 7 : 1;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    return row.fetched_at > cutoff ? parsed : (expiredOk ? parsed : null);
  };
  const cached = loadCached();
  if (cached) return cached;
  const stale = loadCached(true); // expired entry, still useful if HC is down
  try {
    const rosters = await withTimeout(seriesRosters(name), 8000);
    // null = the HC lookup FAILED; [] = HC genuinely has no such series —
    // but a phantom-window miss returns [] too, so never let an empty
    // refetch clobber a roster we already have.
    if (rosters === null) return stale;
    if (!rosters.length) return stale && stale.length ? stale : [];
    db.prepare(`INSERT INTO series_cache (series_key, books) VALUES (?,?)
      ON CONFLICT(series_key) DO UPDATE SET books=excluded.books, fetched_at=datetime('now')`)
      .run(key, JSON.stringify(rosters));
    return rosters;
  } catch (err) {
    console.warn(`[series/journey] roster "${name}" failed: ${err.message}`);
    return stale;
  }
}

// "You're 4 of 6 in Red Rising Saga — next: Dark Age." The member's most
// recently FINISHED series first: recency = the latest finish DATE in the
// series (finished_at, or finished_year for year-only entries) — not the
// order books were added. The roster becomes a LADDER of slots — noise and
// unreleased entries out, duplicate-position translations collapsed by
// readers count, whole-number positions plus HC's half-step novellas kept,
// everything finer (split volumes, prologue ebooks, prequels) out by
// arithmetic alone, trimmed at the first gap — and both card numbers are
// slots: "7 of 9" means 7 of the ladder's rungs are finished (matched by the
// member's own book ids/positions, never by roster authorship — HC credits
// translators/illustrators/ghostwriters there, so those strings are only
// trusted for choosing WHICH same-named series is yours).
// Standalone one-book "series" and series with nothing finished are excluded.
// 5 by default, ?limit=all for up to 25 — the dashboard shows 5 and expands
// on demand. current = slots finished; next = first rung neither finished
// nor already owned.
r.get('/series/journey', async (req, res, next) => {
  try {
    const uid = currentUserId();
    const limit = req.query.limit === 'all' ? 25
      : Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 25);
    const owned = db.prepare(`
      SELECT b.id, b.series_name, b.series_order, b.hardcover_id, b.author, b.title,
        EXISTS(SELECT 1 FROM events e WHERE e.book_id=b.id AND e.status='finished') AS finished
      FROM books b
      WHERE b.user_id=? AND b.series_name IS NOT NULL AND b.series_name != ''`).all(uid);
    if (!owned.length) return res.json({ series: [], total_series: 0 });

    // Latest finish date per series, computed in JS: finished_at text dates
    // and year-only entries sort on the same YYYY-MM-DD key. Series whose
    // finishes are all undated (Kobo/Audible rows with no device date, ABS
    // stale-marked entries) still count — they anchor to insertion order,
    // which always sorts below any real date.
    const finishRows = db.prepare(`
      SELECT b.series_name AS name, e.finished_at, e.finished_year, e.rowid AS rid
      FROM books b JOIN events e ON e.book_id = b.id
      WHERE b.user_id=? AND b.series_name IS NOT NULL AND b.series_name != ''
        AND e.status='finished'`).all(uid);
    const recency = new Map();
    const recencyRowFallback = new Map();
    for (const r of finishRows) {
      const d = r.finished_at || (r.finished_year ? `${r.finished_year}-01-01` : null);
      if (!d) {
        if (!recencyRowFallback.has(r.name) || r.rid > recencyRowFallback.get(r.name)) {
          recencyRowFallback.set(r.name, r.rid);
        }
        continue;
      }
      if (!recency.has(r.name) || d > recency.get(r.name)) recency.set(r.name, d);
    }
    // Zero-pad the rowid so it compares lexicographically below real dates.
    for (const [name, rid] of recencyRowFallback) {
      if (!recency.has(name)) recency.set(name, `0000-${String(rid).padStart(10, '0')}`);
    }

    const groups = new Map();
    for (const b of owned) {
      if (!groups.has(b.series_name)) groups.set(b.series_name, []);
      groups.get(b.series_name).push(b);
    }
    // Journey-worthy = you've FINISHED at least two of its books (a
    // standalone tagged as a series — one To Kill a Mockingbird — is not a
    // journey; an unfinished shelf isn't "recently read").
    const eligible = [...groups.entries()]
      .filter(([name, rows]) => rows.filter((r) => r.finished).length >= 2 && recency.has(name))
      .sort((a, b) => String(recency.get(b[0])).localeCompare(String(recency.get(a[0]))));
    const top = eligible.slice(0, limit);

    const out = [];
    for (const [name, rows] of top) {
      // Disambiguate same-named series by the member's own shelf: a series
      // roster scores +2 per member hardcover_id it contains and +1 per
      // entry by one of the member's authors in this series. Zero across the
      // board means none of HC's same-named series is actually THIS member's
      // series (Witness/Forster vs Erikson, Generations/Marvel vs Salvatore)
      // — better no roster than the wrong one.
      const candidates = (await seriesRosterCached(name)) || [];
      const myAuthors = new Set(rows.map((r) => r.author).filter(Boolean).map(normTitle));
      const myIds = new Set(rows.map((r) => r.hardcover_id).filter(Boolean));
      // Containment, not exact equality: roster entries credit every author,
      // joined ("Brandon Sanderson, Robert Jordan"), and the member's shelf
      // names just one of them.
      const authorOk = (entryAuthor) => {
        const na = normTitle(entryAuthor);
        return [...myAuthors].some((m) => m && na.includes(m));
      };
      // A mistyped manual series name ("The Whell of Time") must not adopt
      // an unrelated franchise on author-points alone: author scoring only
      // counts when the candidate's titles overlap the member's own titles
      // (or the series name's own tokens land in the roster), so a shared
      // byline can't drag in a series the member owns nothing of.
      const myTitleTokens = new Set(rows.flatMap((b) => normTitle(b.title || '').split(' ').filter((w) => w.length >= 3)));
      const sharesTitleTokens = (c) => {
        if (!myTitleTokens.size) return false;
        for (const r of c.roster) {
          for (const t of normTitle(r.title).split(' ')) {
            if (t.length >= 3 && myTitleTokens.has(t)) return true;
          }
        }
        return false;
      };
      let best = null;
      let bestScore = 0;
      for (const c of candidates) {
        let score = 0;
        let idScore = 0;
        let authorScore = 0;
        for (const r of c.roster) {
          if (myIds.has(r.hardcover_id)) idScore += 2;
          else if (r.author && authorOk(r.author)) authorScore += 1;
        }
        // Id hits prove the franchise; author-only hits need the titles to
        // agree too, otherwise a same-authored-but-unrelated series adopts
        // the member's card.
        if (idScore > 0) score = idScore + authorScore;
        else if (authorScore > 0 && sharesTitleTokens(c)) score = authorScore;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      const rosterRaw = best?.roster || [];
      // Same noise rule the search toggle uses (plus Untitled placeholders),
      // and keep only released entries. NO per-entry author gate: HC credits
      // translators, narrators, illustrators and ghostwriters — sometimes as
      // the ONLY name on the entry ("Ken Liu" on Death's End, "Joel
      // Martinsen" on The Dark Forest, "Howard Lyon" on Tress) — so every
      // author-based eviction punched a silent hole in a real ladder, and a
      // holed ladder rendered as a false "you're up to date". Which series
      // this IS was already settled above, by scoring the member's own
      // ids/authors against each same-named candidate.
      const releasedOnly = (r) => !r.release_year || r.release_year <= new Date().getFullYear();
      const cleaned = rosterRaw.filter((r) => Number.isFinite(r.position)
        && !isNoiseTitle(r.title) && releasedOnly(r));
      const normT = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const variants = new Set();
      for (const a of cleaned) {
        for (const b of cleaned) {
          if (a === b) continue;
          const na = normT(a.title);
          const nb = normT(b.title);
          if (na.length > nb.length + 3 && nb.length >= 10 && na.includes(nb)) variants.add(a);
        }
      }
      const byPosition = new Map();
      for (const r of cleaned) {
        if (variants.has(r)) continue;
        // Translations share the position with the original ("Het Oog van de
        // Wereld" vs "The Eye of the World") — readers count decides, the
        // canonical edition wins. Entries from old cache rows carry no
        // users_count; first-seen stands for those.
        const prev = byPosition.get(r.position);
        if (!prev || (r.users_count || 0) > (prev.users_count || 0)) byPosition.set(r.position, r);
      }
      const all = [...byPosition.values()].sort((a, b) => a.position - b.position);
      // A slot is a BOOK, not a fraction of one. HC's numbering is a
      // convention: whole numbers are the mainline novels, the half steps
      // between them are real novellas (2.5 Edgedancer, 3.5 Dawnshard, 4.5
      // Horneater), and everything finer is an EDITION of a neighboring
      // novel, not another rung — "A Storm of Swords, Part 2" at 3.2, French
      // volume splits at 3.3/3.4, dramatized-audio parts at 1.1–1.5,
      // prologue ebooks at 12.9. Position 0 and below #1 hold prequels and
      // companions ("New Spring", "The Hedge Knight"). Those all stay out,
      // in every language, by arithmetic alone.
      const slots = all.filter((r) => r.position >= 1
        && (Number.isInteger(r.position) || r.position % 1 === 0.5));
      let roster = slots.length ? slots : all.filter((r) => r.position > 0);
      // Trim after the first gap: foreign publishers sneak their own
      // numbering into the same HC series list (a Swedish Towers of Midnight
      // sits at position 28 in The Wheel of Time), and a ladder with a hole
      // at 15 reads "3 of 17" for a 14-book series. The head survives even
      // when a sub-arc legitimately starts above 1.
      if (roster.length > 1) {
        const end = roster.findIndex((r, i) => i > 0 && r.position - roster[i - 1].position > 1);
        if (end !== -1) roster = roster.slice(0, end);
      }

      const finishedRows = rows.filter((r) => r.finished);
      // "X of Y" counts SLOTS finished, not the highest position reached:
      // someone with five novels AND both novellas finished stood at "5 of
      // 9" while having read 7 of the 9 rungs. A slot is done when a
      // finished shelf book lands on it by hardcover id or series position —
      // the member's own data, no metadata trust involved.
      // A book's id and order can disagree (manual typo, alternate-edition
      // numbering, translator splits) — the id wins, unless the book's own
      // title shares at least two tokens with the order-pointed slot's
      // title, in which case the order wins (cheap, language-independent;
      // "The Eye of the World" vs "Het Oog van de Wereld" correctly does
      // NOT tie-break, so id/order still decide alone there).
      const slotById = new Map();
      for (const r of roster) slotById.set(r.hardcover_id, r.position);
      const orderTokens = (t) => new Set(normT(t).split(' ').filter((w) => w.length >= 2));
      const done = new Set();
      for (const b of finishedRows) {
        const idSlot = b.hardcover_id ? slotById.get(b.hardcover_id) : undefined;
        const order = b.series_order === null ? null : Number(b.series_order);
        const orderSlot = (order !== null && Number.isFinite(order)
          && roster.some((r) => r.position === order)) ? order : null;
        if (idSlot !== undefined && orderSlot !== null && idSlot !== orderSlot) {
          const orderTitle = roster.find((r) => r.position === orderSlot)?.title || '';
          const bt = orderTokens(b.title);
          const shared = orderTokens(orderTitle).size
            ? [...orderTokens(orderTitle)].filter((w) => bt.has(w)).length : 0;
          done.add(shared >= 2 ? orderSlot : idSlot);
        } else if (idSlot !== undefined) {
          done.add(idSlot);
        } else if (orderSlot !== null) {
          done.add(orderSlot);
        }
      }
      const current = done.size;
      // "Next" is the first rung that is neither finished nor already on the
      // member's shelf (owned-but-unfinished editions — DNFs, re-reads
      // queued, mid-read — shouldn't be recommended either). First-finished
      // order, not "position > current": a skipped 2.5 novella is the right
      // next read even after book 3.
      const ownedIds = new Set(rows.map((r) => r.hardcover_id).filter(Boolean));
      const ownedTitles = new Set(rows.map((r) => normTitle(r.title)));
      const next = roster.find((r) => !done.has(r.position)
        && !ownedIds.has(r.hardcover_id) && !ownedTitles.has(normTitle(r.title))) || null;
      // A roster can't be shorter than what the member already finished —
      // partial HC listings must never render "3 of 1".
      const total = roster.length ? Math.max(roster.length, current) : null;
      out.push({
        name,
        finished_count: finishedRows.length,
        total,
        current,
        // The only thing that stops an unfinished slot from being "next" is
        // the member owning it — worth its own state, or the card claims
        // "up to date" over an unread book on their shelf.
        owned_next: next === null && total !== null && current < total,
        next: next ? {
          title: next.title,
          // Prefer the member's own author spelling over HC's joined credits
          // ("Howard Lyon, Brandon Sanderson" on Tress) — display only.
          author: rows.map((b) => b.author).filter(Boolean)
            .find((a) => normTitle(next.author || '').includes(normTitle(a))) || next.author,
          hardcover_id: next.hardcover_id, position: next.position,
        } : null,
      });
    }
    res.json({ series: out, total_series: eligible.length });
  } catch (err) { next(err); }
});

// ---------- reading streaks ----------

// Consecutive-day streak for the signed-in member: any logged entry or
// progress touch counts as a day. current survives until a day truly ends
// (yesterday's anchor); best is the longest run ever.
r.get('/streaks', (req, res) => {
  res.json(readingStreak(currentUserId()));
});

// ---------- events ----------

function cleanEvent(e, { partial = false } = {}) {
  const out = {};
  const check = (cond, field) => { if (!cond) throw bad(`invalid ${field}`); };

  if (!partial || 'format' in e) { check(FORMATS.includes(e.format), 'format'); out.format = e.format; }
  if (!partial || 'status' in e) {
    const s = e.status || 'finished';
    check(STATUSES.includes(s), 'status'); out.status = s;
  }
  if ('rating' in e) { check(!e.rating || TIERS.includes(e.rating), 'rating'); out.rating = e.rating || null; }
  if ('narration_rating' in e) { check(!e.narration_rating || TIERS.includes(e.narration_rating), 'narration_rating'); out.narration_rating = e.narration_rating || null; }
  if ('dnf_percent' in e) {
    if (e.dnf_percent === null || e.dnf_percent === '') out.dnf_percent = null;
    else { check(Number.isInteger(+e.dnf_percent) && +e.dnf_percent >= 1 && +e.dnf_percent <= 99, 'dnf_percent'); out.dnf_percent = +e.dnf_percent; }
  }
  const dateOk = (d) => !d || /^\d{4}-\d{2}-\d{2}/.test(d);
  if ('started_at' in e) { check(dateOk(e.started_at), 'started_at'); out.started_at = e.started_at || null; }
  if ('finished_at' in e) { check(dateOk(e.finished_at), 'finished_at'); out.finished_at = e.finished_at || null; }
  if ('finished_year' in e) {
    if (e.finished_year === null || e.finished_year === '') out.finished_year = null;
    else { check(Number.isInteger(+e.finished_year) && +e.finished_year > 1900 && +e.finished_year <= 2100, 'finished_year'); out.finished_year = +e.finished_year; }
  }
  if ('medium' in e) out.medium = e.medium || null;
  if ('notes' in e) out.notes = e.notes || null;
  return out;
}

r.post('/events', (req, res, next) => {
  try {
    const uid = currentUserId();
    const e = req.body || {};
    const book = db.prepare('SELECT * FROM books WHERE id=? AND user_id=?').get(e.book_id, uid);
    if (!book) throw bad('book not found');
    const c = cleanEvent(e);
    if (c.status === 'dnf' && !c.dnf_percent) c.dnf_percent = 50; // sane default
    const info = db
      .prepare(`INSERT INTO events
        (user_id, book_id, format, medium, status, dnf_percent, started_at, finished_at,
         finished_year, rating, narration_rating, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(uid, book.id, c.format, c.medium || null, c.status, c.dnf_percent || null,
        c.started_at || null, c.finished_at || null, c.finished_year || null,
        c.rating || null, c.narration_rating || null, c.notes || null);
    // TBR drains into the log: starting or finishing a queued book advances it.
    const queued = db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'")
      .get(uid, book.id);
    if (queued) {
      db.prepare('UPDATE tbr SET status=? WHERE id=?')
        .run(c.status === 'reading' ? 'started' : 'done', queued.id);
    }
    res.json({ event: db.prepare('SELECT * FROM events WHERE id=?').get(info.lastInsertRowid) });
  } catch (err) { next(err); }
});

const EVENT_FIELDS = ['format', 'medium', 'status', 'dnf_percent', 'started_at', 'finished_at',
  'finished_year', 'rating', 'narration_rating', 'notes'];

r.put('/events/:id', (req, res, next) => {
  try {
    const uid = currentUserId();
    const ev = db.prepare('SELECT * FROM events WHERE id=? AND user_id=?').get(req.params.id, uid);
    if (!ev) return res.status(404).json({ error: 'not found' });
    const c = cleanEvent(req.body || {}, { partial: true });
    // A real status change behaves like a fresh entry: hero progress belonged
    // to the old state, and a queued book advances.
    if ('status' in c && c.status !== ev.status) {
      c.percent = null;
      const queued = db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'")
        .get(uid, ev.book_id);
      if (queued) {
        db.prepare('UPDATE tbr SET status=? WHERE id=?')
          .run(c.status === 'reading' ? 'started' : 'done', queued.id);
      }
    }
    const sets = Object.keys(c).map((k) => `${k}=?`);
    const vals = [...Object.values(c), ev.id];
    if (sets.length) db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    // A percent edit through the modal is a progress touch — stamp the day
    // for streaks, same as the hero ±% buttons do.
    if ('percent' in c) {
      db.prepare("UPDATE events SET progress_at=datetime('now') WHERE id=?").run(ev.id);
    }
    res.json({ event: db.prepare('SELECT * FROM events WHERE id=?').get(ev.id) });
  } catch (err) { next(err); }
});

r.delete('/events/:id', (req, res) => {
  const uid = currentUserId();
  const info = db.prepare('DELETE FROM events WHERE id=? AND user_id=?').run(req.params.id, uid);
  res.json({ deleted: info.changes > 0 });
});

// Progress update from the now-reading hero: set where you are (1-99) in an
// open 'reading' event. Finishing/DNFing goes through quick-status, which
// closes the event in place.
r.post('/events/:id/progress', (req, res, next) => {
  try {
    const uid = currentUserId();
    const pct = Number(req.body?.percent);
    if (!Number.isInteger(pct) || pct < 1 || pct > 99) throw bad('percent must be an integer 1-99');
    const ev = db.prepare("SELECT id FROM events WHERE id=? AND user_id=? AND status='reading'")
      .get(req.params.id, uid);
    if (!ev) return res.status(404).json({ error: 'no open reading event for this user' });
    // progress_at stamps the day for streaks — minor progress counts too.
    db.prepare("UPDATE events SET percent=?, progress_at=datetime('now') WHERE id=?").run(pct, ev.id);
    res.json({ ok: true, percent: pct });
  } catch (err) { next(err); }
});

// Quick status (book modal buttons): set a book's current state without the
// full entry form. 'read' → event status 'finished'; 'reading' opens an open
// reading event (no-op if one is already open). An open 'reading' event is
// closed in place (keeping its format/medium); with none, a minimal event is
// created — format mirrors the book's last entry, date defaults to today.
r.post('/books/:id/quick-status', (req, res, next) => {
  try {
    const uid = currentUserId();
    const book = db.prepare('SELECT * FROM books WHERE id=? AND user_id=?').get(req.params.id, uid);
    if (!book) return res.status(404).json({ error: 'book not found' });
    const want = req.body?.status;
    if (!['read', 'dnf', 'reading'].includes(want)) throw bad('status must be "read", "dnf", or "reading"');
    const last = db.prepare('SELECT format FROM events WHERE book_id=? AND user_id=? ORDER BY id DESC LIMIT 1')
      .get(book.id, uid);
    const format = last?.format || (book.audio_runtime_minutes && !book.page_count ? 'listened' : 'read');

    if (want === 'reading') {
      const open = db.prepare("SELECT id FROM events WHERE book_id=? AND user_id=? AND status='reading'")
        .get(book.id, uid);
      if (!open) {
        // Started today — server-local date, same rule as finishes below.
        db.prepare("INSERT INTO events (user_id, book_id, format, status, started_at) VALUES (?,?,?,'reading',?)")
          .run(uid, book.id, format, localToday());
      }
    } else {
      // Same integer rule cleanEvent enforces — dnf_percent is rendered on other
      // members' pages, so free text (i.e. HTML) must never reach the column.
      let dnfPercent = 50;
      if (want === 'dnf' && req.body?.dnf_percent !== undefined && req.body?.dnf_percent !== null && req.body?.dnf_percent !== '') {
        if (!Number.isInteger(+req.body.dnf_percent) || +req.body.dnf_percent < 1 || +req.body.dnf_percent > 99) {
          throw bad('dnf_percent must be an integer 1-99');
        }
        dnfPercent = +req.body.dnf_percent;
      }
      const status = want === 'read' ? 'finished' : 'dnf';
      const dateOk = !req.body?.finished_at || /^\d{4}-\d{2}-\d{2}/.test(req.body.finished_at);
      if (!dateOk) throw bad('invalid finished_at');
      // "Today" is the server's LOCAL calendar date — UTC here would date
      // evening finishes tomorrow for the household's timezone.
      const finishedAt = req.body?.finished_at || localToday();

      const open = db.prepare("SELECT id FROM events WHERE book_id=? AND user_id=? AND status='reading' ORDER BY id DESC")
        .all(book.id, uid);
      for (const ev of open) {
        db.prepare("UPDATE events SET status=?, dnf_percent=?, percent=NULL, finished_at=COALESCE(finished_at, ?) WHERE id=?")
          .run(status, status === 'dnf' ? dnfPercent : null, finishedAt, ev.id);
      }
      if (!open.length) {
        db.prepare('INSERT INTO events (user_id, book_id, format, status, dnf_percent, finished_at) VALUES (?,?,?,?,?,?)')
          .run(uid, book.id, format, status, status === 'dnf' ? dnfPercent : null, finishedAt);
      }
    }
    // Any quick status drains the queue (starting → started, finishing → done)
    // and clears a pause, same as a full entry would.
    const queued = db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'")
      .get(uid, book.id);
    if (queued) db.prepare('UPDATE tbr SET status=? WHERE id=?').run(want === 'reading' ? 'started' : 'done', queued.id);
    db.prepare('UPDATE books SET on_pause=0 WHERE id=?').run(book.id);
    const events = db.prepare('SELECT * FROM events WHERE book_id=? AND user_id=? ORDER BY id DESC').all(book.id, uid);
    res.json({ book: parseBook(db.prepare('SELECT * FROM books WHERE id=?').get(book.id)), events });
  } catch (err) { next(err); }
});

export default r;
