// KOReader progress sync — the receiving half of the kosync protocol.
//
// A member turns on KOReader's progress-sync plugin, points it at this
// server, and from then on the DEVICE pushes its position as it reads
// (percentage 0–1, a progress string, the device name). This module folds
// those pushes into that member's events with the same contract the ABS and
// Kobo syncs keep:
//   - ≥97%  → a finished read. A book that already has a finish — full date,
//     year, or deliberate blank — is never re-dated (the ABS rule, verbatim:
//     it protects hand-entered and backfilled dates).
//   - part-way → an open reading event carrying the percent (feeds the
//     now-reading hero and Reading together), updated in place per push.
//   - Sync-opened reading events announce nothing (the standing 5.29 rule);
//     fresh finishes ring the circle and the crier like any live finish.
//
// Book matching: the wire document id is always a digest (md5 of the
// filename even in KOReader's Filename mode), so without the plugin's
// opt-in "send metadata" there is nothing to match — the push parks as a
// pending document for manual mapping on the Account page. With metadata
// (title/authors) the shelf is searched with the Kobo title tiers, and a
// miss auto-creates the book with Hardcover enrichment, mirroring the ABS
// first-sighting path.
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { notifyCircleFinish } from '../notify.js';
import { announceFinish } from '../discord.js';
import { noteReadingDay } from '../streak.js';
import { hardcoverEnabled } from '../metadata/index.js';
import { hardcoverLookup, pickSeries, genresFrom, moodsFrom } from '../metadata/hardcover-import.js';
import { findBookByTitle } from '../kobo/sync.js';

// KOReader hashes the password with md5 before sending it as x-auth-key, so
// the credential at rest is md5(token) and the raw token exists only in the
// Account page's shown-once panel.
export const hashKosyncKey = (token) =>
  createHash('md5').update(String(token)).digest('hex');

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A push is a live observation — the device is open right now — so its date
// is today, always fresh. A pending document mapped later folds with its
// stored updated_at as the observation, gated by this window (the Kobo
// rule: a stale stall never opens a reading event, and a stale finish lands
// undated instead of inventing a day).
const STALE_MS = 14 * 24 * 60 * 60 * 1000;

const insertBook = db.prepare(`INSERT INTO books
  (user_id, title, author, series_name, series_order, genres, moods,
   published_year, page_count, hardcover_id, source_provider, source_id)
  VALUES (?,?,?,?,?,?,?,?,?,?, 'koreader', ?)
  ON CONFLICT(user_id, source_provider, source_id) DO NOTHING`);

const byKoreaderId = (uid, document) =>
  db.prepare("SELECT id FROM books WHERE user_id=? AND source_provider='koreader' AND source_id=?")
    .get(uid, document);

// Add a book KOReader is reading that isn't on the shelf yet. Metadata
// pushes carry title/authors; Hardcover (when configured) canonical
// metadata. Covers: none — a re-pull or the member fills them later, the
// same as any other source's fallback.
const ensureBook = async (uid, document, meta) => {
  const existing = byKoreaderId(uid, document);
  if (existing) return existing.id;
  let hc = null;
  if (hardcoverEnabled()) {
    try { hc = await hardcoverLookup(meta.title, meta.author); } catch { /* filename metadata is fine */ }
  }
  const series = hc ? pickSeries(hc, meta.title) : null;
  const info = insertBook.run(
    uid,
    hc?.title || meta.title,
    (hc?.contributions?.[0]?.author?.name || meta.author) || null,
    series?.name || null,
    series?.order ?? null,
    JSON.stringify(hc ? genresFrom(hc) : []),
    JSON.stringify(hc ? moodsFrom(hc) : []),
    hc?.release_year || null,
    hc?.pages || null,
    hc?.id || null,
    document
  );
  if (info.changes === 0) return byKoreaderId(uid, document).id;
  return Number(info.lastInsertRowid);
};

// The protocol's position row: latest wins (that is what the member's OTHER
// devices pull back), and it doubles as the document→book mapping. book_id
// and hints are never clobbered by a push — a later metadata-carrying push
// only fills hints in (COALESCE), and the mapping changes through the
// Account page.
const upsertDoc = db.prepare(`INSERT INTO kosync_docs
  (user_id, document, book_id, title_hint, author_hint, last_percentage, last_progress, device, updated_at)
  VALUES (?,?,?,?,?,?,?,?, datetime('now'))
  ON CONFLICT(user_id, document) DO UPDATE SET
    last_percentage=excluded.last_percentage, last_progress=excluded.last_progress,
    device=excluded.device, updated_at=excluded.updated_at,
    title_hint=COALESCE(excluded.title_hint, kosync_docs.title_hint),
    author_hint=COALESCE(excluded.author_hint, kosync_docs.author_hint)`);
const touchLink = db.prepare("UPDATE kosync_links SET last_push_at=datetime('now') WHERE user_id=?");

const getDoc = (uid, document) =>
  db.prepare('SELECT * FROM kosync_docs WHERE user_id=? AND document=?').get(uid, document);

const setDocBook = (uid, document, bookId) =>
  db.prepare('UPDATE kosync_docs SET book_id=? WHERE user_id=? AND document=?').run(bookId, uid, document);

// authors arrives as a string or an array (the plugin sends doc_props
// verbatim); findBookByTitle wants the string form.
const authorOf = (metadata) =>
  Array.isArray(metadata?.authors) ? metadata.authors.join(', ') : (metadata?.authors || null);

// Fold one observation into the member's shelf. `observedAt` is the push
// time (live) or the stored updated_at (a pending doc mapped later).
// Returns what happened, for the route's logs and the smoke pins.
export async function foldKosyncPush(uid, push, observedAt = new Date()) {
  const metadata = push.metadata && typeof push.metadata === 'object' ? push.metadata : {};
  const fresh = Date.now() - observedAt.getTime() <= STALE_MS;
  const date = fresh ? localDate(observedAt) : null;

  upsertDoc.run(uid, push.document, null,
    metadata.title || metadata.filename || null,
    authorOf(metadata) || null,
    push.percentage, push.progress || null, push.device || null);
  touchLink.run(uid);

  let doc = getDoc(uid, push.document);
  let bookId = doc?.book_id ?? null;

  // Resolve: mapped → shelf title match → auto-create. Without metadata and
  // without a mapping this push stays a pending document (position only).
  if (!bookId && metadata.title) {
    const hit = findBookByTitle(uid, { title: metadata.title, author: authorOf(metadata) });
    bookId = hit ? hit.id : await ensureBook(uid, push.document, { title: metadata.title, author: authorOf(metadata) });
    setDocBook(uid, push.document, bookId);
  }
  if (!bookId) return { pending: true };

  const out = { book_id: bookId, finished: false, reading_opened: false, reading_updated: false };
  const finished = push.percentage >= 0.97;
  if (finished) {
    const prior = db.prepare("SELECT id FROM events WHERE book_id=? AND user_id=? AND status='finished' LIMIT 1")
      .get(bookId, uid);
    if (prior) return out; // already recorded — never re-date, whatever its state
    const closed = db.prepare("UPDATE events SET status='finished', percent=NULL, progress_at=datetime('now'), finished_at=COALESCE(finished_at, ?) WHERE book_id=? AND user_id=? AND status='reading'")
      .run(date, bookId, uid);
    if (closed.changes) {
      noteReadingDay(uid);
    } else {
      db.prepare("INSERT INTO events (user_id, book_id, format, medium, status, finished_at) VALUES (?,?,'read','koreader','finished',?)")
        .run(uid, bookId, date);
    }
    const queued = db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'").get(uid, bookId);
    if (queued) db.prepare("UPDATE tbr SET status='done' WHERE id=?").run(queued.id);
    out.finished = true;
    // A fresh finish is a live one — the circle hears about it and the crier
    // gathers a post, same as an ABS-observed finish. A stale finish (a
    // pending document mapped weeks later) lands quietly and undated.
    if (fresh) {
      const book = db.prepare('SELECT * FROM books WHERE id=?').get(bookId);
      notifyCircleFinish(uid, book);
      announceFinish(uid, book);
    }
  } else {
    const pct = Math.max(1, Math.min(99, Math.round(push.percentage * 100)));
    const open = db.prepare("SELECT id, percent FROM events WHERE book_id=? AND user_id=? AND status='reading' ORDER BY id DESC LIMIT 1")
      .get(bookId, uid);
    if (open) {
      if (open.percent !== pct) {
        db.prepare("UPDATE events SET percent=?, progress_at=datetime('now') WHERE id=?").run(pct, open.id);
        noteReadingDay(uid);
        out.reading_updated = true;
      }
    } else if (fresh) {
      // Stale observations never open a reading event (the Kobo window rule)
      // — a months-old percent is history, not a current read.
      db.prepare("INSERT INTO events (user_id, book_id, format, medium, status, percent, started_at) VALUES (?,?,'read','koreader','reading',?,?)")
        .run(uid, bookId, pct, date);
      const queued = db.prepare("SELECT id FROM tbr WHERE user_id=? AND book_id=? AND status='queued'").get(uid, bookId);
      if (queued) db.prepare("UPDATE tbr SET status='started' WHERE id=?").run(queued.id);
      out.reading_opened = true;
    }
  }
  return out;
}

// Map a pending document to a shelf book (the Account page's picker), then
// fold the stored position under the rules above — observation time is the
// document's updated_at, so an old read lands undated/quietly.
export async function mapKosyncDoc(uid, document, bookId) {
  const doc = getDoc(uid, document);
  if (!doc) return null;
  const book = db.prepare('SELECT id FROM books WHERE id=? AND user_id=?').get(bookId, uid);
  if (!book) return null;
  setDocBook(uid, document, book.id);
  const observedAt = doc.updated_at ? new Date(doc.updated_at.replace(' ', 'T') + 'Z') : new Date();
  return foldKosyncPush(uid, {
    document,
    percentage: doc.last_percentage ?? 0,
    progress: doc.last_progress,
    device: doc.device,
  }, observedAt);
}
