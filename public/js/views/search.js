// Universal search — one box over the world's catalogs AND the household's
// shelves. The skeleton is Log a book's (field chips, debounced box, result
// grid) minus the logging machinery: clicking a result opens the book modal
// you'd get from a shelf — your own copy, a member's preview with notes and
// chatter, or the catalog details when nobody here has it yet. Ticking
// "in the hearth" scopes the same page to the household's shelves
// (/members/search) with the chips rendered as first-class cards.
import { api } from '../api.js';
import { $, esc, tierBadge, toast, debounce } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { openModal, closeModal, bookModal } from '../book-modal.js';
import { openMemberBookModal } from './members.js';
import { renderInfoBody } from '../book-info.js';

// In-flight search controller — aborted when a newer query supersedes it or
// the view is left, so typing doesn't stack doomed prefix searches upstream
// (each one costs real Hardcover/Google/OL quota server-side).
let searchCtl = null;

const FIELD_PLACEHOLDER = {
  hearth: {
    all: 'Search the hearth — a title, an author, a series…',
    title: 'Search the hearth by title…',
    author: 'Search the hearth by author…',
    series: 'Search the hearth by series…',
  },
  catalog: {
    all: 'Search — your shelves first, then everywhere…',
    title: 'Search by title — your shelves first, then everywhere…',
    author: 'Search an author — your shelves first, then their catalog…',
    series: 'Search a series — your shelves in order, then the full roster…',
  },
};
const FIELD_CHIPS = [
  ['all', 'All'],
  ['title', 'Title'],
  ['author', 'Author'],
  ['series', 'Series'],
];

const fmtIcon = (f) => (f === 'listened' ? '🎧' : f === 'read' ? '📖' : '');
const statusNote = (s) => (s === 'reading' ? ' · reading now' : s === 'dnf' ? ' · DNF' : '');

// An owner chip — same shape as the shelf-search chips (avatar, name, tier,
// format, year), but bound straight to the in-memory owner object so the
// click opens THAT member's copy without a dataset round-trip.
const ownerChip = (o, idx) => `
  <button type="button" class="chip search-owner" data-owner="${idx}"
    title="Open ${esc(o.name)}'s copy — notes & chatter"
    style="display:inline-flex;align-items:center;gap:5px;color:var(--text);padding:2px 8px 2px 2px;cursor:pointer">
    ${o.has_avatar
      ? `<img class="avatar" src="/api/avatar/${o.member_id}" alt="" style="width:16px;height:16px">`
      : '<span class="avatar blank" style="width:16px;height:16px"></span>'}
    <strong style="font-weight:600">${esc(o.name)}</strong>${o.is_self ? '<span class="muted small">(you)</span>' : ''}
    ${o.rating ? tierBadge(o.rating) : '<span class="muted small">unrated</span>'}
    <span class="muted small">${fmtIcon(o.format)}${(o.finished || '').slice(0, 4)}${statusNote(o.status)}</span>
  </button>`;

// One result card for both modes: cover, title, author meta, then either the
// household's owner chips or the quiet "nobody here yet" note (catalog mode).
function resultCard(r, hearth, i) {
  return `<div class="result-card search-card" data-i="${i}">
    ${r.cover_url ? `<img src="${esc(r.cover_url)}" loading="lazy">` : '<div class="cover-m blank" style="margin:0 auto"></div>'}
    <div class="rt">${esc(r.title)}</div>
    <div class="ra">${esc(r.author || '')}${r.series_name
      ? ` · ${esc(r.series_name)}${r.series_order != null ? ' #' + esc(r.series_order) : ''}`
      : r.series_order != null ? ` · Book ${esc(r.series_order)}`
      : r.published_year ? ' · ' + r.published_year : ''}</div>
    ${hearth
      ? `<div class="search-owners">${hearth.owners.map((o, oi) => ownerChip(o, oi)).join('')}</div>`
      : '<div class="muted small" style="margin-top:6px">not in the hearth yet</div>'}
  </div>`;
}

// The catalog modal for a result nobody here owns: same chrome as the other
// book modals, description when the result is Hardcover-sourced, and the
// quick paths — straight onto your shelf or TBR, or over to Log a book for
// a full entry (query pre-filled).
function openCatalogModal(r, onAdded) {
  openModal(`
    <div class="modal-head">
      ${r.cover_url ? `<img class="cover-m" src="${esc(r.cover_url)}">` : '<div class="cover-m blank"></div>'}
      <div>
        <h2>${esc(r.title)}</h2>
        <div class="muted">${r.author ? `<a class="text-link" href="#search/author/${encodeURIComponent(r.author)}">${esc(r.author)}</a>` : 'Unknown author'}</div>
        ${r.series_name ? `<div class="muted small"><a class="text-link" href="#search/series/${encodeURIComponent(r.series_name)}">${esc(r.series_name)}</a>${r.series_order != null ? ' #' + r.series_order : ''}</div>` : ''}
        <div class="muted small">Not on any shelf here yet.</div>
      </div>
    </div>
    <div id="catalog-info"><div class="muted small">Loading details…</div></div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn ghost" id="catalog-lib" style="padding:4px 12px;font-size:13px">＋ Add to library</button>
      <button class="btn ghost" id="catalog-tbr" style="padding:4px 12px;font-size:13px">📌 Add to TBR</button>
      <button class="btn ghost" id="catalog-start" style="padding:4px 12px;font-size:13px">▶ Start Reading</button>
      <a class="text-link" href="#add/title/${encodeURIComponent(r.title)}" id="catalog-log">Log it yourself →</a>
    </div>`);
  const hcId = r.provider === 'hardcover' && /^\d+$/.test(String(r.source_id || '')) ? r.source_id : null;
  const info = hcId ? api('/books/hardcover-info/' + hcId).catch(() => null) : Promise.resolve(null);
  info.then((data) => renderInfoBody($('#catalog-info'), { title: r.title, author: r.author || null, ...(data || {}) }));
  // The same draft Log a book's batch add posts: the catalog result's own
  // fields, anchored to its provider so a later re-pull can enrich it.
  const draft = {
    title: r.title, author: r.author || null, page_count: r.page_count || null,
    published_year: r.published_year || null, cover_url: r.cover_url || null,
    genres: r.genres || [], moods: r.moods || [], series_name: r.series_name || null,
    series_order: r.series_order ?? null, source_provider: r.provider || 'manual', source_id: r.source_id || null,
  };
  const add = async (btn, mode) => {
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const { book, existed } = await api('/books', { method: 'POST', body: draft });
      if (mode === 'tbr') {
        const res = await api('/tbr', { method: 'POST', body: { book_id: book.id } });
        toast(res.existed ? `"${r.title}" is already queued on your TBR` : `"${r.title}" added to your TBR`);
      } else if (mode === 'start') {
        // Shelf + open reading event in one tap — quick-status is a no-op if
        // a reading event is somehow already open, so this can't double-log.
        await api(`/books/${book.id}/quick-status`, { method: 'POST', body: { status: 'reading' } });
        toast(existed ? `"${r.title}" was already on your shelf — you're reading it now`
          : `"${r.title}" added to your shelf — you're reading it now`);
      } else {
        toast(existed ? `"${r.title}" is already in your library` : `"${r.title}" added to your library`);
      }
      closeModal();
      onAdded?.(); // re-run the search — the card should now carry your chip
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = mode === 'tbr' ? '📌 Add to TBR'
        : mode === 'start' ? '▶ Start Reading' : '＋ Add to library';
    }
  };
  $('#catalog-lib').addEventListener('click', (e) => add(e.currentTarget, 'lib'));
  $('#catalog-tbr').addEventListener('click', (e) => add(e.currentTarget, 'tbr'));
  $('#catalog-start').addEventListener('click', (e) => add(e.currentTarget, 'start'));
}

async function searchView(prefill = null) {
  searchCtl?.abort();
  searchCtl = null;
  let field = prefill?.field || 'all';
  // Deep links (a clicked author/series/title anywhere in the app) search
  // exact — the fuzzy match is for typing, not for following a link.
  const searchExact = Boolean(prefill?.exact);
  // The tick persists per device — on stays on until turned off (the
  // Log a book toggles' convention).
  let hearthMode = localStorage.getItem('bt-search-hearth') === '1';

  view.innerHTML = `
    <h1>Search</h1>
    <p class="muted" style="margin:0 0 10px">One box, every book — your shelves lead, the catalogs fill the rest.
    Clicking a result opens the book's panel; tick <b>in the hearth</b> to search only shelves here.</p>
    <div class="pill-row" id="search-field-chips" style="margin:0 0 8px" role="group" aria-label="Search field">
      ${FIELD_CHIPS.map(([f, label]) => `<span class="pill link${f === field ? ' sel' : ''}" data-field="${f}">${label}</span>`).join('')}
    </div>
    <div class="search-row">
      <input id="search-q" placeholder="${esc(FIELD_PLACEHOLDER[hearthMode ? 'hearth' : 'catalog'][field])}" autocomplete="off" aria-label="Search">
      <label class="muted small" title="Search only the household's shelves — who has what, and how they rated it"
        style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
        <input type="checkbox" id="search-hearth"${hearthMode ? ' checked' : ''}> in the hearth
      </label>
      <label class="muted small" id="search-collections-wrap" title="Also show omnibuses, anthologies, boxed sets, store samples, multi-part splits and bare stub records"
        style="display:${hearthMode ? 'none' : 'inline-flex'};align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
        <input type="checkbox" id="search-collections"> collections &amp; samples
      </label>
    </div>
    <div id="search-results" style="margin-top:16px">
      <div class="muted small">${hearthMode
        ? 'Type at least two characters — every shelf here at once.'
        : 'Type at least two characters — titles, authors, series.'}</div>
    </div>`;

  const out = $('#search-results');
  const input = $('#search-q');
  if (matchMedia('(pointer: fine)').matches) input.focus();

  // Results painting keeps both modes in one grid: `rows` is the card list,
  // `hearthBy` the per-card owners (null = nobody here has it), and
  // `firstCatalog` the index where the shelves end and the catalogs begin —
  // paint() drops the section divider there and the shelf count ahead of it.
  let rows = [];
  let hearthBy = [];
  let firstCatalog = Infinity;
  let searchedCount = null;

  const paint = () => {
    if (!rows.length) { out.innerHTML = ''; return; }
    let html = '';
    rows.forEach((r, i) => {
      if (i === firstCatalog && searchedCount != null) {
        html += firstCatalog
          ? `<div style="grid-column:1/-1" class="muted small">searched ${searchedCount} ${searchedCount === 1 ? 'shelf' : 'shelves'} here — more from the catalogs:</div>`
          : '<div style="grid-column:1/-1" class="muted small">nobody here has that yet — from the catalogs:</div>';
      }
      html += resultCard(r, hearthBy[i] || null, i);
    });
    if (firstCatalog >= rows.length && searchedCount != null) {
      html = `<div style="grid-column:1/-1" class="muted small">searched ${searchedCount} ${searchedCount === 1 ? 'shelf' : 'shelves'} here</div>` + html;
    }
    out.innerHTML = html;
  };

  // Click resolution: an owner chip opens THAT member's copy; anywhere else
  // on the card opens your own copy when you have one, else the first
  // owner's preview, else the catalog modal. Delegated once — rows repaint
  // per keystroke.
  out.addEventListener('click', (e) => {
    const chipBtn = e.target.closest('[data-owner]');
    const card = e.target.closest('.result-card');
    if (!card) return;
    const i = +card.dataset.i;
    const h = hearthBy[i];
    if (chipBtn) {
      const o = h?.owners[+chipBtn.dataset.owner];
      if (o) return openOwner(o, rows[i]);
    }
    if (h) {
      const own = h.owners.find((x) => x.is_self) || h.owners[0];
      return openOwner(own, rows[i]);
    }
    openCatalogModal(rows[i], run);
  });

  const openOwner = (o, r) => {
    if (o.is_self) return bookModal(o.book_id);
    openMemberBookModal({ id: o.member_id, name: o.name }, {
      book_id: o.book_id, title: r.title, author: r.author || null,
      series_name: r.series_name || null, cover_url: r.cover_url || null,
      rating: o.rating || null, format: o.format || null, last_finished: o.finished || null,
    });
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    searchCtl?.abort();
    if (q.length < 2) {
      searchCtl = null;
      rows = []; hearthBy = [];
      out.innerHTML = `<div class="muted small">${hearthMode
        ? 'Type at least two characters — every shelf here at once.'
        : 'Type at least two characters — titles, authors, series.'}</div>`;
      return;
    }
    searchCtl = new AbortController();
    const { signal } = searchCtl;
    out.innerHTML = '<div class="muted small">Searching…</div>';
    try {
      if (hearthMode) {
        const data = await api('/members/search?q=' + encodeURIComponent(q)
          + (field === 'all' ? '' : `&field=${field}`), { signal });
        if (signal.aborted) return;
        rows = data.results;
        hearthBy = data.results.map((g) => ({ owners: g.owners }));
        firstCatalog = Infinity;
        searchedCount = data.searched;
        if (!rows.length) {
          out.innerHTML = `<div class="muted small">Nobody here has that yet —
            <a class="text-link" href="#add/title/${encodeURIComponent(q)}">log it yourself →</a></div>`;
          return;
        }
        paint();
        return;
      }
      // Unified: the household's own works lead (they're the copies under our
      // control, hand-corrected, complete with positions), the catalogs fill
      // in everything nobody here owns — provider-ranked, deduped against the
      // shelves server-side. One round trip; the provider half failing still
      // leaves the shelves' answer on the page.
      const collections = $('#search-collections')?.checked ? '&collections=1' : '';
      const data = await api('/search/unified?q=' + encodeURIComponent(q)
        + (field === 'all' ? '' : `&field=${field}`)
        + (searchExact && field !== 'all' ? '&exact=1' : '') + collections, { signal });
      if (signal.aborted) return;
      rows = [...data.shelves, ...data.catalogs];
      hearthBy = [...data.shelves.map((g) => ({ owners: g.owners })), ...data.catalogs.map(() => null)];
      firstCatalog = data.shelves.length;
      searchedCount = data.searched;
      if (!rows.length) {
        out.innerHTML = '<div class="muted small">Nothing found — try fewer words, or a different spelling.</div>';
        return;
      }
      paint();
    } catch (err) {
      if (signal.aborted || err.name === 'AbortError') return;
      rows = []; hearthBy = [];
      out.innerHTML = `<div class="muted small">Search failed: ${esc(err.message)}</div>`;
    }
  }, 300);

  input.addEventListener('input', run);
  $('#search-field-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-field]');
    if (!chip || chip.classList.contains('sel')) return;
    field = chip.dataset.field;
    $('#search-field-chips').querySelectorAll('.pill').forEach((c) => c.classList.toggle('sel', c === chip));
    input.placeholder = FIELD_PLACEHOLDER[hearthMode ? 'hearth' : 'catalog'][field];
    run();
  });
  $('#search-hearth').addEventListener('change', (e) => {
    hearthMode = e.target.checked;
    localStorage.setItem('bt-search-hearth', hearthMode ? '1' : '0');
    input.placeholder = FIELD_PLACEHOLDER[hearthMode ? 'hearth' : 'catalog'][field];
    // The collections tick only speaks to the catalog — hide it in hearth mode.
    $('#search-collections-wrap').style.display = hearthMode ? 'none' : 'inline-flex';
    run();
  });
  // Persisted per device like the hearth tick (and Log a book's own toggles).
  $('#search-collections').checked = localStorage.getItem('bt-search-collections') === '1';
  $('#search-collections').addEventListener('change', (e) => {
    localStorage.setItem('bt-search-collections', e.target.checked ? '1' : '0');
    run();
  });

  // Deep link (#search/author/…): query pre-filled, search fires immediately.
  if (prefill?.q) {
    input.value = prefill.q;
    run();
  }
}

registerRoute('#search', searchView);

// Deep links from clickable author/series/title text anywhere in the app
// (modal headers, shelf rows, series cards): #search/<field>/<encoded q>.
registerRoute('#search/', () => {
  const [, field, enc = ''] = location.hash.split('/');
  const q = enc ? decodeURIComponent(enc) : '';
  return ['title', 'author', 'series'].includes(field) && q
    ? searchView({ field, q, exact: true })
    : searchView();
});
