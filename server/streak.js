// Reading streaks: consecutive days on which the member logged ANY reading
// activity — a finished entry, a fresh reading event, or a progress touch
// (the ±% buttons / progress API stamp events.progress_at, and so do the
// ABS sync and in-app finishes). Days are the household's calendar days
// (config.tz, STREAK_TZ), not the container's UTC: storage stays UTC
// (datetime('now')) and converts when keying, so an 11pm touch counts for
// that evening instead of bouncing to the next UTC day. Today not logged
// yet doesn't break a streak — it's alive until the day actually ends, so
// the anchor can be yesterday.
//
// Day sources: events.created_at is immutable (an entry's creation day
// survives forever), but events.progress_at holds only the LATEST touch —
// reading the same book two days running used to overwrite yesterday's
// stamp and erase the day (the Oct 12 reset). reading_days (m53) records
// each touch day durably; every progress_at stamp site calls
// noteReadingDay beside it, and the set below unions all three.
import { db } from './db.js';
import { config } from './config.js';

// en-CA formats as YYYY-MM-DD; stored timestamps are SQLite 'YYYY-MM-DD HH:MM:SS' UTC.
const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz });
const toDay = (ts) => dayKey.format(new Date(String(ts).replace(' ', 'T') + 'Z'));

// Record TODAY (household calendar) as a reading day for this member.
// INSERT OR IGNORE: one row per member per day, however many touches.
export function noteReadingDay(uid) {
  db.prepare('INSERT OR IGNORE INTO reading_days (user_id, day) VALUES (?, ?)')
    .run(uid, dayKey.format(new Date()));
}

// Day-KEY arithmetic instead of wall-clock -24h steps: consecutive tz days
// are consecutive YYYY-MM-DD strings, and stepping a UTC-noon anchor by
// exact 24h multiples never crosses a calendar boundary — so the walk can't
// skip or repeat a day around a DST transition the way setDate(-1) on a
// UTC container could.
const shiftKey = (key, days) => new Date(new Date(key + 'T12:00:00Z').getTime() + days * 86400000)
  .toISOString().slice(0, 10);

export function readingStreak(uid) {
  const keys = db.prepare(`
    SELECT created_at AS ts FROM events WHERE user_id=?
    UNION
    SELECT progress_at AS ts FROM events WHERE user_id=? AND progress_at IS NOT NULL`)
    .all(uid, uid).map((r) => toDay(r.ts));
  for (const r of db.prepare('SELECT day FROM reading_days WHERE user_id=?').all(uid)) keys.push(r.day);
  const days = new Set(keys);
  if (!days.size) return { current: 0, best: 0 };

  const anchor = days.has(dayKey.format(new Date()))
    ? dayKey.format(new Date())
    : shiftKey(dayKey.format(new Date()), -1);
  let current = 0;
  for (let k = anchor; days.has(k); k = shiftKey(k, -1)) current++;

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
