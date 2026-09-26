import { Router } from 'express';
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { destroyAllSessions } from '../auth.js';
import { hardcoverEnabled } from '../metadata/hardcover.js';
import { hcHealthSummary } from '../metadata/hardcover-import.js';
import { listBackups, takeSnapshot } from '../backup.js';

const router = Router();
const backupDir = path.join(config.root, 'backups');

const requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
};
const bad = (message) => Object.assign(new Error(message), { status: 400 });

// GET /api/backup — list existing snapshots (admin: snapshot names leak data).
router.get('/backup', requireAdmin, (req, res) => {
  res.json({ backups: listBackups() });
});

// POST /api/backup — consistent snapshot via VACUUM INTO; safe to run while
// the server is live (reads a stable view, never blocks writes for long).
// Admin-only and gap-limited: VACUUM is synchronous, and unbounded calls
// would let any member pin the event loop and fill the disk. (The scheduled
// nightly snapshot in index.js bypasses the gap — it's the same code path.)
let lastBackupAt = 0;
const BACKUP_MIN_GAP = 60 * 60 * 1000;
router.post('/backup', requireAdmin, (req, res) => {
  if (Date.now() - lastBackupAt < BACKUP_MIN_GAP) {
    return res.status(429).json({ error: 'a backup was made recently — try again later' });
  }
  const { file, bytes } = takeSnapshot();
  lastBackupAt = Date.now();
  res.json({ file, bytes });
});

// POST /api/admin/restore-account { user_id, file } — surgically replace ONE
// account's data with its state in a snapshot. Everything user-scoped is
// swapped in a single transaction; the account's current password and admin
// flag survive (so nobody is locked out or demoted by a restore), their
// sessions are cleared, and a fresh restore-point snapshot is taken first so
// even a regretted restore can be undone.
// Insert order respects foreign keys (books before events); the DELETE pass
// runs in reverse so children never dangle mid-transaction.
const RESTORE_TABLES = ['books', 'events', 'tbr', 'recommendations', 'avoid_signals',
  'series_overrides', 'kobo_links', 'sessions'];
const RESTORE_DELETE_ORDER = [...RESTORE_TABLES].reverse();

router.post('/admin/restore-account', requireAdmin, (req, res, next) => {
  try {
    const userId = Number(req.body?.user_id);
    const file = String(req.body?.file || '');
    if (!Number.isInteger(userId)) throw bad('user_id required');
    if (!listBackups().some((b) => b.name === file)) throw bad('unknown snapshot');
    const liveUser = db.prepare('SELECT id, name, password_hash, is_admin FROM users WHERE id=?').get(userId);
    if (!liveUser) return res.status(404).json({ error: 'no such user' });

    const snapPath = path.join(backupDir, path.basename(file));
    let snap;
    try {
      snap = new DatabaseSync(snapPath, { readOnly: true });
    } catch {
      return res.status(400).json({ error: 'snapshot file unreadable' });
    }
    try {
      const snapVersion = snap.prepare('PRAGMA user_version').get().user_version;
      const liveVersion = db.prepare('PRAGMA user_version').get().user_version;
      if (snapVersion !== liveVersion) {
        return res.status(400).json({ error: `snapshot schema (v${snapVersion}) differs from the current schema (v${liveVersion}) — pick a newer snapshot` });
      }
      const snapUser = snap.prepare('SELECT id, name FROM users WHERE id=?').get(userId);
      if (!snapUser) return res.status(404).json({ error: `that snapshot has no "${liveUser.name}" account` });

      const restorePoint = takeSnapshot();

      const cols = (t) => snap.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      db.exec('BEGIN');
      // The account row is deleted and re-inserted inside this transaction,
      // and rows we don't restore (invites.created_by, login_audit) still
      // point at it mid-flight — defer FK checks to COMMIT, by which time
      // the user row is back and every reference resolves again.
      db.exec('PRAGMA defer_foreign_keys = ON');
      try {
        for (const t of RESTORE_DELETE_ORDER) db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(userId);
        db.prepare('DELETE FROM users WHERE id=?').run(userId);
        const userCols = cols('users');
        const snapUserRow = snap.prepare('SELECT * FROM users WHERE id=?').get(userId);
        snapUserRow.password_hash = liveUser.password_hash; // credentials stay current
        snapUserRow.is_admin = liveUser.is_admin;            // restores never change who is admin
        db.prepare(`INSERT INTO users (${userCols.join(',')}) VALUES (${userCols.map(() => '?').join(',')})`)
          .run(...userCols.map((c) => snapUserRow[c]));
        const counts = {};
        for (const t of RESTORE_TABLES) {
          const tcols = cols(t);
          const ins = db.prepare(`INSERT INTO ${t} (${tcols.join(',')}) VALUES (${tcols.map(() => '?').join(',')})`);
          const rows = snap.prepare(`SELECT * FROM ${t} WHERE user_id=?`).all(userId);
          for (const r of rows) ins.run(...tcols.map((c) => r[c]));
          counts[t] = rows.length;
        }
        db.exec('COMMIT');
        res.json({ ok: true, restored: counts, restore_point: restorePoint.file });
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } finally {
      snap.close();
    }
  } catch (err) { next(err); }
});

// GET /api/admin/overview — everything the admin panel shows, in one payload:
// instance vitals, per-user access data, login history, job history, kobo
// sync state, library health, integration flags. Read-only except for the
// dedicated revoke endpoint below.
router.get('/admin/overview', requireAdmin, (req, res) => {
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  let dbBytes = null;
  try { dbBytes = statSync(config.dbPath).size; } catch { /* non-fatal */ }

  const users = db.prepare(`
    SELECT u.id, u.name, u.is_admin, u.created_at AS joined,
      (SELECT COUNT(*) FROM books b WHERE b.user_id = u.id) AS books,
      (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id AND e.status = 'finished') AS finished,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS sessions,
      (SELECT MAX(s2.created_at) FROM sessions s2 WHERE s2.user_id = u.id) AS last_login,
      (SELECT MAX(e2.created_at) FROM events e2 WHERE e2.user_id = u.id) AS last_activity
    FROM users u ORDER BY u.name COLLATE NOCASE`)
    .all()
    .map((u) => ({ ...u, is_admin: !!u.is_admin }));

  const sessions = db.prepare(`
    SELECT s.user_id, u.name, s.created_at, s.expires_at, s.user_agent
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > datetime('now') ORDER BY s.created_at DESC`)
    .all();

  const logins = db.prepare(`
    SELECT a.id, a.user_id, a.name, a.ip, a.ok, a.created_at,
      u.name AS resolved_name
    FROM login_audit a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT 20`)
    .all();

  const jobs = db.prepare(`
    SELECT j.id, j.kind, j.status, j.error, j.result, j.created_at, j.updated_at,
      u.name AS user_name
    FROM jobs j LEFT JOIN users u ON u.id = j.user_id
    ORDER BY j.id DESC LIMIT 15`)
    .all();

  const kobo = db.prepare(`
    SELECT k.user_id, u.name, k.last_synced_at, k.last_error, k.created_at
    FROM kobo_links k JOIN users u ON u.id = k.user_id`)
    .all();

  // Per-member ABS links — same health view as Kobo (the integrations pills
  // above only say the instance-level config exists, not whether a member's
  // link is actually syncing).
  const abs = db.prepare(`
    SELECT a.user_id, u.name, a.last_synced_at, a.last_error, a.created_at
    FROM abs_links a JOIN users u ON u.id = a.user_id`)
    .all();

  const health = {
    books: count('SELECT COUNT(*) n FROM books'),
    events: count('SELECT COUNT(*) n FROM events'),
    missing_covers: count("SELECT COUNT(*) n FROM books WHERE cover_url IS NULL"),
    missing_series: count("SELECT COUNT(*) n FROM books WHERE series_name IS NULL"),
    missing_moods: count("SELECT COUNT(*) n FROM books WHERE moods IS NULL"),
  };

  const integrations = {
    hardcover: { configured: hardcoverEnabled(), ...hcHealthSummary() },
    abs: Boolean(config.abs?.url && config.abs?.token),
    llm: Boolean((process.env.LLM_API_KEY || '') !== '' || db.prepare("SELECT COUNT(*) n FROM users WHERE llm_api_key IS NOT NULL").get().n > 0),
  };

  const backups = listBackups();

  res.json({
    instance: {
      started_at: config.startedAt,
      schema_version: db.prepare('PRAGMA user_version').get().user_version,
      db_bytes: dbBytes,
      users: users.length,
    },
    users,
    sessions,
    logins,
    jobs,
    kobo,
    abs,
    health,
    integrations,
    backups: { count: backups.length, newest: backups[0]?.name || null, bytes: backups.reduce((s, b) => s + b.bytes, 0) },
  });
});

// POST /api/admin/sessions/revoke { user_id } — log a member out everywhere
// (password reset does the same implicitly; this is the explicit lever).
router.post('/admin/sessions/revoke', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, name FROM users WHERE id=?').get(req.body?.user_id);
  if (!user) return res.status(404).json({ error: 'no such user' });
  destroyAllSessions(user.id);
  res.json({ ok: true, revoked: user.name });
});

export default router;
