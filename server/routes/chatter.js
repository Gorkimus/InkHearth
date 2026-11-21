// Book chatter: one comment thread per WORK with progress-gated spoilers.
// Every write canonicalizes through works.js; every read expands to the full
// alias set, so comments land on the same thread no matter whose copy — or
// how complete its Hardcover data — was used to open it.
import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { resolveWork, workKeyForBook } from '../works.js';
import { notify } from '../notify.js';

const r = Router();
const EMOJI = ['👏', '❤️', '😂', '😮', '😭', '🔥'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// The work a request refers to: either a concrete book row (any member's copy
// — it's only used for work resolution) or an explicit work key from a card.
// GETs carry ?book=, POST bodies carry book_id — accept both spellings.
function workFromParams({ book, book_id, work }) {
  const bookParam = book ?? book_id;
  if (bookParam !== undefined && bookParam !== null && bookParam !== '') {
    const row = db.prepare('SELECT * FROM books WHERE id=?').get(bookParam);
    if (!row) throw bad('book not found');
    return resolveWork(workKeyForBook(row));
  }
  if (work) return resolveWork(String(work));
  throw bad('book or work required');
}

// How far the viewer has gotten in this work, across every copy of it they
// own: an open event counts at its percent, a finish is 100, a DNF counts at
// its drop point. Zero-ish when they've never touched it — general chatter
// (no percent attached) stays visible either way.
function viewerState(uid, bookIds) {
  if (!bookIds.length) return { percent: 0, ownBookId: null };
  const rows = db.prepare(`
    SELECT e.status, e.percent, e.dnf_percent, e.book_id FROM events e
    WHERE e.user_id=? AND e.book_id IN (${bookIds.map(() => '?').join(',')})`).all(uid, ...bookIds);
  let percent = 0;
  for (const ev of rows) {
    const p = ev.status === 'finished' ? 100
      : ev.status === 'dnf' ? (ev.dnf_percent || ev.percent || 0)
      : (ev.percent || 0);
    if (p > percent) percent = p;
  }
  const ownBookId = db.prepare(
    `SELECT id FROM books WHERE user_id=? AND id IN (${bookIds.map(() => '?').join(',')}) ORDER BY id LIMIT 1`
  ).get(uid, ...bookIds)?.id || null;
  return { percent, ownBookId };
}

// The gating rule: only a spoiler-flagged comment is ever withheld, and only
// while its author was ahead of you when they posted it — a spoiler stamped
// at 75% stays invisible until you reach 75%. Plain comments show no matter
// how far ahead their author was, and a spoiler with no stamped position (its
// author never got into the book) was posted from behind everyone, so it's
// fair game too.
const canSee = (c, vp) =>
  !c.contains_spoiler || c.progress_percent == null || c.progress_percent <= vp;

function reactionsFor(kind, targetIds, uid) {
  const map = new Map();
  if (!targetIds.length) return map;
  const rows = db.prepare(`
    SELECT target_id, emoji, COUNT(*) AS n, MAX(user_id = ?) AS mine
    FROM reactions WHERE kind=? AND target_id IN (${targetIds.map(() => '?').join(',')})
    GROUP BY target_id, emoji ORDER BY MIN(id)`).all(uid, kind, ...targetIds);
  for (const row of rows) {
    if (!map.has(row.target_id)) map.set(row.target_id, []);
    map.get(row.target_id).push({ emoji: row.emoji, count: row.n, mine: !!row.mine });
  }
  return map;
}

// The @-tags on a batch of comments, grouped for the views: who was
// tagged, plus a `you` flag so the client can badge rows aimed at the
// viewer without ever learning their own id.
function mentionsFor(commentIds, uid) {
  const map = new Map();
  if (!commentIds.length) return map;
  const rows = db.prepare(`
    SELECT m.comment_id, m.user_id, u.name FROM comment_mentions m
    JOIN users u ON u.id = m.user_id
    WHERE m.comment_id IN (${commentIds.map(() => '?').join(',')})`).all(...commentIds);
  for (const row of rows) {
    if (!map.has(row.comment_id)) map.set(row.comment_id, []);
    map.get(row.comment_id).push({ user_id: row.user_id, name: row.name, you: row.user_id === uid });
  }
  return map;
}

function commentView(c, uid, isAdmin, reactions, mentions = []) {
  return {
    id: c.id,
    user_id: c.user_id,
    name: c.name,
    has_avatar: !!c.has_avatar,
    body: c.body,
    progress_percent: c.progress_percent,
    contains_spoiler: !!c.contains_spoiler,
    created_at: c.created_at,
    mine: c.user_id === uid,
    can_delete: c.user_id === uid || isAdmin,
    reactions: reactions.get(c.id) || [],
    mentions,
  };
}

// The thread for a work. Withheld comments never leave the server — the
// client gets a count to show as a "catch up" nudge.
r.get('/', (req, res, next) => {
  try {
    const uid = currentUserId();
    const { canonical, keys, bookIds } = workFromParams(req.query);
    const vp = viewerState(uid, bookIds).percent;
    // Newest 200, displayed oldest-first — a thread reads as a conversation.
    const rows = db.prepare(`
      SELECT c.*, u.name, 1 AS has_avatar
      FROM book_comments c JOIN users u ON u.id = c.user_id
      WHERE c.work_key IN (${keys.map(() => '?').join(',')})
      ORDER BY c.id DESC LIMIT 200`).all(...keys).reverse();
    const visible = rows.filter((c) => canSee(c, vp));
    const reactions = reactionsFor('comment', visible.map((c) => c.id), uid);
    const mentions = mentionsFor(visible.map((c) => c.id), uid);
    // Reading the thread IS the acknowledgment: any of the viewer's tags on
    // comments they can actually see (a spoiler-gated tag waits its turn)
    // gets acked, which unpins the hearth card row. A read with a side
    // effect, on purpose — there is no lighter honest definition of "they
    // saw it".
    if (visible.length) {
      db.prepare(`UPDATE comment_mentions SET acked_at=datetime('now')
        WHERE user_id=? AND acked_at IS NULL
          AND comment_id IN (${visible.map(() => '?').join(',')})`)
        .run(uid, ...visible.map((c) => c.id));
    }
    res.json({
      work: canonical,
      viewer_percent: vp,
      hidden_count: rows.length - visible.length,
      comments: visible.map((c) => commentView(c, uid, req.user?.is_admin, reactions, mentions.get(c.id) || [])),
    });
  } catch (err) { next(err); }
});

// Post as the viewer: the percent is stamped server-side from their real
// position in the work, never from the client. Attaching your own copy's id
// (when you have one) keeps the dashboard card's title/cover honest.
r.post('/', (req, res, next) => {
  try {
    const uid = currentUserId();
    const body = String(req.body?.body ?? '').trim();
    if (!body) throw bad('comment is empty');
    if (body.length > 1000) throw bad('comment too long (1000 char max)');
    const { canonical, bookIds } = workFromParams(req.body || {});
    const { percent, ownBookId } = viewerState(uid, bookIds);
    const info = db.prepare(`
      INSERT INTO book_comments (user_id, work_key, book_id, body, progress_percent, contains_spoiler)
      VALUES (?,?,?,?,?,?)`)
      .run(uid, canonical, ownBookId || (req.body?.book_id ? +req.body.book_id : null),
        body, percent || null, req.body?.contains_spoiler ? 1 : 0);
    const c = db.prepare(`
      SELECT c.*, u.name, 1 AS has_avatar
      FROM book_comments c JOIN users u ON u.id = c.user_id WHERE c.id=?`).get(info.lastInsertRowid);
    // Nudge everyone who has touched this work (they'll want the thread),
    // each deep link pointing at their own copy when they have one. The 24h
    // dedupe in notify() keeps a lively thread from spamming an inbox.
    // Copy-less commenters stamp no book_id, so their nudges borrow the
    // work's title from any titled copy — the bell never says "a book".
    const workTitle = db.prepare('SELECT title FROM books WHERE id=?').get(c.book_id)?.title
      || (bookIds.length
        ? db.prepare(`SELECT title FROM books WHERE id IN (${bookIds.map(() => '?').join(',')})
                      AND title IS NOT NULL AND title != '' ORDER BY id LIMIT 1`).get(...bookIds)?.title
        : null);
    // @-tags: the composer's picker sends explicit user ids — the "@Name"
    // text in the body is display sugar, the ids are the contract. Real
    // accounts only, deduped, the author dropped (notify() would skip a
    // self-tag anyway).
    const mentionIds = [...new Set((Array.isArray(req.body?.mentions) ? req.body.mentions : [])
      .map(Number).filter(Number.isInteger))]
      .filter((id) => id !== uid && !!db.prepare('SELECT id FROM users WHERE id=?').get(id));
    const insMention = db.prepare('INSERT OR IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?,?)');
    for (const id of mentionIds) insMention.run(c.id, id);
    const recipients = db.prepare(`
      SELECT DISTINCT e.user_id FROM events e
      WHERE e.book_id IN (${bookIds.map(() => '?').join(',')}) AND e.user_id != ?`)
      .all(...bookIds, uid);
    for (const { user_id } of recipients) {
      // A tagged member skips the generic nudge — they're getting the
      // pointed one below, and two rings for one comment is noise.
      if (mentionIds.includes(user_id)) continue;
      const theirBook = db.prepare(
        `SELECT id FROM books WHERE user_id=? AND id IN (${bookIds.map(() => '?').join(',')}) LIMIT 1`)
        .get(user_id, ...bookIds)?.id || null;
      notify(user_id, 'comment', { book_id: theirBook, work: canonical, title: workTitle, comment_id: c.id }, uid);
    }
    for (const id of mentionIds) {
      const theirBook = db.prepare(
        `SELECT id FROM books WHERE user_id=? AND id IN (${bookIds.map(() => '?').join(',')}) LIMIT 1`)
        .get(id, ...bookIds)?.id || null;
      notify(id, 'mention', { book_id: theirBook, work: canonical, title: workTitle, comment_id: c.id }, uid);
    }
    const postedMentions = mentionIds.length
      ? db.prepare(`SELECT m.user_id, u.name FROM comment_mentions m
          JOIN users u ON u.id=m.user_id WHERE m.comment_id=?`).all(c.id)
          .map((row) => ({ ...row, you: row.user_id === uid }))
      : [];
    res.json({ comment: commentView(c, uid, req.user?.is_admin, new Map(), postedMentions) });
  } catch (err) { next(err); }
});

// Toggle one of the fixed reactions on any reactable row (comment or event).
// Returns the fresh count and whether the viewer's own reaction is now on.
function toggleReaction(kind, targetId, uid, emoji) {
  const existing = db.prepare(
    'SELECT id FROM reactions WHERE kind=? AND target_id=? AND user_id=? AND emoji=?')
    .get(kind, targetId, uid, emoji);
  let mine;
  if (existing) {
    db.prepare('DELETE FROM reactions WHERE id=?').run(existing.id);
    mine = false;
  } else {
    db.prepare('INSERT INTO reactions (kind, target_id, user_id, emoji) VALUES (?,?,?,?)')
      .run(kind, targetId, uid, emoji);
    mine = true;
  }
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM reactions WHERE kind=? AND target_id=? AND emoji=?')
    .get(kind, targetId, emoji).n;
  return { count, mine };
}

// Toggle one of the fixed reactions. Reacting is a form of reading — you
// can't applaud a comment you aren't allowed to see yet.
r.post('/comments/:id/react', (req, res, next) => {
  try {
    const uid = currentUserId();
    const emoji = String(req.body?.emoji || '');
    if (!EMOJI.includes(emoji)) throw bad('unknown reaction');
    const c = db.prepare('SELECT * FROM book_comments WHERE id=?').get(req.params.id);
    if (!c) throw bad('comment not found');
    const { percent } = viewerState(uid, resolveWork(c.work_key).bookIds);
    if (!canSee(c, percent)) throw Object.assign(new Error('that comment is ahead of your progress'), { status: 403 });
    res.json({ emoji, ...toggleReaction('comment', c.id, uid, emoji) });
  } catch (err) { next(err); }
});

// Cheers: the same six emojis aimed at a reading event (a finish, a DNF, an
// in-progress update) — the "someone noticed" loop for the activity feed and
// the reading-together rows. The event's owner gets a nudge; cheering your
// own row toggles fine but never notifies (notify() skips self).
r.post('/cheer', (req, res, next) => {
  try {
    const uid = currentUserId();
    const emoji = String(req.body?.emoji || '👏');
    if (!EMOJI.includes(emoji)) throw bad('unknown reaction');
    const ev = db.prepare(`
      SELECT e.id, e.user_id, b.id AS book_id, b.title
      FROM events e JOIN books b ON b.id = e.book_id WHERE e.id=?`).get(req.body?.event_id);
    if (!ev) throw bad('event not found');
    const { count, mine } = toggleReaction('event', ev.id, uid, emoji);
    notify(ev.user_id, 'cheer', { event_id: ev.id, book_id: ev.book_id, title: ev.title, emoji }, uid);
    res.json({ emoji, count, mine });
  } catch (err) { next(err); }
});

r.delete('/comments/:id', (req, res, next) => {
  try {
    const uid = currentUserId();
    const c = db.prepare('SELECT * FROM book_comments WHERE id=?').get(req.params.id);
    if (!c) throw bad('comment not found');
    if (c.user_id !== uid && !req.user?.is_admin) {
      throw Object.assign(new Error('not your comment'), { status: 403 });
    }
    db.prepare("DELETE FROM reactions WHERE kind='comment' AND target_id=?").run(c.id);
    // Mentions cascade off the comment row (FK ON DELETE CASCADE).
    db.prepare('DELETE FROM book_comments WHERE id=?').run(c.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// The @-picker's shortlist: every account in the hearth. A tag is direct
// address, not directory browsing, so profile privacy doesn't gate it —
// the tagged name shows in a thread the reader can already see. Self is
// excluded server-side; avatars are per-house convention always present.
r.get('/mentionable', (req, res, next) => {
  try {
    res.json({ members: db.prepare(
      'SELECT id, name, 1 AS has_avatar FROM users WHERE id != ? ORDER BY name COLLATE NOCASE')
      .all(currentUserId()) });
  } catch (err) { next(err); }
});

// Household-wide newest comments for the dashboard hearth card, gated for
// the viewer exactly like a thread (spoilers posted ahead of them stay off
// the feed) and served a page at a time so the card can walk the household's
// talk backwards instead of dropping everything older than the newest six.
// Pages are carved from the visible set within the newest-200 window — the
// same ceiling a thread reads — so hidden spoilers never occupy a row.
r.get('/recent', (req, res, next) => {
  try {
    const uid = currentUserId();
    const PAGE_SIZE = 10, WINDOW = 200;
    const rows = db.prepare(`
      SELECT c.id, c.user_id, c.work_key, c.book_id, c.body, c.progress_percent,
             c.contains_spoiler, c.created_at,
             u.name, 1 AS has_avatar,
             b.title, b.author, b.cover_url
      FROM book_comments c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN books b ON b.id = c.book_id
      ORDER BY c.id DESC LIMIT ?`).all(WINDOW);
    // work_key → resolved work + display meta + the viewer's own position,
    // once per distinct thread. A comment can carry no book_id (posted from
    // the standalone thread modal by someone without a copy), so the card
    // borrows title/author/cover from any copy in the work rather than
    // saying "a book".
    const works = new Map();
    const workFor = (key) => {
      if (!works.has(key)) {
        const w = resolveWork(key);
        const meta = w.bookIds.length
          ? db.prepare(`SELECT title, author, cover_url FROM books
                        WHERE id IN (${w.bookIds.map(() => '?').join(',')})
                        ORDER BY (title IS NOT NULL AND title != '') DESC, id LIMIT 1`)
            .get(...w.bookIds)
          : null;
        works.set(key, { w, meta, vp: viewerState(uid, w.bookIds).percent });
      }
      return works.get(key);
    };
    const visible = rows.filter((c) => canSee(c, workFor(c.work_key).vp));
    // The viewer's un-acked tags — from anywhere; the table is tiny — pin
    // those rows above the newest-first walk, so "someone asked for you"
    // can't scroll off page 1. Rows the spoiler gate withholds aren't in
    // `visible` at all, so a tag they can't see yet can't pin anything.
    const pinned = new Set(db.prepare(
      'SELECT comment_id AS id FROM comment_mentions WHERE user_id=? AND acked_at IS NULL')
      .all(uid).map((row) => row.id));
    visible.sort((a, b) => ((pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0)) || (b.id - a.id));
    const page_count = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), page_count);
    const pageRows = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const mentions = mentionsFor(pageRows.map((c) => c.id), uid);
    res.json({
      page,
      page_count,
      hidden_count: rows.length - visible.length,
      comments: pageRows.map((c) => {
        const { w, meta } = workFor(c.work_key);
        const ownBookId = db.prepare(
          `SELECT id FROM books WHERE user_id=? AND id IN (${w.bookIds.map(() => '?').join(',') || "SELECT NULL"})
           ORDER BY id LIMIT 1`).get(uid, ...w.bookIds)?.id || null;
        return {
          id: c.id,
          user_id: c.user_id,
          name: c.name,
          has_avatar: !!c.has_avatar,
          mine: c.user_id === uid,
          body: c.body,
          progress_percent: c.progress_percent,
          contains_spoiler: !!c.contains_spoiler,
          created_at: c.created_at,
          title: c.title || meta?.title || null,
          author: c.author || meta?.author || null,
          cover_url: c.cover_url || meta?.cover_url || null,
          work: w.canonical,
          viewer_book_id: ownBookId,
          mentions_you: pinned.has(c.id),
          mentions: (mentions.get(c.id) || []).map(({ user_id, name }) => ({ user_id, name })),
        };
      }),
    });
  } catch (err) { next(err); }
});

export default r;
