import { Router } from 'express';
import express from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// produce get stored, and GET never emits anything outside this whitelist
// (plus the stock set's svg, which the server itself ships).
const KNOWN_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// The stock portrait wall: five hearth/book icons shipped in public/avatars.
// Everyone wears one — an explicit users.avatar_stock pick wins, else the id
// auto-assigns (stable, spreads consecutive signups across the set) — and a
// custom upload always covers it. Frontends pick up the list from
// STOCK_AVATARS in the Account view; the SVGs also serve as plain statics
// (/avatars/<key>.svg) for the picker itself.
const STOCK_KEYS = ['hearth', 'lantern', 'openbook', 'stack', 'mug'];
const stockDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'avatars');
const STOCK = new Map(STOCK_KEYS.map((k) => [k, readFileSync(join(stockDir, k + '.svg'))]));
export const stockFor = (u) =>
  (u.avatar_stock && STOCK.has(u.avatar_stock) ? u.avatar_stock : STOCK_KEYS[u.id % STOCK_KEYS.length]);

r.put('/account/avatar', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_AVATAR_BYTES }), (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const type = buf && sniff(buf);
  if (!type) return res.status(400).json({ error: 'that file does not look like an image (jpg, png or webp)' });
  db.prepare('UPDATE users SET avatar=?, avatar_type=? WHERE id=?').run(buf, type, currentUserId());
  res.json({ has_avatar: true });
});

r.delete('/account/avatar', (req, res) => {
  // Removing the photo falls back to the stock portrait — nobody is ever
  // faceless, so every has_avatar consumer stays a plain <img>.
  db.prepare('UPDATE users SET avatar=NULL, avatar_type=NULL WHERE id=?').run(currentUserId());
  const u = db.prepare('SELECT id, avatar_stock FROM users WHERE id=?').get(currentUserId());
  res.json({ has_avatar: true, stock: stockFor(u) });
});

// Choose from the stock wall. key null = back to the auto-assign.
r.put('/account/avatar-stock', (req, res) => {
  const key = req.body?.key ?? null;
  if (key !== null && !STOCK.has(key)) return res.status(400).json({ error: 'unknown avatar' });
  db.prepare('UPDATE users SET avatar_stock=? WHERE id=?').run(key, currentUserId());
  const u = db.prepare('SELECT id, avatar_stock FROM users WHERE id=?').get(currentUserId());
  res.json({ avatar_stock: u.avatar_stock, effective: stockFor(u) });
});

// Serving someone's picture is a peek at their account: your own, or anyone
// whose profile is public — the same gate the Members profile uses (admins
// get no bypass there either). 404 (not 403) so a private account leaves no
// trace of having an avatar at all. The stock wall is exempt: it's shared
// art, not personal bytes, so it serves to everyone.
r.get('/avatar/:id', (req, res) => {
  const target = db.prepare('SELECT id, avatar, avatar_type, avatar_stock, profile_public FROM users WHERE id=?')
    .get(req.params.id);
  if (!target) return res.status(404).json({ error: 'no avatar' });
  if (target.avatar) {
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
    return res.send(Buffer.from(target.avatar));
  }
  const key = stockFor(target);
  const etag = `W/"stock-${key}"`;
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  res.setHeader('Content-Type', 'image/svg+xml');
  res.set({
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    ETag: etag,
  });
  res.send(STOCK.get(key));
});

export default r;
