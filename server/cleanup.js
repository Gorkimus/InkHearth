// The janitor: three kinds of clutter accumulate forever without this —
// expired login sessions (only an explicit logout ever removed them),
// uploaded Kobo device databases (they contain live sync credentials, so
// they must not outlive their import by much), and data/tmp leftovers.
// Runs on the CLEANUP_HOURS clock (see index.js); files get a 24h grace so
// an in-flight import never loses its upload mid-parse.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

const FILE_GRACE_MS = 24 * 60 * 60 * 1000;

export function runCleanup() {
  const out = { sessions: 0, files: 0 };

  // Same clock comparison the session lookup uses, so a session this deletes
  // is exactly one the app would no longer accept anyway.
  out.sessions = db
    .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    .run().changes;

  for (const dir of ['uploads', 'tmp']) {
    const full = path.join(config.root, 'data', dir);
    let names = [];
    try { names = readdirSync(full); } catch { continue; } // no dir — nothing to do
    for (const name of names) {
      const file = path.join(full, name);
      try {
        if (Date.now() - statSync(file).mtimeMs > FILE_GRACE_MS) {
          unlinkSync(file);
          out.files++;
        }
      } catch { /* raced or unreadable — the next sweep retries */ }
    }
  }
  return out;
}
