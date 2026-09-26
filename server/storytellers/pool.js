// Author lineup sources for Storyteller Selection flights. The member's own
// shelf anchors the flight; the staples roster adds style-distinct voices
// they don't own yet, so a flight can surface a new author. Names are facts,
// not content — nothing here approaches publisher text.
import { db } from '../db.js';

export const STAPLES = [
  'Robin Hobb', 'Joe Abercrombie', 'Ursula K. Le Guin', 'Terry Pratchett',
  'N.K. Jemisin', 'Brandon Sanderson', 'Susanna Clarke', 'Patrick Rothfuss',
  'Neil Gaiman', 'Octavia E. Butler', 'Andy Weir', 'T. Kingfisher',
];

export const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Shelf authors with at least two rated books, best average tier first —
// the same latest-rating-per-book rule the digest and board use.
export function libraryAuthors(uid) {
  return db.prepare(`
    SELECT b.author AS name, COUNT(*) AS books,
           AVG(CASE e.rating WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                             WHEN 'C' THEN 2 WHEN 'D' THEN 1 END) AS score
    FROM books b
    JOIN events e ON e.book_id = b.id
      AND e.id = (SELECT MAX(id) FROM events WHERE book_id = b.id AND rating IS NOT NULL)
    WHERE b.user_id = ? AND b.author IS NOT NULL AND e.rating IS NOT NULL
    GROUP BY b.author HAVING COUNT(*) >= 2
    ORDER BY score DESC, books DESC LIMIT 8`).all(uid)
    .map((a) => ({
      name: a.name, books: a.books,
      avg_tier: [null, 'D', 'C', 'B', 'A', 'S'][Math.round(a.score)] || null,
      owned: true,
    }));
}
