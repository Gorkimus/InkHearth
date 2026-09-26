import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getRequestUserId } from './request-context.js';
import { mapGenres } from './genres-vocab.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// --- Migrations ------------------------------------------------------------
// Ordered list tracked by PRAGMA user_version (an integer in the db header).
// Append new migrations at the bottom; never edit one that has shipped — the
// runner skips anything at or below the stored version. Each runs in a
// transaction, so a failed migration leaves the db at its previous version.
const migrations = [
  {
    version: 1,
    up: () => db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every user-owned table carries user_id so multi-user later is additive:
-- swap currentUserId() for the session user, add auth middleware, done.
CREATE TABLE IF NOT EXISTS books (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id               INTEGER NOT NULL REFERENCES users(id),
  title                 TEXT NOT NULL,
  author                TEXT,
  narrator              TEXT,
  series_name           TEXT,
  series_order          INTEGER,
  page_count            INTEGER,
  word_count            INTEGER,
  word_count_source     TEXT,
  genres                TEXT,
  cover_url             TEXT,
  published_year        INTEGER,
  audio_runtime_minutes INTEGER,
  source_provider       TEXT,
  source_id             TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_user ON books(user_id);

-- A book is a thing; finishing it is an event. Re-reads / read-then-listened
-- are multiple events on one book, and each counts toward stats.
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  format           TEXT NOT NULL CHECK (format IN ('read','listened')),
  medium           TEXT,
  status           TEXT NOT NULL DEFAULT 'finished' CHECK (status IN ('finished','dnf','reading')),
  dnf_percent      INTEGER,
  started_at       TEXT,
  finished_at      TEXT,
  finished_year    INTEGER,
  rating           TEXT CHECK (rating IN ('S','A','B','C','D')),
  narration_rating TEXT CHECK (narration_rating IN ('S','A','B','C','D')),
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user_book ON events(user_id, book_id);

-- V3 feature, table ready now.
CREATE TABLE IF NOT EXISTS tbr (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  book_id    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  source     TEXT,
  priority   INTEGER NOT NULL DEFAULT 0,
  is_next_up INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','started','done','dismissed')),
  added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`),
  },
  {
    version: 2,
    up: () => addColumnIfMissing('books', 'hardcover_id', 'INTEGER'),
  },
  {
    version: 3,
    up: () => db.exec(`
-- Long-running ops (Kobo import with paced Hardcover matching) run in an
-- in-process worker: client POSTs a job, polls GET /api/jobs/:id.
CREATE TABLE IF NOT EXISTS jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL,
  payload        TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','error')),
  progress       INTEGER,
  progress_label TEXT,
  result         TEXT,
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id);`),
  },
  {
    version: 4,
    up: () => db.exec(`
-- Manual series tier overrides (Phase 2 rollups): the override wins over the
-- computed average when present.
CREATE TABLE IF NOT EXISTS series_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  series_name TEXT NOT NULL,
  rating      TEXT CHECK (rating IN ('S','A','B','C','D')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, series_name)
);`),
  },
  {
    version: 5,
    up: () => {
      db.exec(`
-- Auth (Phase 3): passwords + sessions + single-use invite tokens.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  used_by    INTEGER REFERENCES users(id),
  used_at    TEXT
);`);
      // The seed user owns this instance: admin, and the account that claims
      // the printed invite link on first boot after auth lands.
      db.prepare('UPDATE users SET is_admin=1 WHERE id=(SELECT MIN(id) FROM users)').run();
    },
  },
  {
    version: 6,
    up: () => db.exec(`
-- Password-reset invites: same single-use token machinery, but the link sets
-- a new password on an existing account instead of creating one.
ALTER TABLE invites ADD COLUMN resets_user INTEGER REFERENCES users(id);`),
  },
  {
    version: 7,
    up: () => db.exec(`
-- Compare view consent: opting in lets other members see your tier letters
-- (S-D) next to theirs for shared books/series. Off by default — signup
-- promises the account's data is yours alone, so comparison needs consent.
ALTER TABLE users ADD COLUMN share_compare INTEGER NOT NULL DEFAULT 0;`),
  },
  {
    version: 8,
    up: () => db.exec(`
-- Recommendations (Phase 4): one LLM generation = one batch of cards. A card
-- keeps its Hardcover anchor (null = unverified) plus the length fields
-- captured at verification, so accepting it needs no second HC lookup.
-- Acted-on rows are kept as "already suggested" context for future runs.
CREATE TABLE IF NOT EXISTS recommendations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  batch_id             INTEGER NOT NULL,
  title                TEXT NOT NULL,
  author               TEXT,
  series_name          TEXT,
  hardcover_id         INTEGER,
  reasoning            TEXT,
  estimated_words      INTEGER,
  page_count           INTEGER,
  audio_runtime_minutes INTEGER,
  status               TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','tbr','dismissed','avoided')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recs_user ON recommendations(user_id, batch_id);

-- "Not for me" signals: fed into future digests so the LLM steers away.
CREATE TABLE IF NOT EXISTS avoid_signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, label)
);`),
  },
  {
    version: 9,
    up: () => db.exec(`
-- Per-user LLM keys for recommendations: a member's own key wins over the
-- instance-wide LLM_* env fallback, so nobody depends on the admin's key.
ALTER TABLE users ADD COLUMN llm_api_key TEXT;
ALTER TABLE users ADD COLUMN llm_base_url TEXT;
ALTER TABLE users ADD COLUMN llm_model TEXT;`),
  },
  {
    version: 10,
    up: () => db.exec(`
-- Personal tags: free-form labels on books (JSON array), filterable in the
-- library. Per-user by construction — books rows are per-user.
ALTER TABLE books ADD COLUMN tags TEXT;`),
  },
  {
    version: 11,
    up: () => db.exec(`
-- Who an invite was minted for (free text, admin-entered). The recipient
-- still picks their own username; this just labels the link and feeds the
-- copy-paste invite email.
ALTER TABLE invites ADD COLUMN recipient TEXT;`),
  },
  {
    version: 12,
    up: () => db.exec(`
-- Members page: everyone's profile is browsable in this friend & family
-- instance; the flag exists so an opt-out (Account toggle) is trivial later.
ALTER TABLE users ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 1;`),
  },
  {
    version: 13,
    up: () => db.exec(`
-- Per-user UI preferences as a JSON blob (namespaced: dashboard.*, compare.*).
-- Absent keys mean "show the default" — new sections appear for everyone.
ALTER TABLE users ADD COLUMN prefs TEXT;`),
  },
  {
    version: 14,
    up: () => db.exec(`
-- "On pause" shelf state: a book set aside mid-read (not DNF, not queued).
-- A per-book flag rather than an events.status — that CHECK constraint can't
-- be ALTERed, and a new status would ripple into word math + TBR sync.
ALTER TABLE books ADD COLUMN on_pause INTEGER NOT NULL DEFAULT 0;`),
  },
  {
    version: 15,
    up: () => db.exec(`
-- Device-link polling: opt-in storage of the Kobo device's own cloud
-- credentials (UserID/UserKey, extracted from the uploaded KoboReader.sqlite)
-- so the app can pull reading state from Kobo's cloud as the device. One row
-- per user — a linked device is personal.
CREATE TABLE kobo_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  api_endpoint TEXT NOT NULL,
  user_key TEXT NOT NULL,
  kobo_user_id TEXT,
  last_sync_token TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);`),
  },
  {
    version: 16,
    up: () => db.exec(`
-- Now-reading progress: where you are in an open 'reading' event (1-99).
-- Lives on the event, not the book — re-reads have their own positions.
ALTER TABLE events ADD COLUMN percent INTEGER;`),
  },
  {
    version: 17,
    up: () => db.exec(`
-- Series journey: cached Hardcover series rosters (positions + book ids).
-- Series data is user-independent, so one global cache row per series name.
CREATE TABLE series_cache (
  series_key TEXT PRIMARY KEY,
  books TEXT NOT NULL,
  fetched_at TEXT DEFAULT (datetime('now'))
);`),
  },
  {
    version: 18,
    up: () => db.exec(`
-- Crowd-sourced mood labels ("dark", "adventurous", ...) rented from
-- Hardcover's cached_tags, same JSON-array convention as genres. Imported
-- metadata, never user tags — those live in books.tags.
ALTER TABLE books ADD COLUMN moods TEXT;`),
  },
  {
    version: 19,
    up: () => db.exec(`
-- Rec cards can now be marked "I've already read this" — a status the old
-- CHECK constraint rejected. SQLite can't ALTER a CHECK, so rebuild the
-- table (same columns) with the extended constraint.
CREATE TABLE recommendations_new (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  batch_id             INTEGER NOT NULL,
  title                TEXT NOT NULL,
  author               TEXT,
  series_name          TEXT,
  hardcover_id         INTEGER,
  reasoning            TEXT,
  estimated_words      INTEGER,
  page_count           INTEGER,
  audio_runtime_minutes INTEGER,
  status               TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','tbr','read','dismissed','avoided')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO recommendations_new SELECT * FROM recommendations;
DROP TABLE recommendations;
ALTER TABLE recommendations_new RENAME TO recommendations;
CREATE INDEX IF NOT EXISTS idx_recs_user ON recommendations(user_id, batch_id);`),
  },
  {
    version: 20,
    up: () => db.exec(`
-- Manual ordering within a tier on the tier board: position of the book in
-- its current tier row. NULL = never hand-arranged (sorts after, by age).
ALTER TABLE books ADD COLUMN tier_order INTEGER;`),
  },
  {
    version: 21,
    up: () => db.exec(`
-- Admin panel: which device logged in (captured once at session creation)
-- and a durable login record — sessions vanish on logout, so they can't be
-- the history. login_audit self-trims to the newest 500 rows.
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
CREATE TABLE login_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT,
  ip TEXT,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`),
  },
  {
    version: 22,
    up: () => db.exec(`
-- Compare matching backfill: books created from rec accepts (and some
-- quick-add paths) carry the Hardcover id in source_id with source_provider
-- 'hardcover' but hardcover_id never set, so compare pairs them by the
-- fragile title+author fallback. Copy the id across; CAST is guarded to
-- numeric source_ids so junk can't land in the column.
UPDATE books SET hardcover_id = CAST(source_id AS INTEGER)
WHERE source_provider = 'hardcover' AND hardcover_id IS NULL
  AND source_id IS NOT NULL AND source_id GLOB '[0-9]*';`),
  },
  {
    version: 23,
    up: () => {
      // Work-level identity slot for compare matching: matching tries
      // work_id before hardcover_id before title+author. Hardcover's public
      // API exposes no work key today (verified against their schema Sept
      // 2026 — no `work` relation, no `work_id` on books, no `works` type),
      // so the column stays NULL unless a future source populates it.
      addColumnIfMissing('books', 'work_id', 'INTEGER');
    },
  },
  {
    version: 24,
    up: () => db.exec(`
-- Feature requests: members suggest functionality, the admin triages it in
-- the admin panel. status is the admin's ledger (open → done); done requests
-- stay visible until explicitly deleted.
CREATE TABLE IF NOT EXISTS feature_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`),
  },
  {
    version: 25,
    up: () => db.exec(`
-- Profile pictures: the browser square-crops and shrinks them to a 256px
-- JPEG before upload, so the blob stays tiny. Stored in the users table on
-- purpose — snapshots back them up and account deletion takes them with it.
ALTER TABLE users ADD COLUMN avatar BLOB;
ALTER TABLE users ADD COLUMN avatar_type TEXT;`),
  },
  {
    version: 26,
    up: () => db.exec(`
-- Audible and ABS collapse into one plain 'audiobook' medium — to a reader
-- they're the same thing, and imports now write it directly. Values are
-- rewritten in place; nothing else about the events changes.
UPDATE events SET medium = 'audiobook' WHERE lower(medium) IN ('audible', 'abs');`),
  },
  {
    version: 27,
    up: () => db.exec(`
-- "No Hardcover profile" flag: novellas and niche editions sometimes have no
-- Hardcover entry to match, and those books flag "needs re-pull" forever.
-- Excluded books skip every HC lookup (re-pull, bulk backfill, ABS re-match)
-- and drop out of the needs-refresh counts; a re-pull still fills their
-- missing cover/pages from Google Books as the fallback source.
ALTER TABLE books ADD COLUMN hardcover_excluded INTEGER NOT NULL DEFAULT 0;`),
  },
  {
    version: 28,
    up: () => db.exec(`
-- Per-member Audiobookshelf links: each member stores their own ABS server +
-- API token + library, and a sync folds ABS's mediaProgresses into their
-- events (open reading events with percent, finishes dated to lastUpdate).
-- The token is stored server-side only and never sent back to the client —
-- same trust model as kobo_links. One row per member.
CREATE TABLE abs_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  server_url TEXT NOT NULL,
  api_token TEXT NOT NULL,
  library_id TEXT,
  abs_username TEXT,
  library_name TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);`),
  },
  {
    version: 29,
    // Uniform tag casing: crowd-sourced genres/moods (Hardcover, Open Library
    // subjects) and early hand-typed tags mixed "dark academia" with "Dark
    // Academia". First letter of each tag goes upper, stray padding trims,
    // in-list case duplicates collapse — writes are normalized going forward
    // (normTags), this sweeps what's already stored. A corrupt JSON cell is
    // skipped, not fatal — a wedged migration would stall every boot.
    up: () => {
      const cap = (t) => (t = String(t ?? '').trim()) ? t[0].toUpperCase() + t.slice(1) : t;
      const fix = (json) => JSON.stringify([...new Set(JSON.parse(json || '[]').map(cap).filter(Boolean))]);
      const rows = db.prepare('SELECT id, genres, moods, tags FROM books').all();
      const upd = db.prepare('UPDATE books SET genres=?, moods=?, tags=? WHERE id=?');
      for (const r of rows) {
        try {
          const g = fix(r.genres), m = fix(r.moods), t = fix(r.tags);
          if (g !== (r.genres ?? '[]') || m !== (r.moods ?? '[]') || t !== (r.tags ?? '[]')) {
            upd.run(g, m, t, r.id);
          }
        } catch { /* unparseable cell — leave it for a re-pull */ }
      }
    },
  },
  {
    version: 30,
    // Canonical genre vocabulary (server/genres-vocab.js): every stored genre
    // is re-mapped strictly — aliases resolve to the canonical name, unknowns
    // drop. Also stamps the books table for the background genre reconciler:
    // NULL means "never cross-checked against Google Books".
    up: () => {
      addColumnIfMissing('books', 'genres_synced_at', 'TEXT');
      const rows = db.prepare('SELECT id, genres FROM books').all();
      const upd = db.prepare('UPDATE books SET genres=?, genres_synced_at=NULL WHERE id=?');
      for (const r of rows) {
        try {
          const g = JSON.stringify(mapGenres(JSON.parse(r.genres || '[]')));
          if (g !== (r.genres ?? '[]')) upd.run(g, r.id);
        } catch { /* unparseable cell — leave it; a re-pull rebuilds genres */ }
      }
    },
  },
  {
    version: 31,
    // Metadata re-pull stamp: NULL means "never re-pulled". The needs-re-pull
    // flag only nags about missing metadata until a re-pull has actually been
    // attempted — books whose sources (HC + Google) simply have no lengths or
    // cover would otherwise flag forever (Road of the Patriarch, Sept 2026).
    up: () => addColumnIfMissing('books', 'metadata_refreshed_at', 'TEXT'),
  },
  {
    version: 32,
    // GET /books decorates every book with six correlated subqueries over
    // events (rating, format, status, count, last finish) — all filtering
    // events by book_id alone, which no index covered (the existing one leads
    // with user_id). Also serves /tbr and the event routes.
    up: () => db.exec('CREATE INDEX IF NOT EXISTS idx_events_book ON events(book_id)'),
  },
  {
    version: 33,
    // Schema-level identity backstop: one book row per (user, provider,
    // source_id). App-level dedupe stays (it powers the friendly existed:true
    // responses and title matching), but every import path awaits between its
    // check and its insert, so two concurrent runs could both miss and
    // double-insert — the Sept 18 "Chain-Gang All-Stars" 75-dupe class. NULL
    // source_ids (manual/demo books) are exempt: SQLite treats NULLs as
    // distinct in unique indexes.
    up: () => {
      // Insurance merge before the rule switches on: fold any existing
      // duplicate groups into their MIN(id) keeper. Events re-point BEFORE
      // the book delete — the FK cascade would otherwise destroy them. TBR
      // keeps at most one row per (user, book): the keeper's row wins, else
      // the oldest dupe's row re-points and the rest drop. Ephemeral tables
      // (recommendations etc.) may cascade-delete; they regenerate. No-op on
      // clean data (prod verified 0 groups, Sept 22 2026).
      const groups = db.prepare(`SELECT user_id, source_provider, source_id, MIN(id) AS keeper
        FROM books WHERE source_id IS NOT NULL
        GROUP BY user_id, source_provider, source_id HAVING COUNT(*) > 1`).all();
      for (const g of groups) {
        const stale = db.prepare('SELECT id FROM books WHERE user_id=? AND source_provider=? AND source_id=? AND id<>?')
          .all(g.user_id, g.source_provider, g.source_id, g.keeper).map((r) => r.id);
        const inStale = stale.map(() => '?').join(',');
        db.prepare(`UPDATE events SET book_id=? WHERE book_id IN (${inStale})`).run(g.keeper, ...stale);
        const tbrIds = db.prepare(`SELECT id FROM tbr WHERE user_id=? AND book_id IN (${inStale}) ORDER BY id`)
          .all(g.user_id, ...stale).map((r) => r.id);
        const keeperQueued = db.prepare('SELECT 1 FROM tbr WHERE user_id=? AND book_id=?')
          .get(g.user_id, g.keeper);
        if (tbrIds.length) {
          const drop = tbrIds.slice(keeperQueued ? 0 : 1);
          if (drop.length) {
            db.prepare(`DELETE FROM tbr WHERE id IN (${drop.map(() => '?').join(',')})`).run(...drop);
          }
          if (!keeperQueued) {
            db.prepare('UPDATE tbr SET book_id=? WHERE id=?').run(g.keeper, tbrIds[0]);
          }
        }
        db.prepare(`DELETE FROM books WHERE id IN (${inStale})`).run(...stale);
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_books_identity ON books(user_id, source_provider, source_id)');
    },
  },
  {
    version: 34,
    // Storyteller Selection: one row per blind tasting flight. Passages are
    // LLM-written original prose in an author's style — never stored
    // publisher text. `authors` rides in key order (A, B, C…) and `ranking`
    // stays NULL until the member locks their blind preference order.
    up: () => {
      db.exec(`CREATE TABLE storyteller_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        scene TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'pastiche',
        authors TEXT NOT NULL,
        passages TEXT NOT NULL,
        ranking TEXT,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX idx_storytellers_user ON storyteller_rounds(user_id, created_at)');
    },
  },
  {
    version: 35,
    // Storyteller flights restyle a FIXED "set" passage per scene (picked
    // from passages.js at generation time); storing it per round lets the
    // ranking screen show the block every voice started from.
    up: () => addColumnIfMissing('storyteller_rounds', 'base', 'TEXT'),
  },
  {
    version: 36,
    // Authentic-flight corpus: real passages the ADMIN brings in — scanned
    // out of ebook files they own, or pasted as JSON. Instance-wide ON
    // PURPOSE (no user_id): one shared household corpus, curated by one
    // admin. Rows arrive as unclassified 'candidate's from a scan; 'kept'
    // rows are the corpus authentic flights draw from. This text lives only
    // in the instance DB — never in git, never in any export.
    up: () => {
      db.exec(`CREATE TABLE storyteller_snippets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_batch TEXT,
        author TEXT NOT NULL,
        title TEXT,
        source_year INTEGER,
        scene TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','kept','discarded')),
        passage TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      db.exec('CREATE INDEX idx_snippets_scene ON storyteller_snippets(scene, status, author)');
      db.exec('CREATE INDEX idx_snippets_batch ON storyteller_snippets(scan_batch)');
    },
  },
  {
    version: 37,
    // Reading streaks: a progress touch (±% buttons, progress API) stamps the
    // day so streaks count minor progress, not just new entries. created_at
    // already covers entries; both feed the day set in server/streak.js.
    up: () => addColumnIfMissing('events', 'progress_at', 'TEXT'),
  },
  {
    version: 38,
    // Cooperative job cancellation: DELETE on a RUNNING job sets this flag
    // instead of refusing; cancel-aware runners check it between rows and
    // stop cleanly (partial imports stand, the rest is skipped).
    up: () => addColumnIfMissing('jobs', 'cancel_requested', 'INTEGER DEFAULT 0'),
  },
];

function addColumnIfMissing(table, column, decl) {
  const names = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!names.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

for (const m of migrations) {
  if (m.version <= db.prepare('PRAGMA user_version').get().user_version) continue;
  db.exec('BEGIN');
  try {
    m.up();
    db.exec(`PRAGMA user_version = ${m.version}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const seeded = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
// Seed user gets share_compare like every other new account (signups set it
// explicitly; the column default stays 0 for migration-era rows).
if (!seeded) db.prepare('INSERT INTO users (name, share_compare) VALUES (?, 1)').run(config.defaultUserName);

// Fresh databases: migration 5's promote-first-user ran before any user
// existed, so guarantee an admin here — the first-boot claim-link flow in
// index.js depends on one existing.
if (!db.prepare('SELECT id FROM users WHERE is_admin=1 LIMIT 1').get()) {
  db.prepare('UPDATE users SET is_admin=1 WHERE id=(SELECT MIN(id) FROM users)').run();
}

// Multi-user now: the auth middleware runs each request as its session user
// (see request-context.js). CLI scripts and job runners run outside a request
// and either pass user ids explicitly or fall back to the seed user.
export function currentUserId() {
  return getRequestUserId()
    ?? db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id;
}
