// Metadata re-pull: bring a book's objective fields up to Hardcover's
// canonical copy. Series/genres/year are OVERWRITTEN (HC is the source of
// truth and the whole point of a re-pull); lengths stay fill-if-empty so
// corrected values survive; the cover follows overwriteCover — the bulk
// backfill keeps it fill-if-empty, while an explicit single-book re-pull
// sets it, because pressing the button on ONE book is deliberate intent
// ("this cover is wrong — replace it") and must actually replace it.
// title/author/tags/tiers/events are never touched. Degrades to
// {matched:false} on any HC failure — a re-pull must never 500 or mangle a book.
import { db } from '../db.js';
import { searchGoogleBooks } from '../metadata/google-books.js';
import { mapGenres } from '../genres-vocab.js';
import { parseJsonArr } from '../jsonarr.js';
import {
  hardcoverBookById, hardcoverLookup, pickSeries, genresFrom, moodsFrom, norm,
} from '../metadata/hardcover-import.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google Books genres for a book, strictly canonical (mapGenres drops
// unknowns and collapses breadcrumb variants). Null when Google has no
// agreeing hit or the call fails — callers must distinguish "checked, found
// nothing" (stamp synced) from "couldn't check" (leave for a retry).
async function googleGenresFor(book) {
  if (!book.title) return null;
  const q = `intitle:${book.title}${book.author ? ` inauthor:${book.author}` : ''}`;
  let hits;
  try {
    hits = await searchGoogleBooks(q);
  } catch (err) {
    console.warn(`[book-refresh] Google genres for "${book.title}" failed: ${err.message}`);
    return null;
  }
  const t = norm(book.title);
  const agrees = (s) => {
    const g = norm(s);
    return g === t || g.includes(t) || t.includes(g);
  };
  const hit = hits.find((h) => h.title && agrees(h.title));
  return hit ? mapGenres(hit.genres) : [];
}

// HC-first union: Hardcover's crowd-ranked genres lead, Google adds whatever
// they know that HC didn't, and the whole list stays inside the canonical
// vocabulary (mapGenres already dropped unknowns on both sides).
const unionGenres = (hcGenres, gbGenres) =>
  [...new Set([...hcGenres, ...(gbGenres || []).filter((g) => !hcGenres.includes(g))])].slice(0, 6);

export async function refreshBookMetadata(book, { overwriteCover = false } = {}) {
  let b = null;
  const knownId = book.hardcover_id
    ?? (book.source_provider === 'hardcover' ? Number(book.source_id) : null);
  try {
    if (knownId) b = await hardcoverBookById(knownId);
    if (!b) b = await hardcoverLookup(book.title, book.author);
  } catch (err) {
    console.warn(`[book-refresh] "${book.title}" lookup failed: ${err.message}`);
    return { matched: false, changed: [] };
  }
  if (!b) return { matched: false, changed: [] };
  const series = pickSeries(b, book.title);
  const hcGenres = genresFrom(b);
  // Cross-check with Google on every refresh: HC-first union, so books HC
  // tagged sparsely pick up what Google knows. A Google failure keeps the
  // HC-only list and leaves genres_synced_at for the background reconciler.
  const gbGenres = await googleGenresFor(book);
  const genres = unionGenres(hcGenres, gbGenres);
  const moods = moodsFrom(b);
  const set = {};
  const changed = [];
  // [column, hcValue, overwrite]
  const candidates = [
    ['series_name', series?.name || null, true],
    ['series_order', series?.order ?? null, true],
    ['published_year', b.release_year || null, true],
    ['page_count', b.pages || null, false],
    ['audio_runtime_minutes', b.audio_seconds ? Math.round(b.audio_seconds / 60) : null, false],
    ['cover_url', b.cached_image?.url || null, overwriteCover],
  ];
  for (const [column, value, overwrite] of candidates) {
    if (value === null || value === undefined || value === '') continue;
    if (!overwrite && book[column] !== null && book[column] !== undefined && book[column] !== '') continue;
    if (book[column] === value) continue;
    set[column] = value;
    changed.push(column);
  }
  if (genres.length && JSON.stringify(genres) !== (book.genres || '[]')) {
    set.genres = JSON.stringify(genres);
    changed.push('genres');
  }
  // The Google cross-check ran, so reconciliation happened — stamp it either
  // way, or the background reconciler redoes the same work later.
  if (gbGenres !== null) {
    set.genres_synced_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  if (moods.length && JSON.stringify(moods) !== (book.moods || '[]')) {
    set.moods = JSON.stringify(moods);
    changed.push('moods');
  }
  if (!book.hardcover_id && b.id) {
    set.hardcover_id = b.id;
    changed.push('hardcover_id');
  }
  if (Object.keys(set).length) {
    const assignments = Object.keys(set).map((c) => `${c}=?`).join(', ');
    db.prepare(`UPDATE books SET ${assignments} WHERE id=?`).run(...Object.values(set), book.id);
  }
  return { matched: true, changed };
}

// Google Books fallback: when Hardcover has no profile for a book (novellas,
// niche editions, "hardcover_excluded" picks), a re-pull can still fetch the
// missing cover, page count and year from Google. Strictly fill-if-empty —
// Google metadata is the second source here and must never overwrite anything
// the user (or HC) already provided. Requires a title agreement (normalized
// containment, same rule the HC matcher uses) so a same-ish title can't pull
// a stranger's data in; returns the changed columns, [] when nothing matched.
export async function googleFallbackFill(book) {
  const targets = ['cover_url', 'page_count', 'published_year']
    .filter((c) => book[c] === null || book[c] === undefined || book[c] === '');
  if (!targets.length || !book.title) return [];
  const q = `intitle:${book.title}${book.author ? ` inauthor:${book.author}` : ''}`;
  let hits;
  try {
    hits = await searchGoogleBooks(q);
  } catch (err) {
    console.warn(`[book-refresh] Google fallback for "${book.title}" failed: ${err.message}`);
    return [];
  }
  const t = norm(book.title);
  const agrees = (s) => {
    const g = norm(s);
    return g === t || g.includes(t) || t.includes(g);
  };
  const hit = hits.find((h) => h.title && agrees(h.title));
  if (!hit) return [];
  const values = {
    cover_url: hit.cover_url || null,
    page_count: hit.page_count || null,
    published_year: hit.published_year || null,
  };
  const set = {}, changed = [];
  for (const c of targets) {
    const val = values[c];
    if (val === null || val === undefined || val === '') continue;
    set[c] = val;
    changed.push(c);
  }
  if (Object.keys(set).length) {
    const assignments = Object.keys(set).map((c) => `${c}=?`).join(', ');
    db.prepare(`UPDATE books SET ${assignments} WHERE id=?`).run(...Object.values(set), book.id);
  }
  return changed;
}

// Mark a book as having had a re-pull attempt (successful or not). The
// needs-re-pull flag defers to this stamp: once sources have been consulted
// and couldn't supply the missing bits, the badge would be permanent noise.
export const stampRefreshed = (id) =>
  db.prepare("UPDATE books SET metadata_refreshed_at=datetime('now') WHERE id=?").run(id);

// Bulk job: re-pull the whole library (paced by the shared HC client, ~400ms
// per call). Default only touches books missing a series, HC link, or moods
// that have never been re-pulled — the metadata stamp bounds the work, so
// books whose sources simply lack the data don't get re-fetched forever.
// Books flagged "no Hardcover profile" are skipped: every attempt would miss.
export async function runBookRefresh({ only_missing = true } = {}, report, uid) {
  const books = db.prepare('SELECT * FROM books WHERE user_id=? ORDER BY id').all(uid);
  const targets = books.filter((b) => !b.hardcover_excluded
    && (!only_missing || (!b.metadata_refreshed_at
      && (!b.hardcover_id || !b.series_name || !b.moods))));
  let matched = 0;
  let updated = 0;
  const unmatched = [];
  for (let i = 0; i < targets.length; i++) {
    const book = targets[i];
    report(Math.round((i / Math.max(1, targets.length)) * 100), `${i + 1}/${targets.length}: ${book.title}`);
    const result = await refreshBookMetadata(book);
    stampRefreshed(book.id);
    if (result.matched) {
      matched += 1;
      if (result.changed.length) updated += 1;
    } else {
      unmatched.push(book.title);
    }
  }
  return { candidates: targets.length, matched, updated, unmatched };
}

// Background genre reconciler — the scheduled poller's workhorse. Walks books
// never cross-checked against Google Books (oldest first), merges Google's
// canonical genres into the stored HC list, and stamps the check. A Google
// failure leaves the stamp NULL so the next cycle retries that book; a clean
// "Google has nothing" stamps too, or the same book would be re-fetched
// forever. Budget-capped per tick so a whole-library backfill can't
// monopolize the process — the next cycle resumes where this one stopped.
export async function reconcileGenresBatch({ budgetMs = 5 * 60 * 1000 } = {}) {
  const pending = db.prepare(
    'SELECT id, title, author, genres FROM books WHERE genres_synced_at IS NULL ORDER BY id'
  ).all();
  let stamped = 0, merged = 0;
  const start = Date.now();
  for (const book of pending) {
    if (Date.now() - start > budgetMs) break;
    const gb = await googleGenresFor(book);
    if (gb !== null) {
      db.prepare("UPDATE books SET genres=?, genres_synced_at=datetime('now') WHERE id=?")
        .run(JSON.stringify(unionGenres(parseJsonArr(book.genres), gb)), book.id);
      stamped++;
      if (gb.length) merged++;
    }
    // Paced even on failure — a Google outage must not hot-loop the quota.
    await sleep(700);
  }
  return { found: pending.length, stamped, merged };
}
