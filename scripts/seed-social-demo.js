// Seed synthetic household chatter on STAGING so the social surfaces demo
// well when only one real member is around. Creates four passwordless demo
// members who mirror a few of the anchor member's real books and fill the
// work threads with comments positioned around the anchor's real progress —
// some visible to them, some deliberately locked ahead, one spoiler-flagged.
//
// The anchor member's rows are only ever READ. Demo accounts carry
// prefs.demo_social=1 so they're identifiable and removable.
//
// Idempotent: exits cleanly if the demo already has comments.
//   --reset    remove the demo accounts (and everything they own) first
//   --reset    plus --reset-only: remove and exit without reseeding
//
// Run inside the staging container (same data/ the server uses):
//   docker compose -p booktracker-staging -f docker-compose.staging.yml \
//     exec booktracker-staging node scripts/seed-social-demo.js
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.BT_DB_PATH || 'data/booktracker.db');
const reset = process.argv.includes('--reset');

const NAMES = ['Nadia', 'Theo', 'Marisol', 'Priya'];

if (reset) {
  for (const name of NAMES) {
    // The prefs guard means a real member who happens to share a demo name
    // is never touched. Books go first — books→users has no cascade (the
    // smoke test's cleanup unloads in the same order); events and TBR rows
    // cascade off the books, comments/reactions/sessions/polls off the user.
    const u = db.prepare("SELECT id FROM users WHERE name=? AND prefs LIKE '%demo_social%'").get(name);
    if (!u) continue;
    db.prepare('DELETE FROM books WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    console.log(`reset: removed demo account "${name}"`);
  }
  // The bell nudges the demo addressed to the anchor are demo artifacts too
  // (every actor is a demo user) — they'd otherwise point at deleted rows.
  const demoIds = NAMES.map((n) => db.prepare("SELECT id FROM users WHERE name=? AND prefs LIKE '%demo_social%'").get(n)?.id).filter(Boolean);
  if (demoIds.length) {
    db.prepare(`DELETE FROM notifications WHERE actor_id IN (${demoIds.map(() => '?').join(',')})`).run(...demoIds);
  }
  if (process.argv.includes('--reset-only')) process.exit(0);
}

// Mirror of server/works.js's work identity (kept inline so this script stays
// a standalone sqlite utility, like seed-demo.js).
const norm = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
const workKeyFor = (b) => (b.hardcover_id ? 'hc:' + b.hardcover_id : 't:' + norm(b.title) + '|' + norm(b.author));

// Anchor: the real member the demo arranges itself around — the first admin
// (the instance's founding account; on the origin instance that's the same
// hand that claims the boot link).
const anchor = db.prepare('SELECT id, name FROM users WHERE is_admin=1 ORDER BY id LIMIT 1').get();
if (!anchor) throw new Error('no anchor member found (no admin account)');
console.log(`anchor: ${anchor.name} (user ${anchor.id}) — read-only`);

// Demo members: passwordless (login verify can never pass), publicly visible
// so they show up on the Members page like everyone else.
const uidOf = {};
for (const name of NAMES) {
  const existing = db.prepare('SELECT id, prefs FROM users WHERE name=?').get(name);
  if (existing && !(existing.prefs || '').includes('demo_social')) {
    throw new Error(`a real member named "${name}" exists — refusing to seed over them; change NAMES`);
  }
  if (!existing) {
    const i = db.prepare("INSERT INTO users (name, profile_public, share_compare, prefs) VALUES (?,1,1,?)")
      .run(name, JSON.stringify({ demo_social: 1 }));
    uidOf[name] = Number(i.lastInsertRowid);
  } else {
    uidOf[name] = existing.id;
  }
}

// Per-surface seeding gates: an upgrade (this script gaining a new surface)
// must fill in the new part without duplicating what's already there. A
// surface seeds only when it has zero rows of its own; the script exits when
// there's nothing left to do.
const demoUserIds = NAMES.map((n) => uidOf[n]);
const demoCommentCount = db.prepare(
  `SELECT COUNT(*) AS n FROM book_comments WHERE user_id IN (${demoUserIds.map(() => '?').join(',')})`)
  .get(...demoUserIds).n;
const demoPollCount = db.prepare(
  `SELECT COUNT(*) AS n FROM polls WHERE user_id IN (${demoUserIds.map(() => '?').join(',')})`)
  .get(...demoUserIds).n;
const seedChatter = demoCommentCount === 0;
const seedPolls = demoPollCount === 0;
if (!seedChatter && !seedPolls) {
  console.log(`demo social already seeded (${demoCommentCount} comments, ${demoPollCount} polls) — nothing to do. Use --reset to reseed.`);
  process.exit(0);
}
if (!seedChatter) console.log(`chatter already seeded (${demoCommentCount} comments) — leaving it in place.`);
if (!seedPolls) console.log(`polls already seeded (${demoPollCount}) — leaving them in place.`);

// Anchor books to mirror: what they're mid-way through (up to 2 — those make
// the progress gating legible) plus their most recent finish.
const anchorReading = db.prepare(`
  SELECT b.*, e.percent AS anchor_percent FROM books b
  JOIN events e ON e.book_id = b.id AND e.user_id = b.user_id
  WHERE b.user_id=? AND e.status='reading' ORDER BY e.id DESC LIMIT 2`).all(anchor.id);
const anchorFinished = db.prepare(`
  SELECT b.*, 100 AS anchor_percent FROM books b
  JOIN events e ON e.book_id = b.id AND e.user_id = b.user_id
  WHERE b.user_id=? AND e.status='finished' ORDER BY e.finished_at DESC LIMIT 1`).all(anchor.id);
const anchors = [...anchorReading, ...anchorFinished];
if (!anchors.length) throw new Error('anchor member has no books to mirror');
for (const b of anchors) console.log(`mirroring: ${b.title}${b.author ? ' — ' + b.author : ''} (anchor at ${b.anchor_percent}%)`);

const insBook = db.prepare(`INSERT INTO books
  (user_id, title, author, series_name, series_order, hardcover_id, cover_url, page_count,
   audio_runtime_minutes, genres, source_provider, source_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,'demo-social',?)`);
const copyFor = (uid, b) => {
  const sourceId = `${uid}-${b.id}`;
  const ex = db.prepare("SELECT id FROM books WHERE user_id=? AND source_provider='demo-social' AND source_id=?")
    .get(uid, sourceId);
  if (ex) return ex.id;
  return Number(insBook.run(uid, b.title, b.author, b.series_name, b.series_order, b.hardcover_id,
    b.cover_url, b.page_count, b.audio_runtime_minutes, b.genres, sourceId).lastInsertRowid);
};

const insEvent = db.prepare(`INSERT INTO events
  (user_id, book_id, format, medium, status, percent, progress_at, finished_at, rating,
   narration_rating, notes, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const addFinish = (uid, bookId, listen, rating, daysAgo, notes) =>
  insEvent.run(uid, bookId, listen ? 'listened' : 'read', listen ? 'audiobook' : null, 'finished',
    null, null, isoDaysAgo(daysAgo), rating, listen ? 'A' : null, notes || null, isoDaysAgo(daysAgo));
const addReading = (uid, bookId, listen, percent, daysAgo) =>
  insEvent.run(uid, bookId, listen ? 'listened' : 'read', listen ? 'audiobook' : null, 'reading',
    percent, isoHoursAgo(20), null, null, null, null, isoDaysAgo(daysAgo));
// SQLite takes full ISO strings in datetime() arithmetic fine, but explicit
// formatting keeps the events table consistent with the app's own writes.
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function isoHoursAgo(n) {
  const d = new Date(Date.now() - n * 3600_000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const insComment = db.prepare(`INSERT INTO book_comments
  (user_id, work_key, book_id, body, progress_percent, contains_spoiler, created_at)
  VALUES (?,?,?,?,?,?, datetime('now', ?))`);
const insReaction = db.prepare(`INSERT INTO reactions (kind, target_id, user_id, emoji, created_at)
  VALUES ('comment',?,?,?, datetime('now', ?))`);

// One mirror row per anchor book: every demo member gets a copy and a
// position; the comments land on the shared work thread.
let commentCount = 0;
const say = (uid, book, body, percent, spoiler, when) => {
  insComment.run(uid, workKeyFor(book), copyFor(uid, book), body, percent, spoiler ? 1 : 0, when);
  commentCount += 1;
  return db.prepare('SELECT id FROM book_comments ORDER BY id DESC LIMIT 1').get().id;
};
const react = (commentId, uid, emoji, when) => insReaction.run(commentId, uid, emoji, when);

// A book the anchor doesn't own — found through the household card, joinable
// without a shelf copy. Defined unconditionally: the poll options below
// reference it too. (Every field bound explicitly: node:sqlite rejects
// undefined params.)
const NOTW = {
  id: 'notw', // stable source_id half for copyFor's dedupe key
  title: 'The Name of the Wind', author: 'Patrick Rothfuss', hardcover_id: null,
  series_name: 'The Kingkiller Chronicle', series_order: 1, cover_url: null,
  page_count: 662, audio_runtime_minutes: null, genres: '["Fantasy"]',
};

let cheerCount = 0;
let nudgeCount = 0;
if (seedChatter) {
  // One mirror row per anchor book: every demo member gets a copy and a
  // position; the comments land on the shared work thread.
  for (const [i, b] of anchors.entries()) {
    const listen = !!b.audio_runtime_minutes;
    const pct = b.anchor_percent ?? 0;
    const inProgress = anchorReading.includes(b);
    const nadia = uidOf.Nadia, theo = uidOf.Theo, marisol = uidOf.Marisol, priya = uidOf.Priya;

    const nadiaCopy = copyFor(nadia, b);
    addFinish(nadia, nadiaCopy, listen, i % 2 ? 'A' : 'S', 18 - i, 'devour');
    const theoCopy = copyFor(theo, b);
    const theoPct = inProgress ? Math.min(97, pct + 12) : null;
    if (inProgress) addReading(theo, theoCopy, listen, theoPct, 12 - i);
    else addFinish(theo, theoCopy, listen, 'A', 9 - i);
    const marisolCopy = copyFor(marisol, b);
    const mariPct = inProgress ? Math.max(4, pct - 35) : null;
    if (inProgress) addReading(marisol, marisolCopy, listen, mariPct, 6 - i);
    else addFinish(marisol, marisolCopy, listen, 'B', 5 - i);

    say(nadia, b, 'Finished this one last week and I\u2019m still thinking about the ending. No notes, just vibes.', null, 0, '-6 days');
    const locked = say(theo, b,
      inProgress
        ? `Past the ${Math.round((theoPct || 80) / 10) * 10}% mark — the last stretch recontextualizes everything. Keep going.`
        : 'That final act. Wow.',
      theoPct, 0, '-4 days');
    if (!inProgress) {
      say(theo, b, 'The final act is a gut punch. That\u2019s all I\u2019ll say.', 100, 1, '-3 days');
    }
    say(marisol, b,
      inProgress ? 'Is it just me, or is the middle a bit of a slog? Pushing through for the pay everyone keeps promising.'
        : 'Solid, not spectacular. The narration carries it.', mariPct, 0, '-2 days');
    const priyaC = say(priya, b, 'Queued! Everyone here won\u2019t stop mentioning it. NO SPOILERS please.', null, 0, '-1 days');
    react(locked, nadia, '🔥', '-3 days');
    react(priyaC, marisol, '😂', '-20 hours');
  }

  const theoN = copyFor(uidOf.Theo, NOTW);
  addFinish(uidOf.Theo, theoN, false, 'S', 10, 're-read');
  const mariN = copyFor(uidOf.Marisol, NOTW);
  addReading(uidOf.Marisol, mariN, false, 45, 8);
  say(uidOf.Theo, NOTW, 'The prose is the whole show. Slow opening, but once Kvothe starts talking it doesn\u2019t let go.', 100, 0, '-5 days');
  say(uidOf.Marisol, NOTW, 'Halfway through and the inn chapter was somehow my favorite part of the whole book so far.', 45, 0, '-30 hours');
  say(uidOf.Nadia, NOTW, 'This one\u2019s on my shelf for October — starting it next week.', null, 0, '-12 hours');

  // Priya's TBR: one of the anchor's books, flagged next-up like the real
  // queue does it.
  if (anchors[0]) {
    db.prepare(`INSERT INTO tbr (user_id, book_id, source, priority, is_next_up, status, added_at)
      VALUES (?,?, 'demo', 0, 1, 'queued', datetime('now'))`)
      .run(uidOf.Priya, copyFor(uidOf.Priya, anchors[0]));
  }

  // The anchor's bell: demo members cheer the anchor's three most recent
  // finishes (read-only — the reactions attach to the anchor's events but are
  // authored by demo users), and the two newest demo comments arrive as
  // unseen nudges so the badge has something to say on first open.
  const anchorFinishes = db.prepare(`
    SELECT e.id AS event_id, b.id AS book_id, b.title FROM events e
    JOIN books b ON b.id = e.book_id
    WHERE e.user_id=? AND e.status='finished' ORDER BY e.created_at DESC LIMIT 3`).all(anchor.id);
  cheerCount = anchorFinishes.length;
  const cheery = [uidOf.Nadia, uidOf.Marisol, uidOf.Priya];
  for (const [i, ev] of anchorFinishes.entries()) {
    db.prepare(`INSERT OR IGNORE INTO reactions (kind, target_id, user_id, emoji, created_at)
      VALUES ('event', ?, ?, '👏', datetime('now', ?))`)
      .run(ev.event_id, cheery[i % cheery.length], `${-(i + 2)} days`);
    db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, payload, created_at)
      VALUES (?, 'cheer', ?, ?, datetime('now', ?))`)
      .run(anchor.id, cheery[i % cheery.length],
        JSON.stringify({ event_id: ev.event_id, book_id: ev.book_id, title: ev.title, emoji: '👏' }),
        `-${i + 2} days`);
  }
  // Nudges reference the works the ANCHOR actually owns (by work key — the
  // demo comments attach to the commenters' own copies), and each payload's
  // book_id points at the anchor's copy so the bell deep-links to their modal.
  const anchorKeys = new Map(anchors.map((b) => [workKeyFor(b), b.id]));
  const nudges = db.prepare(`
    SELECT c.id, c.user_id, c.work_key, b.title FROM book_comments c
    JOIN books b ON b.id = c.book_id
    WHERE c.user_id IN (${NAMES.map(() => '?').join(',')})
      AND c.work_key IN (${[...anchorKeys.keys()].map(() => '?').join(',')})
    ORDER BY c.id DESC LIMIT 2`).all(...NAMES.map((n) => uidOf[n]), ...anchorKeys.keys());
  nudgeCount = nudges.length;
  for (const [i, c] of nudges.entries()) {
    db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, payload, created_at)
      VALUES (?, 'comment', ?, ?, datetime('now', ?))`)
      .run(anchor.id, c.user_id,
        JSON.stringify({ book_id: anchorKeys.get(c.work_key), work: c.work_key, title: c.title, comment_id: c.id }),
        `-${i + 3} hours`);
  }
}

// Club polls & the Hearth pick: one live poll seeded from the mirrored works
// (every option points at a demo copy, so the client-side stamping story
// holds) and one closed poll whose winner became the pick with a couple of
// "I'm in" joins — the dashboard banner and the polls page demo themselves.
let pollSummary = 'polls already present';
if (seedPolls) {
  const insPoll = db.prepare(`INSERT INTO polls
    (user_id, question, status, closes_at, closed_at, closed_by, created_at)
    VALUES (?,?,?,?,?,?, datetime('now', ?))`);
  const insOpt = db.prepare(`INSERT INTO poll_options
    (poll_id, work_key, book_id, title, author, cover_url, hardcover_id, proposed_by, position)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insVote = db.prepare(`INSERT INTO poll_votes (poll_id, option_id, user_id, created_at)
    VALUES (?,?,?, datetime('now', ?))`);
  const insPick = db.prepare(`INSERT INTO club_picks
    (poll_id, option_id, work_key, book_id, title, author, cover_url, hardcover_id, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?, datetime('now', ?))`);
  const insJoin = db.prepare(`INSERT INTO pick_participants (pick_id, user_id, book_id, joined_at)
    VALUES (?,?,?, datetime('now', ?))`);
  // Options carry a demo copy id (copyFor dedupes), never the anchor's rows.
  const seedOption = (pollId, book, proposer, position) => {
    insOpt.run(pollId, workKeyFor(book), copyFor(proposer, book), book.title, book.author,
      book.cover_url, book.hardcover_id, proposer, position);
  };

  // Closed poll first, live poll second — row ids mirror real chronology, and
  // the dashboard banner only promotes an open poll newer than the last pick.
  const finishedBook = anchors.find((b) => !anchorReading.includes(b)) || anchors[0];
  const runnerUp = finishedBook === anchors[0] ? NOTW : anchors[0];
  const closedPollId = Number(insPoll.run(uidOf.Theo, 'Which one do we all read together?',
    'closed', null, isoDaysAgo(2), uidOf.Theo, '-5 days').lastInsertRowid);
  seedOption(closedPollId, finishedBook, uidOf.Theo, 0);
  seedOption(closedPollId, runnerUp, uidOf.Theo, 1);
  const closedOptIds = db.prepare('SELECT id FROM poll_options WHERE poll_id=? ORDER BY position').all(closedPollId).map((o) => o.id);
  insVote.run(closedPollId, closedOptIds[0], uidOf.Nadia, '-4 days');
  insVote.run(closedPollId, closedOptIds[0], uidOf.Marisol, '-4 days');
  insVote.run(closedPollId, closedOptIds[1], uidOf.Priya, '-3 days');
  const pickId = Number(insPick.run(closedPollId, closedOptIds[0], workKeyFor(finishedBook),
    copyFor(uidOf.Theo, finishedBook), finishedBook.title, finishedBook.author, finishedBook.cover_url,
    finishedBook.hardcover_id, uidOf.Theo, '-2 days').lastInsertRowid);
  insJoin.run(pickId, uidOf.Marisol, copyFor(uidOf.Marisol, finishedBook), '-2 days');
  const priyaPickCopy = copyFor(uidOf.Priya, finishedBook);
  insJoin.run(pickId, uidOf.Priya, priyaPickCopy, '-1 days');
  // The pick runs as a readalong: started yesterday, ends in eleven days.
  // Theo and Marisol's chatter-block finishes put them at 100% on this work;
  // Priya gets a real reading position so the wall varies (finished,
  // finished, ahead — expected pace today sits near 8%).
  db.prepare('UPDATE club_picks SET target_finish=?, readalong_started_at=? WHERE id=?')
    .run(isoDaysAgo(-11), isoDaysAgo(1), pickId);
  addReading(uidOf.Priya, priyaPickCopy, !!finishedBook.audio_runtime_minutes, 62, 1);

  // Live poll: closes in six days, votes already split so the tallies breathe.
  const openPollId = Number(insPoll.run(uidOf.Nadia, 'What should the club read next?',
    'open', isoDaysAgo(-6), null, null, '-1 days').lastInsertRowid);
  const liveChoices = [anchors[0], NOTW, ...(anchors[1] ? [anchors[1]] : [])];
  liveChoices.forEach((b, i) => seedOption(openPollId, b, uidOf.Nadia, i));
  const liveOptIds = db.prepare('SELECT id FROM poll_options WHERE poll_id=? ORDER BY position').all(openPollId).map((o) => o.id);
  insVote.run(openPollId, liveOptIds[0], uidOf.Theo, '-20 hours');
  insVote.run(openPollId, liveOptIds[1], uidOf.Marisol, '-16 hours');
  insVote.run(openPollId, liveOptIds[1], uidOf.Priya, '-9 hours');

  // Two fresh bell rows for the anchor: the live poll and the crowned pick —
  // clicking either opens the poll modal, both demo the new nudge kinds.
  db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, payload, created_at)
    VALUES (?, 'poll', ?, ?, datetime('now', ?))`)
    .run(anchor.id, uidOf.Nadia,
      JSON.stringify({ poll_id: openPollId, question: 'What should the club read next?', closes_at: isoDaysAgo(-6) }),
      '-19 hours');
  db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, payload, created_at)
    VALUES (?, 'pick', ?, ?, datetime('now', ?))`)
    .run(anchor.id, uidOf.Theo,
      JSON.stringify({ poll_id: closedPollId, pick_id: pickId, question: 'Which one do we all read together?', title: finishedBook.title }),
      '-2 hours');
  // The readalong's start rang too — the freshest nudge, so the bell demos
  // the deep link into the pace wall.
  db.prepare(`INSERT INTO notifications (user_id, kind, actor_id, payload, created_at)
    VALUES (?, 'readalong', ?, ?, datetime('now', ?))`)
    .run(anchor.id, uidOf.Theo,
      JSON.stringify({ act: 'start', pick_id: pickId, poll_id: closedPollId, title: finishedBook.title, target_finish: isoDaysAgo(-11) }),
      '-40 minutes');

  pollSummary = `2 poll(s) (${liveChoices.length + 2} options), 1 pick with 2 joins`;
}

console.log(`seeded ${NAMES.join(', ')} with ${anchors.length + 1} thread(s), ${commentCount} comments, `
  + `${cheerCount} cheer(s), ${nudgeCount} comment nudge(s), ` + pollSummary + '.');
console.log('done.');
