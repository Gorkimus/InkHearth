// Minimal xlsx reader for Audible library exports (Libation exports xlsx
// alongside CSV/JSON). An xlsx is a zip of XML; fflate already ships for the
// epub scanner, so this adds zero dependencies. Scope is deliberately narrow:
// first worksheet, shared/inline/plain strings, booleans, numbers, and Excel
// serial dates converted at cell level (date-ness is inferred from the serial
// range — realistic library dates 1950–2064 — because full numFmt style
// resolution isn't worth the chase for export files).
import { unzipSync, strFromU8 } from 'fflate';

// Column letter (A, B, AA…) → 0-based index.
const colIndex = (ref) => {
  const n = ref.replace(/\d+$/, '');
  let x = 0;
  for (const ch of n) x = x * 26 + (ch.charCodeAt(0) - 64);
  return x - 1;
};

// Excel serial (days since 1899-12-30, accounting for the 1900 leap bug) →
// YYYY-MM-DD; the same shape toDate() expects downstream.
const serialToDate = (serial) => {
  const ms = Math.round((Number(serial) - 25569) * 86400000);
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};

const decode = (s) => s
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&');

// Rich-text shared strings: <si><r><t>a</t></r><r><t>b</t></r></si> → "ab".
// Element matchers are prefix-tolerant — Libation writes namespaced XML
// (<x:worksheet>, <x:row>, <x:si>), Excel writes bare tags.
const rowRe = /<(?:\w+:)?row[ >][\s\S]*?<\/(?:\w+:)?row>/g;
const cellRe = /<(?:\w+:)?c[ >][\s\S]*?<\/(?:\w+:)?c>|<(?:\w+:)?c[^>]*\/>/g;
const siRe = /<(?:\w+:)?si>[\s\S]*?<\/(?:\w+:)?si>/g;
const tRe = /<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
const readSharedStrings = (xml) => {
  const out = [];
  for (const si of xml.match(siRe) || []) {
    out.push((si.match(tRe) || []).map((t) => decode(t.replace(/<[^>]+>/g, ''))).join(''));
  }
  return out;
};

export function xlsxToTable(buf) {
  let zip;
  try {
    zip = unzipSync(new Uint8Array(buf));
  } catch {
    throw new Error('that file is not a readable xlsx');
  }
  const shared = zip['xl/sharedStrings.xml']
    ? readSharedStrings(strFromU8(zip['xl/sharedStrings.xml'])) : [];

  // First worksheet: sheet1.xml when present (every real export), else
  // whatever sheet sorts first.
  const sheetName = Object.keys(zip)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('no worksheet found in that xlsx');
  const sheet = strFromU8(zip[sheetName]);

  const rows = [];
  for (const rowXml of sheet.match(rowRe) || []) {
    const cells = [];
    // Cells without an r="A1" ref (some writers omit them) fall back to
    // sequential placement.
    let next = 0;
    for (const c of rowXml.match(cellRe) || []) {
      const ref = (c.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
      const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const type = (c.match(/t="([a-zA-Z]+)"/) || [])[1] || 'n';
      const v = (c.match(/<(?:\w+:)?v[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
      const inline = c.match(/<(?:\w+:)?is>[\s\S]*?<\/(?:\w+:)?is>/);
      let val = '';
      if (type === 'inlineStr') val = inline ? decode(inline[0].replace(/<[^>]+>/g, '')) : '';
      else if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) {
        val = decode(v);
        // Bare numeric in the serial-date range → date. Two guardrails: only
        // plausible dates (1950–2064), never integers that could be a real
        // count (percent/runtimes stay 0–5 digits… runtime minutes can reach
        // ~3000 ≈ 1908-01 — under the 1950 floor, safe).
        const n = Number(val);
        if (Number.isFinite(n) && n >= 18264 && n <= 60000 && !/\.\d/.test(val)) {
          val = serialToDate(n) || val;
        }
      }
      cells[idx] = val;
    }
    if (cells.some((c) => c !== undefined && String(c).trim() !== '')) {
      // Sparse holes (missing cells) become '' — Array.from's mapper sees
      // them as undefined, unlike .map which preserves holes as nulls.
      rows.push(Array.from({ length: cells.length }, (_, i) => (cells[i] === undefined ? '' : String(cells[i]))));
    }
  }
  if (!rows.length) throw new Error('that xlsx has no data rows');
  return rows;
}

export const isZipFile = (buf) =>
  buf && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
