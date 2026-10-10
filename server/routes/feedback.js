import { Router } from 'express';
import { db, currentUserId } from '../db.js';

// Feature requests: members drop ideas, the admin triages them in the admin
// panel. Modest anti-spam (length caps + open-request ceiling) — this is a
// household instance, not the internet.

const r = Router();
const MAX_BODY = 1000;
const MAX_OPEN = 20;

const requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
};

// Submit a feature request (any signed-in member).
r.post('/', (req, res) => {
  const uid = currentUserId();
  const body = String(req.body?.body || '').trim();
  if (body.length < 3) return res.status(400).json({ error: 'tell us a little more (3+ characters)' });
  if (body.length > MAX_BODY) return res.status(400).json({ error: `keep it under ${MAX_BODY} characters` });
  const open = db.prepare("SELECT COUNT(*) n FROM feature_requests WHERE user_id=? AND status='open'").get(uid).n;
  if (open >= MAX_OPEN) {
    return res.status(400).json({ error: 'you have a lot of open requests already — let the admin catch up first' });
  }
  const info = db.prepare('INSERT INTO feature_requests (user_id, body) VALUES (?,?)').run(uid, body);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

// The member's own requests, newest first.
r.get('/', (req, res) => {
  const requests = db.prepare(`
    SELECT id, body, status, created_at FROM feature_requests
    WHERE user_id=? ORDER BY id DESC LIMIT 50`).all(currentUserId());
  res.json({ requests });
});

// Admin view: everything with names — open requests first, then done ones.
r.get('/all', requireAdmin, (req, res) => {
  const requests = db.prepare(`
    SELECT f.id, f.body, f.status, f.created_at, u.name AS user_name
    FROM feature_requests f JOIN users u ON u.id = f.user_id
    ORDER BY f.status = 'done', f.id DESC LIMIT 200`).all();
  res.json({ requests });
});

r.put('/:id/status', requireAdmin, (req, res) => {
  const status = req.body?.status === 'done' ? 'done' : 'open';
  const info = db.prepare('UPDATE feature_requests SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ updated: info.changes > 0, status });
});

r.delete('/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM feature_requests WHERE id=?').run(req.params.id);
  res.json({ deleted: info.changes > 0 });
});

export default r;
