// Cross-member work identity: which of everyone's book rows are "the same
// book". The social surfaces (compare, reading-together) match per lookup;
// a persisted thread (chatter comments) needs the reverse — one canonical key
// a row is written under, and the full alias set a read expands to, so a
// comment left on a Hardcover-linked copy shows up on a title-matched copy
// that has no hardcover_id (and vice versa).
import { db } from './db.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, '');
// Title variants for the name-based fallback: "Mistborn: The Final Empire"
// (store wording) vs "The Final Empire" only pair if a series-prefixed /
// subtitle form also tries the part after the last colon. Parentheticals
// ("(Unabridged)") are already stripped by norm().
export const titleKeys = (title, author) => {
  const raw = String(title || '');
  const keys = [norm(raw)];
  const seg = raw.split(':').pop().trim();
  if (seg && norm(seg) !== keys[0]) keys.push(norm(seg));
  return keys.map((k) => 't:' + k + '|' + norm(author));
};

// The key a work's rows are written under: Hardcover id wins (stable across
// retitles), otherwise the full-title key.
export function workKeyForBook(book) {
  if (book.hardcover_id) return 'hc:' + book.hardcover_id;
  return titleKeys(book.title, book.author)[0];
}

// alias graph of every book in the household, cached briefly — book edits
// (a re-pull filling hardcover_id) are the only thing that changes it, and a
// minute of lag there just splits a thread until the next call.
let aliasCache = null; // { at, byAlias: Map<key, Set<bookId>> }

// Book INSERTs (add-copy paths, club-pick joins) change the graph; deletes
// are caught by the stale-id rebuild inside resolveWork. Callers drop the
// cache so a copy created seconds ago is visible to its own response —
// otherwise the join that just created your copy can't find it to link it.
export function invalidateWorkGraph() {
  aliasCache = null;
}
function aliasGraph() {
  if (aliasCache && Date.now() - aliasCache.at < 60_000) return aliasCache.byAlias;
  const byAlias = new Map();
  for (const b of db.prepare('SELECT id, hardcover_id, title, author FROM books').all()) {
    const keys = titleKeys(b.title, b.author);
    if (b.hardcover_id) keys.push('hc:' + b.hardcover_id);
    for (const k of keys) {
      if (!byAlias.has(k)) byAlias.set(k, new Set());
      byAlias.get(k).add(b.id);
    }
  }
  aliasCache = { at: Date.now(), byAlias };
  return byAlias;
}

// Everything that is provably the same work as `key`: the union of the alias
// components of every book carrying that key. Returns the canonical key to
// write under plus every key/thread alias and concrete book row id.
export function resolveWork(key) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const byAlias = aliasGraph();
    const direct = byAlias.get(key);
    if (!direct) {
      // A miss may just mean the graph predates a book created seconds ago
      // (add a book, comment immediately): rebuild once and look again.
      aliasCache = null;
      continue;
    }
    const bookIds = new Set();
    const queue = [...direct];
    const seenKeys = new Set([key]);
    let stale = false;
    while (queue.length) {
      const bookId = queue.pop();
      if (bookIds.has(bookId)) continue;
      const b = db.prepare('SELECT id, hardcover_id, title, author FROM books WHERE id=?').get(bookId);
      if (!b) { stale = true; break; } // graph predates a deletion — rebuild
      bookIds.add(bookId);
      const keys = titleKeys(b.title, b.author);
      if (b.hardcover_id) keys.push('hc:' + b.hardcover_id);
      for (const k of keys) {
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        for (const id of byAlias.get(k) || []) queue.push(id);
      }
    }
    if (stale) { aliasCache = null; continue; }
    let canonical = key;
    if (!key.startsWith('hc:')) {
      // Prefer a hardcover key if any copy in the component carries one — a
      // re-pull can add it after comments were first written under t: keys.
      for (const k of seenKeys) if (k.startsWith('hc:')) { canonical = k; break; }
    }
    return { canonical, keys: [...seenKeys], bookIds: [...bookIds] };
  }
  // Unreachable in practice (the second pass always runs on a fresh graph);
  // a genuinely unknown key lands here with an honest empty answer.
  return { canonical: key, keys: [key], bookIds: [] };
}
