// Goodreads CSV export parser (My Books → Import/Export → Export Library).
// The export shape: UTF-8 (often with BOM), RFC4180-ish quoting, ISBN13
// wrapped as ="978…" by Excel-guard, dates as YYYY/MM/DD, and "Exclusive
// Shelf" carrying the read state. My Rating (0–5) maps onto the S–D scale.
// Column order varies between exports, so headers are alias-matched.

const SHELF_STATUS = { read: 'finished', 'currently-reading': 'reading' };
const DEFAULT_SHELVES = new Set(['read', 'currently-reading', 'to-read']);
const RATING_TIER = { 5: 'S', 4: 'A', 3: 'B', 2: 'C', 1: 'D' };

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row);
      row = [];
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const cleanIsbn = (v) => {
  const s = String(v || '').replace(/^="?|"?"$/g, '').replace(/[^\dXx]/g, '');
  return s || null;
};

const cleanDate = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); // Goodreads: YYYY/MM/DD
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s || null; // already ISO, or untouched — the event validator re-checks
};

// Goodreads glues series data onto the Title: "The Giver (Giver, #1)",
// "Eragon (The Inheritance Cycle #1)" (comma optional). Left in place, the
// tag poisons Hardcover's title search — a whole import can land with
// parenthesised titles and no series data (Sept 2026, 18 misses on one
// member's library). A real series tag carries a #position; any other
// trailing parenthetical ("(Vintage International)" is a publisher imprint,
// "(Cosmere)" a universe) is stripped for matching but never stored as a
// series — inventing a series from an imprint would be worse than none.
const SERIES_TAG = /\(([^()]+?)\s*,?\s*#(\d+(?:\.\d+)?)\s*\)\s*$/;
const TRAILING_PAREN = /\s*\([^()]*\)\s*$/;

function splitSeriesTag(rawTitle) {
  const title = rawTitle.trim();
  const tag = SERIES_TAG.exec(title);
  if (tag) {
    return {
      title: title.slice(0, tag.index).trim() || title,
      series: tag[1].trim(),
      series_order: parseFloat(tag[2]),
    };
  }
  const paren = TRAILING_PAREN.exec(title);
  if (paren && paren.index > 0) {
    return { title: title.slice(0, paren.index).trim() || title, series: null, series_order: null };
  }
  return { title, series: null, series_order: null };
}

export function parseGoodreads(text) {
  const table = parseCsv(text);
  if (!table.length) throw new Error('the file has no rows — is it a Goodreads CSV export?');
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
    author: col('author'),
    isbn: col('isbn13', 'isbn'),
    rating: col('myrating', 'rating'),
    pages: col('numberofpages'),
    dateRead: col('dateread', 'dateread date read'),
    shelf: col('exclusiveshelf', 'bookshelves', 'bookshelves with positions'),
    shelves: col('bookshelves', 'bookshelves with positions'),
    bookId: col('bookid', 'book id'),
  };
  if (c.title === -1 || c.author === -1) {
    throw new Error('no Title/Author columns found — this doesn\'t look like a Goodreads export');
  }

  const books = [];
  for (const r of table.slice(1)) {
    const get = (i) => (i === -1 ? '' : String(r[i] ?? '').trim());
    if (!get(c.title)) continue;
    const { title, series, series_order } = splitSeriesTag(get(c.title));

    const shelfRaw = get(c.shelf).toLowerCase();
    const shelf = shelfRaw.split(',')[0].trim() || 'read';
    const ratingNum = parseInt(get(c.rating), 10);
    // Custom shelves (read/currently-reading/to-read excluded) become tags.
    const tags = get(c.shelves).toLowerCase().split(',')
      .map((t) => t.trim()).filter((t) => t && !DEFAULT_SHELVES.has(t));

    books.push({
      content_id: get(c.bookId) ? `gr-${get(c.bookId)}` : 'gr-' + title.toLowerCase().replace(/[^a-z0-9]+/g, ''),
      title,
      author: get(c.author) || null,
      isbn: cleanIsbn(c.isbn === -1 ? '' : get(c.isbn)),
      pages: parseInt(get(c.pages), 10) || null,
      rating: RATING_TIER[ratingNum] || null,
      last_read: shelf === 'read' ? cleanDate(get(c.dateRead)) : cleanDate(get(c.dateRead)) || null,
      percent: null,
      series,
      series_order,
      shelves: tags,
      // 'to-read' → 'tbr': these queue straight into the want-to-read list on
      // import instead of landing as bare catalog rows — pulling a Goodreads
      // want-to-read list over is the whole point of that shelf.
      suggested_status: SHELF_STATUS[shelf] || (shelf === 'to-read' ? 'tbr' : 'book'),
    });
  }
  return books;
}
