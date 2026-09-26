import { Router } from 'express';
import { db, currentUserId } from '../db.js';
import { resolveLlm } from '../llm.js';
import { hardcoverBookById } from '../metadata/hardcover.js';
import { bookInfo } from '../metadata/book-info.js';
import { parseJsonArr } from '../jsonarr.js';

const r = Router();
const STATUSES = ['tbr', 'read', 'dismissed', 'avoided'];

// Per-user LLM key (recommendations). Lives behind the session gate — NOT in
// the auth router, whose paths are exempt from the gate by design. The key is
// write-only over the API: responses never echo it back.
r.get('/account/llm', (req, res) => {
  const uid = currentUserId();
  const u = db.prepare('SELECT llm_api_key, llm_base_url, llm_model FROM users WHERE id=?').get(uid);
  const llm = resolveLlm(uid);
  res.json({
    has_key: !!u?.llm_api_key,
    base_url: u?.llm_base_url || '',
    model: u?.llm_model || '',
    source: llm?.source || null, // 'user' | 'env' | null
    effective_model: llm?.model || null,
  });
});

r.put('/account/llm', (req, res) => {
  const uid = currentUserId();
  const b = req.body || {};
  if (b.clear) {
    db.prepare('UPDATE users SET llm_api_key=NULL, llm_base_url=NULL, llm_model=NULL WHERE id=?').run(uid);
    return res.json({ has_key: false, source: resolveLlm(uid)?.source || null });
  }
  const key = String(b.api_key || '').trim();
  const existing = db.prepare('SELECT llm_api_key FROM users WHERE id=?').get(uid)?.llm_api_key;
  if (!key && !existing) return res.status(400).json({ error: 'API key required' });
  db.prepare('UPDATE users SET llm_api_key=?, llm_base_url=?, llm_model=? WHERE id=?')
    .run(key || existing, String(b.base_url || '').trim() || null, String(b.model || '').trim() || null, uid);
  const llm = resolveLlm(uid);
  res.json({ has_key: true, source: llm?.source || null, effective_model: llm?.model || null });
});

// ---- per-user UI preferences (namespaced JSON: dashboard.*, compare.*) ----
// Views save only their own namespace; absent keys mean "use the default".
const readPrefs = (uid) => {
  try { return JSON.parse(db.prepare('SELECT prefs FROM users WHERE id=?').get(uid)?.prefs || '{}'); }
  catch { return {}; }
};

const mergeDeep = (target, patch) => {
  for (const k of Object.keys(patch)) {
    // JSON.parse materializes "__proto__" as an own property, and
    // target['__proto__'] resolves to Object.prototype — without this guard a
    // crafted prefs patch pollutes every object in the process.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])
      && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      mergeDeep(target[k], patch[k]);
    } else {
      target[k] = patch[k];
    }
  }
  return target;
};

r.get('/account/prefs', (req, res) => {
  res.json(readPrefs(currentUserId()));
});

r.put('/account/prefs', (req, res) => {
  const uid = currentUserId();
  const stored = mergeDeep(readPrefs(uid), req.body || {});
  db.prepare('UPDATE users SET prefs=? WHERE id=?').run(JSON.stringify(stored), uid);
  res.json(stored);
});

// Download my data: the account's complete content as one lossless JSON file
// — the "total data ownership" promise, exercised by the user, not the admin.
// Sits behind the session gate like the other /account endpoints.
r.get('/account/export', (req, res) => {
  const uid = currentUserId();
  const user = db.prepare('SELECT name, created_at, prefs FROM users WHERE id=?').get(uid);
  if (!user) return res.status(404).json({ error: 'no such user' });
  const parseBook = (row) => ({
    ...row,
    genres: parseJsonArr(row.genres),
    moods: parseJsonArr(row.moods),
    tags: parseJsonArr(row.tags),
  });
  const payload = {
    app: 'booktracker',
    exported_at: new Date().toISOString(),
    account: {
      name: user.name,
      joined: user.created_at,
      prefs: JSON.parse(user.prefs || '{}'),
    },
    books: db.prepare('SELECT * FROM books WHERE user_id=? ORDER BY id').all(uid).map(parseBook),
    events: db.prepare('SELECT * FROM events WHERE user_id=? ORDER BY id').all(uid),
    tbr: db.prepare('SELECT * FROM tbr WHERE user_id=? ORDER BY id').all(uid),
    series_overrides: db.prepare('SELECT * FROM series_overrides WHERE user_id=? ORDER BY series_name').all(uid),
    recommendations: db.prepare('SELECT * FROM recommendations WHERE user_id=? ORDER BY id').all(uid),
    avoid_signals: db.prepare('SELECT * FROM avoid_signals WHERE user_id=? ORDER BY id').all(uid),
  };
  const slug = user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'me';
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="booktracker-${slug}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Recommendation cards (Phase 4). Generation runs through the jobs system
// (kind 'recommendations'); these endpoints serve the latest batch and handle
// the card actions.

r.get('/recommendations', (req, res) => {
  const uid = currentUserId();
  const batch = db.prepare('SELECT MAX(batch_id) m FROM recommendations WHERE user_id=?').get(uid).m;
  const recs = batch
    ? db.prepare(`SELECT id, batch_id, title, author, series_name, hardcover_id, reasoning,
                         estimated_words, page_count, audio_runtime_minutes, status, created_at
                  FROM recommendations WHERE user_id=? AND batch_id=? ORDER BY id`).all(uid, batch)
    : [];
  const avoid_signals = db.prepare(
    'SELECT id, label, created_at FROM avoid_signals WHERE user_id=? ORDER BY id DESC').all(uid);
  res.json({ batch_id: batch || null, recs, avoid_signals });
});

// Mark a card acted-on. 'avoided' doubles as a "Not for me" signal: the
// author (or series, when that's the distinctive part) steers future digests.
r.post('/recommendations/:id/status', (req, res) => {
  const uid = currentUserId();
  const status = req.body?.status;
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const rec = db.prepare('SELECT * FROM recommendations WHERE id=? AND user_id=?').get(req.params.id, uid);
  if (!rec) return res.status(404).json({ error: 'recommendation not found' });
  db.prepare('UPDATE recommendations SET status=? WHERE id=?').run(status, rec.id);
  if (status === 'avoided') {
    const label = rec.series_name || rec.author || rec.title;
    db.prepare(`INSERT INTO avoid_signals (user_id, label) VALUES (?,?)
      ON CONFLICT (user_id, label) DO NOTHING`).run(uid, label);
  }
  res.json({ ok: true, status });
});

// "More info" for a card: the Hardcover description + catalog details, via
// the shared book-info helper (paced HC call, 24h in-memory cache).
// Unverified cards (no hardcover_id) come back with description:null and the
// client falls back to search links.
r.get('/recommendations/:id/info', async (req, res, next) => {
  try {
    const rec = db.prepare('SELECT * FROM recommendations WHERE id=? AND user_id=?')
      .get(req.params.id, currentUserId());
    if (!rec) return res.status(404).json({ error: 'recommendation not found' });
    const data = rec.hardcover_id ? await bookInfo(rec.hardcover_id) : null;
    res.json({
      hardcover_id: rec.hardcover_id || null,
      title: rec.title,
      author: rec.author,
      ...data,
    });
  } catch (err) {
    next(err);
  }
});

// Cover hydration for the current batch — paced from HC and cached for a
// day in-process. The view renders immediately and paints covers when this
// resolves; cards without one just keep their tile.
const coverCache = new Map(); // hardcover_id → url|null
r.get('/recommendations/covers', async (req, res, next) => {
  try {
    const uid = currentUserId();
    const batch = db.prepare('SELECT MAX(batch_id) m FROM recommendations WHERE user_id=?').get(uid).m;
    const recs = batch
      ? db.prepare('SELECT id, hardcover_id FROM recommendations WHERE user_id=? AND batch_id=?').all(uid, batch)
      : [];
    const covers = {};
    for (const rec of recs) {
      if (!rec.hardcover_id) continue;
      if (!coverCache.has(rec.hardcover_id)) {
        let url = null;
        try { url = (await hardcoverBookById(rec.hardcover_id))?.cached_image?.url || null; }
        catch { /* leave null; retried next batch view */ }
        coverCache.set(rec.hardcover_id, url);
      }
      if (coverCache.get(rec.hardcover_id)) covers[rec.id] = coverCache.get(rec.hardcover_id);
    }
    res.json({ covers });
  } catch (err) {
    next(err);
  }
});

r.post('/avoid-signals', (req, res) => {
  const uid = currentUserId();
  const label = String(req.body?.label || '').trim();
  if (label.length < 2) return res.status(400).json({ error: 'label required' });
  db.prepare(`INSERT INTO avoid_signals (user_id, label) VALUES (?,?)
    ON CONFLICT (user_id, label) DO NOTHING`).run(uid, label);
  res.json({ ok: true, label });
});

r.delete('/avoid-signals/:id', (req, res) => {
  const info = db.prepare('DELETE FROM avoid_signals WHERE id=? AND user_id=?').run(req.params.id, currentUserId());
  res.json({ deleted: info.changes > 0 });
});

export default r;
