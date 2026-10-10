// "Search the shelves" — one box over the household's libraries: type a
// title, author or series and see who has it and how each of them rated it.
// Search UX mirrors Log a book: field chips, debounced queries, aborted when
// the view is left. Privacy is server-side (profile_public members, plus
// yourself); this module only renders what the API already gated.
import { api } from './api.js';
import { $, esc, tierBadge, debounce } from './ui.js';

const FIELDS = [['all', 'All'], ['title', 'Title'], ['author', 'Author'], ['series', 'Series']];
const PLACEHOLDERS = {
  all: 'Search the shelves — a title, an author, a series…',
  title: 'Search the shelves by title…',
  author: 'Search the shelves by author…',
  series: 'Search the shelves by series…',
};
const HINT = '<div class="muted small">Type at least two characters — search every shelf here at once. '
  + 'You\'ll see who has each book (or anything by that author, or in that series) and the tier they rated it.</div>';

let searchCtl = null;

const fmtIcon = (f) => (f === 'listened' ? '🎧' : f === 'read' ? '📖' : '');
const statusNote = (s) => (s === 'reading' ? ' · reading now' : s === 'dnf' ? ' · DNF' : '');

export function shelfSearchHTML() {
  return `
    <div class="pill-row" id="shelf-field" role="group" aria-label="Search field">
      ${FIELDS.map(([f, label]) => `<button type="button" class="pill link" style="background:none" data-field="${f}" aria-pressed="${f === 'all'}">${label}</button>`).join('')}
    </div>
    <input id="shelf-q" placeholder="${PLACEHOLDERS.all}" autocomplete="off" aria-label="Search the household's shelves">
    <div id="shelf-results" style="margin-top:10px">${HINT}</div>`;
}

const ownerChip = (o) => {
  const year = (o.finished || '').slice(0, 4);
  return `
  <button type="button" class="chip" data-member="${o.member_id}" title="Open ${esc(o.name)}'s shelf"
    style="display:inline-flex;align-items:center;gap:6px;color:var(--text);padding:2px 10px 2px 3px;cursor:pointer">
    ${o.has_avatar
      ? `<img class="avatar" src="/api/avatar/${o.member_id}" alt="" style="width:18px;height:18px">`
      : '<span class="avatar blank" style="width:18px;height:18px"></span>'}
    <strong>${esc(o.name)}</strong>${o.is_self ? '<span class="muted small">(you)</span>' : ''}
    ${o.rating ? tierBadge(o.rating) : '<span class="muted small">unrated</span>'}
    <span class="muted small">${fmtIcon(o.format)}${year ? ` ${year}` : ''}${statusNote(o.status)}</span>
  </button>`;
};

const resultsHTML = (data, q) => {
  if (!data.results.length) {
    return `<div class="muted small">Nobody here has that yet —
      <a class="text-link" href="#add/title/${encodeURIComponent(q)}">log it yourself →</a></div>`;
  }
  return `${data.results.map((g) => `
    <div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
      ${g.cover_url ? `<img class="cover-s" src="${esc(g.cover_url)}" loading="lazy" alt="">` : '<div class="cover-s blank"></div>'}
      <div style="flex:1;min-width:0">
        <div class="t">${esc(g.title)}</div>
        <div class="muted small">${esc(g.author || 'Unknown author')}${g.series_name ? ` · ${esc(g.series_name)}` : ''}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
          ${g.owners.map(ownerChip).join('')}
        </div>
      </div>
    </div>`).join('')}
  <div class="muted small" style="margin-top:6px">searched ${data.searched} shelf${data.searched === 1 ? '' : 's'}</div>`;
};

export function bindShelfSearch(root) {
  searchCtl?.abort(); // a fresh Members mount supersedes any in-flight query
  searchCtl = null;
  const input = $('#shelf-q', root);
  const out = $('#shelf-results', root);
  let currentField = 'all';

  const run = debounce(async () => {
    const q = input.value.trim();
    searchCtl?.abort();
    if (q.length < 2) {
      searchCtl = null;
      out.innerHTML = HINT;
      return;
    }
    searchCtl = new AbortController();
    const { signal } = searchCtl;
    try {
      const params = new URLSearchParams({ q, field: currentField });
      const data = await api('/members/search?' + params, { signal });
      if (signal.aborted) return;
      out.innerHTML = resultsHTML(data, q);
    } catch (err) {
      if (signal.aborted || err.name === 'AbortError') return;
      out.innerHTML = `<div class="muted small">Search failed: ${esc(err.message)}</div>`;
    }
  }, 300);

  input.addEventListener('input', run);
  root.querySelectorAll('#shelf-field [data-field]').forEach((chip) =>
    chip.addEventListener('click', () => {
      currentField = chip.dataset.field;
      root.querySelectorAll('#shelf-field [data-field]').forEach((c) => {
        const on = c === chip;
        c.classList.toggle('sel', on);
        c.setAttribute('aria-pressed', String(on));
      });
      input.placeholder = PLACEHOLDERS[currentField];
      run();
    }));
  // Owner chips open that member's profile — delegated on the results region
  // (the rows are re-rendered per keystroke, like the add page's grid).
  out.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-member]');
    if (chip) location.hash = '#members/' + chip.dataset.member;
  });
}
