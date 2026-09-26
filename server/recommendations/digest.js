// Taste profile digest: everything the LLM needs to recommend like a friend
// who knows the reader — what they tier highly, what they drop, which series
// and narrators work, what they own, and what to avoid. Plain text, a few KB.
import { db } from '../db.js';

const SCORE = { S: 5, A: 4, B: 3, C: 2, D: 1 };

// Latest rated event per book, the same "displayed tier" rule as the board.
const tieredBooks = (uid) => db.prepare(`
  SELECT b.title, b.author, b.series_name, b.narrator, b.page_count,
         e.rating, e.status, e.dnf_percent, e.format
  FROM books b
  JOIN events e ON e.book_id = b.id
    AND e.id = (SELECT MAX(id) FROM events WHERE book_id = b.id AND rating IS NOT NULL)
  WHERE b.user_id = ? AND e.rating IS NOT NULL`).all(uid);

const list = (items, fmt) => items.map(fmt).join('; ');

export function buildDigest(uid) {
  const books = tieredBooks(uid);
  const byTier = { S: [], A: [], B: [], C: [], D: [] };
  for (const b of books) byTier[b.rating]?.push(b);

  const parts = [];

  parts.push(`## Ratings (S=love, D=disliked/DNF)
Total rated: ${books.length} — S:${byTier.S.length} A:${byTier.A.length} B:${byTier.B.length} C:${byTier.C.length} D:${byTier.D.length}
Loved (S): ${list(byTier.S, (b) => `${b.title} by ${b.author || '?'}`) || 'none yet'}
Excellent (A): ${list(byTier.A.slice(0, 15), (b) => `${b.title} by ${b.author || '?'}`) || 'none'}
Disliked / DNF (D): ${list(byTier.D, (b) => `${b.title}${b.status === 'dnf' ? ` (DNF at ${b.dnf_percent || '?'}%)` : ''}`) || 'none'}`);

  // Series rollups: avg of member tiers (S=5…D=1), min 2 rated — the same
  // math the tier board shows.
  const seriesRows = db.prepare(`
    SELECT b.series_name AS series, COUNT(*) AS n,
           AVG(CASE e.rating WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                             WHEN 'C' THEN 2 WHEN 'D' THEN 1 END) AS score
    FROM books b
    JOIN events e ON e.book_id = b.id
      AND e.id = (SELECT MAX(id) FROM events WHERE book_id = b.id)
    WHERE b.user_id=? AND b.series_name IS NOT NULL AND e.rating IS NOT NULL
    GROUP BY b.series_name ORDER BY score DESC LIMIT 15`).all(uid);
  if (seriesRows.length) {
    parts.push(`## Series taste (avg tier)
${seriesRows.map((s) => `${s.series}: ${[null, 'D', 'C', 'B', 'A', 'S'][Math.round(s.score)]} (${s.n} books)`).join('\n')}`);
  }

  // Authors: count + avg tier, beyond the dashboard's top-10-by-words.
  const authorMap = new Map();
  for (const b of books) {
    const a = b.author || 'Unknown';
    const e = authorMap.get(a) || { n: 0, score: 0 };
    e.n += 1; e.score += SCORE[b.rating] ?? 0;
    authorMap.set(a, e);
  }
  const authors = [...authorMap.entries()]
    .sort((x, y) => (y[1].score / y[1].n) - (x[1].score / x[1].n))
    .slice(0, 12);
  if (authors.length) {
    parts.push(`## Authors read (best first)
${authors.map(([a, e]) => `${a}: ${e.n} books, avg ${[null, 'D', 'C', 'B', 'A', 'S'][Math.round(e.score / e.n)]}`).join('\n')}`);
  }

  // Genres from HC cached tags, count-weighted.
  const genreRows = db.prepare(`
    SELECT j.value AS genre, COUNT(*) AS n
    FROM books b, json_each(COALESCE(b.genres, '[]')) j
    WHERE b.user_id=? AND EXISTS (SELECT 1 FROM events e WHERE e.book_id=b.id)
    GROUP BY j.value ORDER BY n DESC LIMIT 12`).all(uid);
  if (genreRows.length) {
    parts.push(`## Genres in the library\n${genreRows.map((g) => `${g.genre} (${g.n})`).join(', ')}`);
  }

  // Narrators: performance matters for listeners — avg narration tier.
  const narrators = db.prepare(`
    SELECT b.narrator AS name, COUNT(*) AS n,
           AVG(CASE e.narration_rating WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                                       WHEN 'C' THEN 2 WHEN 'D' THEN 1 END) AS score
    FROM books b JOIN events e ON e.book_id = b.id
    WHERE b.user_id=? AND b.narrator IS NOT NULL AND e.narration_rating IS NOT NULL
    GROUP BY b.narrator HAVING COUNT(*) >= 1 ORDER BY score DESC LIMIT 8`).all(uid);
  if (narrators.length) {
    parts.push(`## Narrators (for audiobooks; tier = narration rating)
${narrators.map((n) => `${n.name}: ${[null, 'D', 'C', 'B', 'A', 'S'][Math.round(n.score)]}${n.n > 1 ? ` (${n.n} books)` : ''}`).join('\n')}`);
  }

  // Owned catalog so the LLM doesn't recommend the shelf itself. TBR too.
  const owned = db.prepare(`SELECT title, author FROM books WHERE user_id=? ORDER BY title`).all(uid);
  const chunks = [];
  for (let i = 0; i < owned.length; i += 25) {
    chunks.push(list(owned.slice(i, i + 25), (b) => `${b.title} (${b.author || '?'})`));
  }
  parts.push(`## Already owned or read — NEVER recommend these\n${chunks.join('\n')}`);

  const dnfNote = db.prepare(`
    SELECT b.title FROM books b JOIN events e ON e.book_id=b.id
    WHERE b.user_id=? AND e.status='dnf'
      AND NOT EXISTS (SELECT 1 FROM events e2 WHERE e2.book_id=b.id AND e2.id > e.id AND e2.rating IS NOT NULL)
    LIMIT 10`).all(uid);
  if (dnfNote.length) {
    parts.push(`## Unrated DNFs (started and abandoned)\n${list(dnfNote, (b) => b.title)}`);
  }

  const suggested = db.prepare(`SELECT title FROM recommendations WHERE user_id=? ORDER BY id DESC LIMIT 40`).all(uid);
  if (suggested.length) {
    parts.push(`## Previously suggested (skip these too)\n${list(suggested, (r) => r.title)}`);
  }

  const avoids = db.prepare(`SELECT label FROM avoid_signals WHERE user_id=? ORDER BY id DESC`).all(uid);
  if (avoids.length) {
    parts.push(`## Reader said "not for me" — avoid authors/series/genres like these\n${avoids.map((a) => `- ${a.label}`).join('\n')}`);
  }

  return parts.join('\n\n');
}
