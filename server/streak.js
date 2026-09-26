// Reading streaks: consecutive days on which the member logged ANY reading
// activity — a finished entry, a fresh reading event, or a progress touch
// (the ±% buttons / progress API stamp events.progress_at). Days are UTC
// dates, the same clock SQLite writes created_at with, so the math is
// timezone-stable. Today not logged yet doesn't break a streak — it's alive
// until the day actually ends, so the anchor can be yesterday.
import { db } from './db.js';

export function readingStreak(uid) {
  const days = new Set(db.prepare(`
    SELECT DISTINCT substr(created_at, 1, 10) AS d FROM events WHERE user_id=?
    UNION
    SELECT DISTINCT substr(progress_at, 1, 10) FROM events WHERE user_id=? AND progress_at IS NOT NULL`)
    .all(uid, uid).map((r) => r.d));
  if (!days.size) return { current: 0, best: 0 };

  const iso = (d) => d.toISOString().slice(0, 10);
  const cursor = new Date();
  if (!days.has(iso(cursor))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (days.has(iso(cursor))) {
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
