import { esc } from './ui.js';

// Shared "more info" panel body — description, meta line, genre/mood pills,
// and external links — fed by any /info payload (recommendation cards,
// member-profile previews). Links are built from title+author so they work
// even without a Hardcover match.
export function renderInfoBody(el, info) {
  if (!info) {
    el.innerHTML = '<p class="muted small">Description unavailable right now.</p>';
    return;
  }
  const q = encodeURIComponent([info.title, info.author].filter(Boolean).join(' '));
  const links = [];
  if (info.slug) links.push(['Hardcover', `https://hardcover.app/books/${info.slug}`]);
  else if (info.hardcover_id) links.push(['Hardcover', `https://hardcover.app/search?q=${q}`]);
  links.push(['Google Books', `https://www.google.com/search?tbm=bks&q=${q}`]);
  links.push(['Goodreads', `https://www.goodreads.com/search?q=${q}`]);
  links.push(['Open Library', `https://openlibrary.org/search?q=${q}`]);
  const metaBits = [
    info.page_count ? `${info.page_count} pages` : '',
    info.audio_runtime_minutes ? `${Math.round((info.audio_runtime_minutes / 60) * 10) / 10}h audio` : '',
    info.published_year || '',
    info.series_name ? `${info.series_name}${info.series_order ? ` #${info.series_order}` : ''}` : '',
  ].filter(Boolean);
  const pills = [...(info.genres || []), ...(info.moods || [])];
  el.innerHTML = `
    ${info.description ? `<p style="margin:6px 0">${esc(info.description)}</p>`
      : info.hardcover_id ? '' : '<p class="muted small">No Hardcover match — no description, but the links below still help.</p>'}
    ${metaBits.length ? `<div class="muted small">${esc(metaBits.join(' · '))}</div>` : ''}
    ${pills.length ? `<div style="margin-top:6px">${pills.map((p) => `<span class="pill">${esc(p)}</span>`).join(' ')}</div>` : ''}
    <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap">
      ${links.map(([label, href]) => `<a href="${href}" target="_blank" rel="noopener">${label} ↗</a>`).join('')}
    </div>`;
}
