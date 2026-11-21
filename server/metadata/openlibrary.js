// Open Library: keyless fallback/sharing provider for autofill. Google Books
// anonymous quota is routinely exhausted on shared IPs, so this keeps search alive.
import { fetchJson } from './fetch.js';

const FIELDS = 'title,author_name,first_publish_year,number_of_pages_median,cover_i';

// opts.author targets OL's author field instead of full-text q.
export async function searchOpenLibrary(q, opts = {}) {
  const url = `https://openlibrary.org/search.json?${opts.author ? 'author' : 'q'}=${encodeURIComponent(q)}&limit=20&fields=${FIELDS}`;
  // OL is slow but reliable (often 3-6s) — the workhorse on this network, so
  // it gets the long leash. Google answers or fails fast either way.
  const data = await fetchJson(url, { headers: { 'User-Agent': 'BookTracker/0.1 (personal)' }, timeout: 10000 });

  return (data.docs || [])
    .map((d) => ({
      provider: 'openlibrary',
      source_id: d.cover_i ? `ol-cover-${d.cover_i}` : null,
      title: d.title || '',
      author: (d.author_name || [])[0] || null,
      page_count: d.number_of_pages_median || null,
      published_year: d.first_publish_year || null,
      // Open Library subjects are noisy user tags; keep the short plausible-genre ones.
      genres: [...new Set(
        (d.subject || [])
          .filter((s) => s.length < 28 && !s.includes('('))
      )].slice(0, 4),
      cover_url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null,
    }))
    .filter((b) => b.title);
}
