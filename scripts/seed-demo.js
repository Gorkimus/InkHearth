// Seed a demo member for the Members page: "Demo Reader" — a Dune/Hyperion
// superfan with a small rated history spread over recent months. Idempotent:
// skips if the account already exists. Run: node scripts/seed-demo.js
// (run while the container is stopped, same data/ caveat as the smoke test).
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('data/booktracker.db');

const existing = db.prepare('SELECT id FROM users WHERE name=?').get('Demo Reader');
if (existing) {
  // Keep the flags honest even if the demo predates them.
  db.prepare('UPDATE users SET share_compare=1, profile_public=1 WHERE id=?').run(existing.id);
  console.log('Demo Reader already exists — compare/profile flags ensured.');
  process.exit(0);
}

const info = db.prepare('INSERT INTO users (name, profile_public, share_compare) VALUES (?, 1, 1)').run('Demo Reader');
const uid = Number(info.lastInsertRowid);

// [title, author, series, pages, rating, format, narrator, finished, runtimeMin, genres]
const BOOKS = [
  ['Dune', 'Frank Herbert', 'Dune', 658, 'S', 'read', null, '2026-03-14', null, ['Science Fiction']],
  ['Dune Messiah', 'Frank Herbert', 'Dune', 256, 'A', 'read', null, '2026-04-02', null, ['Science Fiction']],
  ['Children of Dune', 'Frank Herbert', 'Dune', 444, 'B', 'read', null, '2026-05-01', null, ['Science Fiction']],
  ['Hyperion', 'Dan Simmons', 'Hyperion Cantos', 482, 'S', 'listened', 'Marc Vietor', '2026-05-20', 573, ['Science Fiction']],
  ['The Fall of Hyperion', 'Dan Simmons', 'Hyperion Cantos', 528, 'A', 'listened', 'Marc Vietor', '2026-06-11', 611, ['Science Fiction']],
  ['Endymion', 'Dan Simmons', 'Hyperion Cantos', 574, 'S', 'listened', 'Victor Bevine', '2026-07-03', 673, ['Science Fiction']],
  ['The Rise of Endymion', 'Dan Simmons', 'Hyperion Cantos', 720, 'B', 'listened', 'Victor Bevine', '2026-08-01', 830, ['Science Fiction']],
  ['Project Hail Mary', 'Andy Weir', null, 476, 'S', 'listened', 'Ray Porter', '2026-08-18', 642, ['Science Fiction']],
  ['The Martian', 'Andy Weir', null, 387, 'A', 'read', null, '2025-11-22', null, ['Science Fiction']],
  ['Red Rising', 'Pierce Brown', 'Red Rising Saga', 382, 'A', 'listened', 'Tim Gerard Reynolds', '2026-09-01', 635, ['Science Fiction', 'Fantasy']],
  ['The Hobbit', 'J.R.R. Tolkien', null, 310, 'S', 'read', null, '2025-12-30', null, ['Fantasy']],
  // Overlaps with the admin's logged books so the Compare view has real deltas.
  ['The Way of Kings', 'Brandon Sanderson', 'The Stormlight Archive', 1007, 'S', 'read', null, '2025-10-12', null, ['Fantasy', 'Adventure']],
  ['Words of Radiance', 'Brandon Sanderson', 'The Stormlight Archive', 1084, 'A', 'read', null, '2025-11-08', null, ['Fantasy', 'Adventure']],
  ['Oathbringer', 'Brandon Sanderson', 'The Stormlight Archive', 1248, 'B', 'read', null, '2026-01-19', null, ['Fantasy', 'Adventure']],
];

const insBook = db.prepare(`INSERT INTO books
  (user_id, title, author, series_name, page_count, tags, audio_runtime_minutes, genres, source_provider)
  VALUES (?,?,?,?,?,?,?,?, 'demo')`);
const insEvent = db.prepare(`INSERT INTO events
  (user_id, book_id, format, status, finished_at, rating, narration_rating, created_at)
  VALUES (?,?,?,'finished',?,?,?,?)`);

for (const [title, author, series, pages, rating, format, narrator, finished, runtime, genres] of BOOKS) {
  const tags = series === 'Hyperion Cantos' ? '["favourites"]' : '[]';
  const b = insBook.run(uid, title, author, series, pages, tags, runtime, JSON.stringify(genres || []));
  const narrated = format === 'listened' ? 'A' : null;
  insEvent.run(uid, b.lastInsertRowid, format, finished, rating, narrated, `${finished}T12:00:00.000`);
}

console.log(`Seeded Demo Reader (user ${uid}) with ${BOOKS.length} books.`);
