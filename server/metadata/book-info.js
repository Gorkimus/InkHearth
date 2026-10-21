import { hardcoverBookById } from './hardcover.js';
import { genresFrom, moodsFrom } from './hardcover-import.js';

// Shared "book details" payload for lazy info panels (recommendation cards,
// member profiles): Hardcover description + catalog details, cached 24h
// in-process. One paced HC call per id no matter how many panels ask.
const infoCache = new Map(); // hardcover_id → { at, data }
const INFO_TTL = 24 * 60 * 60 * 1000;

export async function bookInfo(hardcoverId) {
  const id = Number(hardcoverId);
  if (!Number.isInteger(id)) return null;
  const cached = infoCache.get(id);
  if (cached && Date.now() - cached.at < INFO_TTL) return cached.data;
  const b = await hardcoverBookById(id);
  let data = null;
  if (b) {
    const series = b.book_series?.filter((bs) => bs?.series?.name) || [];
    data = {
      description: b.description || null,
      // The site routes /books/{slug} — numeric ids 404 there.
      slug: b.slug || null,
      genres: genresFrom(b),
      moods: moodsFrom(b),
      page_count: b.pages || null,
      audio_runtime_minutes: b.audio_seconds ? Math.round(b.audio_seconds / 60) : null,
      published_year: b.release_year || null,
      series_name: series[0]?.series.name || null,
      series_order: series[0]?.position ?? null,
    };
  }
  infoCache.set(id, { at: Date.now(), data });
  return data;
}
