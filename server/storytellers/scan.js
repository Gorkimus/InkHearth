// Scan storage: turns extracted epub chunks into unclassified candidate rows
// for one scan batch. Instance-wide rows (no user_id) — the household shares
// one admin-curated corpus, and none of this text ever enters git.
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { epubChunks } from './epub.js';

export function createScan({ buf, author, title, year }) {
  const chunks = epubChunks(buf);
  if (!chunks.length) throw new Error('no readable text found in that file');
  const scanBatch = randomUUID();
  const ins = db.prepare(`
    INSERT INTO storyteller_snippets (scan_batch, author, title, source_year, status, passage)
    VALUES (?,?,?,?,'candidate',?)`);
  const insertAll = db.transaction((rows) => {
    for (const passage of rows) ins.run(scanBatch, author, title, year, passage);
  });
  insertAll(chunks);
  return { scan_batch: scanBatch, chunks: chunks.length, author, title };
}
