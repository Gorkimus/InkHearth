// Shared file-import runner: turns review-selected rows (from the Kobo device
// DB or Audible library exports) into books + events. Hardcover matching
// paces ~400ms/book, hence the progress report. The user picks statuses in
// the review list; the runner just writes what was chosen.
import { db, currentUserId } from '../db.js';
import { hardcoverEnabled } from '../metadata/index.js';
import { hardcoverLookup, pickSeries, genresFrom, moodsFrom, norm as hcNorm, authorListAgrees } from '../metadata/hardcover-import.js';

const PROVIDER_LABEL = { kobo: 'Kobo', audible: 'Audible', goodreads: 'Goodreads', libby: 'Libby' };
// Audible rows are listening history — recording them as 'read' would poison
// the format split and word math. Kobo/Goodreads are reading. Libby's file
// can't tell an ebook borrow from an audiobook one, so the format rides on
// each row (the review list's format column): audio-only-publisher rows
// arrive preset 'listened', everything else is whatever the member picked —
// and a row they left at "—" fails hard rather than guessing read.
const EVENT_SHAPE = {
  audible: { format: 'listened', medium: 'audiobook' },
  kobo: { format: 'read', medium: 'kobo' },
  goodreads: { format: 'read', medium: null },
  libby: { format: 'row', medium: 'libby' },
};
const TIER = new Set(['S', 'A', 'B', 'C', 'D']);

export async function runLibraryImport({ provider = 'kobo', uid: uidOverride, hardcover, rows }, report = () => {}, signal = {}) {
  // Job runners pass the owner explicitly; CLI callers fall back to the seed user.
  const uid = uidOverride ?? currentUserId();
  if (!Array.isArray(rows) || !rows.length) {
    throw Object.assign(new Error('no rows selected'), { status: 400 });
  }
  const useHc = Boolean(hardcover) && hardcoverEnabled();
  const shape = EVENT_SHAPE[provider] || { format: 'read', medium: null };
  // Libby rows carry their own format. Validated up front — before any
  // writes — so one forgotten row can't leave an import half-done: the
  // review UI's job is to leave no row at "—", and anything that slips
  // through fails loudly instead of silently logging an unclassified
  // borrow as read. (tbr/book rows never create events, so they're exempt.)
  const eventStatus = (r) => r.chosen_status || r.suggested_status || 'book';
  if (shape.format === 'row') {
    const missing = rows.find((r) => r.format !== 'read' && r.format !== 'listened'
      && (eventStatus(r) === 'finished' || eventStatus(r) === 'reading'));
    if (missing) {
      throw Object.assign(
        new Error(`"${missing.title}" has no format — pick Read or Listened for every row you're importing`),
        { status: 400 });
    }
  }
  const formatFor = (row) => (shape.format === 'row' ? row.format : shape.format);

  const insertBook = db.prepare(`INSERT INTO books
    (user_id, title, author, narrator, series_name, series_order, genres, moods, tags,
     published_year, page_count, audio_runtime_minutes, hardcover_id, source_provider, source_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id, source_provider, source_id) DO NOTHING`);
  const insertEvent = db.prepare(`INSERT INTO events
    (user_id, book_id, format, medium, status, finished_at, finished_year, rating, notes, percent)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);

  let imported = 0, skipped = 0, matched = 0, eventsCreated = 0, tbrQueued = 0;
  const bookIds = [];
  let cancelled = false;

  // Shelf index for dedupe, matched on hcNorm'd titles so punctuation and
  // spacing variants count as the same book — "Chain-Gang All-Stars" vs
  // "Chain Gang All Stars" slipped the old SQL compare and duplicated 75+
  // books in the Sept 18 Kobo pull.
  const shelf = db.prepare('SELECT id, title, author, source_provider, source_id FROM books WHERE user_id=?').all(uid);
  // Same forgiving tiers the sync's findBookByTitle applies (the Oct 4
  // replay duplicated "Out" and "Butter" because this path matched authors
  // by strict equality — the feed appends the translator — and had no
  // subtitle tier at all): exact title, then a single same-title candidate
  // when the row carries no author, then subtitle drift with author
  // agreement. Contributor-list drift ("Author, Translator" vs "Author")
  // counts as agreement; a disagreeing author never matches.
  const shelfHit = (bookTitle, bookAuthor, contentId) => {
    const byId = contentId
      ? shelf.find((b) => b.source_provider === provider && b.source_id === contentId)
      : undefined;
    if (byId) return byId.id;
    const t = hcNorm(bookTitle);
    const cands = shelf.filter((b) => hcNorm(b.title) === t);
    const byAuthor = cands.find((c) => authorListAgrees(c.author, bookAuthor));
    // A sync row with no author credit still dedupes when the title is
    // unambiguous; several same-title copies need the author to agree.
    if (byAuthor) return byAuthor.id;
    if (cands.length === 1 && !bookAuthor) return cands[0].id;
    const minLen = Math.min(4, t.length);
    const drifted = shelf.find((b) => {
      const bt = hcNorm(b.title);
      if (bt.length < minLen || t.length < minLen) return false;
      const pre = bt.length <= t.length ? bt : t;
      const long = bt.length <= t.length ? t : bt;
      return long.startsWith(pre) && authorListAgrees(b.author, bookAuthor);
    });
    return drifted?.id;
  };

  for (const [i, row] of rows.entries()) {
    // Cooperative cancellation (the member hit Stop): everything written so
    // far stands, the rest is skipped, and the job reports where it stopped.
    if (signal.cancelled?.()) { cancelled = true; break; }
    const title = (row.title || '').trim();
    if (!title) continue;
    report(Math.round((i / rows.length) * 100), `Matching "${title}" (${i + 1}/${rows.length})`);

    // Dedupe: external content id first, then normalized title+author.
    let bookId = shelfHit(title, row.author, row.content_id);

    let hcBook = null;
    if (!bookId && useHc) {
      try { hcBook = await hardcoverLookup(title, row.author, row.isbn); }
      catch { /* keep local metadata */ }
    }

    if (!bookId) {
      const series = hcBook ? pickSeries(hcBook, title) : null;
      // Same role-aware byline rule as mapHcBook — authors outrank artists.
      const hcAuthor = hcBook?.contributions?.find((c) => c.contributor_role?.id === 1)?.author?.name
        ?? hcBook?.contributions?.[0]?.author?.name;
      const info = insertBook.run(
        uid,
        hcBook?.title || title,
        (hcAuthor || row.author) || null,
        row.narrator || null,
        series?.name || row.series || null,
        series?.order ?? row.series_order ?? null,
        JSON.stringify(hcBook ? genresFrom(hcBook) : []),
        JSON.stringify(hcBook ? moodsFrom(hcBook) : []),
        JSON.stringify(row.shelves || []),
        hcBook?.release_year || null,
        hcBook?.pages || row.pages || null,
        row.runtime_minutes || null,
        hcBook?.id || null,
        provider,
        row.content_id || null
      );
      if (info.changes === 0) {
        // Raced a concurrent import of the same identity — the unique index
        // (migration 33) caught it. lastInsertRowid is stale on a conflict
        // skip, so re-select the winner and let this row's events attach to
        // it, exactly like an ordinary shelf hit.
        const raced = db.prepare('SELECT id, title, author FROM books WHERE user_id=? AND source_provider=? AND source_id=?')
          .get(uid, provider, row.content_id);
        bookId = raced.id;
        shelf.push({ id: raced.id, title: raced.title, author: raced.author, source_provider: provider, source_id: row.content_id });
        skipped++;
      } else {
        bookId = Number(info.lastInsertRowid);
        // Later rows in this batch must see the new book when they dedupe.
        shelf.push({
          id: bookId,
          title: hcBook?.title || title,
          author: (hcAuthor || row.author) || null,
          source_provider: provider,
          source_id: row.content_id || null,
        });
      }
    } else {
      skipped++;
    }
    bookIds.push(bookId);
    if (hcBook) matched++;

    const status = row.chosen_status || row.suggested_status || 'book';
    const eventRating = TIER.has(row.rating) ? row.rating : null;
    const format = formatFor(row);
    // Idempotency guard: re-uploading the same file must not double-count
    // events. A finished event dedupes on book+format alone — Kobo bumps
    // StatusInfo.LastModified when a finished book is merely re-opened, and
    // dating the tuple let every such touch mint a phantom second finish
    // (one member's "Out" logged twice, nine days apart). Re-reads are logged
    // by hand, same as ABS re-listens. Reading events carry no date, so
    // book+format+reading is already drift-proof.
    const dup = status === 'finished' || status === 'reading'
      ? db.prepare('SELECT id FROM events WHERE book_id=? AND format=? AND status=? LIMIT 1')
        .get(bookId, format, status)
      : null;
    if (status === 'finished' && !dup) {
      // No device date → no invented date; the user can add one later.
      insertEvent.run(uid, bookId, format, shape.medium, 'finished', row.last_read || null, null, eventRating, null, null);
      eventsCreated++;
    } else if (status === 'reading' && !dup) {
      const pct = row.percent ? ` (~${row.percent}% read)` : '';
      // Progress feeds the now-reading hero directly, not just the note text.
      const percent = row.percent ? Math.max(1, Math.min(99, Math.round(row.percent))) : null;
      insertEvent.run(uid, bookId, format, shape.medium, 'reading', null, null, eventRating,
        `imported from ${PROVIDER_LABEL[provider] || provider}${pct}`, percent);
      eventsCreated++;
    } // 'book' → catalog only, no event

    // 'tbr' (Goodreads' to-read shelf, or a manual review choice) queues the
    // book as want-to-read. Idempotent like the events: anything already in
    // the queue — queued, started, done or dismissed — is left alone, so a
    // member's deliberate queue order never gets clobbered by a re-import.
    if (status === 'tbr') {
      const queued = db.prepare('SELECT id FROM tbr WHERE user_id=? AND book_id=?').get(uid, bookId);
      if (!queued) {
        db.prepare('INSERT INTO tbr (user_id, book_id, source) VALUES (?,?,?)').run(uid, bookId, provider);
        tbrQueued++;
      }
    }
    imported++;
  }

  return {
    imported, skipped, hardcover_matched: matched, events_created: eventsCreated,
    tbr_queued: tbrQueued, book_ids: bookIds,
    // A member-requested stop: what was processed stands, the rest is skipped.
    cancelled,
    rows_total: rows.length,
  };
}
