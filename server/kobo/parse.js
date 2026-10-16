// Parser for KoboReader.sqlite (the device database exposed over USB at
// .kobo/KoboReader.sqlite). Firmware versions differ, so columns are detected
// rather than assumed; anything unrecognizable surfaces as an error instead of
// silently importing wrong data.

import { DatabaseSync } from 'node:sqlite';

const isoDate = (s) => {
  if (!s) return null;
  const str = String(s).replace(/\s{2,}/g, ' ').trim();
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const toPercent = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};

export function parseKoboDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    if (!tables.includes('content')) {
      throw new Error('This file has no "content" table — it does not look like a Kobo device database.');
    }
    const cols = db.prepare('PRAGMA table_info(content)').all().map((c) => c.name);
    const has = (n) => cols.includes(n);
    const pick = (...names) => names.find((n) => has(n)) || null;

    const idCol = pick('ContentID', 'ID');
    const titleCol = pick('Title', 'BookTitle');
    const authorCol = pick('Attribution', 'Author', 'AuthorDisplayName');
    const isbnCol = pick('ISBN', 'Isbn');
    const percentCol = pick('___PercentRead', 'PercentRead');
    const lastReadCol = pick('DateLastRead', '___SyncTime');
    const deletedCol = pick('___Deleted', 'IsDeleted');
    const typeCol = pick('ContentType');
    const mimeCol = pick('MimeType');
    if (!idCol || !titleCol) {
      throw new Error(`Unrecognized content table columns (${cols.slice(0, 12).join(', ')}…).`);
    }

    // ContentType 6 = books; fall back to Kobo mime types if the column is absent.
    let where = '';
    if (typeCol) where = `WHERE "${typeCol}" = 6`;
    else if (mimeCol) where = `WHERE "${mimeCol}" LIKE 'application/x-kobo-%' OR "${mimeCol}" = 'application/pdf'`;

    const selectCols = [idCol, titleCol, authorCol, isbnCol, percentCol, lastReadCol, deletedCol]
      .filter(Boolean).map((c) => `"${c}"`);
    const rows = db.prepare(`SELECT ${selectCols.join(', ')} FROM content ${where}`).all();
    if (!rows.length) {
      throw new Error('No books found in the content table (0 rows after filtering).');
    }

    const books = [];
    for (const r of rows) {
      const title = (r[titleCol] || '').trim();
      if (!title) continue;
      const deleted = deletedCol ? (r[deletedCol] == null ? 0 : Number(r[deletedCol])) : 0;
      const percent = percentCol ? toPercent(r[percentCol]) : 0;
      const lastReadRaw = lastReadCol ? r[lastReadCol] : null;
      books.push({
        content_id: String(r[idCol] ?? ''),
        title,
        author: (r[authorCol] || '').trim() || null,
        isbn: (r[isbnCol] || '').trim() || null,
        percent,
        last_read: isoDate(lastReadRaw),
        removed_from_device: deleted === 1,
        // Read > progress: ~complete counts as finished, anything started is
        // in-progress, untouched books are catalog-only.
        suggested_status: percent >= 97 ? 'finished' : percent >= 1 ? 'reading' : 'book',
      });
    }
    return { books, detected_columns: { titleCol, authorCol, isbnCol, percentCol, lastReadCol } };
  } finally {
    db.close();
  }
}
