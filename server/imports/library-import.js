// Shared file-import runner: turns review-selected rows (from the Kobo device
// DB or Audible library exports) into books + events. Hardcover matching
// paces ~400ms/book, hence the progress report. The user picks statuses in
// the review list; the runner just writes what was chosen.
import { db, currentUserId } from '../db.js';
import { hardcoverEnabled } from '../metadata/index.js';
import { hardcoverLookup, pickSeries, genresFrom, moodsFrom, norm as hcNorm, authorListAgrees, hcDailyCapped, hcDailyCap } from '../metadata/hardcover-import.js';

const PROVIDER_LABEL = { kobo: 'Kobo', audible: 'Audible', goodreads: 'Goodreads', libby: 'Libby', storygraph: 'StoryGraph' };
// Audible rows are listening history — recording them as 'read' would poison
// the format split and word math. Kobo/Goodreads are reading. Libby's and
// StoryGraph's files carry the format per row (the review list's format
// column): Libby can't tell an ebook borrow from an audiobook one, so only
// audio-only-publisher rows arrive preset 'listened'; StoryGraph states each
// row's edition outright (audio → 'listened', everything else → 'read'). A
// row left at "—" fails hard rather than guessing read.
const EVENT_SHAPE = {
  audible: { format: 'listened', medium: 'audiobook' },
  kobo: { format: 'read', medium: 'kobo' },
  goodreads: { format: 'read', medium: null },
  libby: { format: 'row', medium: 'libby' },
  storygraph: { format: 'row', medium: null },
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
    const missing = rows.filter((r) => r.format !== 'read' && r.format !== 'listened'
      && (eventStatus(r) === 'finished' || eventStatus(r) === 'reading'));
    if (missing.length) {
      // Name several offenders, not one: a 900-row review list must not
      // become a fix-one-retry loop hunting the next "—".
      const names = missing.slice(0, 3).map((r) => `"${r.title}"`).join(', ');
      throw Object.assign(
        new Error(`${missing.length} row${missing.length === 1 ? '' : 's'} with no format (${names}${missing.length > 3 ? ` +${missing.length - 3} more` : ''}) — pick Read or Listened for every row you're importing`),
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
  let pooledMatched = 0, hcCapped = false;
  const bookIds = [];
  let cancelled = false;

  // Metadata-first, cross-member: every book row with a hardcover_id carries
  // the objective HC layer (series, genres, moods, year, pages), and imports
  // used to re-ask Hardcover for titles another member had already matched —
  // ten members importing overlapping libraries is what exhausted the
  // 5,000/day cap on Oct 12. Only objective fields are reused; nothing
  // personal (tags, events, ratings) crosses members. Applies even with HC
  // disabled — it's local, free data.
  const pool = db.prepare(`SELECT title, author, series_name, series_order, genres, moods,
    published_year, page_count, hardcover_id FROM books WHERE hardcover_id IS NOT NULL`).all();
  const poolMatch = (bookTitle, bookAuthor) => {
    const t = hcNorm(bookTitle);
    const cands = pool.filter((p) => hcNorm(p.title) === t);
    const hit = cands.find((c) => authorListAgrees(c.author, bookAuthor));
    if (hit) return hit;
    // Unambiguous single candidate with no author credit on the row — same
    // leniency the member's own shelf dedupe grants.
    if (cands.length === 1 && !bookAuthor) return cands[0];
    return null;
  };

  // Negative cache: title+author pairs Hardcover already had no answer for
  // skip re-asking for 14 days (a miss is a miss — re-burning the daily cap
  // on it buys nothing). A later live match clears the row.
  const missKey = (bookTitle, bookAuthor) =>
    hcNorm(bookTitle) + '|' + hcNorm(String(bookAuthor || '').split(',')[0]);
  const wasMiss = db.prepare("SELECT 1 AS hit FROM hc_misses WHERE key=? AND checked_at > datetime('now', '-14 days')");
  const recordMiss = db.prepare(`INSERT INTO hc_misses (key, checked_at) VALUES (?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET checked_at=datetime('now')`);
  const clearMiss = db.prepare('DELETE FROM hc_misses WHERE key=?');
  const parseArr = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

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
    let pooled = null;
    if (!bookId) {
      // 1) Another member's shelf already carries this work's HC layer.
      pooled = poolMatch(title, row.author);
      if (pooled) pooledMatched++;
      // 2) A recent miss: don't re-ask Hardcover for 14 days.
      // 3) The daily cap tripped (now or mid-import): skip the call — the
      //    summary says so, and the admin re-pull fills gaps after reset.
      if (!pooled && !wasMiss.get(missKey(title, row.author))?.hit) {
        if (useHc && !hcDailyCapped()) {
          try {
            hcBook = await hardcoverLookup(title, row.author, row.isbn);
            if (hcBook) clearMiss.run(missKey(title, row.author));
            // A null with the cap tripped means HC never answered — NOT a
            // miss to remember for 14 days.
            else if (hcDailyCapped()) hcCapped = true;
            else recordMiss.run(missKey(title, row.author));
          } catch (err) {
            if (err.dailyCap || hcDailyCapped()) hcCapped = true;
            /* otherwise keep local metadata, as ever */
          }
        }
      }
    }

    if (!bookId) {
      const series = hcBook
        ? pickSeries(hcBook, title)
        : pooled?.series_name
          ? { name: pooled.series_name, order: pooled.series_order }
          : null;
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
        JSON.stringify(hcBook ? genresFrom(hcBook) : pooled ? parseArr(pooled.genres) : []),
        JSON.stringify(hcBook ? moodsFrom(hcBook) : pooled ? parseArr(pooled.moods) : []),
        JSON.stringify(row.shelves || []),
        hcBook?.release_year || pooled?.published_year || null,
        hcBook?.pages || pooled?.page_count || row.pages || null,
        row.runtime_minutes || null,
        hcBook?.id || pooled?.hardcover_id || null,
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
      // No device date → no invented date; the user can add one later. A
      // year-only date (StoryGraph rows like "2020") rides finished_year —
      // the manual-edit path's convention — so it can't leak into months.
      // Reviews (StoryGraph) land as the event's notes; other providers'
      // rows carry none, so this stays null for them.
      const yearOnly = typeof row.last_read === 'string' && /^\d{4}$/.test(row.last_read);
      insertEvent.run(uid, bookId, format, shape.medium, 'finished',
        yearOnly ? null : (row.last_read || null), yearOnly ? parseInt(row.last_read, 10) : null,
        eventRating, row.notes || null, null);
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
    imported, skipped,
    hardcover_matched: matched,
    local_matched: pooledMatched,
    events_created: eventsCreated,
    tbr_queued: tbrQueued, book_ids: bookIds,
    // A member-requested stop: what was processed stands, the rest is skipped.
    cancelled,
    // The daily cap tripped somewhere in this run: books still imported, but
    // enrichment gaps remain — the reset time rides along so the member gets
    // an honest "try again after" instead of a bare matched-count.
    hardcover_capped: hcCapped,
    hardcover_resets_at: hcCapped ? hcDailyCap.resetAt : null,
    rows_total: rows.length,
  };
}
