// The nudge emitter. Everything that wants a member's attention funnels
// through notify(): one insert, deduped — an identical (recipient, kind,
// actor, payload) inside 24h collapses to nothing, so a two-listen day or a
// busy thread can't stack identical rows. Never notifies the actor themself.
import { db } from './db.js';
import { resolveWork, workKeyForBook } from './works.js';

export function notify(uid, kind, payload = {}, actorId = null) {
  if (!uid || uid === actorId) return;
  const json = JSON.stringify(payload);
  const dupe = db.prepare(`
    SELECT id FROM notifications
    WHERE user_id=? AND kind=? AND IFNULL(actor_id, 0)=IFNULL(?, 0) AND payload=?
      AND created_at > datetime('now', '-24 hours')`)
    .get(uid, kind, actorId, json);
  if (dupe) return;
  db.prepare('INSERT INTO notifications (user_id, kind, actor_id, payload) VALUES (?,?,?,?)')
    .run(uid, kind, actorId, json);
}

// Circle finishes: when `uid` finishes `book`, nudge every member whose
// circle contains them — the recipient's own pref gates delivery (default
// on; prefs.notify_finishes === false opts out). One nudge per finish, deep
// linking at the recipient's own copy when they have one, else the bell
// click opens the work's thread modal. Import/backfill paths deliberately
// never call this — importing fifty Memory-lane books should not ring
// anybody's bell.
export function notifyCircleFinish(uid, book) {
  if (!book?.id) return;
  const work = workKeyForBook(book);
  const { bookIds } = resolveWork(work);
  for (const row of db.prepare('SELECT id, prefs FROM users WHERE id != ?').all(uid)) {
    let circle = [];
    let prefs = {};
    try { prefs = JSON.parse(row.prefs || '{}'); circle = prefs.circle || []; } catch { /* unparsable prefs = no circle */ }
    if (!circle.includes(uid) || prefs.notify_finishes === false) continue;
    const theirBookId = db.prepare(
      `SELECT id FROM books WHERE user_id=? AND id IN (${bookIds.map(() => '?').join(',') || 'SELECT NULL'}) LIMIT 1`)
      .get(row.id, ...bookIds)?.id || null;
    notify(row.id, 'finish', { book_id: theirBookId, work, title: book.title }, uid);
  }
}
