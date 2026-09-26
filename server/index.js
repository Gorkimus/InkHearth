import express from 'express';
import path from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import booksRouter from './routes/books.js';
import statsRouter from './routes/stats.js';
import adminRouter from './routes/admin.js';
import jobsRouter from './routes/jobs.js';
import tierRouter from './routes/tier.js';
import compareRouter from './routes/compare.js';
import recommendationsRouter from './routes/recommendations.js';
// HIBERNATING Sept 25 2026 (Storyteller Selection): re-add both lines to wake —
// import storytellersRouter from './routes/storytellers.js';
import membersRouter from './routes/members.js';
import feedbackRouter from './routes/feedback.js';
import authRouter from './routes/auth.js';
import avatarRouter from './routes/avatar.js';
import { failOrphanedJobs, createJob } from './jobs.js';
import { readSessionCookie, sessionUser, runWithUser, createInvite } from './auth.js';
import { listBackups, takeSnapshot, pruneSnapshots } from './backup.js';
import { runCleanup } from './cleanup.js';
import { reconcileGenresBatch } from './imports/book-refresh.js';

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy (nginx/caddy/tunnel) set TRUST_PROXY=1 so req.ip —
// and with it the login rate limit — sees the real client, not the proxy.
if (config.trustProxy) app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Baseline security headers. Camera stays same-origin only: the barcode
// scanner needs it. HSTS only makes sense once HTTPS is on (COOKIE_SECURE=1).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Auth gate: every /api call needs a session, except auth itself, meta and
// health. Inside the gate the request runs as the session user (see
// request-context.js); unauthenticated requests never reach a route.
const AUTH_EXEMPT = [/^\/auth\//, /^\/meta$/, /^\/health$/];
app.use('/api', (req, res, next) => {
  const user = sessionUser(readSessionCookie(req));
  if (!user && !AUTH_EXEMPT.some((re) => re.test(req.path))) {
    return res.status(401).json({ error: 'not signed in' });
  }
  req.user = user;
  runWithUser(user?.id ?? null, next);
});
app.use('/api/auth', authRouter);

// Covers downloaded from ABS by the import script live here, served locally
// so image URLs never embed the ABS token and survive ABS downtime.
app.use('/covers', express.static(path.join(config.root, 'data', 'covers')));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', booksRouter);
app.use('/api', statsRouter);
app.use('/api', adminRouter);
app.use('/api', jobsRouter);
app.use('/api', tierRouter);
app.use('/api', compareRouter);
app.use('/api', recommendationsRouter);
// HIBERNATING Sept 25 2026: app.use('/api', storytellersRouter);
app.use('/api', membersRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api', avatarRouter);

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(pub));
// SPA fallback for any non-API GET — but a missing cover file is a 404, not the app.
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/covers')) {
    return res.sendFile(path.join(pub, 'index.html'));
  }
  next();
});

// JSON error handler — routes attach .status when they know better than 500.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'server error' });
});

const server = app.listen(config.port, () => {
  console.log(`Book Tracker → http://localhost:${config.port}`);
});
// Jobs are in-process; anything mid-flight from a previous server is dead.
failOrphanedJobs();

// First boot after auth lands: the admin has no password yet. Print a
// one-time claim link (reprints on restart until the account is claimed;
// each link self-expires in 7 days so stale printouts can't pile up).
const claimAdmin = db.prepare(
  'SELECT id FROM users WHERE is_admin=1 AND password_hash IS NULL ORDER BY id LIMIT 1'
).get();
if (claimAdmin) {
  const token = createInvite(claimAdmin.id, { expiresInDays: 7 });
  console.log(`\n  Admin account not set up yet — claim it with this one-time link (valid 7 days):\n\n  http://localhost:${config.port}/#invite/${token}\n`);
}
// Kobo imports pace one Hardcover call every ~400ms — big libraries can take
// several minutes for a single request.
server.requestTimeout = 600000;

// A self-hosted app that dies silently is the worst failure mode — log loudly.
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] unhandled rejection (server stays up):`, reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] uncaught exception, exiting:`, err);
  process.exit(1); // docker restart: unless-stopped brings it back
});

// Linked Kobo devices: enqueue a sync for every link past its interval. The
// check runs on a slow clock; the one-at-a-time job worker absorbs bursts and
// KOBO_SYNC_HOURS=0 turns auto-polling off (manual "Sync now" still works).
const koboSyncHours = config.koboSync.hours;
if (koboSyncHours > 0) {
  setInterval(() => {
    try {
      // A link that has never synced syncs once, right away — unless it
      // already failed (last_error set), in which case it waits for the
      // manual "Sync now" so a broken link can't spin the job worker forever.
      const due = db.prepare(`
        SELECT user_id FROM kobo_links
        WHERE (last_synced_at IS NULL AND last_error IS NULL)
           OR last_synced_at < datetime('now', ?)`)
        .all(`-${koboSyncHours} hours`);
      for (const { user_id } of due) {
        const busy = db.prepare(
          "SELECT 1 FROM jobs WHERE kind='kobo_sync' AND user_id=? AND status IN ('queued','running')")
          .get(user_id);
        if (!busy) createJob(user_id, 'kobo_sync', {});
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] kobo auto-sync enqueue failed:`, err.message);
    }
  }, 30 * 60 * 1000).unref();
}

// Per-member Audiobookshelf links: same clock as the Kobo poll. Every linked
// member's listening progress folds into their events automatically;
// ABS_SYNC_HOURS=0 keeps it manual-only ("Sync now" on the Account page).
const absSyncHours = config.abs.syncHours;
if (absSyncHours > 0) {
  setInterval(() => {
    try {
      const due = db.prepare(`
        SELECT user_id FROM abs_links
        WHERE (last_synced_at IS NULL AND last_error IS NULL)
           OR last_synced_at < datetime('now', ?)`)
        .all(`-${absSyncHours} hours`);
      for (const { user_id } of due) {
        const busy = db.prepare(
          "SELECT 1 FROM jobs WHERE kind='abs_sync' AND user_id=? AND status IN ('queued','running')")
          .get(user_id);
        if (!busy) createJob(user_id, 'abs_sync', {});
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] abs auto-sync enqueue failed:`, err.message);
    }
  }, 30 * 60 * 1000).unref();
}

// Genre reconciler: cross-checks books against Google Books and merges
// canonical genres — silently, so nobody has to refresh a book for its tags
// to be right. Runs once shortly after boot (deploy-day backfill of the whole
// library, budget-capped) then on the GENRE_SYNC_HOURS clock, which also
// catches books logged since the last cycle. GENRE_SYNC_HOURS=0 turns the
// poller off; a per-book or bulk refresh reconciles those books immediately.
const genreSyncHours = config.genreSync.hours;
if (genreSyncHours > 0) {
  let genreSyncBusy = false;
  const genreSyncTick = async () => {
    if (genreSyncBusy) return;
    genreSyncBusy = true;
    try {
      const r = await reconcileGenresBatch({});
      if (r.found) console.log(`[genre-sync] checked ${r.stamped}/${r.found} pending books, ${r.merged} gained Google genres`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] genre sync failed:`, err.message);
    } finally {
      genreSyncBusy = false;
    }
  };
  setTimeout(genreSyncTick, 30 * 1000).unref();
  setInterval(genreSyncTick, genreSyncHours * 60 * 60 * 1000).unref();
}

// Silent nightly snapshots: the household archive shouldn't depend on anyone
// remembering a button. The clock checks hourly (and once at boot) whether
// the newest auto-snapshot is older than BACKUP_HOURS; hand-made .db files
// never prune. BACKUP_HOURS=0 turns the whole thing off.
const backupHours = config.backup.hours;
if (backupHours > 0) {
  const backupTick = () => {
    try {
      const newest = listBackups().find((b) => /^booktracker-\d{14}\.db$/.test(b.name));
      const ageH = newest
        ? (Date.now() - statSync(path.join(config.root, 'backups', newest.name)).mtimeMs) / 3.6e6
        : Infinity;
      if (ageH >= backupHours) {
        const snap = takeSnapshot();
        pruneSnapshots(config.backup.keep);
        console.log(`[${new Date().toISOString()}] snapshot taken: ${snap.file} (${Math.round(snap.bytes / 1024)} KB)`);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] scheduled backup failed:`, err.message);
    }
  };
  backupTick();
  setInterval(backupTick, 60 * 60 * 1000).unref();
}

// Nightly janitor (see cleanup.js): expired sessions, day-old uploads — the
// Kobo device sqlite files carry live sync credentials — and stale data/tmp.
// CLEANUP_HOURS=0 turns it off.
const cleanupHours = config.cleanup.hours;
if (cleanupHours > 0) {
  const cleanupTick = () => {
    try {
      const r = runCleanup();
      if (r.sessions || r.files) {
        console.log(`[${new Date().toISOString()}] cleanup: ${r.sessions} expired session(s), ${r.files} stale upload/tmp file(s)`);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] cleanup failed:`, err.message);
    }
  };
  setTimeout(cleanupTick, 2 * 60 * 1000).unref(); // once shortly after boot…
  setInterval(cleanupTick, cleanupHours * 60 * 60 * 1000).unref();
}
