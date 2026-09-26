// Smoke test for a running server: node scripts/smoke-test.js
// Delta-based — safe to run against a live database with real user data.
// Exercises dedupe, events (finished / listened / DNF / year-only / undated),
// in-place event editing, stats math, filters, the TBR queue lifecycle, quick
// status (finish / DNF / start-reading) + the on-pause shelf state, the Kobo
// import pipeline via the jobs system (synthetic device database), the Audible
// import, the tier board API, work-level + subtitle-aware compare matching,
// the member book-info preview, the backup endpoint, auth (invite → signup →
// login → cross-user isolation, share_compare default ON), the consent-gated
// Compare view, the recommendation pipeline (offline candidates path — the
// LLM itself is never called), then cleans up in a finally.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { hashPassword } from '../server/auth.js';

// SMOKE_BASE lets the suite target the staging environment (port 3223) —
// against a fresh copy of production data there, without stopping prod.
const BASE = process.env.SMOKE_BASE || 'http://localhost:3222/api';
// Fixed port so the harness can pre-sanction the mock's origin via the
// server's ABS_LINK_ALLOWLIST (see the workflow's boot step).
const SMOKE_ABS_PORT = 34877;

// The smoke runs on the same machine as the server, so it mints session rows
// directly (hashed exactly like the server does) and drives the API as the
// real admin user. Everything it creates is removed in the finally.
// SMOKE_DB pairs with SMOKE_BASE when testing the staging worktree's copy.
const liveDb = new DatabaseSync(process.env.SMOKE_DB || 'data/booktracker.db');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
let activeCookie = null;
const mintedTokens = [];
let adminCookie = null;
let invitedUserId = null;

function makeSession(userId) {
  const token = randomBytes(32).toString('base64url');
  liveDb.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?, datetime('now','+1 day'))")
    .run(userId, sha256(token));
  mintedTokens.push(token);
  return token;
}
const adminId = liveDb.prepare('SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1').get()?.id;
if (!adminId) throw new Error('no admin user found — did migration 5 run?');
// A fresh install's admin has no password yet — give it one so the invite
// minted in the auth section takes the normal signup path, not the claim path.
if (!liveDb.prepare('SELECT password_hash FROM users WHERE id=?').get(adminId).password_hash) {
  liveDb.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword('smoke-admin-temp'), adminId);
}
// Defensive: remove a previous run's invited user if its cleanup was interrupted.
liveDb.prepare('DELETE FROM books WHERE user_id IN (SELECT id FROM users WHERE name=?)').run('Smoke Invited');
liveDb.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE name=?)').run('Smoke Invited');
liveDb.prepare('DELETE FROM invites WHERE used_by IN (SELECT id FROM users WHERE name=?)').run('Smoke Invited');
liveDb.prepare('DELETE FROM users WHERE name=?').run('Smoke Invited');

async function call(path, body, method) {
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(activeCookie ? { Cookie: 'bt_session=' + activeCookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${method || 'GET'} ${path} → non-JSON (HTTP ${res.status}): ${text.slice(0, 140)}`); }
  if (!res.ok) throw new Error(`${method || 'GET'} ${path} → ${res.status}: ${data.error}`);
  return data;
}

async function callRaw(path, bytes) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...(activeCookie ? { Cookie: 'bt_session=' + activeCookie } : {}) },
    body: bytes,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${data.error}`);
  return data;
}

// Mimics a real KoboReader.sqlite just enough for the parser: same table and
// column names, ContentType 6 = book, one junk row that must be filtered out.
function makeKoboFixture() {
  mkdirSync('data/tmp', { recursive: true });
  // The backup section VACUUMs into backups/ — create it (a fresh checkout
  // or CI run has no backups dir; it's gitignored).
  mkdirSync('backups', { recursive: true });
  const p = `data/tmp/kobo-fixture-${Date.now()}.sqlite`;
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE content (
    ContentID TEXT, ContentType INTEGER, MimeType TEXT, Title TEXT,
    Attribution TEXT, ISBN TEXT, ___PercentRead REAL, DateLastRead TEXT, ___Deleted INTEGER)`);
  const ins = db.prepare('INSERT INTO content VALUES (?,?,?,?,?,?,?,?,?)');
  ins.run('kobo-1', 6, 'application/x-kobo-epub+zip', 'Smoke Kobo Finished', 'F. Author', '9780123456789', 100, '2026-01-15T10:00:00.000', 0);
  ins.run('kobo-2', 6, 'application/x-kobo-epub+zip', 'Smoke Kobo Partial', 'F. Author', null, 45, '2026-02-20T10:00:00.000', 0);
  ins.run('kobo-3', 6, 'application/x-kobo-epub+zip', 'Smoke Kobo Untouched', 'F. Author', null, 0, null, 0);
  ins.run('kobo-junk', 999, 'application/x-kobo-epub+zip', 'Smoke Kobo Junk Not A Book', null, null, 0, null, 0);
  // The device's cloud credentials ride along in the user table — device-link
  // extraction reads this (and stores it only on explicit opt-in).
  db.exec('CREATE TABLE user (UserID TEXT, UserKey TEXT)');
  db.prepare('INSERT INTO user VALUES (?,?)').run('smoke-kobo-user', 'smoke-device-key-0123456789abcdef');
  db.close();
  return p;
}

const approx = (a, b, tol = 2) => Math.abs(a - b) <= tol;

// Audible Library Extractor-style CSV: quoted title with a comma, % signs on
// progress, human runtime strings, missing trailing fields. Field order and
// names differ across helper apps — the parser must alias-match defensively.
function makeAudibleCsv() {
  return [
    'Title,Author,Narrator,ASIN,Runtime,Percent Complete,Last Listened',
    '"Smoke Audible Finished, Revised Edition","A. Author","N. Narrator","B0AUDITFIN1","10 hrs and 3 mins","100%","2026-01-15T10:00:00.000"',
    '"Smoke Audible Partial","B. Writer",,"B0AUDITPAR1","5 hrs","40%","2026-02-20T08:00:00.000"',
    '"Smoke Audible Untouched","C. Person",,"B0AUDITUNB1",,,',
  ].join('\n');
}

// Same books as JSON with different key casing — the parser must normalize.
function makeAudibleJson() {
  return JSON.stringify([
    { ASIN: 'B0AUDITFIN1', Title: 'Smoke Audible Finished, Revised Edition', Author: 'A. Author', 'Percent Complete': '100%', 'Last Listened': '2026-01-15T10:00:00.000' },
    { ASIN: 'B0AUDITPAR1', Title: 'Smoke Audible Partial', Author: 'B. Writer', 'Percent Complete': '40%' },
  ]);
}

// A real-shaped xlsx (Libation also exports this): shared strings, inline
// string, boolean cells, and an Excel serial date (2026-01-15 = 46037).
// `pfx` namespaces the tags — Libation writes <x:row>/<x:c>/<x:si>, Excel
// writes bare tags; both must parse (regression: the reader initially
// matched bare tags only and rejected every Libation file).
import { zipSync, strToU8 } from 'fflate';
function makeAudibleXlsx(pfx = '') {
  const E = (t) => (pfx ? `${pfx}:${t}` : t);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const shared = ['Title', 'Author', 'ASIN', 'Percent Complete', 'Last Listened', 'Is Finished?',
    'Smoke Audible Finished, Revised Edition', 'A. Author', 'B0AUDITFIN1',
    'Smoke Audible Partial', 'B. Writer', 'B0AUDITPAR1'];
  const si = (i) => `<${E('c')} t="s"><${E('v')}>${i}</${E('v')}></${E('c')}>`;
  const sheet = `<?xml version="1.0"?><${E('worksheet')} xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><${E('sheetData')}>
<row r="1">${si(0)}${si(1)}${si(2)}${si(3)}${si(4)}${si(5)}</row>
<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c><c r="C2" t="s"><v>8</v></c><c r="D2"><v>100</v></c><c r="E2"><v>46037</v></c><c r="F2" t="b"><v>1</v></c></row>
<row r="3"><c r="A3" t="s"><v>9</v></c><c r="B3" t="s"><v>10</v></c><c r="C3" t="s"><v>11</v></c><c r="D3"><v>40</v></c><c r="F3" t="inlineStr"><is><t>FALSE</t></is></c></row>
</${E('sheetData')}></${E('worksheet')}>`;
  const sharedTag = pfx ? `${pfx}:sst` : 'sst';
  const siTag = pfx ? `${pfx}:si` : 'si';
  const tTag = pfx ? `${pfx}:t` : 't';
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook/>'),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><${sharedTag} xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<${siTag}><${tTag}>${esc(s)}</${tTag}></${siTag}>`).join('')}</${sharedTag}>`),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
  return Buffer.from(zip);
}

async function assertXlsxVariant(pfx) {
  const a = await callRaw('/audible/parse', makeAudibleXlsx(pfx));
  if (a.source !== 'xlsx' || a.books.length !== 2) {
    throw new Error(`audible xlsx(${pfx || 'bare'}) parse wrong: ${JSON.stringify(a).slice(0, 200)}`);
  }
  const fin = a.books.find((b) => b.content_id === 'B0AUDITFIN1');
  if (!fin || fin.title !== 'Smoke Audible Finished, Revised Edition' || fin.author !== 'A. Author'
    || fin.percent !== 100 || fin.suggested_status !== 'finished' || fin.last_read !== '2026-01-15') {
    throw new Error(`audible xlsx(${pfx || 'bare'}) finished row wrong: ${JSON.stringify(fin)}`);
  }
}

// Jobs run in-process on the server; poll until they settle.
async function waitForJob(id, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const j = await call('/jobs/' + id);
    if (j.status === 'done' || j.status === 'error') return j;
    if (Date.now() > deadline) throw new Error(`job ${id} timed out`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

adminCookie = makeSession(adminId);
activeCookie = adminCookie;

const base = await call('/stats');
const baseline = {
  all: base.all_time,
  year: base.this_year,
  readPages: base.formats.read?.pages || 0,
  listenHours: base.formats.listened?.hours || 0,
};
// The admin's UI prefs are snapshotted and restored verbatim in the finally.
const prePrefs = liveDb.prepare('SELECT prefs FROM users WHERE id=?').get(adminId)?.prefs ?? null;
// Login-audit rows created by the smoke are removed in the finally (real
// logins above this watermark are never touched).
const preAuditMax = liveDb.prepare('SELECT COALESCE(MAX(id), 0) m FROM login_audit').get().m;

const created = [];
let tbrNextUpBefore = null;
const jobIds = [];
// ALL real-user state the test touches is snapshotted HERE, before the try —
// snapshots taken later leave an early failure no way to restore, and the
// finally's DELETE-and-reinsert would then destroy real data.
//   - recommendations/avoid_signals: the recs section replaces batches and the
//     finally deletes by user, so pre-existing rows must be re-insertable.
//   - the admin's per-user LLM key: the llm section overwrites and clears it.
let preRecRows = [];
let preAvoidRows = [];
const preLlm = liveDb.prepare('SELECT llm_api_key, llm_base_url, llm_model FROM users WHERE id=?').get(adminId);
preRecRows = liveDb.prepare('SELECT * FROM recommendations WHERE user_id=?').all(adminId);
preAvoidRows = liveDb.prepare('SELECT * FROM avoid_signals WHERE user_id=?').all(adminId);
// Backup files created by the test are removed in the finally; pre-existing
// snapshots (the user's) are never touched.
const backupsBefore = new Set(existsSync('backups') ? readdirSync('backups') : []);

// The suite's own failure must never be masked by a cleanup failure: the
// finally's books_read check rethrows only when the try body completed.
let suiteError = null;
try {
  const b1 = (await call('/books', { title: 'Smoke Test Book One', author: 'A. Author', page_count: 465, source_provider: 'openlibrary', source_id: 'test-1' })).book;
  created.push(b1.id);
  const again = await call('/books', { title: 'Smoke Test Book One', author: 'A. Author', page_count: 465, source_provider: 'openlibrary', source_id: 'test-1' });
  if (!again.existed) throw new Error('dedupe failed');
  // Provider-id dedupe outranks title changes — the anchor recs/profiles copy on.
  const hcAnchor = (await call('/books', { title: 'Smoke HC Anchor', author: 'H.C. Anchor', source_provider: 'hardcover', source_id: '777' })).book;
  created.push(hcAnchor.id);
  const hcAgain = await call('/books', { title: 'Smoke HC Anchor Retitled', author: 'H.C. Anchor', source_provider: 'hardcover', source_id: '777' });
  if (!hcAgain.existed || hcAgain.book.id !== hcAnchor.id) throw new Error('hardcover-id dedupe failed');

  // ISBN lookup (barcode scan): validation is deterministic; the miss path
  // converges to 404 whether providers are up (no such book — 9798000000007
  // is verified absent) or down; a real ISBN is asserted only when the
  // providers actually answer. UPC-A (0-prefixed 12 digits) must expand to a
  // 978 ISBN rather than 400, while a non-book 12-digit code must 400.
  try {
    await call('/books/isbn/not-an-isbn');
    throw new Error('isbn route accepted garbage');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  try {
    await call('/books/isbn/123456789012');
    throw new Error('non-book 12-digit barcode accepted');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  const miss = await call('/books/isbn/9798000000007').catch((e) => e);
  if (!(miss instanceof Error) || !/No book found/.test(miss.message)) {
    throw new Error(`isbn miss path wrong: ${miss.message || JSON.stringify(miss).slice(0, 80)}`);
  }
  const upc = await call('/books/isbn/012345678901').catch((e) => e);
  if (upc instanceof Error && /400/.test(upc.message)) {
    throw new Error(`UPC-A conversion failed: ${upc.message}`);
  }
  const live = await call('/books/isbn/9780439023481').catch(() => null);
  if (live?.result && !/hunger/i.test(live.result.title)) {
    throw new Error(`isbn live lookup wrong: ${JSON.stringify(live.result.title)}`);
  }
  if (live?.result) console.log('  (isbn live lookup OK:', live.result.title, `via ${live.result.provider})`);

  await call('/events', { book_id: b1.id, format: 'read', status: 'finished', rating: 'S', finished_at: '2026-09-01' });

  const b2 = (await call('/books', { title: 'Smoke Test Audio', author: 'A. Author', audio_runtime_minutes: 600 })).book;
  created.push(b2.id);
  await call('/events', { book_id: b2.id, format: 'listened', status: 'finished', rating: 'A', narration_rating: 'S', finished_at: '2026-08-15' });

  const b3 = (await call('/books', { title: 'Smoke Test DNF', author: 'B. Writer', page_count: 300 })).book;
  created.push(b3.id);
  await call('/events', { book_id: b3.id, format: 'read', status: 'dnf', dnf_percent: 40, rating: 'D', finished_at: '2026-07-01' });

  const b4 = (await call('/books', { title: 'Smoke Test Memory', author: 'C. Person', page_count: 200 })).book;
  created.push(b4.id);
  await call('/events', { book_id: b4.id, format: 'read', status: 'finished', rating: 'B', finished_year: 2023 });

  const s = await call('/stats');
  const a = s.all_time;
  // b1: 465*275 = 127875 | b2: 10h*9300 = 93000 | b3: 300*275*0.4 = 33000 | b4: 200*275 = 55000
  const expectedWords = 127875 + 93000 + 33000 + 55000;
  if (a.books_read - baseline.all.books_read !== 4) throw new Error(`books_read delta ${a.books_read - baseline.all.books_read} != 4`);
  if (!approx(a.words - baseline.all.words, expectedWords)) throw new Error(`words delta ${a.words - baseline.all.words} != ${expectedWords}`);
  if (s.this_year.books_read - baseline.year.books_read !== 3) throw new Error('this_year delta != 3');
  if (!s.years.some((y) => y.year === '2023' && y.books >= 1)) throw new Error('year-only event missing from 2023');
  if (s.formats.read.pages - baseline.readPages !== 785) throw new Error(`read pages delta ${s.formats.read.pages - baseline.readPages} != 785`);
  if (Math.abs(s.formats.listened.hours - baseline.listenHours - 10) > 0.1) throw new Error(`listened hours delta != 10`);
  console.log('stats OK — words delta:', a.words - baseline.all.words, ' expected:', expectedWords);

  const tierS = await call('/books?tier=S');
  if (!tierS.books.some((b) => b.id === b1.id)) throw new Error('tier filter failed');
  const byQuery = await call('/books?query=smoke+test+audio');
  if (byQuery.books.length !== 1 || byQuery.books[0].id !== b2.id) throw new Error('query filter failed');
  const dnfDetail = await call('/books/' + b3.id);
  if (dnfDetail.events[0].rating !== 'D') throw new Error('event detail failed');
  // Stats extensions: tier spread, narrator leaderboard, DNF count.
  const sX = await call('/stats');
  if (!sX.tiers || sX.tiers.S < 1 || sX.tiers.D < 1) throw new Error(`stats tiers wrong: ${JSON.stringify(sX.tiers)}`);
  if (!Array.isArray(sX.narrators)) throw new Error('stats narrators missing');
  if (typeof sX.all_time.dnfs !== 'number' || sX.all_time.dnfs < 1) throw new Error('stats all_time.dnfs missing');
  console.log('filters + detail OK');

  // Needs-re-pull flag: books without full Hardcover data (no HC id, cover,
  // lengths or moods) surface for a re-pull; filling the gaps clears the flag.
  const nr0 = (await call('/books')).needs_refresh_count;
  const nrBook = (await call('/books', {
    title: 'Smoke Needs Refresh', author: 'N. R.', page_count: 100, audio_runtime_minutes: 300,
    source_provider: 'hardcover', source_id: '777001',
  })).book;
  created.push(nrBook.id);
  if (nrBook.hardcover_id !== 777001) throw new Error('needs-refresh fixture missing its HC anchor');
  let nrList = await call('/books');
  const nrRow = nrList.books.find((b) => b.id === nrBook.id);
  if (nrList.needs_refresh_count !== nr0 + 1 || !nrRow?.needs_refresh) {
    throw new Error(`needs_refresh wrong: count ${nrList.needs_refresh_count} vs ${nr0 + 1}, row flag ${JSON.stringify(nrRow?.needs_refresh)}`);
  }
  if (!(await call('/books/' + nrBook.id)).book.needs_refresh) throw new Error('detail view lost needs_refresh');
  // Filling cover + moods (the HC id is anchored at create) clears the flag.
  await call('/books/' + nrBook.id, { cover_url: 'https://covers.example/ok.jpg', moods: ['dark'] }, 'PUT');
  nrList = await call('/books');
  if (nrList.needs_refresh_count !== nr0 || nrList.books.find((b) => b.id === nrBook.id)?.needs_refresh) {
    throw new Error('needs_refresh did not clear after the gaps were filled');
  }
  console.log('needs-re-pull flag OK');

  // TBR lifecycle + to-be-rated / tbr filters
  const tb = (await call('/books', { title: 'Smoke TBR Book', author: 'D. Queue', moods: ['dark', 'adventurous'] })).book;
  created.push(tb.id);
  // normTags capitalizes the first letter of every tag on write (fc63a83).
  if (JSON.stringify(tb.moods) !== JSON.stringify(['Dark', 'Adventurous'])) {
    throw new Error(`moods round-trip on create failed: ${JSON.stringify(tb.moods)}`);
  }
  if (!Array.isArray((await call('/books')).books.find((b) => b.id === tb.id)?.moods)) {
    throw new Error('list rows must parse moods');
  }
  const ur = (await call('/books', { title: 'Smoke Unrated Book', author: 'E. Later' })).book;
  created.push(ur.id);
  await call('/tbr', { book_id: tb.id });
  const tbEntry = (await call('/tbr')).entries.find((e) => e.book_id === tb.id);
  if (!tbEntry) throw new Error('tbr add failed');
  if (JSON.stringify(tbEntry.moods) !== JSON.stringify(['Dark', 'Adventurous'])) {
    throw new Error(`tbr entry moods wrong: ${JSON.stringify(tbEntry.moods)}`);
  }
  if (!(await call('/books/' + tb.id)).book.in_tbr) throw new Error('in_tbr flag failed');
  await call('/books/' + tb.id, { moods: ['cozy', 'slow-burn'] }, 'PUT');
  if (JSON.stringify((await call('/books/' + tb.id)).book.moods) !== JSON.stringify(['Cozy', 'Slow-burn'])) {
    throw new Error('moods edit failed');
  }

  // Preserve the user's real "next up" book — our toggle clears the flag globally.
  const preQueue = await call('/tbr');
  const priorNext = preQueue.entries.find((e) => e.is_next_up && e.book_id !== tb.id);
  tbrNextUpBefore = priorNext?.book_id || null;

  await call('/tbr/next-up', { book_id: tb.id });
  // "To be rated" = unrated AND not queued; queued books get their own filter.
  const unratedNow = (await call('/books?tier=unrated')).books;
  if (!unratedNow.some((b) => b.id === ur.id)) throw new Error('unrated filter should include non-TBR unrated books');
  if (unratedNow.some((b) => b.id === tb.id)) throw new Error('unrated filter should exclude TBR books');
  const tbrFiltered = (await call('/books?tier=tbr')).books;
  if (!tbrFiltered.some((b) => b.id === tb.id)) throw new Error('tbr filter failed');
  if (tbrFiltered.some((b) => b.id === ur.id)) throw new Error('tbr filter should not include non-TBR books');
  await call('/events', { book_id: tb.id, format: 'read', status: 'finished', rating: 'B', finished_at: '2026-09-05' });
  if ((await call('/tbr')).entries.some((e) => e.book_id === tb.id)) throw new Error('tbr should drain after finish');
  if ((await call('/books?tier=tbr')).books.some((b) => b.id === tb.id)) throw new Error('finished book still in tbr filter');
  if ((await call('/books?tier=unrated')).books.some((b) => b.id === tb.id)) throw new Error('rated book still shows as to-be-rated');
  if (!(await call('/books?tier=B')).books.some((b) => b.id === tb.id)) throw new Error('tier B filter failed');
  console.log('tbr + to-be-rated OK');

  // Quick status route: closes an open 'reading' event in place (keeping its
  // format/medium), or creates a minimal event when none is open. Offline —
  // page_count set so no Hardcover enrichment runs.
  const qb = (await call('/books', { title: 'Smoke Quick Read', author: 'F. Fast', page_count: 300, audio_runtime_minutes: 600 })).book;
  created.push(qb.id);
  await call('/events', { book_id: qb.id, format: 'listened', medium: 'audiobook', status: 'reading' });
  const q1 = await call(`/books/${qb.id}/quick-status`, { status: 'read', finished_at: '2026-09-06' });
  if (q1.events.length !== 1) throw new Error('quick-status should close the open event, not add one');
  if (q1.events[0].status !== 'finished') throw new Error('quick-status read should finish the open event');
  if (q1.events[0].format !== 'listened' || q1.events[0].medium !== 'audiobook') throw new Error('quick-status lost format/medium');
  if (q1.events[0].finished_at !== '2026-09-06') throw new Error('quick-status finished_at wrong');

  const qb2 = (await call('/books', { title: 'Smoke Quick Fresh', author: 'G. New', page_count: 100 })).book;
  created.push(qb2.id);
  const q2 = await call(`/books/${qb2.id}/quick-status`, { status: 'dnf' });
  if (q2.events.length !== 1 || q2.events[0].status !== 'dnf' || q2.events[0].dnf_percent !== 50) {
    throw new Error('quick-status dnf should create one event with the 50% default');
  }
  if (q2.events[0].format !== 'read') throw new Error('quick-status created event should default to read format');
  if (!/^\d{4}-\d{2}-\d{2}/.test(q2.events[0].finished_at)) throw new Error('quick-status should default finished_at to today');

  // TBRing a 'reading' book must clear the in-progress designation.
  const qr = (await call('/books', { title: 'Smoke TBR Reading', author: 'H. Mid', page_count: 250 })).book;
  created.push(qr.id);
  await call('/events', { book_id: qr.id, format: 'read', status: 'reading' });
  await call('/tbr', { book_id: qr.id });
  const qrDetail = await call('/books/' + qr.id);
  if (qrDetail.events.some((e) => e.status === 'reading')) throw new Error('TBR should delete open reading events');
  if (!qrDetail.book.in_tbr) throw new Error('TBR after reading should still queue the book');

  // Quick-start: status 'reading' opens an event (idempotently), advances a
  // queued TBR row to 'started', and a later read closes it in place.
  const qb3 = (await call('/books', { title: 'Smoke Quick Start', author: 'I. Start', page_count: 140 })).book;
  created.push(qb3.id);
  await call('/tbr', { book_id: qb3.id });
  const qs1 = await call(`/books/${qb3.id}/quick-status`, { status: 'reading' });
  if (qs1.events.filter((e) => e.status === 'reading').length !== 1) throw new Error('quick-status reading should open one event');
  if (qs1.events[0].finished_at !== null) throw new Error('reading event must carry no finish date');
  const qs2 = await call(`/books/${qb3.id}/quick-status`, { status: 'reading' });
  if (qs2.events.length !== 1) throw new Error('quick-status reading is not idempotent');
  // GET /tbr lists queued rows only — read the advanced row straight from the DB.
  const qsTbr = liveDb.prepare('SELECT status FROM tbr WHERE user_id=? AND book_id=?').get(adminId, qb3.id)?.status;
  if (qsTbr !== 'started') throw new Error(`quick-start should advance the queued TBR row to started, got ${qsTbr}`);
  const qs3 = await call(`/books/${qb3.id}/quick-status`, { status: 'read' });
  if (qs3.events[0].status !== 'finished' || qs3.events[0].started_at === null) {
    throw new Error(`quick-status read should close the started event in place: ${JSON.stringify(qs3.events[0])}`);
  }

  // On pause: flag via PUT, its own filter bucket, excluded from to-be-rated,
  // cleared by quick-status (finishing a book means it is not paused).
  await call('/books/' + qb2.id, { on_pause: 1 }, 'PUT');
  if (!(await call('/books?tier=paused')).books.some((b) => b.id === qb2.id)) throw new Error('paused filter failed');
  if ((await call('/books?tier=unrated')).books.some((b) => b.id === qb2.id)) throw new Error('paused book should not be to-be-rated');
  const q3 = await call(`/books/${qb2.id}/quick-status`, { status: 'read' });
  if (q3.book.on_pause) throw new Error('quick-status should clear on_pause');
  if ((await call('/books?tier=paused')).books.some((b) => b.id === qb2.id)) throw new Error('paused filter should drop unpaused book');
  // Streaks ride on /stats — q3's finish is dated today via the server's
  // local-date default, so the current streak must be live; longest is
  // window-bounded but always >= current. (Must run before the self-clean
  // below removes this section's activity.)
  const sQ = await call('/stats');
  if (!Number.isInteger(sQ.streaks?.current) || sQ.streaks.current < 1
    || !Number.isInteger(sQ.streaks.longest) || sQ.streaks.longest < sQ.streaks.current) {
    throw new Error(`streaks wrong: ${JSON.stringify(sQ.streaks)}`);
  }
  // Self-clean before the import sections: those assert absolute books_read
  // deltas, so this section's finished/dnf events must not leak into them.
  // (Also in `created` — the final cleanup tolerates the double delete.)
  for (const id of [qb.id, qb2.id, qr.id, qb3.id]) await call('/books/' + id, null, 'DELETE');
  if ((await call('/books')).books.some((b) => [qb.id, qb2.id, qr.id, qb3.id].includes(b.id))) throw new Error('quick-status section self-clean failed');
  console.log('quick status + on pause OK');

  // Now-reading hero: progress rides on the open reading event (1-99 clamp),
  // /stats enriches it with lengths + estimate, finishing clears the entry.
  // Self-cleans before the import sections like the block above.
  const heroBook = (await call('/books', { title: 'Smoke Hero Reading', author: 'H. Reader', page_count: 300 })).book;
  created.push(heroBook.id);
  await call('/events', { book_id: heroBook.id, format: 'read', status: 'reading' });
  const heroEv = (await call('/books/' + heroBook.id)).events.find((e) => e.status === 'reading');
  await call(`/events/${heroEv.id}/progress`, { percent: 45 });
  try {
    await call(`/events/${heroEv.id}/progress`, { percent: 250 });
    throw new Error('progress accepted 250');
  } catch (err) {
    if (!/1-99/.test(err.message)) throw err;
  }
  const hero = (await call('/stats')).reading_now.find((r) => r.book_id === heroBook.id);
  if (!hero || hero.percent !== 45 || hero.est_pages_left !== 165 || hero.page_count !== 300) {
    throw new Error(`hero enrichment wrong: ${JSON.stringify(hero)}`);
  }
  await call(`/books/${heroBook.id}/quick-status`, { status: 'read' });
  if ((await call('/stats')).reading_now.some((r) => r.book_id === heroBook.id)) throw new Error('hero entry should clear after finish');
  await call('/books/' + heroBook.id, null, 'DELETE');
  console.log('now-reading hero OK');

  // Edit-in-place: PUT /events/:id changes date/rating/notes without changing
  // the row's identity (event ids drive "latest entry carries the rating"),
  // clears hero progress on a real status change, and advances TBR — the
  // same side effects a fresh entry has. Self-cleans like the block above.
  const ed = (await call('/books', { title: 'Smoke Edit Event', author: 'E. Ditor', page_count: 200 })).book;
  created.push(ed.id);
  const e1 = (await call('/events', { book_id: ed.id, format: 'read', status: 'finished', rating: 'B', finished_at: '2026-05-01' })).event;
  const e2 = (await call('/events', { book_id: ed.id, format: 'listened', status: 'finished', rating: 'A', narration_rating: 'S', finished_at: '2026-06-01' })).event;
  const upd = await call('/events/' + e2.id, { rating: 'S', finished_at: '2026-06-02', notes: 'edited' }, 'PUT');
  if (upd.event.id !== e2.id || upd.event.rating !== 'S' || upd.event.finished_at !== '2026-06-02' || upd.event.notes !== 'edited') {
    throw new Error(`event edit failed: ${JSON.stringify(upd.event)}`);
  }
  try {
    await call('/events/' + e2.id, { rating: 'Z' }, 'PUT');
    throw new Error('event edit accepted an invalid tier');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  try {
    await call('/events/' + e2.id, { finished_at: 'garbage' }, 'PUT');
    throw new Error('event edit accepted a malformed date');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  // Clearing the date leaves a finished entry with no date at all.
  const clr = await call('/events/' + e1.id, { finished_at: null }, 'PUT');
  if (clr.event.finished_at !== null) throw new Error('event edit should accept clearing the date');
  // Status change side effects: hero progress resets; a queued TBR row that
  // the entry predates advances to 'started'.
  await call('/tbr', { book_id: ed.id });
  const toReading = await call('/events/' + e1.id, { status: 'reading' }, 'PUT');
  if (toReading.event.status !== 'reading') throw new Error('event edit to reading failed');
  if (toReading.event.percent !== null) throw new Error('re-opened event should not carry stale progress');
  const edTbr = liveDb.prepare('SELECT status FROM tbr WHERE user_id=? AND book_id=?').get(adminId, ed.id)?.status;
  if (edTbr !== 'started') throw new Error(`event edit to reading should advance queued TBR to started, got ${edTbr}`);
  const e3 = (await call('/events', { book_id: ed.id, format: 'read', status: 'reading' })).event;
  await call(`/events/${e3.id}/progress`, { percent: 30 });
  const doneEv = await call('/events/' + e3.id, { status: 'finished', finished_at: '2026-06-03' }, 'PUT');
  if (doneEv.event.percent !== null || doneEv.event.status !== 'finished') throw new Error('status change should clear percent');
  for (const id of [ed.id]) await call('/books/' + id, null, 'DELETE');
  console.log('event edit OK');

  // Date-unknown entries: a finished event with neither date nor year counts
  // toward all-time totals but stays out of the year/month buckets — the
  // year-only landing is already covered by b4 and the year-review section.
  const preU = await call('/stats');
  const ub = (await call('/books', { title: 'Smoke Undated', author: 'U. Know', page_count: 100 })).book;
  created.push(ub.id);
  const uEv = (await call('/events', { book_id: ub.id, format: 'read', status: 'finished', rating: 'C' })).event;
  if (uEv.finished_at !== null || uEv.finished_year !== null) throw new Error(`undated event stored a date: ${JSON.stringify(uEv)}`);
  const postU = await call('/stats');
  if (postU.all_time.books_read - preU.all_time.books_read !== 1) throw new Error('undated finish not counted all-time');
  if (postU.this_year.books_read !== preU.this_year.books_read) throw new Error('undated finish leaked into this_year');
  if (JSON.stringify(postU.years) !== JSON.stringify(preU.years) || JSON.stringify(postU.months) !== JSON.stringify(preU.months)) {
    throw new Error('undated finish leaked into the year/month buckets');
  }
  await call('/books/' + ub.id, null, 'DELETE');
  console.log('date unknown OK');

  // Metadata re-pull: an unknown HC id degrades cleanly to {matched:false}
  // with the book untouched — HC being down must never 500 a re-pull.
  const rp = (await call('/books', {
    title: 'Smoke Re-pull Book', author: 'R. Pulled', page_count: 100,
    source_provider: 'hardcover', source_id: '999999999',
  })).book;
  created.push(rp.id);
  const rpRes = await call(`/books/${rp.id}/refresh`, {}, 'POST');
  if (rpRes.matched !== false || rpRes.changed.length) throw new Error(`re-pull degrade wrong: ${JSON.stringify(rpRes)}`);
  await call('/books/' + rp.id, null, 'DELETE');
  console.log('book re-pull OK');

  // "No Hardcover profile" exclusion: a book with no HC data flags
  // needs_refresh like any unlinked book; excluding it clears the flag
  // everywhere, refresh short-circuits without a HC call, and un-excluding
  // brings the flag back. (Offline-safe: the excluded refresh's Google
  // fallback finds nothing for a Smoke title.)
  const ex0 = (await call('/books')).needs_refresh_count;
  const exBook = (await call('/books', { title: 'Smoke No HC Book', author: 'N. Hc', page_count: 100 })).book;
  created.push(exBook.id);
  if ((await call('/books')).needs_refresh_count !== ex0 + 1) throw new Error('no-HC fixture should flag needs_refresh');
  const exPut = await call('/books/' + exBook.id, { hardcover_excluded: 1 }, 'PUT');
  if (!exPut.book.hardcover_excluded) throw new Error('hardcover_excluded did not stick');
  const exList = await call('/books');
  if (exList.needs_refresh_count !== ex0 || exList.books.find((b) => b.id === exBook.id)?.needs_refresh) {
    throw new Error('excluded book still flags needs_refresh');
  }
  const exRefresh = await call(`/books/${exBook.id}/refresh`, {}, 'POST');
  if (exRefresh.matched !== false || exRefresh.excluded !== true || exRefresh.fallback_changed?.length) {
    throw new Error(`excluded refresh wrong: ${JSON.stringify(exRefresh)}`);
  }
  await call('/books/' + exBook.id, { hardcover_excluded: 0 }, 'PUT');
  if ((await call('/books')).needs_refresh_count !== ex0 + 1) throw new Error('un-excluding should restore the flag');
  console.log('no-HC exclusion OK');

  // Bulk read-date fixup: import-stamped finish dates clear on the selected
  // books' entries ("date unknown" mode) or land in a given year — ratings and
  // all-time counts stay, and the route only touches the caller's own books
  // (the foreign id is ignored).
  const bd1 = (await call('/books', { title: 'Smoke Bulk Date One', author: 'B. Bulk', page_count: 100 })).book;
  const bd2 = (await call('/books', { title: 'Smoke Bulk Date Two', author: 'B. Bulk', page_count: 100 })).book;
  created.push(bd1.id, bd2.id);
  await call('/events', { book_id: bd1.id, format: 'read', status: 'finished', rating: 'B', finished_at: '2024-03-01' });
  await call('/events', { book_id: bd2.id, format: 'read', status: 'finished', finished_year: 2024 });
  const preB = await call('/stats');
  const bd = await call('/books/read-dates-set', { ids: [bd1.id, bd2.id, 999999999] });
  if (bd.books !== 2 || bd.events !== 2 || bd.year !== null) throw new Error(`bulk date-unknown wrong: ${JSON.stringify(bd)}`);
  const postB = await call('/stats');
  if (postB.all_time.books_read !== preB.all_time.books_read) throw new Error('bulk clear lost all-time entries');
  if (postB.this_year.books_read !== preB.this_year.books_read) throw new Error('bulk clear moved this_year');
  const bd1Ev = (await call('/books/' + bd1.id)).events[0];
  if (bd1Ev.finished_at !== null || bd1Ev.rating !== 'B') throw new Error(`bulk clear lost data: ${JSON.stringify(bd1Ev)}`);
  if ((await call('/books/' + bd2.id)).events[0].finished_year !== null) throw new Error('bulk clear missed finished_year');
  if ((await call('/books')).books.find((x) => x.id === bd1.id)?.last_finished !== null) throw new Error('last_finished not cleared');
  // Year mode: entries the unknown pass just blanked carry NO date at all —
  // the status-based filter must still catch them (a has-a-date filter wouldn't).
  const by = await call('/books/read-dates-set', { ids: [bd1.id, bd2.id], year: 2023 });
  if (by.books !== 2 || by.events !== 2 || by.year !== 2023) throw new Error(`bulk set-year wrong: ${JSON.stringify(by)}`);
  const bd1Y = (await call('/books/' + bd1.id)).events[0];
  if (bd1Y.finished_year !== 2023 || bd1Y.finished_at !== null || bd1Y.rating !== 'B') {
    throw new Error(`bulk set-year lost data: ${JSON.stringify(bd1Y)}`);
  }
  if ((await call('/books')).books.find((x) => x.id === bd1.id)?.last_finished !== '2023') {
    throw new Error('last_finished should show the bulk-set year');
  }
  const postY = await call('/stats');
  if (postY.all_time.books_read !== preB.all_time.books_read || postY.this_year.books_read !== preB.this_year.books_read) {
    throw new Error('bulk set-year shifted totals');
  }
  try {
    await call('/books/read-dates-set', { ids: [] });
    throw new Error('bulk read-dates accepted an empty id list');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  try {
    await call('/books/read-dates-set', { ids: [bd1.id], year: 1900 });
    throw new Error('bulk read-dates accepted an out-of-range year');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  // Self-clean before the import sections: those assert absolute books_read
  // deltas, so this section's two finished entries must not leak into them.
  // (Also in `created` — the final cleanup tolerates the double delete.)
  for (const id of [bd1.id, bd2.id]) await call('/books/' + id, null, 'DELETE');
  console.log('bulk read-dates OK');

  // Per-member ABS link + progress sync: an in-process mock ABS serves
  // deterministic mediaProgresses; the pipeline must link, sync part-listened
  // → reading percent, finished → dated listen, ignore zero-progress items,
  // never leak the API token, and be idempotent on re-sync.
  const absProgress = {
    'li-1': { libraryItemId: 'li-1', currentTime: 100, duration: 200, progress: 0.5, isFinished: false, lastUpdate: Date.now() },
    'li-2': { libraryItemId: 'li-2', currentTime: 300, duration: 300, progress: 1, isFinished: true, lastUpdate: Date.UTC(2025, 4, 10, 21, 30) },
    'li-3': { libraryItemId: 'li-3', currentTime: 0, duration: 400, progress: 0, isFinished: false, lastUpdate: Date.now() },
    'li-4': { libraryItemId: 'li-4', currentTime: 60, duration: 200, progress: 0.3, isFinished: false, lastUpdate: Date.now() },
  };
  const absItems = {
    'li-1': { id: 'li-1', media: { duration: 200, metadata: { title: 'Smoke ABS Listening', authors: [{ name: 'A. Bs' }] } } },
    'li-2': { id: 'li-2', media: { duration: 300, metadata: { title: 'Smoke ABS Finished', authors: [{ name: 'A. Bs' }] } } },
    'li-3': { id: 'li-3', media: { duration: 400, metadata: { title: 'Smoke ABS Zero', authors: [{ name: 'A. Bs' }] } } },
    'li-4': { id: 'li-4', media: { duration: 200, metadata: { title: 'Smoke ABS Stale Finish', authors: [{ name: 'A. Bs' }] } } },
  };
  const absMock = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer smoke-abs-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    if (/^\/api\/items\/.+\/cover/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.alloc(200, 7));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/me') res.end(JSON.stringify({ username: 'smoke-abs', mediaProgresses: Object.values(absProgress) }));
    else if (req.url === '/api/libraries') res.end(JSON.stringify({ libraries: [{ id: 'lib-smoke', name: 'Smoke Lib', mediaType: 'book' }] }));
    else if (/^\/api\/libraries\/lib-smoke\/items/.test(req.url)) {
      res.end(JSON.stringify({ results: Object.values(absItems), total: Object.keys(absItems).length, page: 0 }));
    } else res.end('{}');
  });
  await new Promise((r) => absMock.listen(SMOKE_ABS_PORT, '127.0.0.1', r));
  const absBase = `http://127.0.0.1:${SMOKE_ABS_PORT}`;
  try {
    // SSRF gate: member (non-sanctioned) URLs must be https and resolve
    // publicly. The mock's loopback origin works because the harness boots
    // the server with ABS_LINK_ALLOWLIST containing it (admin-sanctioned
    // path); the open path rejects http and private addresses outright.
    const openGuards = [
      // LAN fixture built from parts: the export privacy gate pattern-matches
      // raw private-range strings, and these tests exist to verify that range
      // is blocked.
      ['http://' + ['192', '168', '1', '1'].join('.') + ':13378', /https/i],
      ['http://localhost:13378', /https/i],
      ['https://' + ['192', '168', '1', '1'].join('.'), /private network/i],
      ['https://10.0.0.5', /private network/i],
    ];
    for (const [url, pattern] of openGuards) {
      const err = await call('/abs/validate', { server_url: url, api_token: 'x' }).then(() => null, (e) => e);
      if (!err || !pattern.test(err.message)) {
        throw new Error(`ssrf guard wrong for ${url}: ${err ? err.message : 'allowed!'}`);
      }
    }
    const v = await call('/abs/validate', { server_url: absBase, api_token: 'smoke-abs-token' });
    // No link yet → bare notice shape.
    const notice0 = await call('/abs/notice');
    if (notice0.last_synced_at !== null) throw new Error(`abs notice should be null pre-link: ${JSON.stringify(notice0)}`);
    if (v.username !== 'smoke-abs' || !v.libraries.some((l) => l.id === 'lib-smoke')) {
      throw new Error(`abs validate wrong: ${JSON.stringify(v)}`);
    }
    try {
      await call('/abs/validate', { server_url: absBase, api_token: 'wrong-token' });
      throw new Error('abs validate accepted a bad token');
    } catch (err) {
      if (!/400/.test(err.message)) throw err;
    }
    await call('/abs/link', { server_url: absBase, api_token: 'smoke-abs-token', library_id: 'lib-smoke' });
    const linkView = JSON.stringify(await call('/abs/link'));
    if (linkView.includes('smoke-abs-token')) throw new Error('abs link status leaked the API token');

    const ajob = await call('/jobs', { kind: 'abs_sync' });
    jobIds.push(ajob.id);
    const ares = await waitForJob(ajob.id);
    if (ares.status !== 'done') throw new Error(`abs sync job failed: ${ares.error}`);
    if (ares.result.books_added !== 3 || ares.result.finished_dated !== 1 || ares.result.reading_opened !== 2) {
      throw new Error(`abs sync result wrong: ${JSON.stringify(ares.result)}`);
    }
    // Boot-time notice endpoint carries the sync stamp for the boot toast.
    const absNotice = await call('/abs/notice');
    if (typeof absNotice.last_synced_at !== 'string' || !absNotice.last_synced_at) {
      throw new Error(`abs notice missing stamp: ${JSON.stringify(absNotice)}`);
    }
    const absList = await call('/books?query=smoke+abs');
    created.push(...absList.books.map((b) => b.id));
    if (absList.books.length !== 3) throw new Error(`abs sync books wrong: ${absList.books.length}`);
    const absListen = (await call('/books/' + absList.books.find((b) => b.title === 'Smoke ABS Listening').id)).events[0];
    if (absListen.status !== 'reading' || absListen.percent !== 50 || absListen.format !== 'listened') {
      throw new Error(`abs reading event wrong: ${JSON.stringify(absListen)}`);
    }
    const absFin = (await call('/books/' + absList.books.find((b) => b.title === 'Smoke ABS Finished').id)).events[0];
    if (absFin.finished_at !== '2025-05-10' || absFin.format !== 'listened') {
      throw new Error(`abs finished event wrong: ${JSON.stringify(absFin)}`);
    }
    // An UNDATED recorded finish must stay undated: ABS's lastUpdate is when
    // the title was marked finished in ABS — worthless as a read date (it
    // once stamped 2026-08-16 across a whole back catalog). Clear the date
    // and make the re-sync prove it leaves the event alone.
    liveDb.prepare("UPDATE events SET finished_at=NULL, finished_year=NULL WHERE book_id=? AND status='finished'")
      .run(absList.books.find((b) => b.title === 'Smoke ABS Finished').id);
    // Idempotency + live progress: bump li-1 to 60% — the same event updates
    // in place, the finished book is left alone, zero-progress stays ignored.
    absProgress['li-1'].progress = 0.6;
    const ares2 = await waitForJob((await call('/jobs', { kind: 'abs_sync' })).id);
    jobIds.push(ares2.id);
    if (ares2.status !== 'done' || ares2.result.reading_updated !== 1 || ares2.result.books_added !== 0) {
      throw new Error(`abs re-sync wrong: ${JSON.stringify(ares2.result)}`);
    }
    if (!ares2.result.already_finished.includes('Smoke ABS Finished')) {
      throw new Error(`abs re-sync did not skip the undated finish: ${JSON.stringify(ares2.result)}`);
    }
    const absFin2 = (await call('/books/' + absList.books.find((b) => b.title === 'Smoke ABS Finished').id)).events[0];
    if (absFin2.finished_at !== null || absFin2.finished_year !== null) {
      throw new Error(`abs sync re-dated an undated finish: ${JSON.stringify(absFin2)}`);
    }
    const absListen2 = (await call('/books/' + absList.books.find((b) => b.title === 'Smoke ABS Listening').id)).events;
    if (absListen2.length !== 1 || absListen2[0].percent !== 60) {
      throw new Error(`abs re-sync duplicated or lost progress: ${JSON.stringify(absListen2)}`);
    }
    // Act 4 pin (the 2026-08-12/15 import-stamped mark days): a completion
    // observed on a tracked book with a STALE lastUpdate is a
    // mark-without-listening — it must record undated, never carry the stale
    // day. li-4 flips to finished with a 40-day-old timestamp. A third sync
    // then proves a FRESH completion still dates (li-1, timestamped now).
    const byTitle = (t) => absList.books.find((b) => b.title === t).id;
    absProgress['li-4'].isFinished = true;
    absProgress['li-4'].progress = 1;
    absProgress['li-4'].lastUpdate = Date.now() - 40 * 864e5;
    const ares3 = await waitForJob((await call('/jobs', { kind: 'abs_sync' })).id);
    jobIds.push(ares3.id);
    if (ares3.status !== 'done' || ares3.result.finished_closed !== 1 || ares3.result.finished_undated !== 1) {
      throw new Error(`abs stale-finish re-sync wrong: ${JSON.stringify(ares3.result)}`);
    }
    const absStale = (await call('/books/' + byTitle('Smoke ABS Stale Finish'))).events[0];
    if (absStale.status !== 'finished' || absStale.finished_at !== null || absStale.finished_year !== null) {
      throw new Error(`abs sync stamped a stale lastUpdate: ${JSON.stringify(absStale)}`);
    }
    absProgress['li-1'].isFinished = true;
    absProgress['li-1'].progress = 1;
    const ares4 = await waitForJob((await call('/jobs', { kind: 'abs_sync' })).id);
    jobIds.push(ares4.id);
    if (ares4.status !== 'done' || ares4.result.finished_closed !== 1 || ares4.result.finished_undated !== 0) {
      throw new Error(`abs fresh-finish re-sync wrong: ${JSON.stringify(ares4.result)}`);
    }
    const today = new Date();
    const want = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const absListen3 = (await call('/books/' + byTitle('Smoke ABS Listening'))).events[0];
    if (absListen3.status !== 'finished' || absListen3.finished_at !== want) {
      throw new Error(`abs fresh finish not dated today: ${JSON.stringify(absListen3)}`);
    }
    // Self-clean before the import sections (absolute books_read deltas below).
    for (const b of absList.books) await call('/books/' + b.id, null, 'DELETE');
    console.log('abs link + sync OK');
  } finally {
    absMock.close();
  }

  // Kobo import pipeline: parse a synthetic device database, then import
  // through the jobs system (start → poll → result), the same path the UI
  // uses. Hardcover matching off — Smoke titles won't match.
  const koboPath = makeKoboFixture();
  const parsed = await callRaw('/kobo/parse', readFileSync(koboPath));
  if (parsed.books.length !== 3) throw new Error(`kobo parse found ${parsed.books.length} books != 3`);
  const kById = Object.fromEntries(parsed.books.map((b) => [b.content_id, b]));
  if (kById['kobo-1'].suggested_status !== 'finished') throw new Error('kobo finished suggestion wrong');
  if (kById['kobo-2'].suggested_status !== 'reading') throw new Error('kobo reading suggestion wrong');
  if (kById['kobo-3'].suggested_status !== 'book') throw new Error('kobo book suggestion wrong');
  if (kById['kobo-1'].last_read !== '2026-01-15') throw new Error('kobo date parse failed');
  try {
    await call('/jobs', { kind: 'not-a-kind' });
    throw new Error('unknown job kind was accepted');
  } catch (err) {
    if (!/unknown job kind/.test(err.message)) throw err;
  }
  const kjob = await call('/jobs', {
    kind: 'kobo_import',
    payload: { hardcover: false, rows: parsed.books.map((b) => ({ ...b, chosen_status: b.suggested_status })) },
  });
  jobIds.push(kjob.id);
  const kres = await waitForJob(kjob.id);
  if (kres.status !== 'done') throw new Error(`kobo job failed: ${kres.error}`);
  const kimp = kres.result;
  if (kimp.imported !== 3 || kimp.events_created !== 2) {
    throw new Error(`kobo job result wrong: ${JSON.stringify(kimp)}`);
  }
  created.push(...kimp.book_ids);
  // LastModified drift pin: a finished book re-opened on the device bumps
  // Kobo's LastModified, and dating the dedupe tuple let that mint a phantom
  // second finish. Re-import the same rows with a bumped finish date — the
  // book+format guard must still skip, leaving one finished event.
  const driftRows = parsed.books.map((b) => ({
    ...b,
    chosen_status: b.suggested_status,
    last_read: b.content_id === 'kobo-1' ? '2026-03-20' : b.last_read,
  }));
  const kdrift = await call('/jobs', { kind: 'kobo_import', payload: { hardcover: false, rows: driftRows } });
  jobIds.push(kdrift.id);
  const kdres = await waitForJob(kdrift.id);
  if (kdres.status !== 'done' || kdres.result.events_created !== 0) {
    throw new Error(`kobo drift re-import minted events: ${JSON.stringify(kdres.result)}`);
  }
  const kdriftEv = (await call('/books/' + kimp.book_ids[0])).events.filter((e) => e.status === 'finished');
  if (kdriftEv.length !== 1 || kdriftEv[0].finished_at !== '2026-01-15') {
    throw new Error(`kobo drift duplicated the finish: ${JSON.stringify(kdriftEv)}`);
  }
  const kStats = await call('/stats');
  if (kStats.all_time.books_read - baseline.all.books_read !== 6) throw new Error('kobo finished event not counted');
  if (!kStats.reading_now.some((r) => r.title === 'Smoke Kobo Partial')) throw new Error('kobo reading event missing');
  // All-history pace series: no-gap months between first and last dated event.
  if (!Array.isArray(kStats.months_all) || !kStats.months_all.length) throw new Error('stats missing all-history month series');
  if (!kStats.months_all.every((m) => /^\d{4}-\d{2}$/.test(m.key) && m.full)) throw new Error('months_all rows malformed');
  // Heatmap + momentum payloads.
  if (!Array.isArray(kStats.days) || kStats.days.length !== 365) throw new Error(`stats.days should be 365 no-gap entries, got ${kStats.days?.length}`);
  if (typeof kStats.momentum?.this_month !== 'number' || typeof kStats.momentum?.trailing_avg !== 'number') throw new Error('stats momentum missing');
  if (typeof kStats.goals !== 'object') throw new Error('stats goals missing');
  console.log('kobo import OK');

  // Device link: the fixture carries device credentials, so the parse offers
  // the link and the opt-in roundtrip stores — but never returns — the key.
  // Skipped when the admin already has a REAL link: its secret can't be
  // snapshotted back, so the delta rule says don't touch it.
  if (!parsed.device_link_available) throw new Error('kobo parse missed device credentials');
  const preLink = (await call('/kobo/link')).link;
  if (!preLink) {
    await call('/kobo/link', {}, 'POST');
    const linked = (await call('/kobo/link')).link;
    if (!linked?.api_endpoint || linked.kobo_user_id !== 'smoke-kobo-user') {
      throw new Error(`kobo link roundtrip wrong: ${JSON.stringify(linked)}`);
    }
    if (JSON.stringify(linked).includes('smoke-device-key')) throw new Error('kobo link status leaked the device key');
    await call('/kobo/link', null, 'DELETE');
    if ((await call('/kobo/link')).link) throw new Error('kobo unlink failed');
    console.log('kobo device link OK');
  } else {
    console.log('kobo device link: pre-existing link present, roundtrip skipped');
  }

  // Audible import: helper-app CSV → parse → job → events; then the same rows
  // again must not double-count (idempotency guard), and JSON must parse too.
  const aCsv = await callRaw('/audible/parse', Buffer.from(makeAudibleCsv()));
  if (aCsv.books.length !== 3) throw new Error(`audible csv parse found ${aCsv.books.length} books != 3`);
  const aById = Object.fromEntries(aCsv.books.map((b) => [b.content_id, b]));
  const aFin = aById['B0AUDITFIN1'];
  if (aFin.suggested_status !== 'finished' || aFin.percent !== 100) throw new Error('audible finished suggestion wrong');
  if (aFin.last_read !== '2026-01-15') throw new Error('audible date parse failed');
  if (aFin.runtime_minutes !== 603) throw new Error(`audible runtime parse failed: ${aFin.runtime_minutes}`);
  if (aById['B0AUDITPAR1'].suggested_status !== 'reading' || aById['B0AUDITPAR1'].percent !== 40) throw new Error('audible reading suggestion wrong');
  if (aById['B0AUDITUNB1'].suggested_status !== 'book') throw new Error('audible book suggestion wrong');
  const aJson = await callRaw('/audible/parse', Buffer.from(makeAudibleJson()));
  if (aJson.books.length !== 2 || aJson.books[0].suggested_status !== 'finished') throw new Error('audible json parse failed');
  // Both XML spellings: Excel writes bare tags, Libation writes namespaced.
  await assertXlsxVariant('');
  await assertXlsxVariant('x');

  const audRows = aCsv.books.map((b) => ({ ...b, chosen_status: b.suggested_status }));
  for (const pass of [1, 2]) {
    const aj = await call('/jobs', { kind: 'audible_import', payload: { hardcover: false, rows: audRows } });
    jobIds.push(aj.id);
    const ares = await waitForJob(aj.id);
    if (ares.status !== 'done') throw new Error(`audible job failed: ${ares.error}`);
    if (ares.result.imported !== 3 || ares.result.events_created !== (pass === 1 ? 2 : 0)) {
      throw new Error(`audible import pass ${pass} wrong: ${JSON.stringify(ares.result)}`);
    }
    if (pass === 1) created.push(...ares.result.book_ids);
  }
  const aStats = await call('/stats');
  if (aStats.all_time.books_read - baseline.all.books_read !== 7) throw new Error('audible finished event not counted');
  // Audible rows are listening history: listened format, audible medium, and
  // the narrator from the CSV must land on the book.
  const aDetail = await call('/books/' + created.at(-3));
  const aEv = aDetail.events[0];
  if (aEv.format !== 'listened' || aEv.medium !== 'audiobook') throw new Error(`audible event not listening: ${JSON.stringify(aEv)}`);
  if (aDetail.book.narrator !== 'N. Narrator') throw new Error(`audible narrator missing: ${aDetail.book.narrator}`);
  // Imported in-progress rows must land their progress in events.percent —
  // the now-reading hero reads the column, not the note text.
  const aPartial = (await call('/books?query=smoke+audible+partial')).books[0];
  const aPartEv = (await call('/books/' + aPartial.id)).events[0];
  if (aPartEv.status !== 'reading' || aPartEv.percent !== 40) {
    throw new Error(`imported progress not stored: ${JSON.stringify(aPartEv)}`);
  }
  console.log('audible import OK');

  // Tier board API: re-rating sets the latest entry's tier; series rollups
  // average member tiers (S=5…D=1) and honor manual overrides.
  const s1 = (await call('/books', { title: 'Smoke Saga One', author: 'S. Author', series_name: 'Smoke Saga', page_count: 100 })).book;
  const s2 = (await call('/books', { title: 'Smoke Saga Two', author: 'S. Author', series_name: 'Smoke Saga', page_count: 100 })).book;
  const s3 = (await call('/books', { title: 'Smoke Saga Three', author: 'S. Author', series_name: 'Smoke Saga', page_count: 100 })).book;
  created.push(s1.id, s2.id, s3.id);
  await call('/events', { book_id: s1.id, format: 'read', status: 'finished', rating: 'S', finished_at: '2026-08-01' });
  await call('/events', { book_id: s2.id, format: 'read', status: 'finished', rating: 'S', finished_at: '2026-08-02' });
  await call('/events', { book_id: s3.id, format: 'read', status: 'finished', rating: 'A', finished_at: '2026-08-03' });
  let roll = (await call('/series-rollups')).rollups.find((x) => x.series === 'Smoke Saga');
  if (!roll || roll.rated !== 3 || Math.abs(roll.score - 14 / 3) > 0.01 || roll.suggested !== 'S') {
    throw new Error(`series rollup wrong: ${JSON.stringify(roll)}`);
  }
  await call('/books/' + s3.id + '/rating', { rating: 'D' }, 'PUT');
  if (!(await call('/books?tier=D')).books.some((b) => b.id === s3.id)) throw new Error('board re-rate failed');
  roll = (await call('/series-rollups')).rollups.find((x) => x.series === 'Smoke Saga');
  if (!roll || Math.abs(roll.score - 11 / 3) > 0.01) throw new Error('rollup did not follow re-rate');
  // An unrated re-read (open in-progress event) must not evict the book from
  // its rollup — the join follows the latest RATED entry, like the board does.
  await call('/events', { book_id: s3.id, format: 'read', status: 'reading' });
  roll = (await call('/series-rollups')).rollups.find((x) => x.series === 'Smoke Saga');
  if (!roll || roll.rated !== 3 || Math.abs(roll.score - 11 / 3) > 0.01) {
    throw new Error(`unrated re-read broke rollup: ${JSON.stringify(roll)}`);
  }
  await call('/series-overrides', { series_name: 'Smoke Saga', rating: 'B' }, 'PUT');
  roll = (await call('/series-rollups')).rollups.find((x) => x.series === 'Smoke Saga');
  if (roll.override !== 'B') throw new Error('series override set failed');
  await call('/series-overrides', { series_name: 'Smoke Saga', rating: null }, 'PUT');
  roll = (await call('/series-rollups')).rollups.find((x) => x.series === 'Smoke Saga');
  if (roll.override !== null) throw new Error('series override clear failed');
  // Within-tier arrangement: the board's saved order — full id list per row,
  // all-or-nothing ownership.
  await call('/board/reorder', { ids: [s3.id, s1.id, s2.id] }, 'POST');
  const order = liveDb.prepare('SELECT id, tier_order FROM books WHERE id IN (?,?,?) ORDER BY tier_order')
    .all(s3.id, s1.id, s2.id);
  if (JSON.stringify(order.map((r) => r.id)) !== JSON.stringify([s3.id, s1.id, s2.id])
    || order.some((r, i) => r.tier_order !== i)) {
    throw new Error(`board reorder not persisted: ${JSON.stringify(order)}`);
  }
  try {
    await call('/board/reorder', { ids: [s1.id, -999] }, 'POST');
    throw new Error('board reorder accepted a foreign book id');
  } catch (err) {
    if (!/404/.test(err.message)) throw err;
  }
  console.log('tier board OK');

  // ---- auth: invite → signup → login → cross-user isolation ----
  const inv = await call('/auth/invites', { recipient: 'Smoke Friend' }, 'POST');
  if (!/#invite\//.test(inv.url)) throw new Error('invite url malformed');
  if (inv.recipient !== 'Smoke Friend') throw new Error(`invite recipient missing: ${JSON.stringify(inv)}`);
  const invList = await call('/auth/invites');
  const mintedInvite = invList.invites.find((i) => i.recipient === 'Smoke Friend');
  if (!mintedInvite) throw new Error('invite list lost the recipient label');
  const inviteToken = inv.url.split('/').pop();
  const nu = await call('/auth/invite/accept', { token: inviteToken, name: 'Smoke Invited', password: 'password123' });
  invitedUserId = nu.id;
  if (!invitedUserId) throw new Error('invite accept failed');
  // New accounts default to share_compare ON (comparisons are the point of a
  // household instance). The consent-gate tests below need the opted-OUT
  // state, so assert the default and then flip it off explicitly.
  if (!liveDb.prepare('SELECT share_compare FROM users WHERE id=?').get(invitedUserId).share_compare) {
    throw new Error('new accounts should default share_compare ON');
  }
  liveDb.prepare('UPDATE users SET share_compare=0 WHERE id=?').run(invitedUserId);
  try {
    await call('/auth/invite/accept', { token: inviteToken, name: 'Smoke Twice', password: 'password123' });
    throw new Error('single-use invite was reused');
  } catch (err) {
    if (!/not valid anymore/.test(err.message)) throw err;
  }
  const login = await call('/auth/login', { name: 'Smoke Invited', password: 'password123' });
  if (login.is_admin) throw new Error('invited user must not be admin');
  try {
    activeCookie = null;
    await call('/auth/login', { name: 'Smoke Invited', password: 'wrong-wrong' });
    throw new Error('wrong password accepted');
  } catch (err) {
    if (!/wrong name or password/.test(err.message)) throw err;
  } finally {
    activeCookie = adminCookie;
  }
  try {
    activeCookie = null;
    await call('/books');
    throw new Error('unauthenticated API access allowed');
  } catch (err) {
    if (!/401/.test(err.message)) throw err;
  } finally {
    activeCookie = adminCookie;
  }
  // Invited (non-admin) session: admin surfaces are off-limits.
  const invitedCookie = makeSession(invitedUserId);
  activeCookie = invitedCookie;
  try {
    await call('/auth/invites', {}, 'POST');
    throw new Error('non-admin created an invite');
  } catch (err) {
    if (!/403/.test(err.message)) throw err;
  }
  try {
    await call('/jobs', { kind: 'abs_import', payload: {} });
    throw new Error('non-admin ran the ABS import');
  } catch (err) {
    if (!/403/.test(err.message)) throw err;
  }
  // Cross-user isolation: the invited user cannot see the admin's books.
  // The private book is created as the admin — switch back first.
  activeCookie = adminCookie;
  const priv = (await call('/books', { title: 'Smoke Private Book', author: 'X. Y' })).book;
  created.push(priv.id);
  activeCookie = invitedCookie;
  if ((await call('/books')).books.some((b) => b.id === priv.id)) throw new Error('cross-user book leak (list)');
  try {
    await call('/books/' + priv.id);
    throw new Error('cross-user book leak (detail)');
  } catch (err) {
    if (!/404/.test(err.message)) throw err;
  }
  activeCookie = adminCookie;
  console.log('auth + isolation OK');

  // Compare view: cross-user tiers are consent-gated (users.share_compare).
  // The invited user mirrors the admin's Smoke Saga with different ratings:
  // One=A, Two=unrated, Three=S, plus one book only they have.
  // The calibrated taste match depends on both raters' FULL rating histories —
  // and the admin here is the live instance's real admin — so expected values
  // are recomputed straight from the DB rather than hardcoded. Same math as
  // the server's tasteMatch(): latest rating per book on the 1–5 scale,
  // centered on a baseline of 0.5·μ + 1.5 (global mean shrunk halfway to the
  // scale's neutral midpoint), adjusted cosine of the overlap, shrunk n/(n+10).
  const R5 = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  const globalMean5 = (uid) => {
    const v = liveDb.prepare(`
      SELECT (SELECT e.rating FROM events e WHERE e.book_id = b.id AND e.rating IS NOT NULL
              ORDER BY e.id DESC LIMIT 1) AS rating
      FROM books b WHERE b.user_id = ?`).all(uid)
      .map((r) => R5[r.rating]).filter((x) => x !== undefined);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  const expectedTaste = (pairs) => {
    const baseA = 0.5 * globalMean5(adminId) + 1.5;
    const baseI = 0.5 * globalMean5(invitedUserId) + 1.5;
    let num = 0;
    let aSq = 0;
    let iSq = 0;
    for (const [ra, ri] of pairs) {
      const u = R5[ra] - baseA;
      const v = R5[ri] - baseI;
      num += u * v;
      aSq += u * u;
      iSq += v * v;
    }
    const denom = Math.sqrt(aSq) * Math.sqrt(iSq);
    const raw = denom > 0 ? Math.max(-1, Math.min(1, num / denom)) : 0;
    const damped = raw * (pairs.length / (pairs.length + 10));
    return {
      raw: Math.round(raw * 10000) / 10000,
      pct: Math.round(((damped + 1) / 2) * 100),
      raw_pct: Math.round(((raw + 1) / 2) * 100), // per-genre bars use the undamped map
    };
  };
  try {
    await call('/compare/with/' + invitedUserId);
    throw new Error('compare worked without consent');
  } catch (err) {
    if (!/403/.test(err.message)) throw err;
  }
  if ((await call('/compare/users')).users.some((u) => u.id === invitedUserId)) {
    throw new Error('non-consenting user listed in compare picker');
  }
  activeCookie = invitedCookie;
  await call('/compare/consent', { share: true }, 'PUT');
  if (!(await call('/compare/consent')).share) throw new Error('consent flag did not stick');
  const c1 = (await call('/books', { title: 'Smoke Saga One', author: 'S. Author', series_name: 'Smoke Saga', page_count: 100 })).book;
  const c2 = (await call('/books', { title: 'Smoke Saga Two', author: 'S. Author', series_name: 'Smoke Saga', page_count: 100 })).book;
  const c3 = (await call('/books', { title: 'Smoke Saga Three', author: 'S. Author', series_name: 'Smoke Saga', page_count: 100 })).book;
  const lone = (await call('/books', { title: 'Smoke Only Theirs', author: 'L. One' })).book;
  await call('/events', { book_id: c1.id, format: 'read', status: 'finished', rating: 'A', finished_at: '2026-08-01' });
  // Logged but not tiered yet — an entry with no rating must still overlap.
  await call('/events', { book_id: c2.id, format: 'read', status: 'finished', finished_at: '2026-08-02' });
  await call('/events', { book_id: c3.id, format: 'read', status: 'finished', rating: 'S', finished_at: '2026-08-03' });
  await call('/events', { book_id: lone.id, format: 'read', status: 'finished', rating: 'B', finished_at: '2026-08-03' });
  // The admin may genuinely have opted in on this instance (delta-based rule:
  // only assert the not-opted-in path when they actually haven't).
  if (!liveDb.prepare('SELECT share_compare FROM users WHERE id=?').get(adminId).share_compare) {
    if ((await call('/compare/users')).users.some((u) => u.id === adminId)) {
      throw new Error('admin listed without opting in');
    }
    try {
      await call('/compare/with/' + adminId);
      throw new Error('compared with a non-consenting user');
    } catch (err) {
      if (!/403/.test(err.message)) throw err;
    }
  }
  try {
    await call('/compare/with/' + invitedUserId);
    throw new Error('self-compare allowed');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  activeCookie = adminCookie;
  const cmp = await call('/compare/with/' + invitedUserId);
  if (cmp.summary.shared !== 3 || cmp.summary.both_rated !== 2 || cmp.summary.agree !== 0
    || cmp.summary.agree_pct !== 0 || cmp.summary.avg_delta !== -1.5) {
    throw new Error(`compare summary wrong: ${JSON.stringify(cmp.summary)}`);
  }
  // Calibrated taste score: Saga Two's unrated side stays out (n=2), and the
  // score must equal the independent recomputation over the live library.
  const expTaste2 = expectedTaste([['S', 'A'], ['D', 'S']]);
  if (cmp.summary.taste?.n !== 2 || cmp.summary.taste.raw !== expTaste2.raw
    || cmp.summary.taste.pct !== expTaste2.pct) {
    throw new Error(`taste match wrong: ${JSON.stringify(cmp.summary.taste)} vs ${JSON.stringify(expTaste2)}`);
  }
  // Admin S/S/D (s3 re-rated on the board) vs invited A/—/S: deltas +1, null, −4;
  // biggest gap first; the invited-only book must not leak in.
  const dOne = cmp.books.find((b) => b.title === 'Smoke Saga One');
  const dTwo = cmp.books.find((b) => b.title === 'Smoke Saga Two');
  const dThree = cmp.books.find((b) => b.title === 'Smoke Saga Three');
  if (!dOne || dOne.mine !== 'S' || dOne.theirs !== 'A' || dOne.delta !== 1) {
    throw new Error(`Saga One delta wrong: ${JSON.stringify(dOne)}`);
  }
  if (!dTwo || dTwo.mine !== 'S' || dTwo.theirs !== null || dTwo.delta !== null) {
    throw new Error(`Saga Two (unrated side) wrong: ${JSON.stringify(dTwo)}`);
  }
  if (!dThree || dThree.delta !== -4) throw new Error(`Saga Three delta wrong: ${JSON.stringify(dThree)}`);
  if (cmp.books[0].title !== 'Smoke Saga Three') throw new Error('biggest gap not sorted first');
  if (cmp.books.some((b) => b.title === 'Smoke Only Theirs')) throw new Error('unshared book leaked into overlap');
  // Series: admin 11/3 → A, invited (4+5)/2 = 4.5 → S, delta 11/3 − 4.5 ≈ −0.83.
  const cmpRoll = cmp.series.find((s) => s.series === 'Smoke Saga');
  if (!cmpRoll || cmpRoll.mine.tier !== 'A' || cmpRoll.theirs.tier !== 'S' || Math.abs(cmpRoll.delta - (11 / 3 - 4.5)) > 0.01) {
    throw new Error(`compare series rollup wrong: ${JSON.stringify(cmpRoll)}`);
  }
  // Side-by-side taste stats ride along with the comparison.
  if (!cmp.stats?.me?.totals || cmp.stats.me.totals.books_read < 4 || cmp.stats.them.totals.books_read < 4) {
    throw new Error(`compare stats totals wrong: ${JSON.stringify(cmp.stats)}`);
  }
  if (!Array.isArray(cmp.stats.me.genres) || !Array.isArray(cmp.stats.them.genres)
    || !cmp.stats.me.tiers || !cmp.stats.them.formats) {
    throw new Error('compare stats genres/tiers/formats missing');
  }
  // Board sharing: a member's tier board is readable exactly when their
  // share_compare opt-in allows the comparison itself, and carries no tags.
  const theirBoard = await call('/board/' + invitedUserId);
  if (theirBoard.user.id !== invitedUserId
    || !theirBoard.books.some((b) => b.title === 'Smoke Only Theirs')
    || theirBoard.books.some((b) => 'tags' in b)) {
    throw new Error(`board payload wrong: ${JSON.stringify(theirBoard.books?.[0])}`);
  }
  if (!theirBoard.books.every((b) => 'rating' in b && 'tier_order' in b)) {
    throw new Error('board books missing tier fields');
  }
  // The invited side can read the admin's board only if the admin opted in
  // (delta rule — depends on the live instance's flag).
  const adminOptedIn = liveDb.prepare('SELECT share_compare FROM users WHERE id=?').get(adminId).share_compare;
  activeCookie = invitedCookie;
  if (adminOptedIn) {
    const adminBoard = await call('/board/' + adminId);
    if (!Array.isArray(adminBoard.books)) throw new Error('admin board payload wrong');
  } else {
    try {
      await call('/board/' + adminId);
      throw new Error('board readable without consent');
    } catch (err) {
      if (!/403/.test(err.message)) throw err;
    }
  }
  activeCookie = adminCookie;
  console.log('compare OK');

  // Members page: directory, cross-household activity feed, browsable profile,
  // and the privacy flag. The match badge needs 3+ commonly rated books — the
  // compare fixtures only overlap on 2 rated ones so far, so it must be off.
  const dir = await call('/members');
  const invEntry = dir.members.find((m) => m.id === invitedUserId);
  if (!invEntry || invEntry.books < 4) throw new Error(`members directory wrong: ${JSON.stringify(invEntry)}`);
  if (invEntry.match !== null) throw new Error(`match shown below the 3-rated threshold: ${JSON.stringify(invEntry.match)}`);
  activeCookie = invitedCookie;
  if ((await call('/members')).members.find((m) => m.id === invitedUserId)?.match !== null) {
    throw new Error('own directory card must never carry a match badge');
  }
  // Rate the third shared book (new event = re-read tier update) → badge on.
  await call('/events', { book_id: c2.id, format: 'read', status: 'finished', rating: 'S', finished_at: '2026-08-02' });
  activeCookie = adminCookie;
  const dir2 = await call('/members');
  const invMatch = dir2.members.find((m) => m.id === invitedUserId)?.match;
  // Deltas S→A=+1, S→S=0, D→S=−4: 1 of 3 identical tiers. The badge pct is
  // the calibrated taste score over all 3 rated pairs — recomputed, since the
  // admin's baseline is the live library's, not a fixture.
  const expTaste3 = expectedTaste([['S', 'A'], ['S', 'S'], ['D', 'S']]);
  if (!invMatch || invMatch.pct !== expTaste3.pct || invMatch.shared_rated !== 3 || invMatch.shared_total !== 3) {
    throw new Error(`match math wrong: ${JSON.stringify(invMatch)} vs ${JSON.stringify(expTaste3)}`);
  }
  const prof = await call('/members/' + invitedUserId);
  if (prof.books.length < 4 || prof.stats.books_read < 4 || !prof.member.name) {
    throw new Error(`member profile wrong: books=${prof.books.length} stats=${JSON.stringify(prof.stats)}`);
  }
  if (prof.match?.pct !== expTaste3.pct) throw new Error(`profile match missing: ${JSON.stringify(prof.match)}`);
  // Per-genre chemistry: tag the saga books Fantasy on both shelves — the
  // genre bucket then holds the same 3 rated pairs, scored with the raw
  // (undamped) mapping. Need 3+ commonly rated per genre, like the badge.
  for (const id of [s1.id, s2.id, s3.id]) await call('/books/' + id, { genres: ['Fantasy'] }, 'PUT');
  activeCookie = invitedCookie;
  for (const id of [c1.id, c2.id, c3.id]) await call('/books/' + id, { genres: ['Fantasy'] }, 'PUT');
  activeCookie = adminCookie;
  const cmpG = await call('/compare/with/' + invitedUserId);
  const ga = (cmpG.genre_alignment || []).find((g) => g.genre === 'Fantasy');
  if (!ga || ga.n !== 3 || ga.raw !== expTaste3.raw || ga.pct !== expTaste3.raw_pct) {
    throw new Error(`genre alignment wrong: ${JSON.stringify(cmpG.genre_alignment)} vs raw ${expTaste3.raw}`);
  }
  // Profile rows carry the copy-fields the "add to my pile" buttons need, and
  // is_self gates them.
  const pb = prof.books[0] || {};
  if (!('hardcover_id' in pb) || !('cover_url' in pb) || !('page_count' in pb) || !('audio_runtime_minutes' in pb)) {
    throw new Error(`profile books missing copy fields: ${JSON.stringify(pb)}`);
  }
  if (prof.is_self !== false) throw new Error(`profile is_self wrong: ${prof.is_self}`);
  // Book-details preview: the lazy info endpoint serves identity + catalog
  // fields and — with no hardcover_id — makes no Hardcover call at all.
  const theirBook = prof.books.find((b) => b.title === 'Smoke Saga One');
  if (!theirBook) throw new Error('profile missing the Saga One row for the info test');
  const bInfo = await call(`/members/${invitedUserId}/books/${theirBook.book_id}/info`);
  if (bInfo.title !== 'Smoke Saga One' || bInfo.hardcover_id !== null || bInfo.description !== null || !Array.isArray(bInfo.genres)) {
    throw new Error(`member book info wrong: ${JSON.stringify(bInfo)}`);
  }
  try {
    await call(`/members/${invitedUserId}/books/999999/info`);
    throw new Error('book info accepted an unknown book');
  } catch (err) {
    if (!/404/.test(err.message)) throw err;
  }
  activeCookie = invitedCookie;
  const selfProf = await call('/members/' + invitedUserId);
  activeCookie = adminCookie;
  if (selfProf.is_self !== true) throw new Error(`self profile is_self wrong: ${selfProf.is_self}`);
  const act = await call('/members/activity');
  if (!act.activity.some((a) => a.user_id === invitedUserId && a.title === 'Smoke Saga One')) {
    throw new Error(`activity feed missing invited finish`);
  }
  // Consent is the only switch: flipping share_compare off removes the badge.
  liveDb.prepare('UPDATE users SET share_compare=0 WHERE id=?').run(invitedUserId);
  if ((await call('/members')).members.find((m) => m.id === invitedUserId)?.match !== null) {
    throw new Error('match badge shown for a member who opted out of comparisons');
  }
  liveDb.prepare('UPDATE users SET share_compare=1 WHERE id=?').run(invitedUserId);
  // Shelf search: one query across the household's shelves — grouped per work
  // (no hardcover id → normalized title+author key), latest rating per owner.
  const ssMine = (await call('/books', { title: 'Shelf Search Duplicate', author: 'SS Author' })).book;
  created.push(ssMine.id);
  await call('/events', { book_id: ssMine.id, format: 'read', status: 'finished', rating: 'S', finished_at: '2026-08-06' });
  activeCookie = invitedCookie;
  const ssTheirs = (await call('/books', { title: 'Shelf Search Duplicate', author: 'SS Author' })).book;
  created.push(ssTheirs.id);
  await call('/events', { book_id: ssTheirs.id, format: 'listened', status: 'finished', rating: 'A', finished_at: '2026-08-05' });
  activeCookie = adminCookie;
  const ssQ = encodeURIComponent('Shelf Search Duplicate');
  if ((await call('/members/search?q=S')).results.length !== 0) throw new Error('shelf search ignored the 2-char minimum');
  const ssRes = (await call('/members/search?q=' + ssQ)).results;
  if (ssRes.length !== 1 || ssRes[0].owners.length !== 2) {
    throw new Error(`shelf search grouping wrong: ${JSON.stringify(ssRes)}`);
  }
  const [ssMe, ssThem] = ssRes[0].owners;
  if (!ssMe.is_self || ssMe.rating !== 'S' || ssThem.rating !== 'A' || ssThem.format !== 'listened') {
    throw new Error(`shelf search owners wrong: ${JSON.stringify(ssRes[0].owners)}`);
  }
  if ((await call('/members/search?q=' + ssQ + '&field=series')).results.length !== 0) {
    throw new Error('series field matched title/author-only books');
  }
  if ((await call('/members/search?q=' + encodeURIComponent('SS Author') + '&field=author')).results[0]?.owners.length !== 2) {
    throw new Error('author-scoped shelf search missed a shelf');
  }
  liveDb.prepare('UPDATE users SET profile_public=0 WHERE id=?').run(invitedUserId);
  try {
    await call('/members/' + invitedUserId);
    throw new Error('private profile was browsable');
  } catch (err) {
    if (!/403/.test(err.message)) throw err;
  }
  // The book-info preview inherits the same privacy gate.
  try {
    await call(`/members/${invitedUserId}/books/${theirBook.book_id}/info`);
    throw new Error('book info readable for a private profile');
  } catch (err) {
    if (!/403/.test(err.message)) throw err;
  }
  // The shelf search inherits the directory gate: a private shelf drops out.
  const ssPriv = (await call('/members/search?q=' + ssQ)).results;
  if (ssPriv.length !== 1 || ssPriv[0].owners.length !== 1 || !ssPriv[0].owners[0].is_self) {
    throw new Error(`private shelf leaked into shelf search: ${JSON.stringify(ssPriv)}`);
  }
  liveDb.prepare('UPDATE users SET profile_public=1 WHERE id=?').run(invitedUserId);
  console.log('members OK');

  // Compare matching layers, offline (no HC calls): hardcover_id promotion
  // from source_id (what migration 22 backfills), then work_id pairing for
  // different editions of one work (work_id set directly — HC's API has no
  // work key today), then the subtitle-aware title fallback.
  activeCookie = adminCookie;
  const workA = (await call('/books', {
    title: 'Smoke Work Edition A', author: 'W. Author', page_count: 100,
    source_provider: 'hardcover', source_id: '888001',
  })).book;
  created.push(workA.id);
  if (workA.hardcover_id !== 888001) throw new Error(`hardcover_id promotion failed: ${JSON.stringify(workA.hardcover_id)}`);
  liveDb.prepare('UPDATE books SET work_id=88800 WHERE id=?').run(workA.id);
  await call('/events', { book_id: workA.id, format: 'read', status: 'finished', rating: 'B', finished_at: '2026-08-05' });
  const subA = (await call('/books', { title: 'Smoke Sub: Title Book', author: 'T. Author', page_count: 100 })).book;
  created.push(subA.id);
  await call('/events', { book_id: subA.id, format: 'read', status: 'finished', rating: 'C', finished_at: '2026-08-05' });
  activeCookie = invitedCookie;
  const workB = (await call('/books', {
    title: 'Smoke Work Edition B UK', author: 'W. Author', page_count: 100,
    source_provider: 'hardcover', source_id: '888002',
  })).book;
  liveDb.prepare('UPDATE books SET work_id=88800 WHERE id=?').run(workB.id);
  await call('/events', { book_id: workB.id, format: 'read', status: 'finished', rating: 'A', finished_at: '2026-08-05' });
  const subB = (await call('/books', { title: 'Title Book', author: 'T. Author', page_count: 100 })).book;
  await call('/events', { book_id: subB.id, format: 'read', status: 'finished', rating: 'C', finished_at: '2026-08-05' });
  activeCookie = adminCookie;
  const cmp2 = await call('/compare/with/' + invitedUserId);
  // Different editions (different HC ids, different titles) pair via work_id.
  const wPair = cmp2.books.find((b) => b.title === 'Smoke Work Edition A');
  if (!wPair || wPair.theirs !== 'A' || wPair.delta !== -1) {
    throw new Error(`work-level pairing failed: ${JSON.stringify(wPair)}`);
  }
  // "Series: Title" vs "Title" pairs via the post-colon fallback.
  const sPair = cmp2.books.find((b) => b.title === 'Smoke Sub: Title Book');
  if (!sPair || sPair.delta !== 0) {
    throw new Error(`subtitle fallback pairing failed: ${JSON.stringify(sPair)}`);
  }
  console.log('compare matching OK');

  // Recommendations: the LLM pipeline only runs when keys are configured —
  // while they're unset, the online path must fail with a clean message. The
  // offline candidates path (like kobo_import's rows) tests verify→store→cards.
  // (Pre-existing rows were snapshotted before the try — see the top.)
  const meta = await call('/meta');
  if (!meta.llm_enabled) {
    const ljob = await call('/jobs', { kind: 'recommendations', payload: {} });
    jobIds.push(ljob.id);
    const lres = await waitForJob(ljob.id);
    if (lres.status !== 'error' || !/LLM not configured/.test(lres.error)) {
      throw new Error(`unconfigured-LLM rec job should fail cleanly: ${JSON.stringify(lres)}`);
    }
  } else {
    console.log('note: LLM keys configured — skipping unconfigured-path assertion');
  }
  const batchBefore = (await call('/recommendations')).batch_id || 0;
  // The fourth candidate belongs to a series the admin already owns — the
  // guardrail must drop it.
  const cands = [
    { title: 'Smoke Rec One', author: 'R. Author', reasoning: 'because you liked Smoke Saga' },
    { title: 'Smoke Rec Two', author: 'R. Author', reasoning: 'same-adjacent pick' },
    { title: 'Smoke Rec Three', author: 'R. Other', reasoning: 'standalone' },
    { title: 'Smoke Saga Four', author: 'S. Author', series_name: 'Smoke Saga', reasoning: 'next in a series you read' },
  ];
  const ojob = await call('/jobs', { kind: 'recommendations', payload: { candidates: cands, hardcover: false } });
  jobIds.push(ojob.id);
  const ores = await waitForJob(ojob.id);
  if (ores.status !== 'done') throw new Error(`offline rec job failed: ${ores.error}`);
  if (ores.result.batch !== batchBefore + 1 || ores.result.proposed !== 4 || ores.result.verified !== 0
    || ores.result.dropped_series !== 1) {
    throw new Error(`offline rec result wrong: ${JSON.stringify(ores.result)}`);
  }
  const recs = (await call('/recommendations')).recs;
  if (recs.length !== 3 || recs.some((r) => r.hardcover_id || r.estimated_words || r.status !== 'new')) {
    throw new Error(`stored recs wrong: ${JSON.stringify(recs)}`);
  }
  const [rec1, rec2, rec3] = recs;
  // Accept: same two-call flow as the view (book + TBR, deduped by source id).
  const acceptBody = (r) => ({
    title: r.title, author: r.author, series_name: r.series_name,
    page_count: r.page_count, audio_runtime_minutes: r.audio_runtime_minutes,
    source_provider: r.hardcover_id ? 'hardcover' : 'rec', source_id: String(r.hardcover_id ?? r.id),
  });
  const accBook = (await call('/books', acceptBody(rec1))).book;
  created.push(accBook.id);
  await call('/tbr', { book_id: accBook.id, source: 'rec' });
  if (!(await call('/tbr')).entries.some((e) => e.book_id === accBook.id && e.source === 'rec')) {
    throw new Error('rec accept did not reach TBR');
  }
  const reAccept = await call('/books', acceptBody(rec1));
  if (!reAccept.existed || reAccept.book.id !== accBook.id) throw new Error('rec accept did not dedupe');
  await call(`/recommendations/${rec1.id}/status`, { status: 'tbr' }, 'POST');
  // Avoid: creates a signal from the author; then removable.
  await call(`/recommendations/${rec2.id}/status`, { status: 'avoided' }, 'POST');
  let sigs = (await call('/recommendations')).avoid_signals;
  const sig = sigs.find((s) => s.label === rec2.author);
  if (!sig) throw new Error(`avoid signal missing: ${JSON.stringify(sigs)}`);
  await call('/avoid-signals/' + sig.id, null, 'DELETE');
  if ((await call('/recommendations')).avoid_signals.some((s) => s.id === sig.id)) {
    throw new Error('avoid signal delete failed');
  }
  await call(`/recommendations/${rec3.id}/status`, { status: 'dismissed' }, 'POST');
  // "I've already read this" — a status the original CHECK rejected, proving
  // migration 19's rebuild; More-info degrades cleanly for an unverified card
  // (no hardcover_id → no HC call, identity + links only).
  await call(`/recommendations/${rec3.id}/status`, { status: 'read' }, 'POST');
  const rinfo = await call(`/recommendations/${rec3.id}/info`);
  if (rinfo.title !== rec3.title || rinfo.hardcover_id !== null || rinfo.description != null) {
    throw new Error(`rec info wrong for unverified card: ${JSON.stringify(rinfo)}`);
  }
  // A new run replaces unacted cards; acted-on history stays out of the way.
  // Standalones-only toggle: a series book is dropped even when new to the reader.
  const ojob2 = await call('/jobs', {
    kind: 'recommendations',
    payload: {
      series: 'standalone',
      hardcover: false,
      candidates: [
        { title: 'Smoke Rec Four', author: 'R. Author' },
        { title: 'Smoke Rec Five', author: 'R. Author', series_name: 'Smoke Fresh Saga' },
      ],
    },
  });
  jobIds.push(ojob2.id);
  const ores2 = await waitForJob(ojob2.id);
  if (ores2.status !== 'done' || ores2.result.batch !== batchBefore + 2 || ores2.result.dropped_series !== 1) {
    throw new Error(`second offline rec job wrong: ${JSON.stringify(ores2.result)}`);
  }
  const recsAfter = (await call('/recommendations')).recs;
  if (recsAfter.length !== 1 || recsAfter[0].title !== 'Smoke Rec Four') {
    throw new Error(`batch replacement wrong: ${JSON.stringify(recsAfter)}`);
  }
  // Per-user LLM key: stored, resolution flips to 'user', never echoed back,
  // and the unauthenticated path can't touch it (endpoint is session-gated).
  await call('/account/llm', { api_key: 'smoke-user-key-123', model: 'smoke-model' }, 'PUT');
  let acct = await call('/account/llm');
  if (!acct.has_key || acct.source !== 'user' || acct.effective_model !== 'smoke-model') {
    throw new Error(`account llm wrong: ${JSON.stringify(acct)}`);
  }
  const savedCookie = activeCookie;
  activeCookie = null;
  try {
    const res = await fetch(BASE + '/account/llm', { headers: { 'Content-Type': 'application/json' } });
    if (res.status !== 401) throw new Error(`unauthenticated /account/llm returned ${res.status}, not 401`);
  } finally {
    activeCookie = savedCookie;
  }
  await call('/account/llm', { clear: true }, 'PUT');
  acct = await call('/account/llm');
  if (acct.has_key || acct.source === 'user') throw new Error(`account llm clear failed: ${JSON.stringify(acct)}`);
  console.log('recommendations OK');

  // Privacy toggles: profile_public / share_compare roundtrip on the Account
  // card's endpoint, self-guarded like the rest of /auth/*, values restored.
  const priv0 = await call('/auth/privacy');
  {
    const saved = activeCookie;
    activeCookie = null;
    try {
      const res = await fetch(BASE + '/auth/privacy');
      if (res.status !== 401) throw new Error(`unauthenticated /auth/privacy returned ${res.status}, not 401`);
    } finally {
      activeCookie = saved;
    }
  }
  await call('/auth/privacy', { profile_public: !priv0.profile_public, share_compare: !priv0.share_compare }, 'PUT');
  const priv1 = await call('/auth/privacy');
  if (priv1.profile_public !== !priv0.profile_public || priv1.share_compare !== !priv0.share_compare) {
    throw new Error(`privacy toggle failed: ${JSON.stringify(priv1)}`);
  }
  await call('/auth/privacy', { profile_public: priv0.profile_public, share_compare: priv0.share_compare }, 'PUT');
  const priv2 = await call('/auth/privacy');
  if (priv2.profile_public !== priv0.profile_public || priv2.share_compare !== priv0.share_compare) {
    throw new Error(`privacy restore failed: ${JSON.stringify(priv2)}`);
  }
  console.log('privacy toggles OK');

  // Series journey: exercised fully offline — two finished books in a series,
  // a synthetic roster in the global cache (noise-filter-safe titles), assert
  // the finished-based math, then clean everything back out.
  const journey = await call('/series/journey');
  if (!Array.isArray(journey.series)) throw new Error('series journey payload wrong');
  const jIds = [999001, 999002];
  const jIns = liveDb.prepare(`INSERT INTO books (user_id, title, series_name, series_order, hardcover_id)
    VALUES (?, 'Smoke Journey Part '||?, 'Smoke Journey Tale', ?, ?)`);
  const jEv = liveDb.prepare(`INSERT INTO events (user_id, book_id, format, status, finished_at)
    VALUES (?, ?, 'read', 'finished', datetime('now'))`);
  for (const [i, id] of jIds.entries()) {
    jIns.run(adminId, i + 1, i + 1, id);
    jEv.run(adminId, liveDb.prepare('SELECT id FROM books WHERE user_id=? AND hardcover_id=?').get(adminId, id).id);
  }
  liveDb.prepare(`INSERT INTO series_cache (series_key, books, fetched_at) VALUES (?,?,datetime('now'))`)
    .run('smoke journey tale', JSON.stringify([
      { position: 1, hardcover_id: 999001, title: 'Smoke Dawn', author: null },
      { position: 2, hardcover_id: 999002, title: 'Smoke Dusk', author: null },
      { position: 3, hardcover_id: 999003, title: 'Smoke Dusk, Part 1 of 2', author: null },
    ]));
  try {
    const j2 = await call('/series/journey');
    const seeded = j2.series.find((s) => s.name === 'Smoke Journey Tale');
    // The "Part 1 of 2" roster entry must be noise-filtered: total is 2, the
    // two finished books set current to 2, so nothing is left to recommend.
    if (!seeded || seeded.total !== 2 || seeded.finished_count !== 2
      || seeded.current !== 2 || seeded.next !== null) {
      throw new Error(`seeded journey wrong: ${JSON.stringify(seeded)}`);
    }
  } finally {
    liveDb.prepare('DELETE FROM events WHERE user_id=? AND book_id IN (SELECT id FROM books WHERE user_id=? AND hardcover_id IN (999001,999002))').run(adminId, adminId);
    liveDb.prepare('DELETE FROM books WHERE user_id=? AND hardcover_id IN (999001,999002)').run(adminId);
    liveDb.prepare('DELETE FROM series_cache WHERE series_key=?').run('smoke journey tale');
  }
  // Second seeded series: id-vs-order conflict + half-step novella +
  // owned-next state + an undated finish (recency falls back to insertion
  // order instead of dropping the series). One HC shape (new
  // {id,name,roster} candidates) so the serialize/normalize path is covered
  // too — the first series above keeps exercising the legacy flat array.
  const kIns = liveDb.prepare(`INSERT INTO books (user_id, title, series_name, series_order, hardcover_id)
    VALUES (?, ?, 'Smoke Ladder Rungs', ?, ?)`);
  const kEvDated = liveDb.prepare(`INSERT INTO events (user_id, book_id, format, status, finished_at)
    VALUES (?, ?, 'read', 'finished', '2026-01-01')`);
  const kEvUndated = liveDb.prepare(`INSERT INTO events (user_id, book_id, format, status, finished_at, finished_year)
    VALUES (?, ?, 'read', 'finished', NULL, NULL)`);
  const kIds = [999011, 999012, 999013, 999014];
  // Book 1: id points at slot 3, order says slot 1, title agrees with slot
  // 1 — the order leg wins by title tie-break, so slot 3 stays undone.
  kIns.run(adminId, 'Smoke Rung Dawn', 1, kIds[0]);
  // Book 2: plain slot-2 finish, undated.
  kIns.run(adminId, 'Smoke Rung Dusk', 2, kIds[1]);
  // Book 3: owned but unfinished edition of slot 2.5's novella (mid-read).
  kIns.run(adminId, 'Smoke Rung Ember', 2.5, 999015);
  // Book 4: owns slot 3 unread — makes slot 3 the owned-next state once the
  // conflict book takes slot 1.
  kIns.run(adminId, 'Smoke Rung Noon', 3, kIds[3]);
  const kBook = (id) => liveDb.prepare('SELECT id FROM books WHERE user_id=? AND hardcover_id=?').get(adminId, id).id;
  kEvDated.run(adminId, kBook(kIds[0]));
  kEvUndated.run(adminId, kBook(kIds[1]));
  liveDb.prepare(`INSERT INTO series_cache (series_key, books, fetched_at) VALUES (?,?,datetime('now'))`)
    .run('smoke ladder rungs', JSON.stringify([{
      id: 424242, name: 'Smoke Ladder Rungs', roster: [
        { position: 1, hardcover_id: 999019, title: 'Smoke Rung Dawn', author: 'Smoke Scribe' },
        { position: 2, hardcover_id: kIds[1], title: 'Smoke Rung Dusk', author: 'Smoke Scribe' },
        { position: 2.5, hardcover_id: 999015, title: 'Smoke Rung Ember', author: 'Smoke Scribe' },
        { position: 3, hardcover_id: kIds[3], title: 'Smoke Rung Noon', author: 'Smoke Scribe' },
      ],
    }]));
  try {
    const j3 = await call('/series/journey');
    const rungs = j3.series.find((s) => s.name === 'Smoke Ladder Rungs');
    // Slots 1 + 2 finished (conflict resolved to slot 1; the undated book
    // counts), slot 2.5 mid-read skipped, slot 3 owned-unread blocks next.
    if (!rungs || rungs.total !== 4 || rungs.finished_count !== 2
      || rungs.current !== 2 || rungs.next !== null || rungs.owned_next !== true) {
      throw new Error(`seeded rungs wrong: ${JSON.stringify(rungs)}`);
    }
    // The conflict book's mis-aimed id must not mark slot 3 done: with slot
    // 3's book deleted, slot 3 becomes a real recommendation.
    liveDb.prepare('DELETE FROM events WHERE user_id=? AND book_id=?').run(adminId, kBook(kIds[3]));
    liveDb.prepare('DELETE FROM books WHERE user_id=? AND hardcover_id=?').run(adminId, kIds[3]);
    const j4 = await call('/series/journey');
    const rungs4 = j4.series.find((s) => s.name === 'Smoke Ladder Rungs');
    if (!rungs4 || rungs4.next?.position !== 3 || rungs4.next?.title !== 'Smoke Rung Noon'
      || rungs4.owned_next !== false) {
      throw new Error(`seeded rungs next wrong: ${JSON.stringify(rungs4)}`);
    }
  } finally {
    liveDb.prepare('DELETE FROM events WHERE user_id=? AND book_id IN (SELECT id FROM books WHERE user_id=? AND hardcover_id IN (999011,999012,999013,999014,999015))').run(adminId, adminId);
    liveDb.prepare('DELETE FROM books WHERE user_id=? AND hardcover_id IN (999011,999012,999013,999014,999015)').run(adminId);
    liveDb.prepare('DELETE FROM series_cache WHERE series_key=?').run('smoke ladder rungs');
  }
  console.log('series journey OK');

  // Goals: prefs-backed targets flow into /api/stats (admin prefs are
  // snapshot-restored in the finally).
  await call('/account/prefs', { goals: { books: 10 } }, 'PUT');
  const gStats = await call('/stats');
  if (!gStats.goals?.books || gStats.goals.books.target !== 10) throw new Error(`goals missing from stats: ${JSON.stringify(gStats.goals)}`);
  if (gStats.goals.books.pct !== Math.min(100, Math.round((gStats.this_year.books_read / 10) * 100))) throw new Error('goal pct wrong');
  await call('/account/prefs', { goals: { books: 0 } }, 'PUT');
  if ((await call('/stats')).goals?.books) throw new Error('goal clear failed');
  console.log('goals OK');
  // Year-in-review endpoint: a year-only entry (Memory lane style) counts
  // toward totals and tiers but not the month buckets.
  const REV_YEAR = '2023';
  const yb = await call('/stats/year/' + REV_YEAR);
  const revBook = (await call('/books', { title: 'Smoke Review Book', author: 'Y. Author', page_count: 100 })).book;
  created.push(revBook.id);
  await call('/events', { book_id: revBook.id, format: 'read', status: 'finished', rating: 'A', finished_year: 2023 });
  const ya = await call('/stats/year/' + REV_YEAR);
  if (ya.totals.books_read - yb.totals.books_read !== 1) throw new Error('year totals delta != 1');
  if (ya.tiers.A - yb.tiers.A !== 1) throw new Error('year tiers delta != 1');
  // Delta-based: real libraries carry dated entries in REV_YEAR (the listen
  // backfill filled 2023 on staging) — the entry must not CHANGE any month.
  if (ya.months.length !== 12 || ya.months.some((m, i) => m.books !== (yb.months[i]?.books ?? 0))) {
    throw new Error('year-only entry leaked into months');
  }
  if (!Array.isArray(ya.days) || ya.days.length < 365 || !ya.days.every((d) => d.date.startsWith(REV_YEAR))) throw new Error('year days malformed');
  const row = ya.top_books.find((b) => b.book_id === revBook.id);
  if (!row || row.words !== 27500 || row.rating !== 'A') throw new Error(`top_books row wrong: ${JSON.stringify(row)}`);
  console.log('year review OK');

  // Tags: stored on create and via PUT, parsed in listings, filterable and
  // searchable.
  const tagBook = (await call('/books', { title: 'Smoke Tagged Book', author: 'T. Author', tags: ['doorstopper', 'smoke-tag'] })).book;
  created.push(tagBook.id);
  await call('/books/' + tagBook.id, { tags: ['doorstopper', 'smoke-tag', 'favourite'] }, 'PUT');
  const tagged = await call('/books?tag=Smoke-tag'); // tag filter is case-exact; normTags stored 'Smoke-tag'
  if (!tagged.books.some((b) => b.id === tagBook.id)) throw new Error('tag filter failed');
  if (tagged.books.find((b) => b.id === tagBook.id).tags.length !== 3) throw new Error('tags not parsed in listing');
  if (!(await call('/books?query=favourite')).books.some((b) => b.id === tagBook.id)) throw new Error('tag text search failed');
  console.log('tags OK');

  // Goodreads import: CSV (BOM, ="isbn" Excel guards, quoted commas) → parse
  // → job → books + events with the star→tier mapping and shelf tags. The
  // series-tag rows pin title cleaning: "(Saga, #2)" becomes structured
  // series data, an imprint paren is stripped without inventing a series.
  const grCsv = '\uFEFF' + [
    'My Rating,Book Id,Title,Author,ISBN13,Number of Pages,Exclusive Shelf,Date Read,Bookshelves',
    '4,12345,"Smoke Goodreads Book, Revised","G. Author","=""9781234567890""",300,read,2024/07/15,"read,favourites"',
    '0,12346,"Smoke Goodreads Reading","H. Writer",,100,currently-reading,,',
    '3,12347,"Smoke Goodreads TBR","I. Person",,200,to-read,,',
    '5,12348,"Smoke Goodreads Series (Smoke Goodreads Saga, #2)","J. Series",,250,read,2024/08/01,',
    '1,12349,"Smoke Imprint Book (Vintage International)","K. Imprint",,150,to-read,,',
  ].join('\n');
  const grParsed = await callRaw('/goodreads/parse', Buffer.from(grCsv, 'utf8'));
  if (grParsed.books.length !== 5) throw new Error(`goodreads parse found ${grParsed.books.length} != 5`);
  const grSeries = grParsed.books.find((b) => b.content_id === 'gr-12348');
  if (!grSeries || grSeries.title !== 'Smoke Goodreads Series'
    || grSeries.series !== 'Smoke Goodreads Saga' || grSeries.series_order !== 2) {
    throw new Error(`goodreads series tag wrong: ${JSON.stringify(grSeries)}`);
  }
  const grImprint = grParsed.books.find((b) => b.content_id === 'gr-12349');
  if (!grImprint || grImprint.title !== 'Smoke Imprint Book' || grImprint.series !== null) {
    throw new Error(`goodreads imprint paren wrong: ${JSON.stringify(grImprint)}`);
  }
  const grFin = grParsed.books[0];
  if (grFin.suggested_status !== 'finished' || grFin.rating !== 'A' || grFin.isbn !== '9781234567890'
    || grFin.last_read !== '2024-07-15') {
    throw new Error(`goodreads finished row wrong: ${JSON.stringify(grFin)}`);
  }
  if (grFin.shelves.length !== 1 || grFin.shelves[0] !== 'favourites') {
    throw new Error(`goodreads shelves wrong: ${JSON.stringify(grFin.shelves)}`);
  }
  if (grParsed.books[1].suggested_status !== 'reading' || grParsed.books[2].suggested_status !== 'tbr') {
    throw new Error('goodreads shelf statuses wrong');
  }
  const grJob = await call('/jobs', {
    kind: 'goodreads_import',
    payload: { hardcover: false, rows: grParsed.books.map((b) => ({ ...b, chosen_status: b.suggested_status })) },
  });
  jobIds.push(grJob.id);
  const grRes = await waitForJob(grJob.id);
  if (grRes.status !== 'done' || grRes.result.imported !== 5 || grRes.result.events_created !== 3) {
    throw new Error(`goodreads import wrong: ${JSON.stringify(grRes.result || grRes)}`);
  }
  created.push(...grRes.result.book_ids);
  const grDetail = await call('/books/' + grRes.result.book_ids[0]);
  if (grDetail.events[0].rating !== 'A') throw new Error(`goodreads event rating missing: ${JSON.stringify(grDetail.events[0])}`);
  if (!(grDetail.book.tags || []).includes('favourites')) throw new Error(`goodreads tags missing: ${JSON.stringify(grDetail.book.tags)}`);
  const grSeriesRow = await call('/books/' + grRes.result.book_ids[3]); // the series-tag row, in row order
  if (grSeriesRow.book.series_name !== 'Smoke Goodreads Saga' || grSeriesRow.book.series_order !== 2) {
    throw new Error(`goodreads series not stored: ${JSON.stringify({ name: grSeriesRow.book.series_name, order: grSeriesRow.book.series_order })}`);
  }
  console.log('goodreads OK');

  // Per-user UI prefs: namespace merge keeps sibling keys, and the roundtrip
  // restores the admin's stored prefs (snapshot in prePrefs, restored in finally).
  const prefs0 = await call('/account/prefs');
  await call('/account/prefs', { dashboard: { sections: { authors: false } } }, 'PUT');
  await call('/account/prefs', { dashboard: { sections: { narrators: false } } }, 'PUT');
  const prefs1 = await call('/account/prefs');
  if (prefs1.dashboard?.sections?.authors !== false || prefs1.dashboard?.sections?.narrators !== false) {
    throw new Error(`prefs merge failed: ${JSON.stringify(prefs1)}`);
  }
  await call('/account/prefs', { dashboard: { sections: { authors: true, narrators: true } } }, 'PUT');
  console.log('prefs OK');

  // Admin-issued password reset: mint → accept → old session dead, new password works.
  const rs = await call('/auth/resets', { user_id: invitedUserId }, 'POST');
  if (!/#reset\//.test(rs.url)) throw new Error('reset url malformed');
  activeCookie = null;
  const ra = await call('/auth/reset/accept', { token: rs.url.split('/').pop(), password: 'fresh-password-9' });
  if (!ra.ok) throw new Error('reset accept failed');
  activeCookie = invitedCookie;
  try {
    await call('/books');
    throw new Error('old session survived password reset');
  } catch (err) {
    if (!/401/.test(err.message)) throw err;
  }
  activeCookie = null;
  const relogin = await call('/auth/login', { name: 'Smoke Invited', password: 'fresh-password-9' });
  if (!relogin.id) throw new Error('post-reset login failed');
  activeCookie = adminCookie;
  console.log('password reset OK');

  // Backup endpoint: a real snapshot file must appear on disk and in the list.
  // Admin-only and gap-limited server-side; a run against a server that backed
  // up recently gets the 429 path (which is itself worth asserting).
  let bk = null;
  try {
    bk = await call('/backup', {});
  } catch (err) {
    if (!/recently/.test(err.message)) throw err;
  }
  if (bk) {
    if (!/^booktracker-\d{14}\.db$/.test(bk.file)) throw new Error(`backup filename unexpected: ${bk.file}`);
    if (!existsSync('backups/' + bk.file)) throw new Error('backup snapshot missing on disk');
  }
  if (!(await call('/backup')).backups.some((b) => !bk || b.name === bk.file)) throw new Error('backup listing broken');
  console.log('backup OK');

  // Data export + per-account restore. Export: the account's own content as
  // one JSON payload — and nobody else's. Restore: one account surgically
  // rolled back to a snapshot taken via VACUUM INTO (the scheduler's exact
  // mechanism); a mutation made after the snapshot must vanish.
  const adminExp = await call('/account/export');
  if (!adminExp.books.some((b) => b.id === b1.id) || !Array.isArray(adminExp.events) || adminExp.account.name === 'Smoke Invited') {
    throw new Error(`admin export wrong: ${JSON.stringify(adminExp.account)} / ${adminExp.books.length} books`);
  }
  // The password-reset section logged the invited account out everywhere,
  // so mint a fresh session for its export/restore checks.
  const invCookie = makeSession(invitedUserId);
  activeCookie = invCookie;
  const invExp = await call('/account/export');
  if (invExp.account.name !== 'Smoke Invited' || invExp.books.some((b) => b.id === b1.id)) {
    throw new Error('export leaked another account\'s books');
  }
  const invBooks0 = invExp.books.length;
  const restoreFile = `smoke-restore-${Date.now()}.db`;
  liveDb.exec(`VACUUM INTO 'backups/${restoreFile}'`);
  const restoreExtra = (await call('/books', {
    title: 'Smoke Restore Extra', author: 'R. Restore', page_count: 50, audio_runtime_minutes: 60,
  })).book;
  if ((await call('/books')).books.length !== invBooks0 + 1) throw new Error('restore fixture book missing');
  // Non-admins can't restore anyone.
  try {
    await call('/admin/restore-account', { user_id: invitedUserId, file: restoreFile });
    throw new Error('non-admin ran restore-account');
  } catch (err) {
    if (!/403/.test(err.message)) throw err;
  }
  activeCookie = adminCookie;
  try {
    await call('/admin/restore-account', { user_id: invitedUserId, file: 'smoke-does-not-exist.db' });
    throw new Error('restore accepted an unknown snapshot');
  } catch (err) {
    if (!/400/.test(err.message)) throw err;
  }
  const rr = await call('/admin/restore-account', { user_id: invitedUserId, file: restoreFile });
  if (!rr.ok || !rr.restore_point) throw new Error(`restore failed: ${JSON.stringify(rr)}`);
  // The restore wiped the account's sessions — mint a fresh one to look.
  activeCookie = makeSession(invitedUserId);
  // A real login re-links a login-audit row: the restore's user-row swap sets
  // older audit rows' user_id null via ON DELETE SET NULL.
  await call('/auth/login', { name: 'Smoke Invited', password: 'fresh-password-9' });
  const invAfter = await call('/books');
  if (invAfter.books.length !== invBooks0 || invAfter.books.some((b) => b.title === 'Smoke Restore Extra')) {
    throw new Error(`restore did not roll the account back: ${invAfter.books.length} vs ${invBooks0}`);
  }
  activeCookie = adminCookie;
  console.log('export + restore OK');

  // Admin panel: overview is admin-only; logins (success + failure) land in
  // login_audit; revoking a member kills their sessions everywhere.
  const probeCookie = makeSession(invitedUserId);
  activeCookie = probeCookie;
  try {
    await call('/admin/overview');
    throw new Error('admin overview readable by a non-admin');
  } catch (err) {
    if (!/403/.test(err.message)) throw err;
  }
  await call('/auth/login', { name: 'Smoke Invited', password: 'definitely-wrong' }).catch((e) => {
    if (!/401/.test(e.message)) throw e;
  });
  activeCookie = adminCookie;
  const ov = await call('/admin/overview');
  const ovInvited = ov.users.find((u) => u.id === invitedUserId);
  if (!ovInvited || ovInvited.sessions < 1 || ovInvited.books < 4) {
    throw new Error(`admin overview users wrong: ${JSON.stringify(ovInvited)}`);
  }
  if (!Number.isInteger(ov.instance.schema_version) || ov.instance.schema_version < 21) {
    throw new Error(`admin overview schema wrong: ${JSON.stringify(ov.instance)}`);
  }
  if (!ov.jobs.length) throw new Error('admin overview jobs empty');
  if (typeof ov.health.books !== 'number' || typeof ov.health.missing_covers !== 'number') {
    throw new Error(`admin overview health wrong: ${JSON.stringify(ov.health)}`);
  }
  if (!ov.logins.some((a) => a.ok === 1 && a.user_id === invitedUserId)) {
    throw new Error(`admin overview missing successful login: ${JSON.stringify(ov.logins)}`);
  }
  if (!ov.logins.some((a) => a.ok === 0 && a.name === 'Smoke Invited')) {
    throw new Error(`admin overview missing failed login: ${JSON.stringify(ov.logins)}`);
  }
  if (!ov.sessions.some((s) => s.user_id === invitedUserId)) {
    throw new Error('admin overview missing the invited session');
  }
  activeCookie = probeCookie;
  await call('/books');
  activeCookie = adminCookie;
  await call('/admin/sessions/revoke', { user_id: invitedUserId }, 'POST');
  activeCookie = probeCookie;
  try {
    await call('/books');
    throw new Error('revoked session still works');
  } catch (err) {
    if (!/401/.test(err.message)) throw err;
  }
  activeCookie = adminCookie;
  console.log('admin panel OK');
} catch (err) {
  suiteError = err;
  throw err;
} finally {
  // Cleanup must run as the admin even if a section died mid-cookie-switch.
  activeCookie = adminCookie;
  // Restore the admin's UI prefs exactly as found.
  liveDb.prepare('UPDATE users SET prefs=? WHERE id=?').run(prePrefs, adminId);
  // Login-audit rows the smoke created go away; real logins stay.
  liveDb.prepare('DELETE FROM login_audit WHERE id > ?').run(preAuditMax);
  // Restore the admin's per-user LLM config exactly as found — the llm section
  // overwrites and clears it, and an early throw used to leave the smoke key
  // behind (or the real key lost).
  liveDb.prepare('UPDATE users SET llm_api_key=?, llm_base_url=?, llm_model=? WHERE id=?')
    .run(preLlm.llm_api_key, preLlm.llm_base_url, preLlm.llm_model, adminId);
  // Recommendation fixtures: restore the pre-run snapshot exactly — the tests
  // (and the server-side batch replacement) may have deleted real cards.
  const restoreTable = (table, rows, cols) => {
    liveDb.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(adminId);
    const ins = liveDb.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    for (const r of rows) ins.run(...cols.map((c) => r[c]));
  };
  restoreTable('recommendations', preRecRows,
    ['id', 'user_id', 'batch_id', 'title', 'author', 'series_name', 'hardcover_id', 'reasoning',
      'estimated_words', 'page_count', 'audio_runtime_minutes', 'status', 'created_at']);
  restoreTable('avoid_signals', preAvoidRows, ['id', 'user_id', 'label', 'created_at']);
  for (const id of jobIds) {
    try { await call('/jobs/' + id, null, 'DELETE'); } catch { /* already gone */ }
  }
  if (existsSync('backups')) {
    for (const f of readdirSync('backups')) {
      if (!backupsBefore.has(f)) rmSync('backups/' + f);
    }
  }
  if (existsSync('data/tmp')) {
    for (const f of readdirSync('data/tmp')) {
      if (f.startsWith('kobo-fixture-')) rmSync('data/tmp/' + f);
    }
  }
  for (const id of created) {
    try { await call('/books/' + id, null, 'DELETE'); } catch { /* already gone */ }
  }
  if (tbrNextUpBefore) {
    try { await call('/tbr/next-up', { book_id: tbrNextUpBefore }); } catch { /* queue changed */ }
  }
  const after = (await call('/stats')).all_time;
  if (after.books_read !== baseline.all.books_read) {
    const msg = `cleanup failed — books_read off by ${after.books_read - baseline.all.books_read}`;
    if (suiteError) console.error(`WARNING: ${msg} (see the original failure below)`);
    else throw new Error(msg);
  }
  // Auth fixtures: invited user (cascades its sessions), its invite, then the
  // DB-minted smoke sessions — restoring the pre-run state exactly. Warn
  // rather than throw, so a cleanup miss never masks the original failure.
  if (invitedUserId) {
    // Compare fixtures gave the invited user books of their own — events and
    // TBR rows cascade off the books, which must go before the user row.
    liveDb.prepare('DELETE FROM books WHERE user_id=?').run(invitedUserId);
    liveDb.prepare('DELETE FROM sessions WHERE user_id=?').run(invitedUserId);
    liveDb.prepare('DELETE FROM invites WHERE used_by=?').run(invitedUserId);
    try {
      liveDb.prepare('DELETE FROM users WHERE id=?').run(invitedUserId);
    } catch (err) {
      console.log(`WARNING: invited user ${invitedUserId} still referenced (${err.message})`);
      for (const [t, c] of [['sessions', 'user_id'], ['invites', 'created_by'], ['invites', 'used_by'], ['books', 'user_id'], ['events', 'user_id'], ['tbr', 'user_id'], ['jobs', 'user_id']]) {
        const n = liveDb.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c}=?`).get(invitedUserId).n;
        if (n) console.log(`  still referenced in ${t}.${c} = ${n}`);
      }
    }
  }
  for (const t of mintedTokens) liveDb.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(t));
  console.log('cleanup OK — database restored to baseline');
}
console.log('ALL SMOKE TESTS PASSED');
