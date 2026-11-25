// The town crier: echoes live reading activity to the household's Discord.
// A webhook URL (channel ⚙️ → Integrations → Webhooks) is the whole contract —
// POST a small JSON, a message appears. No bot, no library, no schema.
//
// What reaches Discord mirrors the circle-nudge rules exactly (see notify.js):
// live finishes from the app and finishes first observed by an ABS sync —
// never import/backfill paths, which don't call these functions at all.
// Starts are UI-only (quick-status, manual log, edit-to-reading): syncs open
// reading events for any progress > 0 with no freshness gate, so announcing
// those would broadcast every zombie re-open (the Blacktongue resurrection)
// until a tombstone exists. DNFs never announce — they stay private to the log.
//
// Burst-proofing: announcements gather per member for DISCORD_BATCH_SECONDS
// (default 60) after the FIRST event, then leave as ONE post. One finish is
// "<member> finished <title>"; a mass-mark day in ABS lands as "<member>
// finished 37 books — A, B, C, and 34 more" instead of 37 messages. The window anchors at
// the first event, not the latest, so a huge burst can't postpone the post
// forever. Two members finishing in the same minute post separately — a shared
// post would misattribute the books.
//
// Delivery is strictly best-effort: fire-and-forget from the request path (a
// finish must never slow down or fail because Discord is down), failures log
// and drop, and a restart mid-window silently loses whatever was gathering.
// That's the right trade for a celebratory feed — a queue would be ceremony.
import { db } from './db.js';
import { config } from './config.js';

// uid → { timer, finish: Map<bookId, {title, author}>, start: Map<…> } — one
// gathering batch per member. Kinds batch independently: a finish-and-start
// flurry becomes one post of each, not a merged mush.
const batches = new Map();

const post = (content) => fetch(config.discord.webhookUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  // The webhook speaks as the app, so the household knows who's talking.
  body: JSON.stringify({ username: 'Inkhearth', content }),
  signal: AbortSignal.timeout(8000),
});

// One line per member per kind: a lone book reads as a sentence, a pile reads
// as a count with the first three titles and a hop into the app — the
// finisher's own shelf (#members/<id> is an existing hash route), where the
// books in the post actually live. Discord renders masked markdown links.
const messageFor = (name, verb, emoji, items, appLink) => {
  const titles = [...items.values()];
  const head = `**${name}** ${verb}`;
  if (titles.length === 1) {
    const { title, author } = titles[0];
    return `${emoji} ${head} **${title}**${author ? ` by ${author}` : ''}`;
  }
  const shown = titles.slice(0, 3).map((t) => `*${t.title}*`).join(', ');
  const rest = titles.length - Math.min(3, titles.length);
  // "and N more" only when titles were actually held back; the tail is the
  // household's phrasing — check them out on InkHearth, as the link itself.
  let tail = rest > 0 ? `, and ${rest} more` : '';
  tail += appLink ? ` — [check them out on InkHearth](${appLink})` : '!';
  return `${emoji} ${head} ${titles.length} books — ${shown}${tail}`;
};

const flush = (uid) => {
  const batch = batches.get(uid);
  batches.delete(uid); // cleared before posting: a failure drops the batch,
  // it never re-flashes on the next event (and the timer is one-shot anyway).
  if (!batch) return;
  const name = db.prepare('SELECT name FROM users WHERE id=?').get(uid)?.name || 'A reader';
  const appLink = config.discord.appUrl ? `${config.discord.appUrl}/#members/${uid}` : null;
  for (const [kind, emoji, verb] of [['finish', '📚', 'finished'], ['start', '▶️', 'started reading']]) {
    if (!batch[kind].size) continue;
    post(messageFor(name, verb, emoji, batch[kind], appLink)).catch((err) => {
      // 429s land here too — best-effort means drop, not retry-storm.
      console.error(`[${new Date().toISOString()}] discord flush failed:`, err.message);
    });
  }
};

const enqueue = (uid, kind, book) => {
  if (!config.discord.webhookUrl || !book?.id || !book?.title) return;
  let batch = batches.get(uid);
  if (!batch) {
    batch = { timer: null, finish: new Map(), start: new Map() };
    batches.set(uid, batch);
    // The window anchors here — only the first event of a batch sets the
    // timer. unref() so a pending post can never hold the process open.
    batch.timer = setTimeout(() => flush(uid), Math.max(0, config.discord.batchSeconds) * 1000);
    batch.timer.unref();
  }
  // Map-set dedupes by book id: the same book re-fired inside a window
  // (edit flip after quick-status, a sync racing a button) counts once.
  batch[kind].set(book.id, { title: book.title, author: book.author || null });
};

export function announceFinish(uid, book) { enqueue(uid, 'finish', book); }
export function announceStart(uid, book) { enqueue(uid, 'start', book); }
