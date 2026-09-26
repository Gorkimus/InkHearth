// Auth: scrypt passwords, hashed session/invite tokens, cookie helpers, and a
// small in-memory login rate limit. Sessions live in the DB so the smoke test
// can mint them directly and "log out everywhere" is one DELETE.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { runAsUser } from './request-context.js';

export const SESSION_COOKIE = 'bt_session';
const SESSION_DAYS = 90;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const mintToken = () => randomBytes(32).toString('base64url');

// ---- passwords ----
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
}

// ---- sessions ----
export function createSession(uid, userAgent) {
  const token = mintToken();
  db.prepare(`INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
    VALUES (?,?, datetime('now', '+${SESSION_DAYS} days'), ?)`)
    .run(uid, sha256(token), userAgent ? String(userAgent).slice(0, 180) : null);
  return token;
}

// Durable login record for the admin panel — sessions vanish on logout, this
// stays. Self-trims to the newest 500 rows so it can never grow unbounded.
export function auditLogin({ userId = null, name = null, ip = null, ok }) {
  db.prepare('INSERT INTO login_audit (user_id, name, ip, ok) VALUES (?,?,?,?)')
    .run(userId, name, ip, ok ? 1 : 0);
  db.prepare('DELETE FROM login_audit WHERE id NOT IN (SELECT id FROM login_audit ORDER BY id DESC LIMIT 500)')
    .run();
}

export function sessionUser(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.name, u.is_admin, (u.avatar IS NOT NULL) AS has_avatar
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash=? AND s.expires_at > datetime('now')`)
    .get(sha256(token)) || null;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));
}

export function destroyAllSessions(uid) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
}

// ---- cookies ----
export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    secure: config.cookieSecure, // set COOKIE_SECURE=1 behind an https tunnel
  });
}

export function clearSessionCookie(res) {
  // Attributes don't affect matching (name+domain+path decide that) but keep
  // them identical to setSessionCookie so the pair stays obviously symmetric.
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: config.cookieSecure,
  });
}

export function readSessionCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

// ---- invites (single-use; only the hash is stored, the token lives in the URL) ----
// Two kinds: signup invites (create a new account) and password-reset invites
// (resets_user set — set a new password on that existing account).
export function createInvite(createdBy, { expiresInDays = null, resetsUser = null, recipient = null } = {}) {
  const token = mintToken();
  // Stored in the same UTC format datetime('now') produces, so expiry
  // comparisons stay plain string comparisons.
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  db.prepare('INSERT INTO invites (token_hash, created_by, expires_at, resets_user, recipient) VALUES (?,?,?,?,?)')
    .run(sha256(token), createdBy, expiresAt, resetsUser, recipient);
  return token;
}

function findUsableInvite(token) {
  return db.prepare(`
    SELECT i.id, i.resets_user, i.created_by, u.is_admin, u.password_hash AS owner_has_password
    FROM invites i JOIN users u ON u.id = i.created_by
    WHERE i.token_hash=? AND i.used_by IS NULL
      AND (i.expires_at IS NULL OR i.expires_at > datetime('now'))`)
    .get(sha256(token));
}

// Cheap liveness pre-checks for the public accept endpoints: they let routes
// reject garbage tokens BEFORE paying for scrypt (which blocks the event
// loop). The redeem functions below stay the authoritative check.
export function inviteIsLive(token) {
  const invite = findUsableInvite(token);
  return !!invite && invite.resets_user === null;
}
export function resetIsLive(token) {
  const invite = findUsableInvite(token);
  return !!invite && invite.resets_user !== null;
}

// Invite-preview payload for the acceptance page: who sent it. Only the
// creator's display name travels, and only while the token is still live —
// the accept page renders it as "X invited you" before signup.
export function inviteInfo(token) {
  const invite = findUsableInvite(token);
  if (!invite || invite.resets_user !== null) return null;
  const row = db.prepare(`
    SELECT u.name AS invited_by, i.recipient
    FROM invites i JOIN users u ON u.id = i.created_by
    WHERE i.token_hash=?`)
    .get(sha256(token));
  return row ? { invited_by: row.invited_by, recipient: row.recipient || null } : null;
}

const consumeInvite = (invite, uid) =>
  db.prepare("UPDATE invites SET used_by=?, used_at=datetime('now') WHERE id=?").run(uid, invite.id);

export function redeemInvite(token, name, passwordHash) {
  const invite = findUsableInvite(token);
  if (!invite) return null;

  // A claim invite upgrades the passwordless admin account in place — the
  // chosen name and password land on it — rather than creating a second
  // account that would have to inherit the data afterwards.
  if (invite.is_admin && !invite.owner_has_password) {
    db.prepare('UPDATE users SET name=?, password_hash=? WHERE id=?')
      .run(name, passwordHash, invite.created_by);
    consumeInvite(invite, invite.created_by);
    return invite.created_by;
  }

  // share_compare is explicitly ON for new accounts (the column default stays
  // 0 — SQLite defaults can't be ALTERed without a table rebuild). Comparisons
  // are the point of a household instance; Account → Privacy opts out.
  const info = db.prepare('INSERT INTO users (name, password_hash, share_compare) VALUES (?,?,1)')
    .run(name, passwordHash);
  const uid = Number(info.lastInsertRowid);
  consumeInvite(invite, uid);
  return uid;
}

// Password-reset invites: set a new password on resets_user and log that
// account out everywhere (a forgotten password usually means a leaked session).
export function redeemPasswordReset(token, passwordHash) {
  const invite = findUsableInvite(token);
  if (!invite || !invite.resets_user) return null;
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, invite.resets_user);
  destroyAllSessions(invite.resets_user);
  consumeInvite(invite, invite.resets_user);
  return invite.resets_user;
}

// ---- per-request context (see request-context.js) ----
export function runWithUser(uid, fn) {
  return runAsUser(uid, fn);
}

// ---- login rate limiting (in-memory; resets when the server restarts) ----
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map();

export function checkRateLimit(key) {
  const e = failures.get(key);
  if (!e) return true;
  if (Date.now() - e.first > WINDOW_MS) { failures.delete(key); return true; }
  return e.count < MAX_FAILURES;
}

export function recordFailure(key) {
  const e = failures.get(key);
  if (!e || Date.now() - e.first > WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 });
  else e.count += 1;
}

export function clearFailures(key) {
  failures.delete(key);
}
