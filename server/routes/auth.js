import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import * as auth from '../auth.js';

const r = Router();

r.post('/login', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  const key = `${req.ip}|${name.toLowerCase()}`;
  const ua = req.headers['user-agent'];
  if (!auth.checkRateLimit(key)) {
    return res.status(429).json({ error: 'too many attempts — try again in 15 minutes' });
  }
  const user = db.prepare('SELECT id, name, is_admin, password_hash FROM users WHERE lower(name)=lower(?)')
    .get(name);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    auth.recordFailure(key);
    auth.auditLogin({ userId: user?.id || null, name, ip: req.ip, ok: false });
    return res.status(401).json({ error: 'wrong name or password' });
  }
  auth.clearFailures(key);
  auth.auditLogin({ userId: user.id, name: user.name, ip: req.ip, ok: true });
  auth.setSessionCookie(res, auth.createSession(user.id, ua));
  res.json({ id: user.id, name: user.name, is_admin: !!user.is_admin });
});

r.post('/logout', (req, res) => {
  auth.destroySession(auth.readSessionCookie(req));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

r.get('/me', (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, name: req.user.name, is_admin: !!req.user.is_admin, has_avatar: !!req.user.has_avatar } : null });
});

// ---- account management ----
// NOTE: /api/auth/* is exempt from the session gate (login must be reachable),
// so every account endpoint must guard itself — currentUserId() would
// otherwise fall back to the seed user for unauthenticated calls.
const requireUser = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'not signed in' });
  next();
};

r.post('/password', requireUser, (req, res) => {
  const uid = currentUserId();
  const user = db.prepare('SELECT password_hash FROM users WHERE id=?').get(uid);
  if (!auth.verifyPassword(String(req.body?.current || ''), user?.password_hash)) {
    return res.status(400).json({ error: 'current password is wrong' });
  }
  const next = String(req.body?.password || '');
  if (next.length < 8) return res.status(400).json({ error: 'new password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(next), uid);
  res.json({ ok: true });
});

r.post('/name', requireUser, (req, res) => {
  const uid = currentUserId();
  const name = String(req.body?.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'name too short' });
  try {
    db.prepare('UPDATE users SET name=? WHERE id=?').run(name, uid);
    res.json({ name });
  } catch (err) {
    return res.status(400).json({ error: /UNIQUE/.test(err.message) ? 'that name is taken' : err.message });
  }
});

r.post('/logout-all', requireUser, (req, res) => {
  auth.destroyAllSessions(currentUserId());
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---- privacy toggles ----
// profile_public gates the Members-directory profile (migration 12);
// share_compare gates cross-account comparisons (migration 7). The Compare
// view has its own inline card for share_compare — same column, two surfaces.

r.get('/privacy', requireUser, (req, res) => {
  const u = db.prepare('SELECT profile_public, share_compare FROM users WHERE id=?').get(currentUserId());
  res.json({ profile_public: !!u?.profile_public, share_compare: !!u?.share_compare });
});

r.put('/privacy', requireUser, (req, res) => {
  const uid = currentUserId();
  const cur = db.prepare('SELECT profile_public, share_compare FROM users WHERE id=?').get(uid);
  const next = (v, fallback) => (typeof v === 'boolean' ? (v ? 1 : 0) : fallback);
  const profile = next(req.body?.profile_public, cur?.profile_public);
  const share = next(req.body?.share_compare, cur?.share_compare);
  db.prepare('UPDATE users SET profile_public=?, share_compare=? WHERE id=?').run(profile, share, uid);
  res.json({ profile_public: !!profile, share_compare: !!share });
});

// ---- invites (admin only) ----

const requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
};

r.get('/invites', requireAdmin, (req, res) => {
  const invites = db.prepare(`
    SELECT i.id, i.created_at, i.expires_at, i.used_at, i.used_by, i.resets_user, i.recipient,
           u2.name AS used_by_name, u3.name AS resets_user_name
    FROM invites i
    LEFT JOIN users u2 ON u2.id = i.used_by
    LEFT JOIN users u3 ON u3.id = i.resets_user
    WHERE i.created_by=? ORDER BY i.id DESC LIMIT 50`)
    .all(currentUserId());
  res.json({ invites });
});

// Admin user list — powers the password-reset dropdown.
r.get('/users', requireAdmin, (req, res) => {
  res.json({ users: db.prepare('SELECT id, name, is_admin FROM users ORDER BY name COLLATE NOCASE').all() });
});

// Password-reset link for an existing account. Shown once, 24h expiry; the
// link itself is the credential — hand it to the user out of band.
r.post('/resets', requireAdmin, (req, res) => {
  const user_id = Number(req.body?.user_id);
  if (!Number.isInteger(user_id)) return res.status(400).json({ error: 'user_id required' });
  const target = db.prepare('SELECT id FROM users WHERE id=?').get(user_id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  const token = auth.createInvite(currentUserId(), { expiresInDays: 1, resetsUser: target.id });
  res.json({ url: `/#reset/${token}` });
});

r.post('/invites', requireAdmin, (req, res) => {
  const recipient = String(req.body?.recipient || '').trim().slice(0, 80) || null;
  const token = auth.createInvite(currentUserId(), { recipient });
  // The full link exists only in this response — the DB stores a hash.
  res.json({ url: `/#invite/${token}`, recipient });
});

r.delete('/invites/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM invites WHERE id=? AND created_by=? AND used_by IS NULL')
    .run(req.params.id, currentUserId());
  res.json({ deleted: info.changes > 0 });
});

// ---- invite acceptance (public — this is the signup path) ----

// Invite preview for the acceptance page — who sent it. Public, but reveals
// only the sender's display name, and only while the token is still live.
r.get('/invite/info', (req, res) => {
  const info = auth.inviteInfo(String(req.query?.token || ''));
  if (!info) return res.status(404).json({ valid: false, error: 'this invite link is not valid anymore' });
  res.json({ valid: true, ...info });
});

r.post('/invite/accept', (req, res) => {
  const token = String(req.body?.token || '');
  const key = `${req.ip}|invite`;
  if (!auth.checkRateLimit(key)) {
    return res.status(429).json({ error: 'too many attempts — try again in 15 minutes' });
  }
  // Token validity is a cheap lookup — check it BEFORE any scrypt work, which
  // blocks the event loop and must never be purchasable with garbage tokens.
  if (!auth.inviteIsLive(token)) {
    auth.recordFailure(key);
    return res.status(400).json({ error: 'this invite link is not valid anymore' });
  }
  const name = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'pick a name (2+ characters)' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  // Who sent it, read before redeeming — the invite is consumed below.
  const inviteMeta = auth.inviteInfo(token);
  let uid;
  try {
    uid = auth.redeemInvite(token, name, auth.hashPassword(password));
  } catch (err) {
    return res.status(400).json({ error: /UNIQUE/.test(err.message) ? 'that name is taken' : err.message });
  }
  if (!uid) {
    auth.recordFailure(key);
    return res.status(400).json({ error: 'this invite link is not valid anymore' });
  }
  auth.clearFailures(key);
  auth.setSessionCookie(res, auth.createSession(uid, req.headers['user-agent']));
  res.json({ id: uid, name, invited_by: inviteMeta?.invited_by || null });
});

// ---- password-reset acceptance (public; no auto-login — reset links may be
// opened on another device, so the user signs in with the new password) ----

r.post('/reset/accept', (req, res) => {
  const key = `${req.ip}|reset`;
  if (!auth.checkRateLimit(key)) {
    return res.status(429).json({ error: 'too many attempts — try again in 15 minutes' });
  }
  const token = String(req.body?.token || '');
  if (!auth.resetIsLive(token)) {
    auth.recordFailure(key);
    return res.status(400).json({ error: 'this reset link is not valid anymore' });
  }
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  const uid = auth.redeemPasswordReset(token, auth.hashPassword(password));
  if (!uid) {
    auth.recordFailure(key);
    return res.status(400).json({ error: 'this reset link is not valid anymore' });
  }
  auth.clearFailures(key);
  res.json({ ok: true });
});

export default r;
