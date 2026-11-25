import { config } from '../config.js';
import {
  hardcoverLookup, hardcoverSearch as hcSearch, hardcoverSeriesRosters as hcRosters,
  hardcoverBookById as hcBookById, hardcoverEnabled as enabled,
  hardcoverAuthorHits as hcAuthorHits, hardcoverAuthorBooks as hcAuthorBooks,
  hardcoverSeriesBooks as hcSeriesBooks,
} from './hardcover-import.js';

// Save-time enrichment: when a HARDCOVER_TOKEN is present in .env, new books
// get missing length fields (page counts, real audiobook runtimes) filled from
// Hardcover. Thin wrapper over the shared paced matcher — it carries all the
// live-API lessons (throttle retries, string ids, cleaned-title matching).
export function hardcoverEnabled() {
  return enabled();
}

// Discovery search (quick-add autofill). Returns [] whenever the token is
// missing or the call fails — discovery must degrade, never break.
export async function searchHardcover(q) {
  if (!enabled() || !q?.trim()) return [];
  return hcSearch(q.trim());
}

// Author/series browse for the fielded search chips — same degrade-to-[]
// contract as searchHardcover: a failed browse must never break search.
export async function searchHardcoverAuthors(q) {
  if (!enabled() || !q?.trim()) return [];
  try {
    return await hcAuthorHits(q.trim());
  } catch (err) {
    console.warn(`[hardcover] author search "${q}" failed: ${err.message}`);
    return [];
  }
}

export async function hardcoverAuthorBooks(q) {
  if (!enabled() || !q?.trim()) return [];
  try {
    return await hcAuthorBooks(q.trim());
  } catch (err) {
    console.warn(`[hardcover] author browse "${q}" failed: ${err.message}`);
    return [];
  }
}

export async function hardcoverSeriesBooks(q, opts = {}) {
  if (!enabled() || !q?.trim()) return [];
  try {
    return await hcSeriesBooks(q.trim(), opts);
  } catch (err) {
    console.warn(`[hardcover] series browse "${q}" failed: ${err.message}`);
    return [];
  }
}

// ALL same-named series rosters for the journey card — HC has many series
// sharing a name ("Witness" = Erikson AND Rebecca Forster), so the caller
// disambiguates by the member's own books. Returns [] when HC genuinely
// lists no such series, null on ERROR — the caller must not cache nulls, or
// a single failed lookup would blank the journey card for the cache TTL.
export async function seriesRosters(name) {
  if (!enabled() || !name?.trim()) return null;
  try {
    return await hcRosters(name.trim());
  } catch (err) {
    console.warn(`[hardcover] series rosters "${name}" failed: ${err.message}`);
    return null;
  }
}

// Detail fetch by HC id for the metadata re-pull — null on any failure.
export async function hardcoverBookById(id) {
  if (!enabled() || !Number.isInteger(Number(id))) return null;
  try {
    return await hcBookById(Number(id));
  } catch (err) {
    console.warn(`[hardcover] book ${id} fetch failed: ${err.message}`);
    return null;
  }
}

// Returns { page_count, audio_runtime_minutes } for missing fields only, else null.
// Any failure returns null — saving a book must never depend on this.
export async function enrichWithHardcover(draft) {
  if (!enabled() || !draft?.title) return null;
  try {
    const b = await hardcoverLookup(draft.title, draft.author, draft.isbn);
    if (!b) return null;
    return {
      page_count: b.pages || null,
      audio_runtime_minutes: b.audio_seconds ? Math.round(b.audio_seconds / 60) : null,
    };
  } catch (err) {
    console.warn('[hardcover] enrich failed, falling back to estimates:', err.message);
    return null;
  }
}
