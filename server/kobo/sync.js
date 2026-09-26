// Kobo device-link sync: pull reading state from Kobo's cloud as the device.
//
// The uploaded KoboReader.sqlite carries the device's own credentials (the
// `user` table's UserID/UserKey). With opt-in storage (kobo_links, migration
// 15) the app speaks the same sync protocol the device uses.
// Validated against a real Kobo account Sept 17, 2026. The wire facts that
// differ from the kobo-docker prior art:
//   • POST {storeapi}/v1/auth/device wants the kobodl-shaped body —
//     AffiliateName/AppVersion/ClientKey(base64 of PlatformId)/DeviceId(64
//     hex)/PlatformId/SerialNumber(32 hex)/UserKey. The old
//     DeviceModel/EmailAddress/... shape 400s.
//   • The device identity must be STABLE: derived here from the link's own
//     UserID so every sync presents the same device to Kobo.
//   • GET {storeapi}/v1/library/sync authorizes with just the Bearer token;
//     repeat it passing the returned x-kobo-synctoken to page through the
//     library until an empty batch.
//   • Real items nest the triple under `NewEntitlement`:
//     {NewEntitlement: {BookEntitlement, BookMetadata, ReadingState}} — the
//     triple also arrives top-level from some firmwares, so both are read.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { db } from '../db.js';
import { config } from '../config.js';
import { runLibraryImport } from '../imports/library-import.js';

// ---- credentials from the uploaded device database ----

export function extractKoboDeviceLink(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    if (!tables.includes('user')) {
      throw new Error('no "user" table in this KoboReader.sqlite — device credentials unavailable');
    }
    const cols = db.prepare('PRAGMA table_info(user)').all().map((c) => c.name);
    const idCol = cols.find((c) => /^userid$/i.test(c));
    const keyCol = cols.find((c) => /^userkey$/i.test(c));
    if (!keyCol) throw new Error(`no UserKey column in the user table (${cols.join(', ')})`);
    const row = db.prepare('SELECT * FROM user LIMIT 1').get();
    const userKey = row?.[keyCol] ? String(row[keyCol]).trim() : '';
    if (!userKey) throw new Error('UserKey is empty — this device has never cloud-synced');
    return {
      kobo_user_id: idCol && row?.[idCol] ? String(row[idCol]) : null,
      user_key: userKey,
      api_endpoint: config.koboSync.endpoint,
    };
  } finally {
    db.close();
  }
}

// ---- protocol ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function koboFetch(url, { method = 'GET', body, accessToken, syncToken } = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(syncToken ? { 'x-kobo-synctoken': syncToken } : {}),
        },
        body: body && method !== 'GET' ? body : undefined,
        signal: AbortSignal.timeout(15000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        await sleep(1200 * attempt);
        continue;
      }
      if (res.status === 401) throw new Error('Kobo rejected the device credentials (HTTP 401) — re-upload KoboReader.sqlite and relink');
      if (!res.ok) throw new Error(`Kobo API HTTP ${res.status} for ${new URL(url).pathname}`);
      return res;
    } catch (err) {
      if (attempt >= tries || err.name === 'TimeoutError' || err.name === 'AbortError') {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error('Kobo API timed out');
        throw err;
      }
      await sleep(1200 * attempt);
    }
  }
}

// Stable per-link device identity, derived from the device's own UserID —
// every sync presents the same "device" to Kobo instead of minting new ones.
const deviceIdentity = (link) => {
  const hex32 = createHash('md5').update(String(link.kobo_user_id || link.user_key)).digest('hex');
  return { deviceId: hex32 + hex32, serialNumber: hex32 + hex32.slice(0, 16) };
};

async function deviceAuth(link) {
  const platformId = config.koboSync.clientKey || '00000000-0000-0000-0000-000000000373';
  const { deviceId, serialNumber } = deviceIdentity(link);
  const body = JSON.stringify({
    AffiliateName: 'Kobo',
    AppVersion: '4.38.23171',
    ClientKey: Buffer.from(platformId).toString('base64'),
    DeviceId: deviceId,
    PlatformId: platformId,
    SerialNumber: serialNumber,
    UserKey: link.user_key,
  });
  const res = await koboFetch(`${link.api_endpoint}/v1/auth/device`, { method: 'POST', body });
  const out = await res.json();
  if (!out?.AccessToken) throw new Error('Kobo device auth returned no AccessToken');
  return out;
}

// ---- mapping: sync items → library-import rows ----

const numFrom = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ProgressPercent arrives as a 0..1 fraction on current firmware, but older
// payloads used whole percents — normalize by magnitude.
function percentFrom(state) {
  const raw = numFrom(state?.CurrentBookmark?.ProgressPercent);
  if (raw === null) return null;
  return Math.max(0, Math.min(100, Math.round(raw <= 1 ? raw * 100 : raw)));
}

export function rowFromItem(item, idx) {
  const ne = item.NewEntitlement || item; // real-cloud payloads nest the triple
  const ent = ne.BookEntitlement || item.BookEntitlement || {};
  const meta = ne.BookMetadata || item.BookMetadata || {};
  const state = ne.ReadingState || item.ReadingState || ne.BookEntitlement?.ReadingState || {};
  const title = String(meta.Title || '').trim();
  if (!title) return null;
  const isbn = (typeof meta.ISBN === 'string' && meta.ISBN) || meta.ISBN?.id || null;
  const author = (typeof meta.Author === 'string' && meta.Author) || meta.Author?.Name || null;
  const percent = percentFrom(state);
  const status = String(state.StatusInfo?.Status || '').toLowerCase();
  const lastModified = state.StatusInfo?.LastModified || state.CurrentBookmark?.LastModified || null;
  const lastRead = lastModified ? String(lastModified).slice(0, 10) : null;
  return {
    content_id: ent.EntitlementId ? String(ent.EntitlementId) : null,
    isbn: isbn ? String(isbn) : null,
    title,
    author,
    percent: status === 'finished' ? 100 : percent,
    last_read: lastRead,
    suggested_status:
      status === 'finished' || (percent ?? 0) >= 97 ? 'finished'
        : (percent ?? 0) >= 1 || status === 'reading' ? 'reading' : 'book',
  };
}

// ---- the job runner ----

export async function runKoboSync(payload, report, uid) {
  const link = db.prepare('SELECT * FROM kobo_links WHERE user_id=?').get(uid);
  if (!link) throw new Error('no linked Kobo device');

  try {
    report(2, 'Authenticating with Kobo…');
    const auth = await deviceAuth(link);

    report(8, 'Pulling reading state…');
    // Page through the library with the returned sync token until an empty
    // batch — the first call carries only the newest 100 entitlements.
    let syncToken = link.last_sync_token || undefined;
    const items = [];
    for (let page = 0; page < 25; page++) {
      const res = await koboFetch(`${link.api_endpoint}/v1/library/sync`, {
        accessToken: auth.AccessToken,
        syncToken,
      });
      const batch = await res.json().catch(() => null);
      if (!Array.isArray(batch) || !batch.length) break;
      items.push(...batch);
      const next = res.headers.get('x-kobo-synctoken');
      if (!next || next === syncToken) break;
      syncToken = next;
    }

    const rows = items.map(rowFromItem).filter(Boolean);
    if (!rows.length) {
      db.prepare("UPDATE kobo_links SET last_synced_at=datetime('now'), last_sync_token=?, last_error=NULL WHERE user_id=?")
        .run(syncToken, uid);
      return { imported: 0, hardcover_matched: 0, events_created: 0, skipped: 0, changed: items.length };
    }

    report(15, `Syncing ${rows.length} changed book${rows.length === 1 ? '' : 's'}…`);
    const result = await runLibraryImport({ uid, provider: 'kobo', rows, hardcover: true }, (p, label) =>
      report(15 + Math.round(((p || 0) / 100) * 80), label));

    db.prepare("UPDATE kobo_links SET last_synced_at=datetime('now'), last_sync_token=?, last_error=NULL WHERE user_id=?")
      .run(syncToken, uid);
    return { ...result, changed: items.length };
  } catch (err) {
    db.prepare('UPDATE kobo_links SET last_error=? WHERE user_id=?').run(String(err.message || err), uid);
    throw err;
  }
}
