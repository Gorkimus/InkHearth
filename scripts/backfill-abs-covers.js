// Re-download covers for ABS-imported books that are missing them.
//   node scripts/backfill-abs-covers.js

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { db, currentUserId } from '../server/db.js';

const abs = config.abs;
const coversDir = path.join(config.root, 'data', 'covers');
mkdirSync(coversDir, { recursive: true });
const uid = currentUserId();

const books = db
  .prepare("SELECT id, source_id, title FROM books WHERE user_id=? AND source_provider='abs' AND (cover_url IS NULL OR cover_url='')")
  .all(uid);
console.log(`Books missing covers: ${books.length}`);

let ok = 0, failed = 0;
const statuses = new Map();

async function grab(book) {
  const file = path.join(coversDir, `${book.source_id}.jpg`);
  if (existsSync(file)) {
    db.prepare('UPDATE books SET cover_url=? WHERE id=?').run(`/covers/${book.source_id}.jpg`, book.id);
    ok++;
    return;
  }
  const res = await fetch(`${abs.url}/api/items/${book.source_id}/cover`, {
    headers: { Authorization: `Bearer ${abs.token}` },
  });
  statuses.set(res.status, (statuses.get(res.status) || 0) + 1);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('empty body');
  writeFileSync(file, buf);
  db.prepare('UPDATE books SET cover_url=? WHERE id=?').run(`/covers/${book.source_id}.jpg`, book.id);
  ok++;
}

const CONCURRENCY = 4;
for (let i = 0; i < books.length; i += CONCURRENCY) {
  await Promise.all(books.slice(i, i + CONCURRENCY).map((b) =>
    grab(b).catch((err) => {
      failed++;
      if (failed <= 5) console.warn(`  ! ${b.title}: ${err.message}`);
    })
  ));
}

console.log(`Covers backfilled: ${ok} | failed: ${failed} | HTTP statuses: ${JSON.stringify([...statuses.entries()])}`);
