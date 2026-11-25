// Pure epub → text → chunks. No DB imports here on purpose: this module is
// the only part of the scanner that runs anywhere but the server, so it must
// stay testable without opening the database.
import { unzipSync, strFromU8 } from 'fflate';

const CHUNK_WORDS = 220;   // tasting-sized: a voice needs a moment, not a chapter
const MIN_CHUNK_WORDS = 90; // slivers and fragments aren't specimens
const JUNK = /copyright|all rights reserved|isbn|table of contents|by the same author|translated by/i;

const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

// An epub is a zip: META-INF/container.xml points at the OPF package file,
// whose manifest maps ids → hrefs and whose spine gives the reading order.
// Walk the spine, keep the xhtml documents, strip the markup.
export function epubToText(buf) {
  let zip;
  try {
    zip = unzipSync(buf);
  } catch {
    throw new Error('that file is not a readable epub (zip container damaged)');
  }
  const container = strFromU8(zip['META-INF/container.xml'] || '');
  const opfPath = (container.match(/full-path="([^"]+)"/) || [])[1];
  if (!opfPath) throw new Error('not an epub we can read (no OPF in container.xml)');
  const opf = strFromU8(zip[opfPath]);
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  // Attribute order isn't guaranteed — match both ways into one map.
  const hrefs = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const tag = m[0];
    const id = (tag.match(/id="([^"]+)"/) || [])[1];
    const href = (tag.match(/href="([^"]+)"/) || [])[1];
    if (id && href) hrefs.set(id, href);
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1]);
  if (!spine.length) throw new Error('epub spine is empty');
  const chapters = [];
  for (const id of spine) {
    const href = hrefs.get(id);
    if (!href || !/\.x?html?$/i.test(href)) continue;
    const file = zip[baseDir + decodeURIComponent(href)];
    if (!file) continue;
    const raw = strFromU8(file);
    const text = raw
      .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ')
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    const clean = decodeEntities(text)
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n\n+ */g, '\n\n')
      .trim();
    if (clean) chapters.push(clean);
  }
  if (!chapters.length) throw new Error('no readable text in the epub spine');
  return chapters.join('\n\n');
}

// Paragraph-accumulator chunking: whole paragraphs stack until a chunk
// reaches ~CHUNK_WORDS, so chunks break on scene-paragraph edges rather than
// mid-sentence. Front-matter junk and slivers never become candidates.
export function chunkText(text) {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = [];
  let words = 0;
  const flush = () => {
    if (!cur.length) return;
    const passage = cur.join('\n\n');
    if (wordCount(passage) >= MIN_CHUNK_WORDS && !JUNK.test(passage.slice(0, 300))) {
      chunks.push(passage);
    }
    cur = [];
    words = 0;
  };
  for (const p of paras) {
    const w = wordCount(p);
    if (w > CHUNK_WORDS * 1.6) {
      // One wall-of-text paragraph: split it on sentence ends instead.
      flush();
      let piece = [];
      let pieceWords = 0;
      for (const sentence of p.split(/(?<=[.!?…")])\s+/)) {
        piece.push(sentence);
        pieceWords += wordCount(sentence);
        if (pieceWords >= CHUNK_WORDS) {
          chunks.push(piece.join(' '));
          piece = [];
          pieceWords = 0;
        }
      }
      if (wordCount(piece.join(' ')) >= MIN_CHUNK_WORDS) chunks.push(piece.join(' '));
      continue;
    }
    cur.push(p);
    words += w;
    if (words >= CHUNK_WORDS) flush();
  }
  flush();
  return chunks;
}

export function epubChunks(buf) {
  return chunkText(epubToText(buf));
}
