import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { createJob, runners } from '../jobs.js';

const r = Router();

// Start a long-running op. Body: { kind, payload }. Returns { id } to poll.
r.post('/jobs', (req, res) => {
  const { kind, payload } = req.body || {};
  if (!runners[kind]) return res.status(400).json({ error: `unknown job kind: ${kind}` });
  // The ABS connection in .env is the host's own library — not for other users.
  // Bulk re-pull hammers the shared HC quota, so it's admin-only too.
  if (['abs_import', 'book_refresh'].includes(kind) && !req.user?.is_admin) {
    return res.status(403).json({ error: `${kind === 'abs_import' ? 'the ABS import' : 'the bulk re-pull'} is admin-only` });
  }
  res.json({ id: createJob(currentUserId(), kind, payload) });
});

r.get('/jobs', (req, res) => {
  const jobs = db.prepare(`SELECT id, kind, status, progress, progress_label, error, created_at, updated_at
    FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 20`).all(currentUserId());
  res.json({ jobs });
});

r.get('/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?')
    .get(req.params.id, currentUserId());
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json({
    ...job,
    payload: JSON.parse(job.payload || '{}'),
    result: job.result ? JSON.parse(job.result) : null,
  });
});

r.delete('/jobs/:id', (req, res) => {
  // Running jobs can't be deleted (the worker owns the row) — they get a
  // cooperative cancellation flag instead: cancel-aware runners stop between
  // rows and report what was already done.
  const info = db.prepare("UPDATE jobs SET cancel_requested=1 WHERE id=? AND user_id=? AND status='running'")
    .run(req.params.id, currentUserId());
  if (info.changes) return res.json({ cancel_requested: true });
  const del = db.prepare("DELETE FROM jobs WHERE id=? AND user_id=? AND status != 'running'")
    .run(req.params.id, currentUserId());
  res.json({ deleted: del.changes > 0 });
});

export default r;
