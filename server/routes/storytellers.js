// Storyteller Selection routes: the castable author pool, flight history,
// the blind round detail, the ranking lock-in that returns the reveal — plus
// the admin-only authentic corpus (epub scans, hand-import, review) and
// instant authentic flights assembled from kept snippets.
import { Router, raw } from 'express';
import { db, currentUserId } from '../db.js';
import { libraryAuthors, STAPLES, normName } from '../storytellers/pool.js';
import { SCENES, shuffle } from '../storytellers/generate.js';
import { createScan } from '../storytellers/scan.js';

const r = Router();

const loadRound = (id, uid) => {
  const row = db.prepare('SELECT * FROM storyteller_rounds WHERE id=? AND user_id=?').get(id, uid);
  if (!row) return null;
  return {
    id: row.id,
    scene: row.scene,
    source: row.source,
    base: row.base, // the set passage every voice in this flight restyled
    model: row.model,
    created_at: row.created_at,
    authors: JSON.parse(row.authors), // key order (A, B, C…)
    passages: JSON.parse(row.passages),
    ranking: row.ranking ? JSON.parse(row.ranking) : null,
  };
};

// Per-author standing in THIS member's library — the reveal's personal hook
// ("you ranked this voice above an author whose books you rate S").
const shelfStats = (uid, author) => {
  const row = db.prepare(`
    SELECT COUNT(*) AS books,
           AVG(CASE e.rating WHEN 'S' THEN 5 WHEN 'A' THEN 4 WHEN 'B' THEN 3
                             WHEN 'C' THEN 2 WHEN 'D' THEN 1 END) AS score
    FROM books b
    JOIN events e ON e.book_id = b.id
      AND e.id = (SELECT MAX(id) FROM events WHERE book_id = b.id AND rating IS NOT NULL)
    WHERE b.user_id = ? AND e.rating IS NOT NULL AND lower(b.author) = lower(?)`)
    .get(uid, author);
  return row && row.books > 0
    ? { books: row.books, avg_tier: [null, 'D', 'C', 'B', 'A', 'S'][Math.round(row.score)] || null }
    : null;
};

// While the ranking is open the round serves BLIND — keys and text only.
// Once locked, the reveal attaches names, style notes and shelf standing
// in ranking order.
const roundView = (uid, round) => {
  if (!round.ranking) {
    return { ...round, passages: round.passages.map(({ key, passage }) => ({ key, passage })) };
  }
  const entries = round.ranking.map((key, i) => {
    const p = round.passages.find((x) => x.key === key) || {};
    const author = p.author || round.authors[key.charCodeAt(0) - 65] || '?';
    const in_library = shelfStats(uid, author);
    return {
      key,
      place: i + 1,
      author,
      // Keep the full text on revealed rounds: history is the archive —
      // members re-read the voices and copy the flight for friends.
      passage: p.passage || null,
      style_notes: p.style_notes || [],
      tags: p.tags || [],
      // Authentic rounds carry provenance instead of style notes.
      source_title: p.source_title || null,
      source_year: p.source_year || null,
      in_library, // null → a discovery, not a shelf voice
      hardcover_url: `https://hardcover.app/search?q=${encodeURIComponent(author)}`,
    };
  });
  return { ...round, passages: undefined, entries };
};

r.get('/storytellers/pool', (req, res) => {
  const uid = currentUserId();
  const library = libraryAuthors(uid);
  const owned = new Set(library.map((a) => normName(a.name)));
  const authentic = db.prepare(`
    SELECT scene, author, COUNT(*) AS n FROM storyteller_snippets
    WHERE status='kept' AND scene IS NOT NULL GROUP BY scene, author`).all();
  res.json({
    scenes: SCENES,
    library,
    staples: STAPLES.filter((s) => !owned.has(normName(s)))
      .map((name) => ({ name, books: 0, avg_tier: null, owned: false })),
    authentic,
  });
});

r.get('/storytellers/rounds', (req, res) => {
  const rounds = db.prepare(`
    SELECT id, scene, source, authors, ranking, model, created_at
    FROM storyteller_rounds WHERE user_id=? ORDER BY id DESC LIMIT 30`).all(currentUserId())
    .map((row) => ({
      ...row,
      authors: JSON.parse(row.authors),
      ranking: row.ranking ? JSON.parse(row.ranking) : null,
    }));
  res.json({ rounds });
});

r.get('/storytellers/rounds/:id', (req, res) => {
  const uid = currentUserId();
  const round = loadRound(req.params.id, uid);
  if (!round) return res.status(404).json({ error: 'flight not found' });
  res.json(roundView(uid, round));
});

r.post('/storytellers/rounds/:id/ranking', (req, res) => {
  const uid = currentUserId();
  const round = loadRound(req.params.id, uid);
  if (!round) return res.status(404).json({ error: 'flight not found' });
  if (round.ranking) return res.status(409).json({ error: 'this flight was already ranked' });
  const ranking = Array.isArray(req.body?.ranking) ? req.body.ranking.map(String) : [];
  const keys = round.passages.map((p) => p.key);
  const valid = ranking.length === keys.length
    && new Set(ranking).size === keys.length
    && ranking.every((k) => keys.includes(k));
  if (!valid) return res.status(400).json({ error: 'ranking must order every passage exactly once' });
  db.prepare('UPDATE storyteller_rounds SET ranking=? WHERE id=? AND user_id=?')
    .run(JSON.stringify(ranking), round.id, uid);
  res.json(roundView(uid, { ...round, ranking }));
});

r.delete('/storytellers/rounds/:id', (req, res) => {
  const info = db.prepare('DELETE FROM storyteller_rounds WHERE id=? AND user_id=?')
    .run(req.params.id, currentUserId());
  res.json({ deleted: info.changes > 0 });
});

// ---------- authentic corpus (admin-curated, instance-only) ----------

// The corpus is deliberately instance-wide (no user_id): one household, one
// admin, one shared set of real passages. Admin-only writes; any member's
// flight may read kept rows. This text exists ONLY in the instance DB.
const adminOnly = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
};

// Upload an ebook file the admin owns → plain-text chunks stored as
// unclassified candidates. The bytes are parsed in memory and discarded;
// nothing is written to disk, and nothing here ever reaches git.
r.post('/storytellers/scan', adminOnly, raw({ type: 'application/octet-stream', limit: '80mb' }), (req, res) => {
  try {
    if (!req.body?.length) return res.status(400).json({ error: 'empty upload' });
    const author = String(req.query.author || '').trim();
    const title = String(req.query.title || '').trim() || null;
    const year = Number.parseInt(req.query.year, 10) || null;
    if (!author) return res.status(400).json({ error: 'author required' });
    const result = createScan({ buf: req.body, author, title, year });
    res.json({ ...result, next: 'POST /api/jobs {kind:"snippet_scan", payload:{scan_batch}} to classify' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Unclassified-and-classified candidates awaiting the admin's keep/discard.
r.get('/storytellers/snippets/candidates', adminOnly, (req, res) => {
  const candidates = db.prepare(`
    SELECT id, scan_batch, author, title, source_year, scene, note, passage
    FROM storyteller_snippets
    WHERE status='candidate' AND scene IS NOT NULL AND scene!='none'
    ORDER BY scan_batch DESC, scene, id`).all();
  res.json({ candidates });
});

const setStatus = (status) => (req, res) => {
  const info = db.prepare('UPDATE storyteller_snippets SET status=? WHERE id=?')
    .run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'snippet not found' });
  res.json({ status });
};
r.post('/storytellers/snippets/:id/keep', adminOnly, setStatus('kept'));
r.post('/storytellers/snippets/:id/discard', adminOnly, setStatus('discarded'));
r.delete('/storytellers/snippets/:id', adminOnly, (req, res) => {
  const info = db.prepare('DELETE FROM storyteller_snippets WHERE id=?').run(req.params.id);
  res.json({ deleted: info.changes > 0 });
});

// Kept-corpus coverage: scene → author → count. Drives the setup screen's
// "authentic ready" display for every member.
r.get('/storytellers/snippets/summary', (req, res) => {
  const coverage = db.prepare(`
    SELECT scene, author, COUNT(*) AS n FROM storyteller_snippets
    WHERE status='kept' AND scene IS NOT NULL GROUP BY scene, author ORDER BY author`).all();
  res.json({ coverage });
});

// Hand-import path: a JSON file of passages the admin curated themselves.
// These arrive trusted — status 'kept' immediately — but still validated and
// deduped on (author, scene, passage prefix).
r.post('/storytellers/snippets/import', adminOnly, (req, res) => {
  const list = Array.isArray(req.body?.snippets) ? req.body.snippets : [];
  if (!list.length) return res.status(400).json({ error: 'snippets array required' });
  const ins = db.prepare(`
    INSERT INTO storyteller_snippets (author, title, source_year, scene, status, passage)
    VALUES (?,?,?,?,'kept',?)`);
  const dupe = db.prepare(`
    SELECT 1 FROM storyteller_snippets
    WHERE author=? AND scene=? AND substr(passage,1,100)=? LIMIT 1`);
  let imported = 0;
  let duplicates = 0;
  const errors = [];
  const run = db.transaction(() => {
    for (const [i, s] of list.entries()) {
      const author = String(s.author || '').trim();
      const scene = String(s.scene || '').trim().toLowerCase();
      const passage = String(s.passage || '').trim();
      const words = passage.split(/\s+/).filter(Boolean).length;
      if (!author || !SCENES[scene]) { errors.push(`#${i + 1}: author and a valid scene are required`); continue; }
      if (words < 60 || words > 400) { errors.push(`#${i + 1}: ${words} words — expected 60–400`); continue; }
      if (dupe.get(author, scene, passage.slice(0, 100))) { duplicates++; continue; }
      ins.run(author, String(s.source_title || '').trim() || null,
        Number.parseInt(s.source_year, 10) || null, scene, passage);
      imported++;
    }
  });
  run();
  res.json({ imported, duplicates, errors });
});

// Authentic flight: every cast author needs a KEPT passage for the scene;
// one is drawn at random per author (skipping passages used in this member's
// last few authentic flights, when alternatives exist). No LLM, no queue —
// the round assembles instantly.
r.post('/storytellers/rounds/authentic', (req, res) => {
  const uid = currentUserId();
  const scene = String(req.body?.scene || '');
  if (!SCENES[scene]) return res.status(400).json({ error: 'pick a scene' });
  const authors = [...new Set((Array.isArray(req.body?.authors) ? req.body.authors : [])
    .map((a) => String(a || '').trim()).filter(Boolean))];
  if (authors.length < 3 || authors.length > 6) {
    return res.status(400).json({ error: 'pick between 3 and 6 authors' });
  }
  const kept = db.prepare(`
    SELECT passage, title, source_year FROM storyteller_snippets
    WHERE status='kept' AND scene=? AND lower(author)=lower(?)`);
  // Passages from this member's most recent authentic rounds — deprioritised
  // so back-to-back flights don't deal the same voice twice.
  const recentRounds = db.prepare(`
    SELECT passages FROM storyteller_rounds
    WHERE user_id=? AND source='authentic' ORDER BY id DESC LIMIT 3`).all(uid)
    .flatMap((r) => JSON.parse(r.passages).map((p) => p.passage));
  const recent = new Set(recentRounds);
  const picked = [];
  for (const author of authors) {
    const rows = kept.all(scene, author);
    if (!rows.length) return res.status(400).json({ error: `no kept passage for ${author} in this scene yet` });
    const fresh = rows.filter((r) => !recent.has(r.passage));
    const pool = fresh.length ? fresh : rows;
    const row = pool[Math.floor(Math.random() * pool.length)];
    picked.push({ author, passage: row.passage, source_title: row.title, source_year: row.source_year });
  }
  const blind = shuffle([...picked])
    .map((p, i) => ({ key: String.fromCharCode(65 + i), ...p }));
  const info = db.prepare(`
    INSERT INTO storyteller_rounds (user_id, scene, source, authors, passages)
    VALUES (?,?,?,?,?)`)
    .run(uid, scene, 'authentic', JSON.stringify(blind.map((p) => p.author)),
      JSON.stringify(blind.map(({ key, author, passage, source_title, source_year }) => (
        { key, author, passage, source_title, source_year }))));
  res.json({ round_id: Number(info.lastInsertRowid), scene, count: blind.length });
});

export default r;
