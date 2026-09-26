import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { bookInfo } from '../metadata/book-info.js';

const r = Router();
const TIERS = ['S', 'A', 'B', 'C', 'D'];
const TIERS_BY_SCORE = [null, 'D', 'C', 'B', 'A', 'S']; // index = avg on the 1–5 scale (D=1 … S=5)

// Read-only view of another member's tier board (linked from the Compare
// screen). Tier letters cross accounts only behind the same opt-in that
// gates the comparison itself — share_compare — and the same promise holds:
// only tier letters + book/series names travel, never tags, notes or dates.
r.get('/board/:userId', (req, res) => {
  const meId = currentUserId();
  const otherId = Number(req.params.userId);
  if (!Number.isInteger(otherId)) return res.status(400).json({ error: 'bad user id' });
  const other = db.prepare('SELECT id, name, share_compare FROM users WHERE id=?').get(otherId);
  if (!other) return res.status(404).json({ error: 'no such member' });
  if (otherId !== meId && !other.share_compare) {
    return res.status(403).json({ error: `${other.name} hasn't opted in to comparisons` });
  }
  const books = db.prepare(`
    SELECT b.id, b.title, b.author, b.series_name, b.cover_url, b.tier_order,
      (SELECT e.rating FROM events e WHERE e.book_id = b.id AND e.rating IS NOT NULL
       ORDER BY e.id DESC LIMIT 1) AS rating
    FROM books b
    WHERE b.user_id=? AND EXISTS (SELECT 1 FROM events e WHERE e.book_id = b.id)
    ORDER BY b.id DESC`)
    .all(otherId);
  res.json({ user: { id: other.id, name: other.name }, books });
});

// Info panel for one book on a viewed board — the same lazy Hardcover
// catalog payload the member profile serves, but gated by share_compare
// (the opt-in that already makes the board visible) so the two surfaces
// can't disagree about what's shared. Only catalog data crosses over; the
// one personal field is the tier letter the board already displays.
r.get('/board/:userId/books/:bookId/info', async (req, res, next) => {
  try {
    const meId = currentUserId();
    const otherId = Number(req.params.userId);
    const other = db.prepare('SELECT id, name, share_compare FROM users WHERE id=?').get(otherId);
    if (!other) return res.status(404).json({ error: 'no such member' });
    if (otherId !== meId && !other.share_compare) {
      return res.status(403).json({ error: `${other.name} hasn't opted in to comparisons` });
    }
    const book = db.prepare('SELECT * FROM books WHERE id=? AND user_id=?')
      .get(req.params.bookId, otherId);
    if (!book) return res.status(404).json({ error: 'book not found' });
    const info = book.hardcover_id ? await bookInfo(book.hardcover_id) : null;
    const rating = db.prepare(`SELECT rating FROM events WHERE book_id=? AND rating IS NOT NULL
      ORDER BY id DESC LIMIT 1`)
      .get(book.id)?.rating || null;
    res.json({
      rating,
      title: book.title,
      author: book.author,
      description: info?.description || null,
      slug: info?.slug || null,
      genres: info?.genres || [],
      moods: info?.moods || [],
      // Local values win: they're what the board's owner logged.
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

// Setting a book's tier = re-rating its most recent entry (the app's displayed
// tier is always the latest event's rating). Only books with entries appear on
// the board.
r.put('/books/:id/rating', (req, res) => {
  const uid = currentUserId();
  const rating = req.body?.rating || null;
  if (rating && !TIERS.includes(rating)) return res.status(400).json({ error: 'invalid rating' });
  const book = db.prepare('SELECT id FROM books WHERE id=? AND user_id=?').get(req.params.id, uid);
  if (!book) return res.status(404).json({ error: 'book not found' });
  const ev = db.prepare('SELECT id FROM events WHERE book_id=? AND user_id=? ORDER BY id DESC LIMIT 1')
    .get(book.id, uid);
  if (!ev) return res.status(400).json({ error: 'book has no entries to rate' });
  db.prepare('UPDATE events SET rating=? WHERE id=?').run(rating, ev.id);
  res.json({ event_id: ev.id, rating });
});

// Manual arrangement on the board: the client sends the full ordered id list
// of one tier row after a drop (within-tier reorder, or the target tier after
// a cross-tier move) and each book gets its display position. All-or-nothing
// — every id must be the caller's own book.
r.post('/board/reorder', (req, res) => {
  const uid = currentUserId();
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(Number.isInteger)) {
    return res.status(400).json({ error: 'ids must be an array of book ids' });
  }
  const known = db.prepare(`SELECT COUNT(*) n FROM books WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`)
    .get(uid, ...ids).n;
  if (known !== ids.length) return res.status(404).json({ error: 'list contains books you do not own' });
  const upd = db.prepare('UPDATE books SET tier_order=? WHERE id=? AND user_id=?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => upd.run(i, id, uid));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  res.json({ ok: true, ordered: ids.length });
});

// Series rollups: average of member books' current tiers (S=5 … D=1), where a
// book's current tier is its latest entry's rating. Needs 2+ rated members.
// A manual override (series_overrides) wins over the computed suggestion.
r.get('/series-rollups', (req, res) => {
  const uid = currentUserId();
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
    HAVING COUNT(*) >= 2
    ORDER BY score DESC, series`)
    .all(uid);
  const overrides = Object.fromEntries(
    db.prepare('SELECT series_name, rating FROM series_overrides WHERE user_id=?')
      .all(uid).map((o) => [o.series_name, o.rating]));
  res.json({
    rollups: rows.map((row) => ({
      series: row.series,
      rated: row.rated,
      score: Math.round(row.score * 100) / 100,
      suggested: TIERS_BY_SCORE[Math.round(row.score)] || 'D',
      override: overrides[row.series] || null,
    })),
  });
});

r.put('/series-overrides', (req, res) => {
  const uid = currentUserId();
  const series = req.body?.series_name?.trim();
  const rating = req.body?.rating || null;
  if (!series) return res.status(400).json({ error: 'series_name required' });
  if (rating && !TIERS.includes(rating)) return res.status(400).json({ error: 'invalid rating' });
  if (!rating) {
    db.prepare('DELETE FROM series_overrides WHERE user_id=? AND series_name=?').run(uid, series);
    return res.json({ override: null });
  }
  db.prepare(`INSERT INTO series_overrides (user_id, series_name, rating) VALUES (?,?,?)
    ON CONFLICT (user_id, series_name) DO UPDATE SET rating=excluded.rating`)
    .run(uid, series, rating);
  res.json({ override: rating });
});

export default r;
