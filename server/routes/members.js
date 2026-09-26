import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { eventWords, eventPages, eventHours } from '../wordcount.js';
import { sharedBooks, matchSummary, tasteMatch, globalMean, buildShelfIndex, matchOnShelf, avgRating } from './compare.js';
import { bookInfo } from '../metadata/book-info.js';
import { readingStreak } from '../streak.js';

const r = Router();

// Members (friend & family): everyone's profile is browsable by default
// (users.profile_public, default 1) — an opt-out toggle can flip it later.
// All endpoints require a session (the /api gate handles that).

const yearKey = (ev) =>
  ev.finished_at ? ev.finished_at.slice(0, 4) : ev.finished_year ? String(ev.finished_year) : null;

// Taste-match badge vs the signed-in viewer, for members who opted into
// comparisons (users.share_compare — the same gate as the Compare view; no
// other bypass). Needs 3+ commonly rated books before a percentage means
// anything. The pct is the calibrated score (adjusted cosine against each
// rater's global average, shrunk for sample size) — 50% means no signal.
function matchFor(memberId, viewerId) {
  if (memberId === viewerId) return null;
  const opted = db.prepare('SELECT share_compare FROM users WHERE id=?').get(memberId)?.share_compare;
  if (!opted) return null;
  const shared = sharedBooks(viewerId, memberId);
  const s = matchSummary(shared, tasteMatch(shared, globalMean(viewerId), globalMean(memberId)));
  return s.both_rated >= 3
    ? { pct: s.taste.pct, shared_rated: s.both_rated, shared_total: s.shared }
    : null;
}

// Directory: every account with a little life-sign data.
r.get('/members', (req, res) => {
  const uid = currentUserId();
  const members = db.prepare(`
    SELECT u.id, u.name, u.is_admin, u.profile_public, (u.avatar IS NOT NULL) AS has_avatar,
      (SELECT COUNT(*) FROM books b WHERE b.user_id = u.id) AS books,
      (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id AND e.status = 'finished') AS finished,
      (SELECT MAX(e2.created_at) FROM events e2 WHERE e2.user_id = u.id) AS last_active,
      (SELECT MAX(COALESCE(e3.finished_at, CAST(e3.finished_year AS TEXT)))
         FROM events e3 WHERE e3.user_id = u.id AND e3.status = 'finished') AS last_finished
    FROM users u
    WHERE u.profile_public = 1
    ORDER BY u.name COLLATE NOCASE`)
    .all();
  res.json({ members: members.map((m) => ({
    ...m,
    is_admin: !!m.is_admin,
    profile_public: !!m.profile_public,
    avg: avgRating(m.id),
    match: matchFor(m.id, uid),
  })) });
});

// ---- friends circle (viewer-private) ----
// A per-user set of members whose live reading shows up in the "together"
// surfaces. Stored in prefs JSON — no schema. The contents never leave the
// viewer's own API responses; being in someone's circle is invisible.

const readCircle = (uid) => {
  try {
    const prefs = JSON.parse(db.prepare('SELECT prefs FROM users WHERE id=?').get(uid)?.prefs || '{}');
    return Array.isArray(prefs.circle) ? prefs.circle.map(Number).filter(Number.isInteger) : [];
  } catch { return []; }
};

r.get('/circle', (req, res) => {
  res.json({ ids: readCircle(currentUserId()) });
});

r.put('/circle', (req, res) => {
  const uid = currentUserId();
  const wanted = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0 && n !== uid)
    .slice(0, 12); // the together panel is a small strip, not the directory
  let ids = wanted;
  if (wanted.length) {
    const known = new Set(db.prepare(
      `SELECT id FROM users WHERE id IN (${wanted.map(() => '?').join(',')})`)
      .all(...wanted).map((x) => x.id));
    ids = wanted.filter((id) => known.has(id));
  }
  let prefs = {};
  try { prefs = JSON.parse(db.prepare('SELECT prefs FROM users WHERE id=?').get(uid)?.prefs || '{}'); } catch { /* fresh */ }
  prefs.circle = ids;
  db.prepare('UPDATE users SET prefs=? WHERE id=?').run(JSON.stringify(prefs), uid);
  res.json({ ids });
});

// Reading together: what the viewer's circle is mid-way through. Two gates
// stack — a member must be in the circle AND profile_public — and each row
// flags whether the book is already on the viewer's own shelf or queued in
// their TBR, so the UI can turn it into a one-tap follow-along.
// Registered before /members/:id, which would otherwise capture the path.
r.get('/members/reading-now', (req, res) => {
  const uid = currentUserId();
  const circle = readCircle(uid);
  if (!circle.length) return res.json({ readers: [] });
  const rows = db.prepare(`
    SELECT u.id AS member_id, u.name, (u.avatar IS NOT NULL) AS has_avatar,
           e.id AS event_id, e.percent, e.format,
           b.id AS book_id, b.title, b.author, b.cover_url, b.on_pause, b.hardcover_id
    FROM events e
    JOIN users u ON u.id = e.user_id
    JOIN books b ON b.id = e.book_id
    WHERE e.status = 'reading' AND u.profile_public = 1
      AND e.user_id IN (${circle.map(() => '?').join(',')})
    ORDER BY u.name COLLATE NOCASE, e.percent DESC`).all(...circle);
  const shelf = buildShelfIndex(uid);
  // Per-member streak for the together strip — one lookup per distinct
  // member, not per row.
  const streaks = new Map();
  for (const id of new Set(rows.map((r) => r.member_id))) streaks.set(id, readingStreak(id).current);
  const readers = rows.map((row) => {
    const mine = matchOnShelf(shelf, row);
    return {
      member_id: row.member_id, name: row.name, has_avatar: !!row.has_avatar,
      event_id: row.event_id, book_id: row.book_id, hardcover_id: row.hardcover_id,
      title: row.title, author: row.author, cover_url: row.cover_url,
      format: row.format, percent: row.percent ?? 0, on_pause: !!row.on_pause,
      streak: streaks.get(row.member_id) || 0,
      in_my_library: !!mine, in_my_tbr: !!(mine && mine.in_tbr),
    };
  });
  res.json({ readers });
});

// Recent activity across the household — finished books and DNFs, newest first.
// `?circle=1` scopes to the viewer's circle; every row is enriched with the
// viewer's own relationship to the book (on shelf? queued?) so the feed can
// offer "TBR it too" instead of plain text.
r.get('/members/activity', (req, res) => {
  const uid = currentUserId();
  const circle = req.query.circle === '1' ? readCircle(uid) : null;
  if (circle && !circle.length) return res.json({ activity: [] });
  const circleSql = circle ? ` AND e.user_id IN (${circle.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`
    SELECT e.user_id, u.name AS user_name, b.id AS book_id, b.title, b.author,
           b.hardcover_id,
           e.rating, e.format, e.status, e.dnf_percent,
           COALESCE(e.finished_at, CAST(e.finished_year AS TEXT)) AS finished,
           e.created_at
    FROM events e
    JOIN users u ON u.id = e.user_id
    JOIN books b ON b.id = e.book_id
    WHERE e.status IN ('finished', 'dnf') AND u.profile_public = 1${circleSql}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT 25`).all(...(circle || []));
  const shelf = buildShelfIndex(uid);
  const activity = rows.map((a) => {
    const mine = matchOnShelf(shelf, a);
    return { ...a, in_my_library: !!mine, in_my_tbr: !!(mine && mine.in_tbr) };
  });
  res.json({ activity });
});

// Search the household's shelves: one query across every searchable member's
// library, grouped per work so the answer reads "who has it and how they
// rated it". Field chips mirror Log a book's /search; privacy is the directory
// convention — profile_public members only, silently excluded, except you
// always search your own shelf. No share_compare gate: shelf + tiers are
// exactly what a public profile already shows.
const SHELF_FIELDS = ['all', 'title', 'author', 'series'];
const shelfNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

r.get('/members/search', (req, res) => {
  const uid = currentUserId();
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [], searched: 0 });
  const field = SHELF_FIELDS.includes(req.query.field) ? req.query.field : 'all';
  const like = `%${q.replace(/([%_\\])/g, '\\$1')}%`;
  const likeCl = " LIKE ? ESCAPE '\\'";
  const col = field === 'series' ? 'series_name' : field; // query param → column
  const matchSql = field === 'all'
    ? `(b.title${likeCl} OR b.author${likeCl} OR b.series_name${likeCl})`
    : `b.${col}${likeCl}`;
  const rows = db.prepare(`
    SELECT b.user_id, u.name, (u.avatar IS NOT NULL) AS has_avatar,
           b.hardcover_id, b.title, b.author, b.series_name, b.cover_url,
           (SELECT e.rating FROM events e WHERE e.book_id = b.id AND e.rating IS NOT NULL
            ORDER BY e.id DESC LIMIT 1) AS rating,
           (SELECT e.format FROM events e WHERE e.book_id = b.id
            ORDER BY e.id DESC LIMIT 1) AS format,
           (SELECT e.status FROM events e WHERE e.book_id = b.id
            ORDER BY e.id DESC LIMIT 1) AS status,
           (SELECT MAX(COALESCE(e2.finished_at, CAST(e2.finished_year AS TEXT)))
              FROM events e2 WHERE e2.book_id = b.id AND e2.status = 'finished') AS finished
    FROM books b
    JOIN users u ON u.id = b.user_id
    WHERE (u.profile_public = 1 OR u.id = ?) AND ${matchSql}
    ORDER BY b.title COLLATE NOCASE`)
    .all(uid, ...Array(field === 'all' ? 3 : 1).fill(like));
  // Group editions of one work: Hardcover id first, normalized title+author
  // otherwise (the compare matcher's key chain, minus the usually-NULL work_id).
  const owner = (row) => ({
    member_id: row.user_id, name: row.name, has_avatar: !!row.has_avatar,
    rating: row.rating, format: row.format, status: row.status, finished: row.finished,
    is_self: row.user_id === uid,
  });
  const groups = new Map();
  for (const row of rows) {
    const key = row.hardcover_id ? `hc:${row.hardcover_id}`
      : `t:${shelfNorm(row.title)}|${shelfNorm(row.author)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key, title: row.title, author: row.author, series_name: row.series_name,
        cover_url: row.cover_url, owners: [],
      });
    }
    const g = groups.get(key);
    if (!g.cover_url && row.cover_url) g.cover_url = row.cover_url;
    if (!g.series_name && row.series_name) g.series_name = row.series_name;
    // One chip per member even if they own two editions — prefer the rated one.
    const have = g.owners.find((o) => o.member_id === row.user_id);
    if (have) { if (!have.rating && row.rating) Object.assign(have, owner(row)); continue; }
    g.owners.push(owner(row));
  }
  const results = [...groups.values()].map((g) => ({
    ...g,
    owners: g.owners.sort((a, b) => (b.is_self - a.is_self) || a.name.localeCompare(b.name)),
  })).sort((a, b) => (b.owners.length - a.owners.length) || a.title.localeCompare(b.title));
  const searched = db.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE profile_public = 1 OR id = ?').get(uid).n;
  res.json({ results, searched });
});

// One member's browsable profile: books with tiers, series rollups, lite stats.
r.get('/members/:id', (req, res) => {
  const member = db.prepare('SELECT id, name, is_admin, profile_public, created_at, (avatar IS NOT NULL) AS has_avatar FROM users WHERE id=?')
    .get(req.params.id);
  if (!member) return res.status(404).json({ error: 'no such member' });
  if (!member.profile_public) {
    return res.status(403).json({ error: `${member.name} keeps their profile private` });
  }
  const match = matchFor(member.id, currentUserId());

  // Per-book viewer relation: hide the copy-buttons for books already on the
  // viewer's shelf (read ones get a checkmark, owned-unread ones keep only
  // ✅ Read — logging your own copy never duplicates the book).
  const shelf = buildShelfIndex(currentUserId());

  const books = db.prepare(`
    SELECT b.id AS book_id, b.title, b.author, b.series_name, b.hardcover_id,
      b.cover_url, b.page_count, b.audio_runtime_minutes,
      (SELECT e.rating FROM events e WHERE e.book_id = b.id AND e.rating IS NOT NULL ORDER BY e.id DESC LIMIT 1) AS rating,
      (SELECT e.format FROM events e WHERE e.book_id = b.id ORDER BY e.id DESC LIMIT 1) AS format,
      (SELECT MAX(COALESCE(e.finished_at, CAST(e.finished_year AS TEXT))) FROM events e WHERE e.book_id = b.id) AS last_finished
    FROM books b WHERE b.user_id = ?
    ORDER BY b.created_at DESC, b.id DESC`)
    .all(member.id);

  const events = db.prepare('SELECT * FROM events WHERE user_id=?').all(member.id);
  const fullBooks = db.prepare('SELECT * FROM books WHERE user_id=?').all(member.id);
  const bById = new Map(fullBooks.map((b) => [b.id, b]));
  const stats = { books_read: 0, words: 0, pages: 0, hours: 0 };
  const TIER = [null, 'D', 'C', 'B', 'A', 'S'];
  const scoreBy = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  const seriesAgg = new Map();
  for (const ev of events) {
    if (ev.status !== 'finished' && ev.status !== 'dnf') continue;
    const b = bById.get(ev.book_id);
    if (!b) continue;
    stats.books_read += 1;
    stats.words += eventWords(b, ev).words;
    stats.pages += eventPages(b, ev);
    stats.hours += eventHours(b, ev);
    if (b.series_name && ev.rating) {
      const s = seriesAgg.get(b.series_name) || { series: b.series_name, books: 0, score: 0 };
      s.books += 1;
      s.score += scoreBy[ev.rating];
      seriesAgg.set(b.series_name, s);
    }
  }
  const series = [...seriesAgg.values()]
    .filter((s) => s.books >= 2)
    .sort((a, b) => b.score / b.books - a.score / a.books)
    .map((s) => ({ series: s.series, books: s.books, avg_tier: TIER[Math.round(s.score / s.books)] }));

  res.json({
    member: { id: member.id, name: member.name, is_admin: !!member.is_admin, joined: member.created_at, has_avatar: !!member.has_avatar, avg: avgRating(member.id) },
    is_self: member.id === currentUserId(),
    match,
    stats: { ...stats, words: Math.round(stats.words), hours: Math.round(stats.hours * 10) / 10 },
    series,
    books: books.map((b) => {
      const mine = matchOnShelf(shelf, b);
      return {
        book_id: b.book_id, title: b.title, author: b.author, series_name: b.series_name,
        hardcover_id: b.hardcover_id, cover_url: b.cover_url,
        page_count: b.page_count, audio_runtime_minutes: b.audio_runtime_minutes,
        rating: b.rating, format: b.format, last_finished: b.last_finished,
        in_my_library: !!mine, in_my_tbr: !!(mine && mine.in_tbr), read_by_me: !!(mine && mine.read_by_me),
      };
    }),
  });
});

// Catalog details for one book on a member's shelf — the same lazy payload
// the recommendation cards' "More info" uses. Gated by the member's
// profile_public exactly like the profile itself; the Hardcover fetch is
// paced and cached in book-info, so a whole-shelf browse costs nothing
// until a book is actually clicked.
r.get('/members/:id/books/:bookId/info', async (req, res, next) => {
  try {
    const member = db.prepare('SELECT id, name, profile_public FROM users WHERE id=?')
      .get(req.params.id);
    if (!member) return res.status(404).json({ error: 'no such member' });
    if (!member.profile_public) {
      return res.status(403).json({ error: `${member.name} keeps their profile private` });
    }
    const book = db.prepare('SELECT * FROM books WHERE id=? AND user_id=?')
      .get(req.params.bookId, member.id);
    if (!book) return res.status(404).json({ error: 'book not found' });
    const info = book.hardcover_id ? await bookInfo(book.hardcover_id) : null;
    res.json({
      hardcover_id: book.hardcover_id || null,
      title: book.title,
      author: book.author,
      description: info?.description || null,
      slug: info?.slug || null,
      genres: info?.genres || [],
      moods: info?.moods || [],
      // Local values win: they're what the shelf row already shows.
      page_count: book.page_count || info?.page_count || null,
      audio_runtime_minutes: book.audio_runtime_minutes || info?.audio_runtime_minutes || null,
      published_year: book.published_year || info?.published_year || null,
      series_name: book.series_name || info?.series_name || null,
      series_order: book.series_order ?? info?.series_order ?? null,
    });
  } catch (err) {
    next(err);
  }
});

export default r;
