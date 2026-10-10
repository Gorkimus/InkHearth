// Libby timeline CSV parser (Shelf → Timeline → Actions → Export Timeline →
// Spreadsheet). The file is an ACTIVITY LOG, not a book list: one row per
// event — Borrowed / Returned / Renewed / holds — with columns
//   cover, title, author, publisher, isbn, timestamp, activity, details, library
// (timestamp like "July 24, 2026 19:23"). As of 2026 Libby's timeline has no
// return entries, so exports carry Borrowed rows only and there is no true
// read date anywhere in the file. By the household's convention the read date
// is ESTIMATED as borrow date + loan length — the loan length taken from the
// row's own details ("14 days" / "21 days") when the file states it, 14 days
// otherwise. A real Returned date would win if a future export ever carries
// one. Dates are deliberately approximate; the review list marks them "~".
// Rows are grouped per book (same title+author under several ISBNs is one
// book — reborrows and edition variants are common), and format is preset to
// Listened ONLY where the publisher is audio-only; everything else stays
// unknown for the review list, because the file cannot distinguish an ebook
// borrow from an audiobook one ("details" is the loan length, not the format).
import { parseCsv } from '../csv.js';

// Publishers with a 100% audiobook catalog — a borrow from these is known to
// have been listened to. Deliberately tight: mixed print/audio imprints
// (HarperCollins, Blackstone, Pottermore, Sounds True, Zibby…) must NOT match.
const AUDIO_ONLY = /audio|tantor|books on tape|recorded books|podium|dreamscape|highbridge|gildan media|pushkin industries|christianaudio|naxos|author'?s republic/i;

const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// "July 24, 2026 19:23" → "2026-07-24" (local time; the export carries no zone).
function isoDate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// "2026-07-24" + n days → "2026-08-07".
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseLibby(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error('the file has no rows — is it a Libby timeline export?');
  const headers = table[0].map((h) => String(h || '').trim().toLowerCase());
  const col = (name) => headers.indexOf(name);
  const c = {
    title: col('title'),
    author: col('author'),
    publisher: col('publisher'),
    isbn: col('isbn'),
    timestamp: col('timestamp'),
    activity: col('activity'),
    details: col('details'),
  };
  if (c.title === -1 || c.timestamp === -1 || c.activity === -1) {
    throw new Error('no Title/timestamp/activity columns — this doesn\'t look like a Libby timeline export');
  }

  // Group by title+author: the same work reborrows and cross-editions under
  // different ISBNs (and many rows carry no ISBN at all), while genuinely
  // different books sharing a title but not an author stay apart.
  const groups = new Map();
  for (const r of table.slice(1)) {
    const get = (i) => (i === -1 ? '' : String(r[i] ?? '').trim());
    const title = get(c.title);
    if (!title) continue;
    const key = normKey(title) + '|' + normKey(get(c.author));
    if (!groups.has(key)) {
      groups.set(key, {
        title,
        author: get(c.author) || null,
        isbn: null,
        audio: false,
        loanDays: null,   // from the file's details ("14 days"), when stated
        borrows: [],      // ISO dates of every Borrowed row, latest last
        returned: [],     // ISO dates of any Returned row (future-proofing: Libby's
                          // timeline has no returns today, but if a later export
                          // grows them, real read dates arrive without a migration)
      });
    }
    const g = groups.get(key);
    const isbn = get(c.isbn).replace(/[^\dXx]/g, '');
    if (isbn && !g.isbn) g.isbn = isbn;
    if (AUDIO_ONLY.test(get(c.publisher))) g.audio = true;
    if (g.loanDays === null) {
      const m = /\b(\d+)\s*days?\b/i.exec(get(c.details));
      if (m) g.loanDays = parseInt(m[1], 10);
    }
    const when = isoDate(get(c.timestamp));
    const activity = get(c.activity).toLowerCase();
    if (when && activity.startsWith('borrow')) g.borrows.push(when);
    else if (when && activity.startsWith('return')) g.returned.push(when);
  }

  const books = [...groups.values()].map((g) => {
    g.borrows.sort();
    g.returned.sort();
    const last_borrowed = g.borrows.at(-1) || null;
    // The read date: a real return wins if one ever appears; otherwise the
    // household convention — borrow date + loan length (the file's stated
    // loan, else Libby's default 14 days). Approximate by design.
    const last_read = g.returned.at(-1)
      || (last_borrowed ? addDays(last_borrowed, g.loanDays ?? 14) : null);
    return {
      content_id: 'libby-' + (g.isbn || normKey(g.title) + '-' + normKey(g.author)),
      title: g.title,
      author: g.author,
      isbn: g.isbn,
      // Preset ONLY on audio-only publishers — everything else stays null so
      // the review list's format column starts at "—" and the member decides.
      format: g.audio ? 'listened' : null,
      pages: null,
      rating: null,
      percent: null,
      last_read,
      last_borrowed,
      series: null,
      series_order: null,
      shelves: [],
      suggested_status: 'finished',
    };
  });
  return books;
}
