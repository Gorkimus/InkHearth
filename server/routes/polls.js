// Club polls & the Hearth pick: a member floats 2–8 books from the club's
// TBR shelves, everyone votes (one live-tally vote per member, revote until
// close), and closing — by hand or by deadline — crowns the winner as the
// current pick, with a one-tap "I'm in" that copies it onto each member's
// shelf. Options are stamped server-side from real book rows (work_key via
// works.js); the client only ever names book ids, the same trust model as
// chatter's server-stamped percent.
import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { resolveWork, workKeyForBook } from '../works.js';
import { notify } from '../notify.js';
import { addCopyForUser } from './books.js';

const r = Router();
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const pollRow = (id) => db.prepare(`
  SELECT p.*, u.name AS creator_name, 1 AS creator_has_avatar
  FROM polls p JOIN users u ON u.id = p.user_id WHERE p.id=?`).get(id);

function optionsWithTallies(pollId, uid) {
  const options = db.prepare(`
    SELECT o.*, u.name AS proposer_name, 1 AS proposer_has_avatar
    FROM poll_options o LEFT JOIN users u ON u.id = o.proposed_by
    WHERE o.poll_id=? ORDER BY o.position, o.id`).all(pollId);
  const votes = db.prepare(`
    SELECT v.option_id, v.user_id, u.name, 1 AS has_avatar
    FROM poll_votes v JOIN users u ON u.id = v.user_id
    WHERE v.poll_id=? ORDER BY v.created_at, v.id`).all(pollId);
  return options.map((o) => {
    const mine = votes.filter((v) => v.option_id === o.id);
    return {
      id: o.id,
      work_key: o.work_key,
      title: o.title,
      author: o.author,
      cover_url: o.cover_url,
      hardcover_id: o.hardcover_id,
      votes: mine.length,
      voters: mine.map((v) => ({ user_id: v.user_id, name: v.name, has_avatar: !!v.has_avatar })),
      mine: mine.some((v) => v.user_id === uid),
    };
  });
}

// How far a member is into a work — chatter's viewerState math, applied to a
// participant for the readalong wall: a finish is 100, a DNF counts at its
// drop point, an open event at its percent; max across their copies.
function percentFor(uid, bookIds) {
  if (!bookIds.length) return 0;
  const rows = db.prepare(`
    SELECT e.status, e.percent, e.dnf_percent FROM events e
    WHERE e.user_id=? AND e.book_id IN (${bookIds.map(() => '?').join(',')})`).all(uid, ...bookIds);
  let percent = 0;
  for (const ev of rows) {
    const p = ev.status === 'finished' ? 100
      : ev.status === 'dnf' ? (ev.dnf_percent || ev.percent || 0)
      : (ev.percent || 0);
    if (p > percent) percent = p;
  }
  return percent;
}

// The pick's pace window. An active readalong (target set) runs from the
// moment pacing began to the target; "expected" is the linear position today.
function readalongState(pick) {
  if (!pick.target_finish) return null;
  const start = new Date(String(pick.readalong_started_at || pick.created_at).replace(' ', 'T') + 'Z').getTime();
  const end = new Date(String(pick.target_finish).replace(' ', 'T') + 'Z').getTime();
  const now = Date.now();
  const expected = end > start
    ? Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)) : 100;
  return {
    target_finish: pick.target_finish,
    started_at: pick.readalong_started_at || pick.created_at,
    days_left: Math.max(0, Math.ceil((end - now) / 86_400_000)),
    expected_percent: Math.round(expected),
  };
}

// The wall's chip: finished beats everything; otherwise ±10 points around
// the expected pace splits ahead / on pace / behind.
const paceFor = (percent, expected) =>
  percent >= 100 ? 'finished'
    : percent >= expected + 10 ? 'ahead'
    : percent <= expected - 10 ? 'behind'
    : 'on';

// A pick with its join roll: who's in (and, on the wall, how far each member
// is plus their pace chip), whether the viewer is, and the viewer's own copy
// of the picked work (the modal the banner opens).
function pickView(pick, uid, isAdmin) {
  const participants = db.prepare(`
    SELECT pp.user_id, pp.joined_at, u.name, 1 AS has_avatar
    FROM pick_participants pp JOIN users u ON u.id = pp.user_id
    WHERE pp.pick_id=? ORDER BY pp.joined_at, pp.id`).all(pick.id);
  const { canonical, bookIds } = resolveWork(pick.work_key);
  const ownBookId = db.prepare(
    `SELECT id FROM books WHERE user_id=? AND id IN (${bookIds.map(() => '?').join(',') || 'SELECT NULL'})
     ORDER BY id LIMIT 1`).get(uid, ...bookIds)?.id || null;
  const ra = readalongState(pick);
  return {
    id: pick.id,
    poll_id: pick.poll_id,
    work_key: canonical,
    title: pick.title,
    author: pick.author,
    cover_url: pick.cover_url,
    hardcover_id: pick.hardcover_id,
    viewer_book_id: ownBookId,
    viewer_in: participants.some((p) => p.user_id === uid),
    // Pacing belongs to the member who ran the poll (admin backstop) — the
    // same hand that closed it.
    can_pace: db.prepare('SELECT user_id FROM polls WHERE id=?').get(pick.poll_id)?.user_id === uid || !!isAdmin,
    readalong: ra,
    participants: participants.map((p) => {
      const percent = percentFor(p.user_id, bookIds);
      return {
        user_id: p.user_id,
        name: p.name,
        has_avatar: !!p.has_avatar,
        percent,
        pace: ra ? paceFor(percent, ra.expected_percent) : null,
      };
    }),
    created_at: pick.created_at,
  };
}

function pollView(p, uid, isAdmin) {
  const options = optionsWithTallies(p.id, uid);
  const pick = db.prepare('SELECT * FROM club_picks WHERE poll_id=?').get(p.id);
  return {
    id: p.id,
    question: p.question,
    status: p.status,
    closes_at: p.closes_at,
    closed_at: p.closed_at,
    created_at: p.created_at,
    created_by: { user_id: p.user_id, name: p.creator_name, has_avatar: !!p.creator_has_avatar },
    can_close: p.user_id === uid || !!isAdmin,
    total_votes: options.reduce((n, o) => n + o.votes, 0),
    options,
    pick: pick ? pickView(pick, uid, isAdmin) : null,
  };
}

// Nudge a set of members about a club moment. Each recipient's own pref
// gates delivery (prefs.notify_polls, absent = on) — the same opt-out shape
// as the circle-finish bell, covering polls, picks and readalongs at once.
function nudgeUsers(ids, kind, payload, actorId) {
  for (const id of new Set(ids)) {
    if (!id || id === actorId) continue;
    const row = db.prepare('SELECT prefs FROM users WHERE id=?').get(id);
    if (!row) continue;
    let prefs = {};
    try { prefs = JSON.parse(row.prefs || '{}'); } catch { /* unparsable prefs = default on */ }
    if (prefs.notify_polls === false) continue;
    notify(id, kind, payload, actorId);
  }
}

const allOtherMemberIds = (actorId) =>
  db.prepare('SELECT id FROM users WHERE id != ?').all(actorId).map((r) => r.id);

// The one close path — a manual close and the deadline sweep both land here.
// Winner: most votes; a tie goes to the option that reached its count first
// (earliest first vote, deterministic for auto-close). Zero votes closes the
// poll with no pick — nothing was decided and nothing pretends otherwise.
function closePoll(p, closedBy) {
  const top = db.prepare(`
    SELECT option_id, COUNT(*) AS n, MIN(created_at) AS first_vote
    FROM poll_votes WHERE poll_id=?
    GROUP BY option_id ORDER BY n DESC, first_vote ASC LIMIT 1`).get(p.id);
  let pickId = null;
  if (top) {
    const o = db.prepare('SELECT * FROM poll_options WHERE id=?').get(top.option_id);
    pickId = db.prepare(`
      INSERT INTO club_picks (poll_id, option_id, work_key, book_id, title, author, cover_url, hardcover_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(p.id, o.id, o.work_key, o.book_id, o.title, o.author, o.cover_url, o.hardcover_id, closedBy)
      .lastInsertRowid;
  }
  db.prepare("UPDATE polls SET status='closed', closed_at=datetime('now'), closed_by=? WHERE id=?")
    .run(closedBy, p.id);
  nudgeUsers(allOtherMemberIds(closedBy), 'pick', {
    poll_id: p.id, pick_id: pickId, question: p.question,
    title: top ? db.prepare('SELECT title FROM poll_options WHERE id=?').get(top.option_id)?.title : null,
  }, closedBy);
  return pickId;
}

// Deadline sweep: close every open poll past its closes_at (as its creator,
// so the nudge reads naturally). Runs lazily on the poll reads and as a
// backstop in the cleanup tick — no timer of its own.
export function closeDuePolls() {
  const due = db.prepare(`
    SELECT * FROM polls WHERE status='open' AND closes_at IS NOT NULL AND closes_at <= datetime('now')`).all();
  for (const p of due) closePoll(p, p.user_id);
  return due.length;
}

// Create-form seed: every distinct work queued on any member's TBR, next-ups
// first. Deduped on the canonical work key so two members' copies of one
// book (differing Hardcover completeness) can't split the vote.
r.get('/options', (req, res, next) => {
  try {
    const rows = db.prepare(`
      SELECT b.*, t.is_next_up, u.name AS owner_name
      FROM tbr t JOIN books b ON b.id = t.book_id JOIN users u ON u.id = t.user_id
      WHERE t.status='queued'
      ORDER BY t.is_next_up DESC, t.added_at DESC`).all();
    const seen = new Map(); // canonical work_key → option
    for (const b of rows) {
      const key = resolveWork(workKeyForBook(b)).canonical;
      if (seen.has(key)) {
        const opt = seen.get(key);
        opt.is_next_up = opt.is_next_up || !!b.is_next_up;
        if (!opt.owners.includes(b.owner_name)) opt.owners.push(b.owner_name);
        continue;
      }
      seen.set(key, {
        book_id: b.id, work_key: key, title: b.title, author: b.author,
        cover_url: b.cover_url, hardcover_id: b.hardcover_id,
        is_next_up: !!b.is_next_up, owners: [b.owner_name],
      });
    }
    res.json({ options: [...seen.values()].slice(0, 50) });
  } catch (err) { next(err); }
});

// One dashboard fetch: the current pick (latest ever crowned) and, when one
// is live, the newest open poll — the banner shows both.
r.get('/banner', (req, res, next) => {
  try {
    const uid = currentUserId();
    closeDuePolls();
    const pick = db.prepare('SELECT * FROM club_picks ORDER BY id DESC LIMIT 1').get();
    const openPoll = db.prepare("SELECT * FROM polls WHERE status='open' ORDER BY id DESC LIMIT 1").get();
    res.json({
      pick: pick ? pickView(pick, uid, req.user?.is_admin) : null,
      open_poll: openPoll ? pollView(pollRow(openPoll.id), uid, req.user?.is_admin) : null,
    });
  } catch (err) { next(err); }
});

// Open polls first (newest first), then closed history.
r.get('/', (req, res, next) => {
  try {
    const uid = currentUserId();
    closeDuePolls();
    const rows = db.prepare(`
      SELECT p.*, u.name AS creator_name, 1 AS creator_has_avatar
      FROM polls p JOIN users u ON u.id = p.user_id
      ORDER BY p.status='open' DESC, p.id DESC LIMIT 30`).all();
    res.json({ polls: rows.map((p) => pollView(p, uid, req.user?.is_admin)) });
  } catch (err) { next(err); }
});

r.post('/', (req, res, next) => {
  try {
    const uid = currentUserId();
    const body = req.body || {};
    const question = String(body.question ?? '').trim() || 'What should the club read next?';
    if (question.length > 200) throw bad('question too long (200 char max)');
    // Deadline arrives as a UTC "YYYY-MM-DD HH:MM:SS" string (the client
    // converts its local end-of-day); it must parse and sit in the future.
    let closesAt = null;
    if (body.closes_at) {
      closesAt = String(body.closes_at);
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(closesAt)) throw bad('bad closes_at');
      if (new Date(closesAt.replace(' ', 'T') + 'Z').getTime() <= Date.now()) throw bad('closes_at is in the past');
    }
    const ids = [...new Set((Array.isArray(body.book_ids) ? body.book_ids : []).map(Number).filter(Boolean))];
    if (ids.length < 2) throw bad('a poll needs at least 2 books');
    if (ids.length > 8) throw bad('8 books max per poll');
    const options = [];
    const seenKeys = new Set();
    for (const id of ids) {
      const b = db.prepare('SELECT * FROM books WHERE id=?').get(id);
      if (!b) throw bad(`book ${id} not found`);
      const key = resolveWork(workKeyForBook(b)).canonical;
      if (seenKeys.has(key)) continue; // two copies of one work = one option
      seenKeys.add(key);
      options.push({ key, b });
    }
    if (options.length < 2) throw bad('a poll needs at least 2 different books');
    const pollId = db.prepare('INSERT INTO polls (user_id, question, closes_at) VALUES (?,?,?)')
      .run(uid, question, closesAt).lastInsertRowid;
    const insOpt = db.prepare(`
      INSERT INTO poll_options (poll_id, work_key, book_id, title, author, cover_url, hardcover_id, proposed_by, position)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    options.forEach(({ key, b }, i) =>
      insOpt.run(pollId, key, b.id, b.title, b.author, b.cover_url, b.hardcover_id, uid, i));
    nudgeUsers(allOtherMemberIds(uid), 'poll', { poll_id: pollId, question, closes_at: closesAt }, uid);
    res.json({ poll: pollView(pollRow(pollId), uid, req.user?.is_admin) });
  } catch (err) { next(err); }
});

// Single poll — the bell's poll/pick nudges deep-link into a modal built
// from this.
r.get('/:id', (req, res, next) => {
  try {
    const p = pollRow(req.params.id);
    if (!p) throw bad('poll not found');
    res.json({ poll: pollView(p, currentUserId(), req.user?.is_admin) });
  } catch (err) { next(err); }
});

// Vote or revote — the UNIQUE(poll_id, user_id) row is upserted, so a switch
// moves the vote and live tallies stay truthful. No bell per vote: a poll
// isn't a conversation, it's a tally.
r.post('/:id/vote', (req, res, next) => {
  try {
    const uid = currentUserId();
    const p = pollRow(req.params.id);
    if (!p) throw bad('poll not found');
    if (p.status !== 'open') throw bad('this poll is closed');
    const opt = db.prepare('SELECT id FROM poll_options WHERE id=? AND poll_id=?')
      .get(req.body?.option_id, p.id);
    if (!opt) throw bad('option not found');
    db.prepare(`INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES (?,?,?)
      ON CONFLICT(poll_id, user_id) DO UPDATE SET option_id=excluded.option_id, created_at=datetime('now')`)
      .run(p.id, opt.id, uid);
    res.json({ options: optionsWithTallies(p.id, uid), my_option_id: opt.id });
  } catch (err) { next(err); }
});

// Manual close: the creator's call, admin as backstop. Crowns the winner as
// the pick and nudges the club.
r.post('/:id/close', (req, res, next) => {
  try {
    const uid = currentUserId();
    const p = pollRow(req.params.id);
    if (!p) throw bad('poll not found');
    if (p.status !== 'open') throw bad('already closed');
    if (p.user_id !== uid && !req.user?.is_admin) {
      throw Object.assign(new Error('only the poll\u2019s creator or an admin can close it'), { status: 403 });
    }
    const pickId = closePoll(p, uid);
    res.json({
      poll: pollView(pollRow(p.id), uid, req.user?.is_admin),
      pick_id: pickId,
    });
  } catch (err) { next(err); }
});

r.delete('/:id', (req, res, next) => {
  try {
    const uid = currentUserId();
    const p = pollRow(req.params.id);
    if (!p) throw bad('poll not found');
    if (p.user_id !== uid && !req.user?.is_admin) {
      throw Object.assign(new Error('only the poll\u2019s creator or an admin can delete it'), { status: 403 });
    }
    db.prepare('DELETE FROM polls WHERE id=?').run(p.id); // options, votes, pick, joins cascade
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// "I'm in": join the pick. Your own copy of the work counts as-is; otherwise
// the winner copies itself onto your shelf (dedupe + Hardcover anchor — the
// same addCopyForUser path as POST /books) and queues it, because a fresh
// copy means you haven't read it. An existing copy is left exactly as the
// member keeps it — next-up flag included. Joining twice is one join. On an
// ACTIVE readalong a first-time join also tells the people already
// committed (participants + the poll's creator) — a leave never rings.
r.post('/picks/:id/join', async (req, res, next) => {
  try {
    const uid = currentUserId();
    const pick = db.prepare('SELECT * FROM club_picks WHERE id=?').get(req.params.id);
    if (!pick) throw bad('pick not found');
    const { bookIds } = resolveWork(pick.work_key);
    let bookId = db.prepare(
      `SELECT id FROM books WHERE user_id=? AND id IN (${bookIds.map(() => '?').join(',') || 'SELECT NULL'})
       ORDER BY id LIMIT 1`).get(uid, ...bookIds)?.id || null;
    let queued = false;
    if (!bookId) {
      const { book } = await addCopyForUser(uid, {
        title: pick.title,
        author: pick.author,
        cover_url: pick.cover_url,
        source_provider: pick.hardcover_id ? 'hardcover' : 'club-pick',
        source_id: pick.hardcover_id ?? `pick-${pick.id}`,
      });
      bookId = book.id;
      const hasEvents = db.prepare('SELECT 1 FROM events WHERE user_id=? AND book_id=? LIMIT 1').get(uid, bookId);
      if (!hasEvents) {
        db.prepare("INSERT INTO tbr (user_id, book_id, source) VALUES (?,?,'pick')").run(uid, bookId);
        queued = true;
      }
    }
    const join = db.prepare('INSERT OR IGNORE INTO pick_participants (pick_id, user_id, book_id) VALUES (?,?,?)')
      .run(pick.id, uid, bookId);
    if (join.changes && pick.target_finish) {
      const others = db.prepare('SELECT user_id FROM pick_participants WHERE pick_id=? AND user_id != ?')
        .all(pick.id, uid).map((r) => r.user_id);
      const creator = db.prepare('SELECT user_id FROM polls WHERE id=?').get(pick.poll_id)?.user_id;
      nudgeUsers([...others, creator], 'readalong',
        { act: 'join', pick_id: pick.id, poll_id: pick.poll_id, title: pick.title }, uid);
    }
    res.json({
      pick: pickView(db.prepare('SELECT * FROM club_picks WHERE id=?').get(pick.id), uid, req.user?.is_admin),
      queued,
    });
  } catch (err) { next(err); }
});

// Leave: the join row goes, the shelf copy stays — undoing an accidental
// tap shouldn't delete a book the member now owns. Never rings a bell.
r.delete('/picks/:id/join', (req, res, next) => {
  try {
    const uid = currentUserId();
    const pick = db.prepare('SELECT * FROM club_picks WHERE id=?').get(req.params.id);
    if (!pick) throw bad('pick not found');
    db.prepare('DELETE FROM pick_participants WHERE pick_id=? AND user_id=?').run(pick.id, uid);
    res.json({ pick: pickView(pick, uid, req.user?.is_admin) });
  } catch (err) { next(err); }
});

// Single pick — the readalong modal's one fetch (wall + pace + chatter ref).
r.get('/picks/:id', (req, res, next) => {
  try {
    const pick = db.prepare('SELECT * FROM club_picks WHERE id=?').get(req.params.id);
    if (!pick) throw bad('pick not found');
    res.json({ pick: pickView(pick, currentUserId(), req.user?.is_admin) });
  } catch (err) { next(err); }
});

// Start or re-date the readalong: the pick's pace window. The poll's creator
// (admin backstop) paces it — the same hand that closed the poll. The FIRST
// start rings the whole club; moving the target later is silent (the wall
// shows the new date), and the start anchor never moves with it.
r.post('/picks/:id/readalong', (req, res, next) => {
  try {
    const uid = currentUserId();
    const pick = db.prepare('SELECT * FROM club_picks WHERE id=?').get(req.params.id);
    if (!pick) throw bad('pick not found');
    const poll = db.prepare('SELECT user_id FROM polls WHERE id=?').get(pick.poll_id);
    if (poll?.user_id !== uid && !req.user?.is_admin) {
      throw Object.assign(new Error('only the poll\u2019s creator or an admin can pace this readalong'), { status: 403 });
    }
    const target = String(req.body?.target_finish || '');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(target)) throw bad('bad target_finish');
    if (new Date(target.replace(' ', 'T') + 'Z').getTime() <= Date.now()) throw bad('target_finish is in the past');
    const wasActive = !!pick.target_finish;
    db.prepare(`UPDATE club_picks SET target_finish=?,
        readalong_started_at=COALESCE(readalong_started_at, datetime('now')) WHERE id=?`)
      .run(target, pick.id);
    if (!wasActive) {
      nudgeUsers(allOtherMemberIds(uid), 'readalong',
        { act: 'start', pick_id: pick.id, poll_id: pick.poll_id, title: pick.title, target_finish: target }, uid);
    }
    res.json({ pick: pickView(db.prepare('SELECT * FROM club_picks WHERE id=?').get(pick.id), uid, req.user?.is_admin) });
  } catch (err) { next(err); }
});

// End the readalong: the pace window closes, the pick banner returns to its
// crowned state. Silent by design — nobody needs a bell for a wall that
// simply stops being there.
r.delete('/picks/:id/readalong', (req, res, next) => {
  try {
    const uid = currentUserId();
    const pick = db.prepare('SELECT * FROM club_picks WHERE id=?').get(req.params.id);
    if (!pick) throw bad('pick not found');
    const poll = db.prepare('SELECT user_id FROM polls WHERE id=?').get(pick.poll_id);
    if (poll?.user_id !== uid && !req.user?.is_admin) {
      throw Object.assign(new Error('only the poll\u2019s creator or an admin can pace this readalong'), { status: 403 });
    }
    db.prepare('UPDATE club_picks SET target_finish=NULL, readalong_started_at=NULL WHERE id=?').run(pick.id);
    res.json({ pick: pickView(db.prepare('SELECT * FROM club_picks WHERE id=?').get(pick.id), uid, req.user?.is_admin) });
  } catch (err) { next(err); }
});

export default r;
