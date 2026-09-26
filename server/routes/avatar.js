import { Router } from 'express';
import express from 'express';
import { createHash } from 'node:crypto';
import { db, currentUserId } from '../db.js';

const r = Router();

// Profile pictures. The browser square-crops and shrinks uploads to a 256px
// JPEG before they leave the page, so the server stays dependency-free: it
// never re-encodes, it only verifies the bytes really are an image before
// storing them. Blobs live in the users table (migration 25) so snapshots
// back them up and account deletion takes them with it — no second place to
// forget. Lives behind the session gate, NOT in the auth router.

const MAX_AVATAR_BYTES = 300 * 1024;

// Content-Type headers lie; the bytes don't. Only types the resize helper can
// produce get stored, and GET never emits anything outside this whitelist.
const KNOWN_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

r.put('/account/avatar', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_AVATAR_BYTES }), (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const type = buf && sniff(buf);
  if (!type) return res.status(400).json({ error: 'that file does not look like an image (jpg, png or webp)' });
  db.prepare('UPDATE users SET avatar=?, avatar_type=? WHERE id=?').run(buf, type, currentUserId());
  res.json({ has_avatar: true });
});

r.delete('/account/avatar', (req, res) => {
  db.prepare('UPDATE users SET avatar=NULL, avatar_type=NULL WHERE id=?').run(currentUserId());
  res.json({ has_avatar: false });
});

// Serving someone's picture is a peek at their account: your own, or anyone
// whose profile is public — the same gate the Members profile uses (admins
// get no bypass there either). 404 (not 403) so a private account leaves no
// trace of having an avatar at all.
r.get('/avatar/:id', (req, res) => {
  const target = db.prepare('SELECT id, avatar, avatar_type, profile_public FROM users WHERE id=?')
    .get(req.params.id);
  if (!target?.avatar) return res.status(404).json({ error: 'no avatar' });
  if (target.id !== currentUserId() && !target.profile_public) {
    return res.status(404).json({ error: 'no avatar' });
  }
  const etag = `W/"${createHash('sha256').update(target.avatar).digest('hex').slice(0, 16)}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  // Raw setHeader: express's res.set appends a text charset to content types,
  // which images shouldn't carry. node:sqlite hands BLOBs back as Uint8Array,
  // which res.send would serialize as JSON — wrap it in a real Buffer.
  res.setHeader('Content-Type', KNOWN_TYPES.has(target.avatar_type) ? target.avatar_type : 'image/jpeg');
  res.set({
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    // User-uploaded bytes: if navigated to directly, render and run nothing
    // (an <img> embed ignores response CSP, so this costs nothing).
    'Content-Security-Policy': "sandbox; default-src 'none'",
    ETag: etag,
  });
  res.send(Buffer.from(target.avatar));
});

export default r;
