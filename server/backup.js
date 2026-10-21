import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';

// Consistent SQLite snapshots of the live database. VACUUM INTO reads a
// stable view, so it is safe while the server serves and writes normally.
// Only auto-generated snapshots (booktracker-<stamp>.db) are pruned —
// hand-made ones (e.g. booktracker-pre-transfer-…) are kept forever.

const backupDir = path.join(config.root, 'backups');
const AUTO_SNAPSHOT = /^booktracker-\d{14}\.db$/;

export function listBackups() {
  return readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .map((name) => ({ name, bytes: statSync(path.join(backupDir, name)).size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function takeSnapshot() {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  // Second-granularity stamps collide when two snapshots land in the same
  // second (the smoke's backup test + restore-point do exactly that) and
  // VACUUM INTO refuses to overwrite — so walk a suffix until free.
  let file = `booktracker-${stamp}.db`;
  let target = path.join(backupDir, file);
  for (let n = 1; existsSync(target); n++) {
    file = `booktracker-${stamp}-${n}.db`;
    target = path.join(backupDir, file);
  }
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return { file, bytes: statSync(target).size };
}

export function pruneSnapshots(keep) {
  const auto = listBackups().map((b) => b.name).filter((n) => AUTO_SNAPSHOT.test(n));
  for (const name of auto.slice(keep)) unlinkSync(path.join(backupDir, name));
}
