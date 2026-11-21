// RFC4180-ish CSV reader shared by the file importers (Goodreads, Libby).
// Handles the shapes those exports actually use: a UTF-8 BOM, quoted fields
// with doubled-quote escapes, and CRLF or LF row endings. Rows made only of
// empty fields are dropped — trailing blank lines.
export function parseCsv(text) {
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
