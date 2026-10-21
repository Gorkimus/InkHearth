// Audible covers, via the same recipe Audiobookshelf uses: the keyless
// catalog search at api.audible.com hands back ASINs, and audnexus — a free
// community API — turns each ASIN into the edition's Amazon-CDN image plus a
// real title. Reached only from the book panel's manual cover picker, so the
// 1 + N request burst is bounded by a click, never by automation.
import { fetchJson } from './fetch.js';

export async function searchAudibleCovers(title, author, { limit = 6 } = {}) {
  if (!title) return [];
  const params = new URLSearchParams({ title, num_results: '10', products_sort_by: 'Relevance' });
  if (author) params.set('author', author);
  const data = await fetchJson(`https://api.audible.com/1.0/catalog/products?${params}`, { timeout: 10000 });
  const asins = (data.products || []).map((p) => p.asin).filter(Boolean).slice(0, limit);
  const settled = await Promise.allSettled(asins.map((asin) =>
    fetchJson(`https://api.audnex.us/books/${encodeURIComponent(asin)}`, { timeout: 10000 })));
  return settled
    .filter((p) => p.status === 'fulfilled' && p.value?.image)
    .map((p) => ({
      url: String(p.value.image).replace(/^http:\/\//, 'https://'),
      title: p.value.title || '',
      narrators: (p.value.narrators || []).map((n) => n.name).filter(Boolean).slice(0, 2).join(', '),
    }));
}
