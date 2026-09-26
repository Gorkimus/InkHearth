// Shared Hardcover matching used by the ABS + Kobo imports.
//
// Verified against the live API (Sept 2026):
// - No word_count field exists anywhere in the schema. Words stay estimates.
// - search() is a Typesense root field returning a jsonb `results` blob;
//   document ids arrive as STRINGS.
// - Bursts get throttled with 200s missing the GraphQL payload -> pace
//   requests and retry with backoff.
// - Folder-style titles ("... (Unabridged)", "Book 14 - ...", "Series #4")
//   poison search -> cleaned variants, author-suffixed disambiguation, and a
//   series-position path for "Series #N" titles.
// - Author agreement uses token overlap (pen names like "Shirtaloon" vs
//   "Travis Deverell Shirtaloon") plus the search index's author_names.

import { config } from '../config.js';
import { mapGenres } from '../genres-vocab.js';

// One builder for all three Typesense indices we browse: "book" (classic
// discovery), "author" (catalog browse) and "series" (roster by name).
// Verified live Sept 17 2026: author documents carry {id, name, books_count},
// series documents {id, name, author_name, books_count, readers_count} —
// ids as strings, like everywhere else in the search blob. Interpolating
// `type`/`perPage` is safe: both are server-side constants, never user input.
const hcSearchQuery = (type, perPage = 15) => `query ($q: String!) {
  search(query: $q, query_type: "${type}", per_page: ${perPage}, page: 1) { results }
}`;

async function hcSearchHits(q, type = 'book', perPage = 15) {
  const data = await hc(hcSearchQuery(type, perPage), { q });
  const s = Array.isArray(data.search) ? data.search[0] : data.search;
  return s?.results?.hits || [];
}

const hitBookIds = (hits, limit) => hits
  .map((h) => Number(h?.document?.id))
  .filter((n) => Number.isInteger(n) && n > 0)
  .slice(0, limit);
const HC_BOOKS = `query ($ids: [Int!]) {
  books(where: {id: {_in: $ids}}) {
    id
    title
    slug
    release_year
    pages
    audio_seconds
    cached_image
    description
    contributions { contributor_role { id } author { name } }
    cached_tags
    book_series { position series { name } }
  }
}`;
// Exact-name series lookup (_ilike is blocked server-side — 403). Includes
// author so journey cards can queue the next installment fully filled.
// The limit must out-populate HC's junk same-named rows ("The Wheel of Time"
// carries 4 empty phantom rows next to the real 196-entry one, "Harry Potter"
// 5) — Hasura returns them in arbitrary order, so a tight window can drop the
// real series entirely and the caller then caches an "absent" roster.
const HC_SERIES = `query ($name: String!) {
  series(where: {name: {_eq: $name}}, limit: 25) {
    id
    name
    book_series(order_by: {position: asc}) {
      position
      book { id title release_year users_count contributions { contributor_role { id } author { name } } }
    }
  }
}`;

// Barcode fallback: search HC by the bare ISBN and require a hit. Their
// index genuinely matches ISBN strings — bogus codes return zero hits —
// unlike hardcoverLookup, whose empty-title fall-through picks popular
// books loosely and must never be called without a title.
export async function hardcoverByIsbn(isbn) {
  const hits = await hcSearchHits(String(isbn), 'book', 5);
  if (!hits.length) return null;
  const ids = hitBookIds(hits, 5);
  const detail = ids.length ? await hc(HC_BOOKS, { ids }) : null;
  return (detail?.books || [])[0] || null;
}

export function hardcoverEnabled() {
  return Boolean(config.hardcoverToken);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastHc = 0;

// Health signal for the admin panel: the integration pill should show whether
// HC calls actually WORK, not just whether a token is configured. (A single
// bad GraphQL field once failed every call for hours with zero visibility.)
export const hcHealth = { lastOkAt: null, lastErrorAt: null, lastError: null };
export const hcHealthSummary = () => ({
  ok: Boolean(hcHealth.lastOkAt && (!hcHealth.lastErrorAt || hcHealth.lastOkAt >= hcHealth.lastErrorAt)),
  lastOkAt: hcHealth.lastOkAt,
  lastErrorAt: hcHealth.lastErrorAt,
  lastError: hcHealth.lastError,
});

async function hc(query, variables, tries = 4) {
  try {
    for (let attempt = 1; ; attempt++) {
      const wait = 400 - (Date.now() - lastHc);
      if (wait > 0) await sleep(wait);
      lastHc = Date.now();
      const res = await fetch('https://api.hardcover.app/v1/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.hardcoverToken}` },
        body: JSON.stringify({ query, variables }),
        // A stalled HC request must never pin a search, a save, or the shared
        // job queue — deadline, then the normal retry/backoff decides.
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= tries) throw new Error(`hardcover HTTP ${res.status} after ${attempt} tries`);
        await sleep(1500 * attempt);
        continue;
      }
      let body;
      try { body = JSON.parse(await res.text()); }
      catch { throw new Error(`hardcover non-JSON response (HTTP ${res.status})`); }
      if (body.errors?.length) throw new Error(body.errors[0].message);
      if (!body.data) {
        // Throttle-shaped 200: treat like 429 and back off.
        if (attempt >= tries) throw new Error(`hardcover empty data (HTTP ${res.status}) after ${attempt} tries`);
        await sleep(1500 * attempt);
        continue;
      }
      hcHealth.lastOkAt = Date.now();
      return body.data;
    }
  } catch (err) {
    hcHealth.lastErrorAt = Date.now();
    hcHealth.lastError = err.message;
    throw err;
  }
}

export const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
export const numFrom = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Folder-derived titles carry the sequence: "Book 14 - …", "14 - …", "#4".
export function sequenceFromTitle(title) {
  const m = /\bbook\s+(\d+(?:\.\d+)?)/i.exec(title)
    || /^(\d+(?:\.\d+)?)\s*[-–.)]\s*/.exec(title)
    || /#(\d+(?:\.\d+)?)/.exec(title);
  return m ? numFrom(m[1]) : null;
}

// Tokenize the RAW string — norm() strips separators, which would glue
// multi-word names into one unmatchable token.
const tokens = (s) => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

const STUDIO_AUTHOR = /\bllc|inc\.|studios|graphic audio|productions|podcast\b/i;

// Strip folder noise ("(Unabridged)", "[Dramatized Adaptation]", "2 of 2")
// before comparing titles — a raw "(Unabridged)" suffix breaks containment
// checks against Hardcover's longer canonical titles.
function cleanTitle(title) {
  return title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:unabridged|abridged|dramatized adaptation[^)]*)\)/gi, ' ')
    .replace(/\b\d+\s+of\s+\d+\b/gi, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function queryVariants(title, author) {
  const cleaned = cleanTitle(title);
  const out = [cleaned];
  // Series-prefixed form: "The Wheel of Time Book 1 - The Eye of the World"
  // → also try the part after the separator.
  const seg = cleaned.split(/\s+[-–—]\s+|\s*:\s+/).pop().trim();
  if (seg && norm(seg) !== norm(cleaned)) out.push(seg);
  if (author && !STUDIO_AUTHOR.test(author)) out.push(`${cleaned} ${author}`.trim());
  return [...new Set(out)];
}

function authorAgrees(absAuthor, book, searchAuthors = []) {
  if (!absAuthor || STUDIO_AUTHOR.test(absAuthor)) return true;
  const at = tokens(absAuthor);
  if (!at.length) return true;
  const names = [
    ...(book.contributions || []).map((c) => c.author?.name),
    ...searchAuthors,
  ];
  return names.some((name) => {
    const ht = tokens(name);
    return ht.some((w) => at.includes(w)) || at.some((w) => ht.includes(w));
  });
}

// Shared mapping: HC book row → the same shape Google Books / Open Library
// results use, so downstream consumers (confirm panel, batch add, library)
// treat every provider identically. `coverUrl` lets search-hit images (more
// reliably populated) win over the row's cached_image.
const coverFrom = (img) => (typeof img === 'string' && img) || (img && typeof img === 'object' && img.url) || null;

export function mapHcBook(b, { authorFallback = null, coverUrl = null, authorIds = null } = {}) {
  if (!b?.title) return null;
  const series = pickSeries(b, b.title);
  const contributions = b.contributions || [];
  // Books credit artists/narrators alongside authors, and contributions[0]
  // is whoever HC lists first — when the caller knows which author it asked
  // for, prefer that credit over the first-listed one.
  const credited = authorIds
    ? contributions.find((c) => authorIds.includes(c.author?.id))
    : null;
  // Role 1 is HC's "Author" — artists/narrators listed first must not steal
  // the byline when the record credits a real author elsewhere.
  const byAuthorRole = contributions.find((c) => c.contributor_role?.id === 1) || null;
  return {
    provider: 'hardcover',
    source_id: String(b.id),
    title: b.title,
    author: credited?.author?.name || byAuthorRole?.author?.name || contributions[0]?.author?.name || authorFallback,
    page_count: b.pages || null,
    audio_runtime_minutes: b.audio_seconds ? Math.round(b.audio_seconds / 60) : null,
    published_year: b.release_year || null,
    genres: genresFrom(b),
    moods: moodsFrom(b),
    // Search carries series too, so quick-added books don't ship without it.
    series_name: series?.name || null,
    series_order: series?.order ?? null,
    cover_url: coverFrom(coverUrl ?? b.cached_image),
  };
}

// Discovery search for the quick-add chain: one paced search + one detail
// fetch. Two calls per query (~1s with pacing) — never on the import hot path.
export async function hardcoverSearch(q, { limit = 10 } = {}) {
  const hits = await hcSearchHits(q, 'book', 15);
  const ids = hitBookIds(hits, limit);
  if (!ids.length) return [];
  const detail = await hc(HC_BOOKS, { ids });
  const byId = new Map((detail.books || []).map((b) => [b.id, b]));
  const out = [];
  for (const h of hits) {
    const mapped = mapHcBook(byId.get(Number(h?.document?.id)), {
      authorFallback: h.document?.author_names?.[0] || null,
      coverUrl: h.document?.image,
    });
    if (mapped) out.push(mapped);
    if (out.length >= limit) break;
  }
  return out;
}

// Detail fetch by HC id — the fast path for the metadata re-pull.
export async function hardcoverBookById(id) {
  const data = await hc(HC_BOOKS, { ids: [Number(id)] });
  return (data.books || [])[0] || null;
}

// Full roster of a series, one entry per position, ordered. HC lists
// translations and split editions alongside the original at the same
// position — dedupe per position, preferring the lowest book id (the
// original/primary edition in practice).
// Series rows → one deduped entry per position, ordered. HC files
// translations and alternate editions at (or near) the same position as the
// original — keep the most-read edition (readers decide what's canonical;
// lowest id is the tiebreak). Split dramatized audiobooks get fractional
// positions of their own, so they stay distinct entries for the noise filter.
function rosterFromSeriesList(seriesList) {
  const out = [];
  for (const series of seriesList) {
    if (!series) continue;
    const byPos = new Map();
    for (const bs of series.book_series || []) {
      const pos = numFrom(bs.position);
      const book = bs.book;
      if (pos === null || !book?.id || !book.title) continue;
      const prev = byPos.get(pos);
      if (!prev
        || (book.users_count || 0) > (prev.users_count || 0)
        || (book.users_count === prev.users_count && book.id < prev.id)) {
        // ALL credited authors ride along, joined: the canonical edition of a
        // co-authored book often lists the ghostwriter FIRST ("Brandon
        // Sanderson, Robert Jordan" for the WoT finale), and a first-author-
        // only field made the journey's author gate drop the position whole.
        const names = (book.contributions || []).map((c) => c.author?.name).filter(Boolean);
        byPos.set(pos, {
          position: pos,
          hardcover_id: book.id,
          title: book.title,
          author: names.length ? names.join(', ') : null,
          release_year: book.release_year || null,
          users_count: book.users_count || 0,
        });
      }
    }
    out.push({
      id: series.id,
      name: series.name,
      roster: [...byPos.values()].sort((a, b) => a.position - b.position),
    });
  }
  return out;
}

export async function hardcoverSeriesRoster(name) {
  const all = await hardcoverSeriesRosters(name);
  return all[0]?.roster || [];
}

// ALL series whose name matches exactly — HC has many same-named series
// ("Witness" = Erikson's trilogy AND Rebecca Forster's legal thrillers), and
// the caller must disambiguate (the journey scores by the member's own
// books/authors; taking the first match put a Marvel comic in a Salvatore row).
export async function hardcoverSeriesRosters(name) {
  const data = await hc(HC_SERIES, { name });
  const list = (Array.isArray(data.series) ? data.series : [data.series]).filter(Boolean);
  return rosterFromSeriesList(list).filter((s) => s.roster.length);
}

// Author browse for the "Author" chip: the author index (name/alias match,
// verified live Sept 17 2026) as the primitive — hits carry enough for a
// future autocomplete.
export async function hardcoverAuthorHits(q) {
  const hits = await hcSearchHits(q, 'author', 15);
  // The author index matches tokens stored across each author document (book
  // titles included), so a surname query surfaces unrelated authors whose
  // BOOK shares a word — live-verified Sept 17 2026: "salvatore" ranks a
  // one-name author, Nicolas de Crécy and Natasha Knight ahead of
  // R. A. Salvatore. Keep only names the query actually names; token and
  // prefix overlap both count, so pen names and mid-typing prefixes still hit.
  const qt = tokens(q);
  const nameOk = (a) => {
    const nt = tokens(a.name);
    return nt.some((w) => qt.includes(w)) || qt.some((w) => a.name.toLowerCase().includes(w));
  };
  return hits
    .map((h) => ({ id: Number(h?.document?.id), name: h?.document?.name || null }))
    .filter((a) => Number.isInteger(a.id) && a.id > 0 && a.name)
    .filter((a) => !qt.length || nameOk(a));
}

// Every book credited to the matched authors, most-read first — `rating` is
// nullable and Postgres orders nulls first on desc, so users_count is the
// popularity sort (verified live Sept 17 2026).
const HC_AUTHOR_BOOKS = `query ($ids: [Int!], $limit: Int!) {
  books(where: {contributions: {author: {id: {_in: $ids}}}}, limit: $limit, order_by: {users_count: desc}) {
    id
    title
    release_year
    pages
    audio_seconds
    cached_image
    contributions { contributor_role { id } author { id name } }
    cached_tags
    book_series { position series { name } }
  }
}`;

export async function hardcoverAuthorBooks(q, { authors = 3, limit = 30 } = {}) {
  const authorIds = (await hardcoverAuthorHits(q)).slice(0, authors).map((a) => a.id);
  if (!authorIds.length) return [];
  const data = await hc(HC_AUTHOR_BOOKS, { ids: authorIds, limit });
  return (data.books || [])
    .map((b) => mapHcBook(b, { authorIds }))
    .filter(Boolean)
    .slice(0, limit);
}

// Whole-series browse for the "Series" chip: series index → rosters of the
// top matches, entries mapped like discovery results, in series order.
// Translation/split-edition side series come along; the shared noise filter
// downstream drops their ", Part N" entries.
const HC_SERIES_BY_IDS = `query ($ids: [Int!]) {
  series(where: {id: {_in: $ids}}) {
    id
    name
    book_series(order_by: {position: asc}) {
      position
      book { id title users_count contributions { contributor_role { id } author { name } } }
    }
  }
}`;

export async function hardcoverSeriesBooks(q, { maxSeries = 3, perSeries = 20, nameMatch = false } = {}) {
  const hits = await hcSearchHits(q, 'series', 15);
  // nameMatch gates to series whose NAME itself matches the query — the
  // All-mode rescue uses it to tell "user typed a series name" apart from
  // books that merely mention the words (samples, companions, "Untitled #6").
  const nq = nameMatch ? norm(q) : null;
  const nameOk = (h) => {
    if (!nq) return true;
    const n = norm(h?.document?.name);
    return Boolean(n) && (n === nq || n.includes(nq) || nq.includes(n));
  };
  const kept = hits.filter(nameOk).slice(0, maxSeries);
  const ids = hitBookIds(kept, maxSeries);
  if (!ids.length) return [];
  // Canonical series lead: side editions ("(Split Volume Edition)") can fuzzy-
  // match ahead of the real one, so order groups by readers, not hit rank.
  const readers = new Map(kept.map((h) => [Number(h?.document?.id), h?.document?.readers_count || 0]));
  const data = await hc(HC_SERIES_BY_IDS, { ids });
  const groups = rosterFromSeriesList(
    (Array.isArray(data.series) ? data.series : [data.series]).filter(Boolean)
  ).sort((a, b) => (readers.get(b.id) || 0) - (readers.get(a.id) || 0));
  // One detail call covers every roster book: covers, pages, genres, moods.
  // Split/placeholder entries are dropped BEFORE the id budget — otherwise a
  // split-heavy roster (The Wheel of Time: 22 "Part N of M" entries) eats the
  // budget and the real later books come back without details.
  const detailWorthy = (r) => !/\bparts? \d|\b\d+ of \d+/i.test(r.title || '')
    && !/^untitled/i.test(r.title || '');
  const bookIds = [...new Set(groups.flatMap((g) => g.roster
    .filter(detailWorthy).map((r) => r.hardcover_id)))]
    .slice(0, maxSeries * perSeries);
  if (!bookIds.length) return [];
  const detail = await hc(HC_BOOKS, { ids: bookIds });
  const byId = new Map((detail.books || []).map((b) => [b.id, b]));
  const out = [];
  const thisYear = new Date().getFullYear();
  const normT = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const g of groups) {
    const mappedAll = g.roster
      .map((r) => ({ r, m: mapHcBook(byId.get(r.hardcover_id)) }))
      .filter((x) => x.m);
    // Dominant-author gate: mixed-data series (The Wheel of Time) carry
    // translated editions credited to their translators/narrators — entries
    // by anyone outside the roster's top two authors are noise. Only applies
    // when the roster actually has 3+ distinct authors to compare.
    const authorCount = new Map();
    for (const { r, m } of mappedAll) {
      // Roster attribution is the differentiator: translated editions often
      // credit their narrator/translator on the series entry while the book
      // detail still says the original author.
      const a = r.author || m.author;
      if (a) authorCount.set(a, (authorCount.get(a) || 0) + 1);
    }
    const topAuthors = new Set([...authorCount.entries()]
      .sort((x, y) => y[1] - x[1]).slice(0, 2).map(([a]) => a));
    const mixedSeries = authorCount.size >= 3;
    // Edition-variant dedupe: a title CONTAINING a sibling's full title is
    // an alternate edition or prologue-of ("The Way of Kings Prime", "What
    // the Storm Means: Prologue to The Gathering Storm"), not a series slot.
    const variants = new Set();
    for (const { m: a } of mappedAll) {
      for (const { m: b } of mappedAll) {
        if (a === b) continue;
        const na = normT(a.title);
        const nb = normT(b.title);
        if (na.length > nb.length + 3 && nb.length >= 10 && na.includes(nb)) variants.add(a);
      }
    }
    let n = 0;
    for (const { r, m } of mappedAll) {
      if (n >= perSeries) break;
      // Unreleased entries don't belong in a browsable series yet — a future
      // release_year (or an Untitled placeholder) would sit in the grid with
      // no cover and no way to log it.
      if ((m.published_year || 0) > thisYear || /^untitled/i.test(m.title || '')) continue;
      const rosterAuthor = r.author || m.author;
      if (mixedSeries && rosterAuthor && !topAuthors.has(rosterAuthor)) continue;
      if (variants.has(m)) continue;
      m.series_name = g.name;
      m.series_order = r.position;
      out.push(m);
      n++;
    }
  }
  return out;
}

export async function hardcoverLookup(absTitle, absAuthor, isbn) {  // "Sun Eater #4"-style titles carry no book name — resolve via the series:
  // search the series name, then match on book_series position.
  const seriesNum = /^(.+?)\s*#(\d+(?:\.\d+)?)\s*$/.exec(absTitle);
  if (seriesNum) {
    const [, seriesName, pos] = seriesNum;
    try {
      const hits = await hcSearchHits(seriesName.trim(), 'book', 25);
      const ids = hitBookIds(hits, 25);
      if (ids.length) {
        const detail = await hc(HC_BOOKS, { ids });
        const ns = norm(seriesName);
        for (const b of detail.books || []) {
          const inSeries = (b.book_series || []).some((bs) => {
            const bn = norm(bs.series?.name);
            return (bn.includes(ns) || ns.includes(bn)) && numFrom(bs.position) === numFrom(pos);
          });
          if (inSeries && authorAgrees(absAuthor, b, [])) return b;
        }
      }
    } catch (err) {
      console.warn(`  ! HC series lookup "${seriesName} #${pos}": ${err.message}`);
    }
  }

  const variants = queryVariants(absTitle, absAuthor);
  if (isbn) variants.unshift(String(isbn).trim());
  const candidates = [];
  const searchAuthors = new Map();
  for (const q of variants) {
    try {
      const hits = await hcSearchHits(q, 'book', 15);
      const ids = hitBookIds(hits, 5);
      if (!ids.length) continue;
      for (const h of hits) {
        const idNum = Number(h?.document?.id);
        if (Number.isInteger(idNum)) searchAuthors.set(idNum, h.document.author_names || []);
      }
      const detail = await hc(HC_BOOKS, { ids });
      const byId = new Map((detail.books || []).map((b) => [b.id, b]));
      for (const id of ids) { const b = byId.get(id); if (b) candidates.push(b); }
    } catch (err) {
      console.warn(`  ! HC search "${q}": ${err.message}`);
    }
  }
  const seen = new Set();
  const uniq = candidates.filter((b) => !seen.has(b.id) && seen.add(b.id));
  const t = norm(cleanTitle(absTitle));
  const titleOk = (b) => {
    const bt = norm(b.title);
    return bt === t || bt.includes(t) || t.includes(bt);
  };
  // Pass 1: title match + author agreement. Pass 2: studio authors
  // ("Graphic Audio LLC.") get no author vote but still need a title match.
  for (const b of uniq) if (titleOk(b) && authorAgrees(absAuthor, b, searchAuthors.get(b.id))) return b;
  if (absAuthor && STUDIO_AUTHOR.test(absAuthor)) {
    for (const b of uniq) if (titleOk(b)) return b;
  }
  return null;
}

export function pickSeries(b, absTitle) {
  let rows = b.book_series || [];
  if (!rows.length) return null;
  if (rows.length > 1) {
    // Trap: a series named exactly after the book itself at position 1 is
    // usually a user-created sub-arc ("Iron Gold" the book → "Iron Gold" #1),
    // while the real parent saga lists the book deeper (Red Rising Saga #4).
    // When such a self-named series exists alongside another candidate, drop it.
    const selfNamed = rows.filter((r) =>
      norm(r.series?.name) === norm(b.title) && numFrom(r.position) === 1);
    if (selfNamed.length && rows.length > selfNamed.length) {
      rows = rows.filter((r) => !selfNamed.includes(r));
    }
  }
  const nt = norm(absTitle);
  const inTitle = rows.find((r) => r.series?.name && nt.includes(norm(r.series.name)));
  const best = inTitle || [...rows].sort((x, y) => (x.position ?? 1e9) - (y.position ?? 1e9))[0];
  return { name: best.series.name, order: numFrom(best.position) };
}

// Uniform tag casing for everything written anywhere (search, refresh,
// imports, hand-typed): crowd tags arrive as "dark academia" as often as
// "Dark Academia". Trim + capitalize the first letter of the tag — nothing
// else, so "sci-fi" and "YA" keep their shape; case-duplicates collapse.
export function normTag(t) {
  t = String(t ?? '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
export const normTags = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map(normTag).filter(Boolean))];

export function genresFrom(b) {
  const g = b.cached_tags?.Genre;
  if (!Array.isArray(g)) return [];
  // Strict canonical mapping: aliases collapse ("Sci-Fi" → Science Fiction),
  // unknown crowd tags drop. HC rank order decides which 3 survive.
  return mapGenres(g.sort((x, y) => (y.count || 0) - (x.count || 0)).map((x) => x.tag), 3);
}

// Same crowd-sourced shape as genres, one category over: cached_tags.Mood.
// Crowd labels attract junk — bare timestamps ("1735854730701") and
// metadata like "Series: X" — so keep only letter-bearing, colon-free
// strings before ranking (moods are plain words; this still allows accents).
const isCleanMood = (t) => typeof t === 'string' && /[a-zA-Z]/.test(t) && !/\d/.test(t) && !t.includes(':');
export function moodsFrom(b) {
  const m = b.cached_tags?.Mood;
  if (!Array.isArray(m)) return [];
  return [...new Set(m.filter((x) => isCleanMood(x?.tag))
    .sort((x, y) => (y.count || 0) - (x.count || 0)).slice(0, 3).map((x) => normTag(x.tag)))];
}
