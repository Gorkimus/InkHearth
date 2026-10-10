// Reading streaks: consecutive days on which the member logged ANY reading
// activity — a finished entry, a fresh reading event, or a progress touch
// (the ±% buttons / progress API stamp events.progress_at, and so does the
// ABS sync when it moves a book's percent). Days are the server's LOCAL
// calendar days (config.tz), not the container's UTC: storage stays UTC
// (datetime('now')) and converts when keying, so an 11pm touch counts for
// that evening instead of bouncing to the next UTC day. Today not logged
// yet doesn't break a streak — it's alive until the day actually ends, so
// the anchor can be yesterday.
import { db } from './db.js';
import { config } from './config.js';

// en-CA formats as YYYY-MM-DD; stored timestamps are SQLite 'YYYY-MM-DD HH:MM:SS' UTC.
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz });
const toDay = (ts) => dayKey.format(new Date(String(ts).replace(' ', 'T') + 'Z'));

export function readingStreak(uid) {
  const days = new Set(db.prepare(`
    SELECT created_at AS ts FROM events WHERE user_id=?
    UNION
    SELECT progress_at AS ts FROM events WHERE user_id=? AND progress_at IS NOT NULL`)
    .all(uid, uid)
    .map((r) => toDay(r.ts)));
  if (!days.size) return { current: 0, best: 0 };

  const cursor = new Date();
  if (!days.has(dayKey.format(cursor))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (days.has(dayKey.format(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }

  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...days].sort()) {
    run = prev && new Date(d) - new Date(prev) === 86400000 ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return { current, best };
}
