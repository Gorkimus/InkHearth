// In-process job worker for multi-minute ops. One job at a time, FIFO; the
// runner registry keeps job kinds decoupled from the HTTP layer. Jobs live in
// the jobs table so the client starts + polls over plain REST.
import { db } from './db.js';
import { runLibraryImport } from './imports/library-import.js';
import { runAbsImport } from './imports/abs-import.js';
import { runRecommendations } from './recommendations/generate.js';
// HIBERNATING Sept 25 2026 (Storyteller Selection): re-add these two imports
// plus the runner/payload entries below to wake —
// import { runStoryteller } from './storytellers/generate.js';
// import { runSnippetScan } from './storytellers/classify.js';
import { runKoboSync } from './kobo/sync.js';
import { runBookRefresh } from './imports/book-refresh.js';
import { runAbsSync } from './abs/sync.js';

export const runners = {
  kobo_import: (payload, report, uid, token) => runLibraryImport({ uid, provider: 'kobo', ...payload }, report, token),
  audible_import: (payload, report, uid, token) => runLibraryImport({ uid, provider: 'audible', ...payload }, report, token),
  goodreads_import: (payload, report, uid, token) => runLibraryImport({ uid, provider: 'goodreads', ...payload }, report, token),
  abs_import: (payload, report, uid) => runAbsImport({ ...payload, uid }, report),
  recommendations: (payload, report, uid) => runRecommendations(payload, report, uid),
  // HIBERNATING Sept 25 2026: storyteller + snippet_scan runners/payloads
  // (see the import note above; tables and code stay, nothing is reachable).
  kobo_sync: (payload, report, uid) => runKoboSync(payload, report, uid),
  book_refresh: (payload, report, uid) => runBookRefresh(payload, report, uid),
  abs_sync: (payload, report, uid, token) => runAbsSync(payload, report, uid, token),
};

let pumping = false;

// Client payloads may carry only these op-specific fields — everything else
// (the owner uid above all) is stripped before a runner sees it, so a crafted
// payload can never redirect writes into another account. The owner always
// comes from the authenticated job row.
const PAYLOAD_FIELDS = {
  kobo_import: ['hardcover', 'rows'],
  audible_import: ['hardcover', 'rows'],
  goodreads_import: ['hardcover', 'rows'],
  abs_import: ['rematch'],
  recommendations: ['candidates', 'hardcover', 'count', 'adventure', 'length', 'series'],
  // HIBERNATING Sept 25 2026: storyteller: ['scene', 'authors'], snippet_scan: ['scan_batch'],
  kobo_sync: [],
  book_refresh: ['only_missing'],
};
const sanitizePayload = (kind, payload) => {
  const out = {};
  for (const key of PAYLOAD_FIELDS[kind] || []) {
    if (payload && payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
};

export function createJob(uid, kind, payload) {
  const info = db.prepare('INSERT INTO jobs (user_id, kind, payload) VALUES (?,?,?)')
    .run(uid, kind, JSON.stringify(payload || {}));
  pump();
  return Number(info.lastInsertRowid);
}

function pump() {
  if (pumping) return;
  pumping = true;
  process.nextTick(runNext);
}

async function runNext() {
  const job = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
  if (!job) {
    pumping = false;
    return;
  }
  db.prepare("UPDATE jobs SET status='running', updated_at=datetime('now') WHERE id=?").run(job.id);
  const report = (progress, progress_label) =>
    db.prepare("UPDATE jobs SET progress=?, progress_label=?, updated_at=datetime('now') WHERE id=?")
      .run(progress ?? null, progress_label ?? null, job.id);
  try {
    const runner = runners[job.kind];
    if (!runner) throw new Error(`no runner for job kind "${job.kind}"`);
    // Jobs run outside any request, so the runner gets the owner explicitly —
    // never a fallback that could touch the wrong library.
    const payload = sanitizePayload(job.kind, JSON.parse(job.payload || '{}'));
    // Cooperative cancellation: cancel-aware runners poll token.cancelled()
    // between rows and stop cleanly; runners that ignore the token run to
    // completion as before.
    const cancelQ = db.prepare('SELECT cancel_requested FROM jobs WHERE id=?');
    const token = { cancelled: () => !!cancelQ.get(job.id)?.cancel_requested };
    const result = await runner(payload, report, job.user_id, token);
    db.prepare("UPDATE jobs SET status='done', result=?, updated_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(result ?? {}), job.id);
  } catch (err) {
    // err.detail (when present) is the raw technical cause for the admin's
    // job list; `error` is the member-facing sentence shown on retries.
    db.prepare("UPDATE jobs SET status='error', error=?, result=?, updated_at=datetime('now') WHERE id=?")
      .run(String(err.message || err), err.detail ? String(err.detail) : null, job.id);
  }
  runNext();
}

// The worker is in-process, so anything still queued/running at boot belongs
// to a server that no longer exists — fail it rather than leave it spinning.
export function failOrphanedJobs() {
  db.prepare("UPDATE jobs SET status='error', error='interrupted by server restart', updated_at=datetime('now') WHERE status IN ('queued','running')").run();
}
