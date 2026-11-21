import { searchGoogleBooks } from './google-books.js';
import { searchOpenLibrary } from './openlibrary.js';
import {
  enrichWithHardcover, hardcoverEnabled, searchHardcover,
  hardcoverAuthorBooks, hardcoverSeriesBooks,
} from './hardcover.js';

// Discovery: Hardcover first, then Google Books + Open Library as the
// fallback pair. HC is token-authenticated and health-tracked, and its data
// (series, moods, covers) is what save-time enrichment uses anyway — when HC
// answers, Google/OL are never called, which also keeps this network away
// from Google's exhausted keyless quota. The pair only fans out when HC is
// disabled, errors, or genuinely has nothing for the query.
//
// Results are cached briefly; FAILURES are negative-cached for a shorter
// window so a doomed query isn't re-fanned-out on every keystroke. Concurrent
// identical queries share one in-flight round instead of stacking.

const CACHE_TTL = 5 * 60 * 1000;
const FAIL_TTL = 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map(); // normalized query -> { at, results } or { at, err }
const inflight = new Map(); // normalized query -> Promise

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Store samples, split-chapter uploads, anthologies and boxed sets bury the
// book you're after, so they're filtered out by default. Matching is prefix
// style ("sampl" also catches "sampler", "trilog" catches "Trilogía") and
// deliberately aggressive — a genuine novel with "collection" in its title
// gets swept up too, but the UI's "collections & samples" toggle is one flip
// away, and clean-by-default is worth that.
const SAMPLE_TITLE = /\b(sampl|preview|excerpt|bonus chapter|free chapter|chapters? \d)/i;
const COLLECTION_TITLE = /\b(collect|omnibus|trilog|duolog|quadrilog|antholog|box set|boxed set|bundle|series|sagas?|complete (works|stories|novels)|short stories|books? \d)/i;
const SPLIT_TITLE = /\bparts? \d|\b\d+ of \d+/i; // ", Part 2" / "(3 of 5)" audiobook splits of a single work
const NOISE_GENRE = /^antholog/i;
// Title-only noise test for roster-style entries (series lists carry no
// genre/length data, so the full isNoise would misfire on isStub). "Untitled"
// catches HC's unreleased placeholder rows.
export const isNoiseTitle = (title) =>
  SAMPLE_TITLE.test(title || '') ||
  COLLECTION_TITLE.test(title || '') ||
  SPLIT_TITLE.test(title || '') ||
  /^untitled/i.test(title || '');
// A record with no author AND nothing to show is a community-data stub:
// logging it would put an empty shell in the library, and a re-pull can't
// fill it (Hardcover itself has nothing on the record).
const isStub = (b) => !b.author && !b.page_count && !b.cover_url;
const isNoise = (b) =>
  isStub(b) ||
  SAMPLE_TITLE.test(b.title || '') ||
  COLLECTION_TITLE.test(b.title || '') ||
  SPLIT_TITLE.test(b.title || '') ||
  (b.genres || []).some((g) => NOISE_GENRE.test(g));

function scoreResult(b, queryWords, position) {
  // Leading articles are the classic search mismatch — HC titles keep them
  // ("The Hero of Ages") while queries drop them ("hero of ages") — so score
  // against the bare title too and take the better match.
  const t = norm(b.title);
  const tBare = t.replace(/^the /, '');
  const match = (title) =>
    !title ? 0 : title === queryWords ? 3 : title.startsWith(queryWords) ? 2 : title.includes(queryWords) ? 1.2 : 0;
  let s = 1 - position * 0.03; // provider relevance order still matters
  if (b.provider === 'google' || b.provider === 'hardcover') s += 0.2;
  s += Math.max(match(t), match(tBare));
  // A query like "mistborn sanderson" rewards author overlap the title can't cover.
  const a = norm(b.author);
  if (a) {
    const titleWords = new Set(t.split(' '));
    for (const w of queryWords.split(' ')) {
      if (w.length >= 3 && !titleWords.has(w) && a.split(' ').includes(w)) { s += 0.6; break; }
    }
  }
  // Community-data quality: HC lets bare stubs and split-upload records exist
  // with no author, length or cover, and their titles often outrank the
  // canonical work. Records with nothing to show sink below any fleshed-out
  // candidate; fully populated records get a nudge up.
  if (!b.author && !b.page_count && !b.cover_url) s -= 0.5;
  else if (b.author && (b.page_count || b.cover_url)) s += 0.3;
  return s;
}

export async function searchMetadata(q, { includeCollections = false, field = 'all', exact = false } = {}) {
  const queryWords = norm(q);
  // Field and the collections toggle change what gets run/filtered, not the
  // query — separate cache keys keep both views warm, so flipping either
  // re-renders without a new fan-out. `exact` (click-through deep links)
  // gets its own key for the same reason.
  const key = `${field}:${exact ? 'x:' : ''}${includeCollections ? 'all:' : ''}${queryWords}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.err ? FAIL_TTL : CACHE_TTL)) {
    if (hit.err) throw new Error(hit.err);
    return { results: hit.results, noiseHidden: hit.noiseHidden };
  }
  const running = inflight.get(key);
  if (running) return running;
  const task = runSearch(q, queryWords, key, includeCollections, field, exact).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function runSearch(q, queryWords, key, includeCollections, field, exact = false) {
  const errs = [];
  let pool = [];
  let rescore = true;
  // HC answers first (paced); the Google/OL pair only fans out behind it.
  const tryHardcover = async (fn) => {
    if (!hardcoverEnabled()) return;
    try {
      pool.push(...await fn(q));
    } catch (err) {
      errs.push(`hardcover: ${err.message}`);
    }
  };
  const fanOut = async (opts) => {
    const settled = await Promise.allSettled([searchGoogleBooks(q, opts), searchOpenLibrary(q, opts)]);
    for (const p of settled) if (p.status === 'fulfilled') pool.push(...p.value);
    for (const p of settled) if (p.status === 'rejected') errs.push(p.reason.message);
  };

  if (field === 'author') {
    // Browse the matched authors' catalogs (most-read first), not fuzzy
    // title hits — this is the whole point of the Author chip. Exact mode
    // (clicked author links) requires every query word in the author name,
    // so "salvatore" can't drag in one-name authors whose book mentions it.
    rescore = false;
    await tryHardcover(hardcoverAuthorBooks);
    if (exact) {
      const qt = queryWords.split(' ').filter(Boolean);
      pool = pool.filter((b) => qt.every((w) => norm(b.author || '').includes(w)));
    }
    if (!pool.length) await fanOut({ author: true });
  } else if (field === 'series') {
    // Whole-roster browse in series order. There is no series index outside
    // HC, so an empty/failed browse degrades to the plain book search.
    // Exact mode (clicked series links / the journey card) gates to series
    // whose NAME matches — the series index otherwise matches book-title
    // tokens inside its documents ("games" drags in media-studies series).
    rescore = false;
    await tryHardcover((qq) => hardcoverSeriesBooks(qq, { nameMatch: exact }));
    if (!pool.length) {
      await tryHardcover(searchHardcover);
      if (!pool.length) await fanOut({});
    }
  } else {
    await tryHardcover(searchHardcover);
    if (!pool.length) await fanOut({});
    // A thin book result usually means the query named a series ("stormlight
    // archive") rather than a title — lead with the roster instead. The name
    // match is the trigger: books whose titles merely contain the query
    // (companions, "Untitled #6" placeholders) would otherwise be all the
    // user sees. The roster leads and skips title rescoring; organic
    // leftovers follow.
    let seriesRescued = false;
    if (field === 'all') {
      const organic = pool;
      pool = [];
      await tryHardcover(() => hardcoverSeriesBooks(q, { nameMatch: true }));
      seriesRescued = pool.length > 0;
      pool.push(...organic);
    }
    rescore = !seriesRescued;
  }

  // Dedupe (normalized title+author; first occurrence wins — pool order means
  // the earlier provider's copy of an overlap beats the later one's).
  const seen = new Set();
  const uniq = pool.filter((b) => {
    const k = norm(b.title) + '|' + norm(b.author);
    if (k === '|') return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // Author/series modes (and a series rescue in All) keep provider semantics
  // — author popularity and series position decide the order. Title-match
  // scoring would bury a series book whose title doesn't contain the series
  // name.
  const scored = rescore
    ? uniq.map((b, i) => ({ b, s: scoreResult(b, queryWords, i) }))
      .sort((x, y) => y.s - x.s)
      .map((x) => x.b)
    : uniq;
  // Only a fully empty pool counts as provider failure — "all matches were
  // samples/collections" is a normal empty result, not an error.
  if (!scored.length && errs.length) {
    // Total failure — negative-cache briefly so retries wait instead of storming.
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), err: errs.join('; ') });
    throw new Error(errs.join('; '));
  }
  const noiseHidden = includeCollections ? 0 : scored.filter((b) => isNoise(b)).length;
  const results = includeCollections ? scored : scored.filter((b) => !isNoise(b));
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results, noiseHidden });
  return { results, noiseHidden };
}

export { enrichWithHardcover, hardcoverEnabled };
