// Google Books: used as the fallback pair with Open Library behind Hardcover.
// Anonymous quota is routinely 429 on shared IPs — set GOOGLE_BOOKS_API_KEY
// (free tier) in .env to restore it as a dependable fallback. A second key
// (GOOGLE_BOOKS_API_KEY_2) takes over when the first burns its daily quota.
import { fetchJson } from './fetch.js';
import { config } from '../config.js';
import { mapGenres } from '../genres-vocab.js';

// A key that just earned its 429 (daily quota, resets midnight Pacific) goes
// to the back of the line for the rest of the process — no point paying a
// known-dead key first on every call.
let bannedKey = '';

// Every Google Books call goes through here: primary key first, fallback key
// on a 429, keyless only when no key is configured.
export async function fetchVolumes(query, opts = {}) {
  const keys = [config.googleBooksKey, config.googleBooksKey2].filter(Boolean);
  keys.sort((a, b) => (a === bannedKey) - (b === bannedKey));
  if (!keys.length) keys.push('');
  let lastErr;
  for (const key of keys) {
    try {
      const base = `https://www.googleapis.com/books/v1/volumes?${query}`;
      return await fetchJson(key ? `${base}&key=${encodeURIComponent(key)}` : base, opts);
    } catch (err) {
      lastErr = err;
      if (!/^HTTP 429/.test(String(err?.message))) throw err;
      bannedKey = key;
    }
  }
  throw lastErr;
}

// opts.author targets the author index (inauthor:) instead of full-text, so
// browsing "sanderson" isn't diluted by title hits.
export async function searchGoogleBooks(q, opts = {}) {
  const term = opts.author ? `inauthor:${q}` : q;
  const data = await fetchVolumes(`q=${encodeURIComponent(term)}&maxResults=20&printType=books`, { timeout: 4000 });

  return (data.items || [])
    .map((it) => {
      const v = it.volumeInfo || {};
      // Breadcrumbs like "Fiction / Science Fiction / Space Opera" split into
      // leaves; generic roots (Fiction, General, Juvenile) drop here and the
      // canonical vocabulary decides which leaves survive at all.
      const genres = mapGenres(
        [...new Set(
          (v.categories || [])
            .flatMap((c) => c.split('/'))
            .map((s) => s.trim())
            .filter((c) => c && !/^(fiction|general|juvenile)/i.test(c))
        )],
        4
      );
      const thumb = v.imageLinks?.thumbnail?.replace('http://', 'https://') || null;
      return {
        provider: 'google',
        source_id: it.id,
        title: v.title || '',
        author: (v.authors || [])[0] || null,
        page_count: v.pageCount || null,
        published_year: parseInt((v.publishedDate || '').slice(0, 4)) || null,
        genres,
        cover_url: thumb,
      };
    })
    .filter((b) => b.title);
}
