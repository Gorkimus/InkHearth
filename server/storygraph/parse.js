// StoryGraph CSV export parser (My Books → Manage → Export Your Library).
// The export shape: UTF-8, RFC4180-ish quoting, dates as YYYY/MM/DD, and one
// row per EDITION — the same work can appear several times (paperback read,
// ebook queued). Rows are grouped per title+author (Libby-style) before
// import so editions fold into one book; the winning row is the most-read
// status (read > reading > to-read > anything else), and fields the winner
// lacks (ISBN, rating, review) fill from its sibling editions.
//
// Column mapping: Read Status → suggested status (did-not-finish and paused
// land as catalog-only rows), Star Rating → S–D tier rounded to the nearest
// whole star (4.75 → S, 3.5 → A, 2.75 → B), Last Date Read → the finish date
// (re-read date ranges are dropped — re-reads are logged by hand, same as
// the Kobo sync), Format → read/listened (audio arrives preset Listened,
// everything else Read; rows with no format stay "—" for the review list),
// Tags → book tags, and Review (HTML) → plain-text event notes. ISBN/UID
// mixes ISBN-10/13 with Kindle ASINs — ASINs aren't ISBNs and only poison
// Hardcover's variant search, so they're dropped. Narrator contributors
// ("Name (Narrator)") ride along for audiobook rows.
import { parseCsv } from '../csv.js';

const STATUS = {
  read: 'finished',
  'currently-reading': 'reading',
  'to-read': 'tbr',
  'did-not-finish': 'book',
  paused: 'book',
};
// Merge priority when editions disagree: a read edition outranks a queued
// one ("Fiasco" read digitally + queued in paperback is a finished book).
const STATUS_RANK = { finished: 4, reading: 3, tbr: 2, book: 1 };
const RATING_TIER = { 5: 'S', 4: 'A', 3: 'B', 2: 'C', 1: 'D' };

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const cleanDate = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); // StoryGraph: YYYY/MM/DD
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s || null; // already ISO, or untouched — the event validator re-checks
};

// ISBN/UID carries ISBN-10 (digits + optional trailing X), ISBN-13, and
// Amazon ASINs ("B0BDS3GQLK"). Only real ISBN shapes survive; an ASIN
// stripped to its digits ("0…") would just be a wrong-number lookup.
const cleanIsbn = (v) => {
  const s = String(v || '').replace(/^="?|"?"$/g, '').replace(/[\s-]/g, '');
  return (/^\d{9}[\dXx]$/.test(s) || /^\d{13}$/.test(s)) ? s : null;
};

// StoryGraph reviews are HTML ("<div>…</div>", "<br>", "&nbsp;"). Paragraph
// breaks become blank lines; inline markup and entities become plain text.
function htmlToText(html) {
  const s = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<(p|div)[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const out = [];
  for (const l of lines) {
    if (l) out.push(l);
    else if (out.length && out.at(-1) !== '') out.push('');
  }
  const text = out.join('\n').trim();
  return text || null;
}

// Contributors is a comma list like "Kevin R. Free (Narrator), Anthea Bell
// (Translator)" — only narrators matter to the shelf.
const narratorsFrom = (v) => String(v || '')
  .split(',')
  .map((c) => c.trim())
  .filter((c) => /\(narrator\)$/i.test(c))
  .map((c) => c.replace(/\s*\([^)]*\)\s*$/, '').trim())
  .filter(Boolean)
  .join(', ') || null;

export function parseStorygraph(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error('the file has no rows — is it a StoryGraph CSV export?');
  const headers = table[0].map(normHeader);
  const col = (...names) => {
    for (const n of names) {
      const i = headers.indexOf(normHeader(n));
      if (i !== -1) return i;
    }
    return -1;
  };
  const c = {
    title: col('title'),
    author: col('authors', 'author'),
    contributors: col('contributors'),
    isbn: col('isbnuid', 'isbn'),
    format: col('format'),
    status: col('readstatus', 'status'),
    lastRead: col('lastdateread'),
    rating: col('starrating', 'rating'),
    review: col('review'),
    tags: col('tags'),
  };
  if (c.title === -1 || c.author === -1 || c.status === -1) {
    throw new Error('no Title/Authors/Read Status columns — this doesn\'t look like a StoryGraph export');
  }

  // Group editions per work, same as the Libby parser: identical normalized
  // title+author is one book ("You Are Here" by two different authors stays
  // two — the author is part of the key).
  const groups = new Map();
  for (const r of table.slice(1)) {
    const get = (i) => (i === -1 ? '' : String(r[i] ?? '').trim());
    const title = get(c.title);
    if (!title) continue;
    const key = normKey(title) + '|' + normKey(get(c.author));
    const row = {
      content_id: null, // stamped from the group's first ISBN/title-key below
      title,
      author: get(c.author) || null,
      isbn: cleanIsbn(get(c.isbn)),
      narrator: narratorsFrom(get(c.contributors)),
      format: get(c.format).toLowerCase() === 'audio' ? 'listened' : (get(c.format) ? 'read' : null),
      rating: null,
      notes: htmlToText(get(c.review)),
      last_read: cleanDate(get(c.lastRead)),
      percent: null,
      series: null,
      series_order: null,
      shelves: get(c.tags).split(',').map((t) => t.trim()).filter(Boolean),
      suggested_status: STATUS[get(c.status).toLowerCase()] || 'book',
    };
    const star = parseFloat(get(c.rating));
    // Round to the nearest whole star, then onto the tier ladder: 4.75 → S,
    // 3.5 → A, 2.75 → B, 2.25 → C. Unrated (and 0-star) rows stay null.
    if (Number.isFinite(star) && star >= 1) row.rating = RATING_TIER[Math.min(5, Math.round(star))] || null;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const books = [...groups.values()].map((editions) => {
    // The most-read edition wins; fields it lacks fill from its siblings.
    const win = editions.reduce((best, r) =>
      (STATUS_RANK[r.suggested_status] ?? 1) > (STATUS_RANK[best.suggested_status] ?? 1) ? r : best);
    for (const r of editions) {
      if (win === r) continue;
      win.isbn ??= r.isbn;
      win.narrator ??= r.narrator;
      win.rating ??= r.rating;
      win.notes ??= r.notes;
      win.last_read ??= r.last_read;
      win.format ??= r.format;
      for (const t of r.shelves) if (!win.shelves.includes(t)) win.shelves.push(t);
    }
    // Idempotency key: ISBN when the group has one, else title+author —
    // stable across re-uploads so already-imported books skip themselves.
    win.content_id = 'sg-' + (win.isbn || normKey(win.title) + '-' + normKey(win.author));
    return win;
  });
  return books;
}
