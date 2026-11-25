// The bell's API: an unread count for the header badge, the list behind it,
// seen-marking, and dismissal. The list keeps at most PER_ACTOR rows per
// person (a member's first ABS sync can mint a finish nudge per book — the
// list shows their latest three, not a wall of them) and is capped overall
// too; the cleanup tick handles real retention (seen rows die at 30 days,
// dismissed rows a day after their ✕).
import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { resolveWork } from '../works.js';
import { notify } from '../notify.js';

const requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
};

const r = Router();
const LIMIT = 30;
const PER_ACTOR = 3;

// The per-person window the list and the badge share: newest PER_ACTOR rows
// per actor among the recipient's live (not dismissed) notifications. The
// badge counts only what the list can actually show — no phantom unread for
// rows hidden by the cap.
const CAPPED = `
  SELECT id, kind, payload, created_at, seen_at, actor_id, actor_name,
         ROW_NUMBER() OVER (PARTITION BY IFNULL(actor_id, 0) ORDER BY id DESC) AS rn
  FROM (
    SELECT n.id, n.kind, n.payload, n.created_at, n.seen_at,
           u.id AS actor_id, u.name AS actor_name
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
    WHERE n.user_id=? AND n.dismissed_at IS NULL
  )`;

// The 👪 state for a bell row's inline button: who's already reacted and
// whether the viewer is among them. Same shape for cheers (kind 'event')
// and comment reactions.
function reactState(kind, targetId, uid) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n, MAX(user_id = ?) AS mine
    FROM reactions WHERE kind=? AND target_id=? AND emoji='👏'`).get(uid, kind, targetId);
  return { type: kind === 'event' ? 'event' : 'comment', id: targetId, count: row.n, mine: !!row.mine };
}

// Bell rows earn their detail at READ time, so every row — including the
// ones minted before a field existed — reads the same: finish nudges name
// the book (title + author) and gain a cheer target (the finisher's latest
// finished event on the work), comment nudges gain a 👪 target on the
// comment. Rows whose event/comment has since been deleted simply lose the
// button, never the text.
function enrich(item, uid) {
  const p = item.payload || {};
  if (item.kind === 'finish' && item.actor) {
    try {
      const { bookIds } = resolveWork(String(p.work || ''));
      const ev = bookIds.length
        ? db.prepare(`
            SELECT e.id, b.title, b.author FROM events e JOIN books b ON b.id = e.book_id
            WHERE e.user_id=? AND e.status='finished'
              AND e.book_id IN (${bookIds.map(() => '?').join(',')})
            ORDER BY e.id DESC LIMIT 1`).get(item.actor.id, ...bookIds)
        : null;
      if (ev) {
        p.event_id = p.event_id || ev.id;
        p.title = p.title || ev.title || null;
        p.author = p.author ?? ev?.author ?? null;
      }
      if (p.event_id) item.react = reactState('event', p.event_id, uid);
    } catch { /* unknown work key — the row still renders its payload text */ }
  } else if ((item.kind === 'comment' || item.kind === 'mention') && p.comment_id
    && db.prepare('SELECT id FROM book_comments WHERE id=?').get(p.comment_id)) {
    item.react = reactState('comment', p.comment_id, uid);
  }
  return item;
}

r.get('/', (req, res, next) => {
  try {
    const uid = currentUserId();
    const rows = db.prepare(`
      SELECT * FROM (${CAPPED}) WHERE rn<=? ORDER BY id DESC LIMIT ?`)
      .all(uid, PER_ACTOR, LIMIT);
    const unread = db.prepare(
      `SELECT COUNT(*) AS n FROM (${CAPPED}) WHERE rn<=? AND seen_at IS NULL`)
      .get(uid, PER_ACTOR).n;
    res.json({
      unread,
      items: rows.map((row) => enrich({
        id: row.id,
        kind: row.kind,
        payload: JSON.parse(row.payload || '{}'),
        created_at: row.created_at,
        seen: !!row.seen_at,
        actor: row.actor_id ? { id: row.actor_id, name: row.actor_name, has_avatar: true } : null,
      }, uid)),
    });
  } catch (err) { next(err); }
});

// The header badge's whole diet: a single number, refreshed on every view
// render and once a minute while the tab is visible. Same per-actor cap as
// the list, so it never counts a row the list is hiding.
r.get('/unread', (req, res, next) => {
  try {
    const count = db.prepare(
      `SELECT COUNT(*) AS n FROM (${CAPPED}) WHERE rn<=? AND seen_at IS NULL`)
      .get(currentUserId(), PER_ACTOR).n;
    res.json({ count });
  } catch (err) { next(err); }
});

const liveUnread = (uid) => db.prepare(
  `SELECT COUNT(*) AS n FROM (${CAPPED}) WHERE rn<=? AND seen_at IS NULL`)
  .get(uid, PER_ACTOR).n;

// Mark seen: specific ids (a tapped row) or everything (the button). Unknown
// ids belonging to someone else simply match nothing — scoped by owner.
r.post('/seen', (req, res, next) => {
  try {
    const uid = currentUserId();
    const info = req.body?.all
      ? db.prepare("UPDATE notifications SET seen_at=datetime('now') WHERE user_id=? AND seen_at IS NULL").run(uid)
      : (() => {
          const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
          if (!ids.length) return { changes: 0 };
          return db.prepare(`
            UPDATE notifications SET seen_at=datetime('now')
            WHERE user_id=? AND seen_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
            .run(uid, ...ids);
        })();
    res.json({ ok: true, marked: info.changes, unread: liveUnread(uid) });
  } catch (err) { next(err); }
});

// Dismiss: the ✕ on a row, or "Clear all". Dismissed rows leave the list
// and the badge immediately (and the janitor sweeps them a day later).
// Owner-scoped exactly like /seen.
r.post('/dismiss', (req, res, next) => {
  try {
    const uid = currentUserId();
    const info = req.body?.all
      ? db.prepare("UPDATE notifications SET dismissed_at=datetime('now') WHERE user_id=? AND dismissed_at IS NULL").run(uid)
      : (() => {
          const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isInteger);
          if (!ids.length) return { changes: 0 };
          return db.prepare(`
            UPDATE notifications SET dismissed_at=datetime('now'), seen_at=COALESCE(seen_at, datetime('now'))
            WHERE user_id=? AND dismissed_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
            .run(uid, ...ids);
        })();
    res.json({ ok: true, dismissed: info.changes, unread: liveUnread(uid) });
  } catch (err) { next(err); }
});

// The admin's town crier: one message to every member's bell. The sender's
// own bell stays quiet (they wrote it), and notify()'s 24h dedupe collapses
// an accidental double-send of the same text.
r.post('/broadcast', requireAdmin, (req, res, next) => {
  try {
    const text = String(req.body?.message || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'nothing to send' });
    const from = currentUserId();
    for (const u of db.prepare('SELECT id FROM users').all()) {
      notify(u.id, 'broadcast', { text }, from);
    }
    res.json({ ok: true, queued: true });
  } catch (err) { next(err); }
});

export default r;
