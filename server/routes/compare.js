import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { eventWords, eventPages, eventHours } from '../wordcount.js';
import { parseJsonArr } from '../jsonarr.js';

const r = Router();
const SCORE = { S: 5, A: 4, B: 3, C: 2, D: 1 }; // same 1–5 scale as RATING5/avgRating
const TIERS_BY_SCORE = [null, 'D', 'C', 'B', 'A', 'S'];
// 1–5 scale (matches avgRating's "B (3.4)" display) — what the taste match
// correlates on. Linear in SCORE, so the choice of scale can't change the result.
const RATING5 = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const norm = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
// Title variants for the name-based fallback: "Mistborn: The Final Empire"
// (store wording) vs "The Final Empire" only pair if a series-prefixed /
// subtitle form also tries the part after the last colon. Parentheticals
// ("(Unabridged)") are already stripped by norm().
const titleKeys = (title, author) => {
  const raw = String(title || '');
  const keys = [norm(raw)];
  const seg = raw.split(':').pop().trim();
  if (seg && norm(seg) !== keys[0]) keys.push(norm(seg));
  return keys.map((k) => 't:' + k + '|' + norm(author));
};
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// All-time taste snapshot of one member: totals, tier spread, format split,
// and genres with their read/listened split — the side-by-side stat blocks
// of the Compare view.
function tasteStats(uid) {
  const books = new Map(db.prepare('SELECT * FROM books WHERE user_id=?').all(uid).map((b) => [b.id, b]));
  const events = db.prepare('SELECT * FROM events WHERE user_id=?').all(uid);
  const countable = (ev) => ev.status === 'finished' || ev.status === 'dnf';
  const totals = { books_read: 0, words: 0, pages: 0, hours: 0, dnfs: 0 };
  const tiers = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  const formats = { read: { books: 0, words: 0 }, listened: { books: 0, words: 0, hours: 0 } };
  const genres = new Map();
  const thisYear = String(new Date().getFullYear());
  const race = { books: 0, words: 0, hours: 0, dnfs: 0, streak: 0 };
  const activeDays = new Set();
  for (const ev of events) {
    const b = books.get(ev.book_id);
    if (!countable(ev) || !b) continue;
    const w = eventWords(b, ev);
    totals.books_read += 1;
    totals.words += w.words;
    totals.pages += eventPages(b, ev);
    totals.hours += eventHours(b, ev);
    if (ev.status === 'dnf') totals.dnfs += 1;
    if (ev.rating) tiers[ev.rating] += 1;
    const yk = ev.finished_at ? ev.finished_at.slice(0, 4) : ev.finished_year ? String(ev.finished_year) : null;
    if (yk === thisYear) {
      race.books += 1;
      race.words += w.words;
      race.hours += eventHours(b, ev);
      if (ev.status === 'dnf') race.dnfs += 1;
    }
    if (ev.finished_at) activeDays.add(ev.finished_at.slice(0, 10));
    const f = formats[ev.format] || (formats[ev.format] = { books: 0, words: 0 });
    f.books += 1;
    f.words += w.words;
    if (ev.format === 'listened') f.hours += eventHours(b, ev);
    for (const g of parseJsonArr(b.genres)) {
      const entry = genres.get(g) || { read: 0, listened: 0 };
      entry[ev.format] += 1;
      genres.set(g, entry);
    }
  }
  race.words = Math.round(race.words);
  race.hours = Math.round(race.hours * 10) / 10;
  race.streak = currentStreak(activeDays);
  return {
    totals: { ...totals, words: Math.round(totals.words), hours: Math.round(totals.hours * 10) / 10 },
    tiers,
    formats,
    race,
    avg: avgRating(uid),
    genres: [...genres.entries()].map(([genre, c]) => ({ genre, ...c }))
      .sort((a, b) => (b.read + b.listened) - (a.read + a.listened)).slice(0, 10),
  };
}

// Current reading streak, same rule as the dashboard's: a day counts when
// anything finished/DNF'd; today without a finish just isn't over yet.
const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function currentStreak(activeDays) {
  const d = new Date();
  if (!activeDays.has(localDay(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (activeDays.has(localDay(d))) { n += 1; d.setDate(d.getDate() - 1); }
  return n;
}

// Cross-member book matching for the social surfaces (reading-together panel,
// activity chips): an index of one member's shelf that anyone's books can be
// looked up against — Hardcover edition id first, then the same title+author
// fallback (with the subtitle variant) sharedBooks uses.
export function buildShelfIndex(uid) {
  const rows = db.prepare(`
    SELECT b.id, b.hardcover_id, b.title, b.author,
      (SELECT 1 FROM tbr t WHERE t.book_id = b.id AND t.status = 'queued') AS in_tbr,
      (SELECT 1 FROM events e WHERE e.book_id = b.id AND e.status = 'finished') AS read_by_me
    FROM books b WHERE b.user_id=?`).all(uid);
  const byHc = new Map();
  const byTitle = new Map();
  for (const b of rows) {
    if (b.hardcover_id) byHc.set('hc:' + b.hardcover_id, b);
    for (const key of titleKeys(b.title, b.author)) byTitle.set(key, b);
  }
  return { byHc, byTitle };
}

export function matchOnShelf(index, book) {
  if (book.hardcover_id) {
    const hit = index.byHc.get('hc:' + book.hardcover_id);
    if (hit) return hit;
  }
  for (const key of titleKeys(book.title, book.author)) {
    const hit = index.byTitle.get(key);
    if (hit) return hit;
  }
  return null;
}

// Average rating across all books the member has rated, weighted D=1 … S=5
// and shown as "B (3.4)". The latest rating per book wins — the same rule the
// tier board uses — so re-reads don't double-count a title. Null until the
// member has rated something.
export function avgRating(uid) {
  const row = db.prepare(`
    SELECT COUNT(*) AS rated,
           ROUND(AVG(CASE rating WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                                 WHEN 'C' THEN 2 WHEN 'D' THEN 1 END), 1) AS score
    FROM (
      SELECT (SELECT e.rating FROM events e WHERE e.book_id = b.id AND e.rating IS NOT NULL
              ORDER BY e.id DESC LIMIT 1) AS rating
      FROM books b WHERE b.user_id = ?
    ) WHERE rating IS NOT NULL`).get(uid);
  if (!row?.rated) return null;
  return {
    score: row.score,
    tier: ['D', 'C', 'B', 'A', 'S'][Math.round(row.score) - 1] || 'D',
    rated: row.rated,
  };
}

// Raw rater baseline for the taste match: their average rating across ALL
// books they've rated (same latest-rating-per-book rule as avgRating, but
// unrounded — precision matters when it's subtracted from every rating).
// tasteMatch shrinks this halfway to the scale's neutral midpoint.
export function globalMean(uid) {
  const row = db.prepare(`
    SELECT AVG(CASE rating WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                           WHEN 'C' THEN 2 WHEN 'D' THEN 1 END) AS mean
    FROM (
      SELECT (SELECT e.rating FROM events e WHERE e.book_id = b.id AND e.rating IS NOT NULL
              ORDER BY e.id DESC LIMIT 1) AS rating
      FROM books b WHERE b.user_id = ?
    ) WHERE rating IS NOT NULL`).get(uid);
  return row?.mean ?? null;
}

// Calibrated taste match between two members, over the shared-books output.
// Adjusted cosine: each commonly-rated book's tier is centered on that
// rater's baseline — their globalMean shrunk halfway to the neutral midpoint
// of the 1–5 scale (0.5·μ + 1.5), so the generosity correction applies at
// half weight: a uniformly generous rater's "A" reads as slightly above
// neutral rather than below their norm. The centered overlap is correlated,
// the raw [-1,1] score is shrunk by n/(n+gamma) so small overlaps stay near
// neutral, and the result maps to 0–100% with 50% as "no signal". Pure over
// `books` so a future per-genre variant can just filter the pairs.
export function tasteMatch(books, meanMe, meanThem, gamma = 10) {
  const pairs = books.filter((b) => b.delta !== null);
  const n = pairs.length;
  if (!n || meanMe === null || meanThem === null) {
    return { raw: 0, damped: 0, pct: 50, n };
  }
  const baseMe = 0.5 * meanMe + 1.5;
  const baseThem = 0.5 * meanThem + 1.5;
  let num = 0;
  let meSq = 0;
  let themSq = 0;
  for (const b of pairs) {
    const u = RATING5[b.mine] - baseMe;
    const v = RATING5[b.theirs] - baseThem;
    num += u * v;
    meSq += u * u;
    themSq += v * v;
  }
  const denom = Math.sqrt(meSq) * Math.sqrt(themSq);
  // No spread on either side (all shared ratings land on the baseline)
  // means no signal — the spec defines that as 0, not an error.
  const raw = denom > 0 ? Math.max(-1, Math.min(1, num / denom)) : 0;
  const damped = raw * (n / (n + gamma));
  return { raw: round4(raw), damped: round4(damped), pct: Math.round(((damped + 1) / 2) * 100), n };
}

// Compare view (Phase 3 step 6). Tiers are the only thing that crosses
// accounts here, and only when the owner opted in (users.share_compare) —
// signup promises the rest (dates, notes, formats, narration, TBR) stays put.

r.get('/compare/consent', (req, res) => {
  const me = db.prepare('SELECT share_compare FROM users WHERE id=?').get(currentUserId());
  res.json({ share: !!me?.share_compare });
});

r.put('/compare/consent', (req, res) => {
  const uid = currentUserId();
  const share = req.body?.share ? 1 : 0;
  db.prepare('UPDATE users SET share_compare=? WHERE id=?').run(share, uid);
  res.json({ share: !!share });
});

// Members this instance who opted in — the compare picker's options.
r.get('/compare/users', (req, res) => {
  const uid = currentUserId();
  res.json({
    users: db.prepare('SELECT id, name FROM users WHERE share_compare=1 AND id != ? ORDER BY name COLLATE NOCASE')
      .all(uid),
  });
});

// Books with at least one entry, tiered like the board displays them:
// the latest rated event wins.
const booksWithTiers = (uid) => db.prepare(`
  SELECT b.id, b.title, b.author, b.series_name, b.hardcover_id, b.work_id, b.genres,
    (SELECT e.rating FROM events e WHERE e.book_id = b.id AND e.rating IS NOT NULL
     ORDER BY e.id DESC LIMIT 1) AS rating
  FROM books b
  WHERE b.user_id=? AND EXISTS (SELECT 1 FROM events e WHERE e.book_id = b.id)`).all(uid);

// One user's series rollups — avg of member tiers, min 2 rated members,
// manual override wins. Same math as /api/series-rollups, keyed for joining.
function seriesRollups(uid) {
  const rows = db.prepare(`
    SELECT b.series_name AS series, COUNT(*) AS rated,
           AVG(CASE e.rating WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                             WHEN 'C' THEN 2 WHEN 'D' THEN 1 END) AS score
    FROM books b
    JOIN events e ON e.book_id = b.id
      AND e.id = (SELECT id FROM events WHERE book_id = b.id AND rating IS NOT NULL
                  ORDER BY id DESC LIMIT 1)
    WHERE b.user_id=? AND b.series_name IS NOT NULL
    GROUP BY b.series_name
    HAVING COUNT(*) >= 2`).all(uid);
  const overrides = Object.fromEntries(
    db.prepare('SELECT series_name, rating FROM series_overrides WHERE user_id=?')
      .all(uid).map((o) => [o.series_name, o.rating]));
  const out = new Map();
  for (const row of rows) {
    const override = overrides[row.series] || null;
    out.set(norm(row.series), {
      series: row.series,
      score: override ? SCORE[override] : round2(row.score),
      tier: override || TIERS_BY_SCORE[Math.round(row.score)] || 'D',
    });
  }
  return out;
}

// Books live per user, so the "same" book is two rows. Match on the stored HC
// work id first (books.work_id — reserved for a work-level key; Hardcover's
// public API exposes none today, so it's usually NULL), then the exact HC
// edition id, then normalized title+author — the same fallback the save path
// dedupes on, with a post-colon variant for series-prefixed/subtitle wording.
// Exported for the Members badge.
export function sharedBooks(meId, otherId) {
  const mine = booksWithTiers(meId);
  const byWork = new Map();
  const byHc = new Map();
  const byTitle = new Map();
  for (const b of mine) {
    if (b.work_id) byWork.set('w:' + b.work_id, b);
    if (b.hardcover_id) byHc.set('hc:' + b.hardcover_id, b);
    for (const key of titleKeys(b.title, b.author)) byTitle.set(key, b);
  }
  const used = new Set();
  const books = [];
  for (const theirs of booksWithTiers(otherId)) {
    let match = (theirs.work_id && byWork.get('w:' + theirs.work_id))
      || (theirs.hardcover_id && byHc.get('hc:' + theirs.hardcover_id))
      || null;
    if (!match) {
      for (const key of titleKeys(theirs.title, theirs.author)) {
        match = byTitle.get(key);
        if (match) break;
      }
    }
    if (!match || used.has(match.id)) continue;
    used.add(match.id);
    books.push({
      id: match.id,
      title: match.title,
      author: match.author,
      series_name: match.series_name,
      // Genre union of both copies — a shared book belongs to a genre if
      // either shelf says so (both sides use the canonical vocabulary).
      genres: [...new Set([...parseJsonArr(match.genres), ...parseJsonArr(theirs.genres)])],
      mine: match.rating || null,
      theirs: theirs.rating || null,
      delta: match.rating && theirs.rating ? SCORE[match.rating] - SCORE[theirs.rating] : null,
    });
  }
  // Rated pairs first, biggest gaps on top.
  books.sort((a, b) =>
    ((a.delta === null) - (b.delta === null))
    || Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0)
    || a.title.localeCompare(b.title));
  return books;
}

// Agreement rollup over sharedBooks() output — drives the Compare headline
// card and the Members match badge alike. `taste` (tasteMatch's result) rides
// along; the exact-tier stats still feed the rating-deltas table.
export function matchSummary(books, taste = null) {
  const rated = books.filter((b) => b.delta !== null);
  const agree = rated.filter((b) => b.delta === 0).length;
  return {
    shared: books.length,
    both_rated: rated.length,
    agree,
    agree_pct: rated.length ? Math.round((agree / rated.length) * 100) : null,
    avg_delta: rated.length ? round2(rated.reduce((s, b) => s + b.delta, 0) / rated.length) : null,
    taste,
  };
}

// Per-genre reading chemistry: the same adjusted-cosine formula run per genre
// over that genre's commonly-rated books, with the sample-size damping off —
// the headline owns "how confident are we", these bars own "where do we
// diverge". Genres with fewer than 3 commonly-rated books are skipped (same
// threshold as the badge). pct is the raw correlation mapped 0–100.
function genreAlignment(books, meanMe, meanThem) {
  const byGenre = new Map();
  for (const b of books) {
    if (b.delta === null) continue;
    for (const g of b.genres || []) {
      if (!byGenre.has(g)) byGenre.set(g, []);
      byGenre.get(g).push(b);
    }
  }
  const out = [];
  for (const [genre, pairs] of byGenre) {
    if (pairs.length < 3) continue;
    const t = tasteMatch(pairs, meanMe, meanThem, 0);
    out.push({ genre, n: t.n, raw: t.raw, pct: t.pct });
  }
  return out.sort((a, b) => b.n - a.n || a.genre.localeCompare(b.genre));
}

r.get('/compare/with/:userId', (req, res) => {
  const meId = currentUserId();
  const otherId = Number(req.params.userId);
  if (!Number.isInteger(otherId) || otherId === meId) {
    return res.status(400).json({ error: 'pick another member to compare with' });
  }
  const other = db.prepare('SELECT id, name, share_compare FROM users WHERE id=?').get(otherId);
  if (!other) return res.status(404).json({ error: 'no such member' });
  if (!other.share_compare) return res.status(403).json({ error: `${other.name} hasn't opted in to comparisons` });

  const sharedWith = sharedBooks(meId, otherId);
  const meanMe = globalMean(meId);
  const meanThem = globalMean(otherId);
  const taste = tasteMatch(sharedWith, meanMe, meanThem);
  const myRolls = seriesRollups(meId);
  const theirRolls = seriesRollups(otherId);
  const series = [];
  for (const [key, m] of myRolls) {
    const t = theirRolls.get(key);
    if (t) series.push({ series: m.series, mine: m, theirs: t, delta: round2(m.score - t.score) });
  }
  series.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.series.localeCompare(b.series));

  res.json({
    me: { id: meId, name: db.prepare('SELECT name FROM users WHERE id=?').get(meId)?.name },
    user: { id: other.id, name: other.name },
    summary: matchSummary(sharedWith, taste),
    genre_alignment: genreAlignment(sharedWith, meanMe, meanThem),
    stats: { me: tasteStats(meId), them: tasteStats(otherId) },
    books: sharedWith,
    series,
  });
});

export default r;
