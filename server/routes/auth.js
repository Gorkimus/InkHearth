import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import * as auth from '../auth.js';
import { stockFor } from './avatar.js';

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
  res.json({ user: req.user ? {
    id: req.user.id, name: req.user.name, is_admin: !!req.user.is_admin,
    has_avatar: !!req.user.has_avatar,
    // For the Account portrait picker: an uploaded photo beats the stock
    // pick; avatar_stock is the explicit pick (null = auto by id), and
    // avatar_effective is what's actually worn when no photo is showing.
    avatar_custom: !!req.user.has_custom,
    avatar_stock: req.user.avatar_stock ?? null,
    avatar_effective: stockFor(req.user),
  } : null });
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

// ---- privacy & notification toggles ----
// profile_public gates the Members-directory profile (migration 12);
// share_compare gates cross-account comparisons (migration 7). The Compare
// view has its own inline card for share_compare — same column, two surfaces.
// notify_finishes (the circle-finish bell) lives in the prefs JSON — absent
// means ON, so the default rings and only an explicit false silences it.

const readPrefs = (row) => {
  try { return JSON.parse(row?.prefs || '{}'); } catch { return {}; }
};

r.get('/privacy', requireUser, (req, res) => {
  const u = db.prepare('SELECT profile_public, share_compare, prefs FROM users WHERE id=?').get(currentUserId());
  res.json({
    profile_public: !!u?.profile_public,
    share_compare: !!u?.share_compare,
    notify_finishes: readPrefs(u).notify_finishes !== false,
    notify_polls: readPrefs(u).notify_polls !== false,
  });
});

r.put('/privacy', requireUser, (req, res) => {
  const uid = currentUserId();
  const cur = db.prepare('SELECT profile_public, share_compare, prefs FROM users WHERE id=?').get(uid);
  const next = (v, fallback) => (typeof v === 'boolean' ? (v ? 1 : 0) : fallback);
  const profile = next(req.body?.profile_public, cur?.profile_public);
  const share = next(req.body?.share_compare, cur?.share_compare);
  const prefs = readPrefs(cur);
  if (typeof req.body?.notify_finishes === 'boolean') prefs.notify_finishes = req.body.notify_finishes;
  if (typeof req.body?.notify_polls === 'boolean') prefs.notify_polls = req.body.notify_polls;
  db.prepare('UPDATE users SET profile_public=?, share_compare=?, prefs=? WHERE id=?')
    .run(profile, share, JSON.stringify(prefs), uid);
  res.json({
    profile_public: !!profile,
    share_compare: !!share,
    notify_finishes: prefs.notify_finishes !== false,
    notify_polls: prefs.notify_polls !== false,
  });
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

// ---- locked-out device pairing ("approve this sign-in") ----
// A signed-out device that forgot its password asks a signed-in device of the
// same member — or the admin — to vouch for it: the requester displays a short
// code, the approver confirms it matches what the requester shows, and the
// requester collects a one-time password-reset token (the SAME invites-table
// reset the admin dropdown mints; redeemPasswordReset logs the account's other
// devices out, exactly like that flow). No session ever crosses devices.
// /api/auth/* is session-exempt by design, so the approver endpoints guard
// themselves with requireUser, and these requester endpoints stay anonymous.

const PAIR_WINDOW_MIN = 10;
// The requester side is anonymous, so cap how many UNDECIDED requests one
// address can keep open — a flood would otherwise spam every approver's
// screen for ten minutes.
const PAIR_MAX_OPEN_PER_IP = 3;

const pairIsFresh = 'decision IS NULL AND created_at > datetime(\'now\', \'-' + PAIR_WINDOW_MIN + ' minutes\')';

r.post('/pair', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'enter the member name first' });
  const open = db.prepare(`SELECT COUNT(*) n FROM pairings WHERE req_ip=? AND ${pairIsFresh}`).get(req.ip).n;
  if (open >= PAIR_MAX_OPEN_PER_IP) {
    return res.status(429).json({ error: 'too many pending requests from this device — wait a few minutes' });
  }
  // No user-existence signal in the response: an unknown name creates a
  // dangling request nobody can approve (the admin can only deny it), so the
  // login screen can't be used to learn which names exist.
  const user = db.prepare('SELECT id FROM users WHERE lower(name)=lower(?)').get(name);
  const token = auth.mintToken();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('INSERT INTO pairings (token, code, user_id, ua, req_ip) VALUES (?,?,?,?,?)')
    .run(token, code, user?.id ?? null, String(req.headers['user-agent'] || '').slice(0, 140), req.ip);
  res.json({ token, code });
});

// The requester's poll. 404 only for a token that never existed; an expired
// one answers { status: 'expired' } so the waiting screen can say so. The
// reset token is handed out exactly once, then dropped from the row.
r.get('/pair/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM pairings WHERE token=?').get(String(req.params.token));
  if (!row) return res.status(404).json({ status: 'expired' });
  if (!row.decision && row.created_at <= db.prepare(`SELECT datetime('now', ?) d`).get(`-${PAIR_WINDOW_MIN} minutes`).d) {
    return res.json({ status: 'expired' });
  }
  if (row.decision === 'approved') {
    if (row.reset_token) {
      db.prepare('UPDATE pairings SET reset_token=NULL WHERE id=?').run(row.id);
      return res.json({ status: 'approved', reset_token: row.reset_token });
    }
    return res.json({ status: 'approved' });
  }
  if (row.decision === 'denied') return res.json({ status: 'denied' });
  res.json({ status: 'pending' });
});

// Approver side: requests I'm allowed to decide — my own, everything for the
// admin. Unresolvable names (user_id NULL) show for the admin so they can be
// denied rather than dangling silently.
r.get('/pair-requests', requireUser, (req, res) => {
  const uid = currentUserId();
  const rows = db.prepare(`
    SELECT p.id, p.code, p.created_at, p.ua, p.user_id, u.name
    FROM pairings p LEFT JOIN users u ON u.id = p.user_id
    WHERE ${pairIsFresh.replaceAll('decision', 'p.decision').replaceAll('created_at', 'p.created_at')}
      AND (p.user_id = ? OR ?)
    ORDER BY p.id DESC`)
    .all(uid, req.user.is_admin ? 1 : 0);
  res.json({ requests: rows.map((row) => ({ ...row, mine: row.user_id === uid })) });
});

const decidablePair = (req) => {
  const row = db.prepare('SELECT * FROM pairings WHERE id=?').get(Number(req.params.id));
  if (!row || row.decision
    || row.created_at <= db.prepare(`SELECT datetime('now', ?) d`).get(`-${PAIR_WINDOW_MIN} minutes`).d) return null;
  return row;
};

r.post('/pair-requests/:id/approve', requireUser, (req, res) => {
  const row = decidablePair(req);
  if (!row) return res.status(404).json({ error: 'that request is gone already' });
  if (row.user_id === null) return res.status(400).json({ error: 'no such member — deny this request' });
  const uid = currentUserId();
  if (row.user_id !== uid && !req.user.is_admin) return res.status(403).json({ error: 'not your request' });
  // Claim first, then mint: a double-approve races to a single winner, and
  // only the winner pays for an invite row.
  const claim = db.prepare("UPDATE pairings SET decision='approved', decided_by=? WHERE id=? AND decision IS NULL")
    .run(uid, row.id);
  if (claim.changes === 0) return res.status(404).json({ error: 'that request is gone already' });
  const resetToken = auth.createInvite(uid, { expiresInDays: 1, resetsUser: row.user_id });
  db.prepare('UPDATE pairings SET reset_token=? WHERE id=?').run(resetToken, row.id);
  res.json({ ok: true });
});

r.post('/pair-requests/:id/deny', requireUser, (req, res) => {
  const row = decidablePair(req);
  if (!row) return res.status(404).json({ error: 'that request is gone already' });
  const uid = currentUserId();
  if (row.user_id !== null && row.user_id !== uid && !req.user.is_admin) {
    return res.status(403).json({ error: 'not your request' });
  }
  const claim = db.prepare("UPDATE pairings SET decision='denied', decided_by=? WHERE id=? AND decision IS NULL")
    .run(uid, row.id);
  if (claim.changes === 0) return res.status(404).json({ error: 'that request is gone already' });
  res.json({ ok: true });
});

export default r;
