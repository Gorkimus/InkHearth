// KOReader progress sync (kosync protocol) — routes.
//
// Two halves share this file:
//   - the PROTOCOL half implements what KOReader's plugin calls (paths from
//     its api.json): GET /users/auth, POST /users/create, PUT /syncs/progress,
//     GET /syncs/progress/:document. These sit under /api/kosync and are
//     exempt from the session gate (index.js AUTH_EXEMPT) — they carry their
//     own credential, x-auth-user + x-auth-key, where the key is md5 of the
//     password the member typed into KOReader (the client hashes it). We
//     store md5(token), so the wire form compares directly.
//   - the MANAGEMENT half (session-authed, same gate as everything else):
//     mint/regenerate the token, list documents + pendings, map a pending
//     document to a shelf book, forget one, disconnect.
import { Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { db, currentUserId } from '../db.js';
import { hashKosyncKey, foldKosyncPush, mapKosyncDoc } from '../koreader/sync.js';

const r = Router();

// ---- protocol auth ----

const eq = (a, b) => {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
};

// A tight in-memory limiter for credential guessing: 5 failures per 60 s per
// (username, IP) — the pushes arrive straight from the internet. Successes
// clear the counter; the table is capped so it can't grow unbounded.
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60 * 1000;
const fails = new Map();
const failKey = (req, name) => `${String(name).slice(0, 64)}|${req.ip}`;
const limited = (key) => {
  const now = Date.now();
  const entry = fails.get(key);
  return !!entry && entry.n >= MAX_FAILS && now - entry.t < FAIL_WINDOW_MS;
};
const recordFail = (key) => {
  const now = Date.now();
  const entry = fails.get(key);
  if (!entry || now - entry.t >= FAIL_WINDOW_MS) fails.set(key, { t: now, n: 1 });
  else entry.n += 1;
  if (fails.size > 10000) fails.clear(); // household scale; a reset beats a leak
};
const clearFail = (key) => fails.delete(key);

// Resolve x-auth-user/x-auth-key to a member. Usernames are the members'
// sign-in names — unique case-insensitively since migration 58, so the
// lookup KOReader-style (typed on a phone) lands on exactly one account.
const authMember = (req) => {
  const name = String(req.headers['x-auth-user'] || '');
  const key = String(req.headers['x-auth-key'] || '');
  const fk = failKey(req, name);
  if (limited(fk)) return { blocked: true };
  const user = name && key
    ? db.prepare('SELECT id, name FROM users WHERE lower(name)=lower(?)').get(name)
    : null;
  const link = user && db.prepare('SELECT key_hash FROM kosync_links WHERE user_id=?').get(user.id);
  if (user && link && eq(key, link.key_hash)) {
    clearFail(fk);
    return { user };
  }
  if (name || key) recordFail(fk);
  return {};
};

const PLACEHOLDER_DOCS = new Set(['none', 'null', 'undefined', '']);

// Login validation — the plugin's "sign in" step.
r.get('/users/auth', (req, res) => {
  const { user, blocked } = authMember(req);
  if (blocked) return res.status(429).json({ error: 'Too many authentication attempts' });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ username: user.name });
});

// "Register" — nothing is ever created here (credentials are minted inside
// the app). Succeeding iff the credentials already match lets a member tap
// either button in KOReader's UI and land the same way. The spec sends the
// raw password in the body while the headers carry its md5, so both forms
// are accepted.
r.post('/users/create', (req, res) => {
  const name = String(req.headers['x-auth-user'] || req.body?.username || '');
  const key = String(req.headers['x-auth-key'] || '');
  const raw = String(req.body?.password || '');
  const fk = failKey(req, name);
  if (limited(fk)) return res.status(429).json({ error: 'Too many authentication attempts' });
  const user = db.prepare('SELECT id, name FROM users WHERE lower(name)=lower(?)').get(name);
  const link = user && db.prepare('SELECT key_hash FROM kosync_links WHERE user_id=?').get(user.id);
  if (user && link && (eq(key, link.key_hash) || (raw && eq(hashKosyncKey(raw), link.key_hash)))) {
    clearFail(fk);
    return res.status(201).json({ username: user.name });
  }
  recordFail(fk);
  res.status(401).json({ error: 'Unauthorized' });
});

// The position push — the hot path. KOReader debounces (25 s) and queues
// offline; every push updates the position row (latest wins) and folds into
// the member's events per koreader/sync.js.
r.put('/syncs/progress', async (req, res) => {
  const { user, blocked } = authMember(req);
  if (blocked) return res.status(429).json({ error: 'Too many authentication attempts' });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  const document = String(b.document || '');
  if (!document || PLACEHOLDER_DOCS.has(document.toLowerCase())) {
    return res.status(400).json({ error: 'Missing document ID' });
  }
  const percentage = b.percentage;
  if (typeof percentage === 'boolean' || typeof percentage !== 'number' || !Number.isFinite(percentage)
    || percentage < 0 || percentage > 1) {
    return res.status(400).json({ error: 'Invalid percentage' });
  }
  const push = {
    document: document.slice(0, 128),
    percentage,
    progress: b.progress == null ? null : String(b.progress).slice(0, 256),
    device: b.device == null ? null : String(b.device).slice(0, 80),
    device_id: b.device_id == null ? null : String(b.device_id).slice(0, 80),
    metadata: b.metadata && typeof b.metadata === 'object' ? {
      filename: b.metadata.filename == null ? null : String(b.metadata.filename).slice(0, 200),
      title: b.metadata.title == null ? null : String(b.metadata.title).slice(0, 200),
      authors: Array.isArray(b.metadata.authors)
        ? b.metadata.authors.slice(0, 8).map((a) => String(a).slice(0, 80))
        : (b.metadata.authors == null ? null : String(b.metadata.authors).slice(0, 200)),
    } : {},
  };
  try {
    await foldKosyncPush(user.id, push);
  } catch (err) {
    console.error('kosync push failed:', err.message);
    return res.status(500).json({ error: 'sync failed' });
  }
  res.json({ document: push.document, timestamp: Math.floor(Date.now() / 1000) });
});

// The position pull — the member's other devices ask where they left off.
// A 404 with a message (not a 5xx): strict clients treat server errors as
// fatal and abort syncing altogether.
r.get('/syncs/progress/:document', (req, res) => {
  const { user, blocked } = authMember(req);
  if (blocked) return res.status(429).json({ error: 'Too many authentication attempts' });
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  const document = String(req.params.document || '');
  if (!document || PLACEHOLDER_DOCS.has(document.toLowerCase())) {
    return res.status(404).json({ message: 'Document not found on server' });
  }
  const doc = db.prepare('SELECT * FROM kosync_docs WHERE user_id=? AND document=?')
    .get(user.id, document);
  if (!doc) return res.status(404).json({ message: 'Document not found on server' });
  res.json({
    document: doc.document,
    progress: doc.last_progress || '',
    percentage: doc.last_percentage ?? 0,
    device: doc.device || '',
    device_id: '',
    timestamp: doc.updated_at ? Math.floor(new Date(doc.updated_at.replace(' ', 'T') + 'Z').getTime() / 1000) : 0,
  });
});

// ---- management (session-authed — these paths stay behind the /api gate) ----

// Mint or replace the member's token. The response is the only place the
// raw token ever appears (invite-link rules: shown once, stored hashed).
r.post('/creds', (req, res) => {
  const uid = currentUserId();
  const token = randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO kosync_links (user_id, key_hash) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET key_hash=excluded.key_hash, created_at=datetime('now')`)
    .run(uid, hashKosyncKey(token));
  const user = db.prepare('SELECT name FROM users WHERE id=?').get(uid);
  res.json({ url: '/api/kosync', username: user?.name || '', token });
});

// Everything the Account card shows: connection state + documents (pending
// first, most recent first) with their mapped book titles.
r.get('/docs', (req, res) => {
  const uid = currentUserId();
  const link = db.prepare('SELECT * FROM kosync_links WHERE user_id=?').get(uid);
  const docs = link ? db.prepare(`
    SELECT d.document, d.book_id, d.title_hint, d.author_hint, d.last_percentage,
           d.last_progress, d.device, d.updated_at, b.title AS book_title
    FROM kosync_docs d LEFT JOIN books b ON b.id = d.book_id
    WHERE d.user_id=?
    ORDER BY (d.book_id IS NULL) DESC, d.updated_at DESC`).all(uid) : [];
  res.json({ connected: !!link, last_push_at: link?.last_push_at || null, docs });
});

// Attach a pending document to a shelf book, folding its stored position.
r.post('/docs/:document/map', async (req, res) => {
  const bookId = Number(req.body?.book_id);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: 'book_id required' });
  const out = await mapKosyncDoc(currentUserId(), String(req.params.document || ''), bookId);
  if (!out) return res.status(404).json({ error: 'document or book not found' });
  res.json({ ok: true, ...out });
});

// Forget a document (position row and mapping) — for wrongly-matched or
// abandoned entries.
r.delete('/docs/:document', (req, res) => {
  const info = db.prepare('DELETE FROM kosync_docs WHERE user_id=? AND document=?')
    .run(currentUserId(), String(req.params.document || ''));
  res.json({ deleted: info.changes > 0 });
});

// Disconnect: credentials and every document row go. Books and events the
// pushes already created stay — they are the member's reading history.
r.delete('/creds', (req, res) => {
  const uid = currentUserId();
  db.prepare('DELETE FROM kosync_docs WHERE user_id=?').run(uid);
  db.prepare('DELETE FROM kosync_links WHERE user_id=?').run(uid);
  res.json({ ok: true });
});

export default r;
