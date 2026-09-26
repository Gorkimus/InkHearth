import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Server start time doubles as the deploy/version marker the SPA checks
// against localStorage to announce "the app was updated" after a restart.
const startedAt = new Date().toISOString();

// Tiny .env loader — avoids a dotenv dependency.
const env = {};
const envPath = path.join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const config = {
  root,
  startedAt,
  port: Number(process.env.PORT || env.PORT || 3222),
  dbPath: process.env.BT_DB_PATH || env.BT_DB_PATH || path.join(root, 'data', 'booktracker.db'),
  defaultUserName: process.env.DEFAULT_USER_NAME || env.DEFAULT_USER_NAME || 'Reader',
  cookieSecure: (process.env.COOKIE_SECURE || env.COOKIE_SECURE || '') === '1',
  // Set TRUST_PROXY=1 when the app runs behind one reverse proxy, so req.ip
  // (login rate limit, login_audit) is the client's address, not the proxy's.
  trustProxy: (process.env.TRUST_PROXY || env.TRUST_PROXY || '') === '1',
  hardcoverToken: process.env.HARDCOVER_TOKEN || env.HARDCOVER_TOKEN || '',
  // Optional free-tier key (console.cloud.google.com → Books API). Without it
  // Google's keyless quota is routinely 429 on shared IPs; with it Google is a
  // reliable fallback instead of a coin flip.
  googleBooksKey: process.env.GOOGLE_BOOKS_API_KEY || env.GOOGLE_BOOKS_API_KEY || '',
  // Second free-tier key — takes over when the first burns its daily quota.
  googleBooksKey2: process.env.GOOGLE_BOOKS_API_KEY_2 || env.GOOGLE_BOOKS_API_KEY_2 || '',
  // Shown in the tab title, favicon and header when set ("STAGING") so two
  // instances open side by side are never mistaken for each other.
  instanceLabel: process.env.INSTANCE_LABEL || env.INSTANCE_LABEL || '',
  koboSync: {
    // Device-link polling. Endpoint override for the protocol spike; hours
    // between automatic pulls (0 disables auto-sync — manual "Sync now" only).
    endpoint: process.env.KOBO_SYNC_ENDPOINT || env.KOBO_SYNC_ENDPOINT || 'https://storeapi.kobo.com',
    clientKey: process.env.KOBO_CLIENT_KEY || env.KOBO_CLIENT_KEY || '',
    hours: Number(process.env.KOBO_SYNC_HOURS || env.KOBO_SYNC_HOURS || 6),
  },
  backup: {
    // Silent nightly snapshots (see server/backup.js). hours between checks
    // against the newest auto-snapshot's age (0 disables); keep = how many
    // auto-snapshots survive pruning. Hand-made .db files are never pruned.
    hours: Number(process.env.BACKUP_HOURS || env.BACKUP_HOURS || 24),
    keep: Number(process.env.BACKUP_KEEP || env.BACKUP_KEEP || 60),
  },
  llm: {
    // OpenAI-compatible endpoint (e.g. Google AI Studio's /v1beta/openai/).
    baseUrl: (process.env.LLM_BASE_URL || env.LLM_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || env.LLM_MODEL || '',
  },
  abs: {
    // process.env first — compose injects .env as environment variables and
    // the container has no /app/.env file to parse.
    url: (process.env.ABS_URL || env.ABS_URL || '').replace(/\/$/, ''),
    token: process.env.ABS_API_TOKEN || env.ABS_API_TOKEN || '',
    libraryId: process.env.ABS_LIBRARY_ID || env.ABS_LIBRARY_ID || '',
    // Per-member ABS links also poll on a clock (hours between syncs, checked
    // every 30 min like the Kobo poll). 0 keeps it manual-only via "Sync now".
    syncHours: Number(process.env.ABS_SYNC_HOURS || env.ABS_SYNC_HOURS || 1),
    // Origins members may link their own ABS sync to, beyond abs.url — e.g. a
    // member's own offsite server. Comma-separated origin forms
    // (https://abs.example.com). Empty with no abs.url = no restriction
    // (dev/CI); any configured origin turns the allowlist on.
    linkAllowlist: (process.env.ABS_LINK_ALLOWLIST || env.ABS_LINK_ALLOWLIST || '')
      .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  },
  // Nightly janitor (see cleanup.js): expired sessions, day-old uploads
  // (Kobo device sqlite files carry live sync credentials), stale data/tmp.
  // 0 disables.
  cleanup: {
    hours: Number(process.env.CLEANUP_HOURS || env.CLEANUP_HOURS || 12),
  },
  // Background genre reconciler: hours between cycles that cross-check books
  // (not yet Google-verified) against Google Books and merge canonical
  // genres. 0 disables the poller entirely — refresh still reconciles.
  genreSync: {
    hours: Number(process.env.GENRE_SYNC_HOURS || env.GENRE_SYNC_HOURS || 24),
  },
};
