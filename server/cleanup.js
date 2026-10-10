// The janitor: four kinds of clutter accumulate forever without this —
// expired login sessions (only an explicit logout ever removed them),
// uploaded Kobo device databases (they contain live sync credentials, so
// they must not outlive their import by much), data/tmp leftovers, and
// read notifications (the inbox stays 30 days past the read mark). Poll
// deadlines close here too, as the backstop behind the polls' lazy
// close-on-read. Runs on the CLEANUP_HOURS clock (see index.js); files get a
// 24h grace so an in-flight import never loses its upload mid-parse.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { closeDuePolls } from './routes/polls.js';

const FILE_GRACE_MS = 24 * 60 * 60 * 1000;
const NOTIF_RETENTION_DAYS = 30;

export function runCleanup() {
  const out = { sessions: 0, files: 0, notifications: 0, polls: 0, pairings: 0 };

  // Same clock comparison the session lookup uses, so a session this deletes
  // is exactly one the app would no longer accept anyway.
  out.sessions = db
    .prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')")
    .run().changes;

  // Pairing requests: decided rows carry a spent reset token; undecided ones
  // expired silently hours ago (requests live 10 minutes). A day keeps
  // recent history visible while sweeping everything that could ever matter.
  out.pairings = db
    .prepare("DELETE FROM pairings WHERE created_at <= datetime('now', '-1 day')")
    .run().changes;

  // Only SEEN notifications age out — an unread nudge waits however long it
  // takes (and unread rows are few; the emit side dedupes).
  out.notifications = db
    .prepare("DELETE FROM notifications WHERE seen_at IS NOT NULL AND seen_at < datetime('now', ?)")
    .run(`-${NOTIF_RETENTION_DAYS} days`).changes;

  // Poll deadlines: usually already closed by the lazy sweep on the poll
  // reads; this catches the ones nobody happened to look at.
  try { out.polls = closeDuePolls(); } catch { /* next sweep retries */ }

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
