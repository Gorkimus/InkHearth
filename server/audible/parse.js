// Defensive parser for user-supplied Audible library exports. Audible has no
// first-party one-file export, so users bring CSVs/JSON from helper apps —
// Libation, OpenAudible, the Audible Library Extractor extension, audible-cli,
// or Amazon's "Request My Data" archive. Column names differ per tool, so
// headers are alias-matched like the Kobo parser matches device schemas.

const FIELDS = {
  asin: ['asin', 'audibleasin', 'productasin', 'audibleproductid'],
  isbn: ['isbn', 'isbn13'],
  title: ['title', 'booktitle', 'name', 'bookname', 'producttitle'],
  author: ['author', 'authors', 'bookauthor', 'authorname', 'contributions'],
  narrator: ['narrator', 'narrators', 'narratorname'],
  series: ['series', 'seriesname', 'seriesnames', 'seriestitle', 'seriesseries'],
  seriesOrder: ['seriesorder', 'booknumber', 'seriesposition', 'seriespositioninseries', 'bookinseries', 'seriesbook'],
  runtimeMinutes: ['runtime', 'runtimeminutes', 'runtimelengthminutes', 'lengthminutes', 'lengthinminutes', 'length', 'minutes'],
  percent: ['percentcomplete', 'percentlistened', 'percentread', 'percentfinished', 'progress', 'percent'],
  lastListened: ['lastheardat', 'lastlistened', 'lastlisteneddate', 'datelistened', 'lastplayed', 'lastused', 'lastlistenendate'],
  // Libation exports "Is Finished?" (TRUE/FALSE) and no progress percent —
  // it's the only read-status signal in that file.
  finished: ['isfinished', 'finished'],
  dateAdded: ['dateadded', 'purchasedate', 'datepurchased', 'addeddate'],
};

const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function mapHeaders(headers) {
  const col = {};
  for (const [field, aliases] of Object.entries(FIELDS)) {
    const idx = headers.findIndex((h) => aliases.includes(normKey(h)));
    if (idx >= 0) col[field] = idx;
  }
  return col;
}

// Minimal RFC-4180-ish CSV: handles quoted fields, doubled quotes, newlines
// in quotes. Delimiter sniffed per file — some tools export semicolon/tab.
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQ = false;
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];

  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// "10 hrs and 3 mins" → 603; "10.5 hrs" → 630; "603" → 603; "9h30" → 570.
function runtimeToMinutes(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).toLowerCase();
  const hr = s.match(/(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|h\b)/);
  const min = s.match(/(\d+)\s*(?:minutes?|mins?|m\b)/);
  if (hr || min) {
    return Math.round((hr ? parseFloat(hr[1].replace(',', '.')) * 60 : 0) + (min ? parseInt(min[1], 10) : 0)) || null;
  }
  return toNumber(s);
}

const toDate = (v) => (v ? (String(v).match(/\d{4}-\d{2}-\d{2}/) || [null])[0] : null);

// percent ≥ 97 → finished; > 0 → reading; none/0 → book-only. Mirrors the
// Kobo parser's suggestion logic so the review UI behaves identically.
function suggestStatus(percent, hasLastListened) {
  if (percent === null) return hasLastListened ? 'reading' : 'book';
  if (percent >= 97) return 'finished';
  if (percent > 0) return 'reading';
  return 'book';
}

// A file with no listening signals anywhere — no progress values, no
// "finished" flags, no last-listened dates on ANY row — is a wishlist/queue
// export (e.g. Audible Library Extractor's wishlist CSV, or Libation's): a
// library export always carries listening history on at least some rows.
// Suggest those rows as want-to-read instead of bare catalog entries.
function finalizeStatuses(books) {
  const anySignal = books.some((b) => b.percent !== null || b.last_read !== null);
  if (books.length && !anySignal) for (const b of books) b.suggested_status = 'tbr';
  return books;
}

// Libation's boolean "Is Finished?" stands in for a progress percent.
const finishedToPercent = (percent, finished) =>
  percent !== null ? Math.max(0, Math.min(100, Math.round(percent)))
    : /^true$/i.test(String(finished || '').trim()) ? 100 : null;

function normalizeRow(raw) {
  const get = (f) => (raw.col[f] === undefined ? null : String(raw.cells[raw.col[f]] ?? '').trim() || null);
  const title = get('title');
  if (!title) return null;
  const percent = finishedToPercent(toNumber(get('percent')), get('finished'));
  const lastListened = get('lastListened');
  return {
    content_id: get('asin'),
    isbn: get('isbn'),
    title,
    author: get('author'),
    narrator: get('narrator'),
    series: get('series'),
    series_order: toNumber(get('seriesOrder')),
    runtime_minutes: runtimeToMinutes(get('runtimeMinutes')),
    percent: percent === null ? null : Math.max(0, Math.min(100, Math.round(percent))),
    last_read: toDate(lastListened),
    suggested_status: suggestStatus(percent, !!lastListened),
  };
}

function normalizeObject(obj) {
  const lower = {};
  for (const [k, v] of Object.entries(obj || {})) lower[normKey(k)] = v;
  const get = (...fields) => {
    for (const f of fields) {
      for (const alias of FIELDS[f]) {
        if (lower[alias] !== undefined && lower[alias] !== null && lower[alias] !== '') return lower[alias];
      }
    }
    return null;
  };
  const title = get('title');
  if (!title) return null;
  const percent = finishedToPercent(toNumber(get('percent')), get('finished'));
  const lastListened = get('lastListened');
  return {
    content_id: get('asin'),
    isbn: get('isbn'),
    title: String(title).trim(),
    author: get('author'),
    narrator: get('narrator'),
    series: get('series'),
    series_order: toNumber(get('seriesOrder')),
    runtime_minutes: runtimeToMinutes(get('runtimeMinutes')),
    percent: percent === null ? null : Math.max(0, Math.min(100, Math.round(percent))),
    last_read: toDate(lastListened),
    suggested_status: suggestStatus(percent, !!lastListened),
  };
}

export function parseAudibleExport(text) {
  text = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('empty file');

  let rawRows;
  if (text.startsWith('[') || text.startsWith('{')) {
    let data = JSON.parse(text);
    if (!Array.isArray(data)) {
      // Some tools wrap the array — take the first array-valued property.
      const arrVal = Object.values(data).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
      if (!arrVal) throw new Error('no book list found in JSON');
      data = arrVal;
    }
    const books = data.map(normalizeObject).filter(Boolean);
    if (!books.length) throw new Error('no recognizable book rows in JSON');
    return { source: 'json', books: finalizeStatuses(books) };
  }

  const table = parseCsv(text);
  return tableFromRows(table, 'csv');
}

// Shared tail for the tabular sources (CSV, xlsx): alias-match the header,
// require a title column, normalize every row.
export function tableFromRows(table, source) {
  if (table.length < 2) throw new Error(`${source.toUpperCase()} needs a header row and at least one book`);
  const col = mapHeaders(table[0]);
  if (col.title === undefined) throw new Error('no title column found — is this an Audible library export?');
  const books = table.slice(1)
    .map((cells) => normalizeRow({ col, cells }))
    .filter(Boolean);
  if (!books.length) throw new Error(`no book rows found in ${source.toUpperCase()}`);
  return { source, books: finalizeStatuses(books) };
}
