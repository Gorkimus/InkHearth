import { api } from '../api.js';
import { $, esc, toast, fmtWords, debounce, eventFormHTML, bindEventForm, collectEventForm, estWordsClient } from '../ui.js';
import { renderInfoBody } from '../book-info.js';
import { view, registerRoute } from '../router.js';
import { scanBarcode } from '../scanner.js';

// In-flight search controller — aborted when a newer query supersedes it or
// the view is left, so typing doesn't stack doomed prefix searches upstream
// (each one costs real Hardcover/Google/OL quota server-side).
let searchCtl = null;

const FIELD_PLACEHOLDER = {
  all: 'Search a title — metadata fills itself in…',
  title: 'Search by title — metadata fills itself in…',
  author: 'Search an author — their books fill in, most-read first…',
  series: 'Search a series — its books fill in, in order…',
};
const FIELD_CHIPS = [
  ['all', 'All'],
  ['title', 'Title'],
  ['author', 'Author'],
  ['series', 'Series'],
];

async function addView(prefill = null) {
  searchCtl?.abort();
  searchCtl = null;
  let selectMode = false;
  let results = [];
  let searchField = prefill?.field || 'all';
  // Deep links (clicked author/series text) search exact — the fuzzy match is
  // for typing, not for following a link.
  const searchExact = Boolean(prefill?.exact);
  const picked = new Set();

  view.innerHTML = `
    <h1>Log a book</h1>
    <p class="muted" style="margin:0 0 4px"><b>Search is the fast path</b> — it finds real editions and
    auto-fills cover, author, series and pages. Use <b>Enter manually</b> only for books the search
    can't find.</p>
    <details class="muted small add-help" style="margin:0 0 12px">
      <summary style="cursor:pointer">How the search, Select and manual entry differ</summary>
      <ul style="margin:10px 0 4px 18px;padding:0;display:grid;gap:7px">
        <li><b>Search, then click a result</b> — opens the confirm panel: pick format (read/listened),
        status and tier, then save. The book stays matched to Hardcover, so a re-pull later keeps
        series, moods and lengths fresh. <b>More info</b> in the panel expands the description and
        Hardcover/Goodreads links — handy for vetting a potential new read.</li>
        <li><b>Title / Author / Series chips</b> — aim the search. <b>Author</b> browses an author's
        whole catalog (most-read first); <b>Series</b> pulls in every book of a series in reading
        order, ready for batch Select. On <b>All</b>, a thin result that's actually a series name
        quietly adds the series' books too.</li>
        <li><b>Select</b> — batch mode: tap the button, click several covers to highlight them, then
        "Add to library" brings them all in at once (catalog only — rate them later on the Tier board).</li>
        <li><b>collections &amp; samples</b> — hides box sets, anthologies and store samples by default;
        flip it on when you actually want one of those.</li>
        <li><b>📷 Scan</b> — point your camera at an ISBN barcode and the confirm panel opens with the
        book already filled in.</li>
        <li><b>Enter manually</b> — title plus whatever you know, no search. Last resort; a
        "↻ Re-pull data" on the book later can still fetch Hardcover data if it knows the book.</li>
      </ul>
    </details>
    <div class="add-wrap">
      <div class="pill-row" id="field-chips" style="margin:0 0 8px" role="group" aria-label="Search field">
        ${FIELD_CHIPS.map(([f, label]) => `<span class="pill link${f === searchField ? ' sel' : ''}" data-field="${f}">${label}</span>`).join('')}
      </div>
      <div class="search-row">
        <input id="add-q" placeholder="${FIELD_PLACEHOLDER[searchField]}">
        <label class="muted small" title="Also show books you already have in your library"
          style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="add-owned"> in library
        </label>
        <label class="muted small" title="Also show omnibuses, anthologies, boxed sets, store samples, multi-part splits and bare stub records"
          style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" id="add-collections"> collections &amp; samples
        </label>
        <button class="btn ghost" id="scan-btn">📷 Scan</button>
        <button class="btn ghost" id="select-btn">Select</button>
        <button class="btn ghost" id="manual-btn">Enter manually</button>
      </div>
      <div id="pick-bar" class="pick-bar hidden"></div>
      <div id="add-results"></div>
      <div id="confirm-panel" class="hidden"></div>
    </div>`;
  // Desktop convenience only — an autofocus on a phone pops the keyboard the
  // moment the screen opens (and iOS may auto-zoom with it).
  if (matchMedia('(pointer: fine)').matches) $('#add-q').focus();

  // Field chips re-run whatever's in the box against the chosen index —
  // same pattern as the collections checkbox below.
  $('#field-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-field]');
    if (!chip || chip.classList.contains('sel')) return;
    searchField = chip.dataset.field;
    $('#field-chips').querySelectorAll('.pill').forEach((c) => c.classList.toggle('sel', c === chip));
    $('#add-q').placeholder = FIELD_PLACEHOLDER[searchField];
    runSearch();
  });

  const paintResults = () => {
    $('#add-results').innerHTML = results.length
      ? results.map((r, i) => `
        <div class="result-card${selectMode && picked.has(i) ? ' picked' : ''}" data-i="${i}">
          ${selectMode ? `<span class="pick">${picked.has(i) ? '✓' : ''}</span>` : ''}
          ${r.cover_url ? `<img src="${esc(r.cover_url)}" loading="lazy">` : '<div class="cover-m blank" style="margin:0 auto"></div>'}
          <div class="rt">${esc(r.title)}</div>
          <div class="ra">${esc(r.author || '')}${r.series_order ? ` · Book ${esc(r.series_order)}` : r.published_year ? ' · ' + r.published_year : ''}</div>
        </div>`).join('')
      : '';
    $('#add-results').querySelectorAll('.result-card').forEach((card) =>
      card.addEventListener('click', () => {
        const i = +card.dataset.i;
        if (!selectMode) return openConfirm(results[i]);
        if (picked.has(i)) picked.delete(i); else picked.add(i);
        card.classList.toggle('picked', picked.has(i));
        card.querySelector('.pick').textContent = picked.has(i) ? '✓' : '';
        renderPickBar();
      }));
  };

  const renderPickBar = () => {
    const bar = $('#pick-bar');
    if (!selectMode) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    bar.innerHTML = `
      <span class="muted small">${picked.size} selected — added books go to the library unlogged, ready to rate later.</span>
      <button class="btn" id="pick-add" ${picked.size ? '' : 'disabled'}>Add ${picked.size || ''} to library</button>
      <button class="btn ghost" id="pick-done">Done</button>`;
    $('#pick-add').addEventListener('click', batchAdd);
    $('#pick-done').addEventListener('click', () => {
      selectMode = false;
      picked.clear();
      $('#select-btn').classList.remove('sel');
      paintResults();
      renderPickBar();
    });
  };

  // Sequential on purpose: each new book may trigger a paced Hardcover
  // length lookup server-side, and parallel POSTs would trip the throttle.
  const batchAdd = async () => {
    const btn = $('#pick-add');
    const chosen = [...picked].map((i) => results[i]).filter(Boolean);
    let added = 0, dupes = 0;
    btn.disabled = true;
    for (let n = 0; n < chosen.length; n++) {
      const r = chosen[n];
      btn.textContent = `Adding ${n + 1} of ${chosen.length}…`;
      try {
        const { existed } = await api('/books', { method: 'POST', body: {
          title: r.title,
          author: r.author,
          page_count: r.page_count,
          published_year: r.published_year,
          cover_url: r.cover_url,
          genres: r.genres || [],
          moods: r.moods || [],
          series_name: r.series_name || null,
          series_order: r.series_order ?? null,
          source_provider: r.provider,
          source_id: r.source_id,
        } });
        existed ? dupes++ : added++;
      } catch (err) {
        toast(`"${r.title}" failed: ${err.message}`, 5000);
      }
    }
    toast(`Added ${added} book${added === 1 ? '' : 's'} to library${dupes ? ` — ${dupes} already there` : ''}`, 5000);
    picked.clear();
    paintResults();
    renderPickBar();
  };

  $('#select-btn').addEventListener('click', () => {
    selectMode = !selectMode;
    picked.clear();
    $('#select-btn').classList.toggle('sel', selectMode);
    paintResults();
    renderPickBar();
  });

  // One debounced search for typing and toggling either filter — flipping a
  // checkbox is just a re-run of whatever's in the box.
  const runSearch = debounce(async () => {
    const q = $('#add-q').value.trim();
    if (q.length < 2) { searchCtl?.abort(); results = []; paintResults(); return; }
    searchCtl?.abort();
    searchCtl = new AbortController();
    const { signal } = searchCtl;
    $('#add-results').innerHTML = '<div class="muted small" style="margin-top:14px">Searching…</div>';
    try {
      const collections = $('#add-collections').checked ? '&collections=1' : '';
      const owned = $('#add-owned')?.checked ? '&owned=1' : '';
      const field = searchField === 'all' ? '' : `&field=${searchField}`;
      const exact = searchExact && searchField !== 'all' ? '&exact=1' : '';
      const data = await api('/search?q=' + encodeURIComponent(q) + field + collections + owned + exact, { signal });
      if (signal.aborted) return; // a newer query already owns the results box
      results = data.results;
      paintResults();
      // Explain every kind of absence: owned books and filtered noise are the
      // two reasons a search that "should" match comes back thin or empty.
      const notes = [];
      if (data.hidden) notes.push(`${data.hidden} already in your library`);
      if (data.noise_hidden) notes.push(`${data.noise_hidden} sample/collection listing${data.noise_hidden === 1 ? '' : 's'} hidden — tick "collections & samples" to show them`);
      if (!results.length) {
        $('#add-results').innerHTML = `<div class="muted small" style="margin-top:14px">${esc(notes.length ? notes.join('; ') + '.' : 'Nothing found — try fewer words, or enter manually.')}</div>`;
      } else if (notes.length) {
        $('#add-results').insertAdjacentHTML('afterbegin',
          `<div class="muted small" style="grid-column:1/-1">${esc(notes.join('; '))}.</div>`);
      }
    } catch (err) {
      if (signal.aborted || err.name === 'AbortError') return;
      results = [];
      $('#add-results').innerHTML = `<div class="muted small" style="margin-top:14px">Search failed: ${esc(err.message)}</div>`;
    }
  });
  $('#add-q').addEventListener('input', runSearch);
  // Both filter toggles persist per device — on stays on until turned off.
  $('#add-collections').checked = localStorage.getItem('bt-add-collections') === '1';
  $('#add-owned').checked = localStorage.getItem('bt-add-owned') === '1';
  $('#add-collections').addEventListener('change', (e) => {
    localStorage.setItem('bt-add-collections', e.target.checked ? '1' : '0');
    runSearch();
  });
  $('#add-owned').addEventListener('change', (e) => {
    localStorage.setItem('bt-add-owned', e.target.checked ? '1' : '0');
    runSearch();
  });
  $('#manual-btn').addEventListener('click', () => openConfirm({}));

  // Barcode scan → ISBN → same confirm panel as a searched book.
  $('#scan-btn').addEventListener('click', async (e) => {    const code = await scanBarcode();
    if (!code) return;
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    try {
      const { result } = await api('/books/isbn/' + encodeURIComponent(code));
      if (result.owned) toast(`"${result.title}" is already in your library`);
      openConfirm(result);
    } catch (err) {
      toast(err.message, 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = '📷 Scan';
    }
  });

  // Deep link (#add/author/…): query pre-filled, search fires immediately.
  if (prefill?.q) {
    $('#add-q').value = prefill.q;
    runSearch();
  }
}

function openConfirm(draft) {
  const panel = $('#confirm-panel');
  panel.classList.remove('hidden');
  panel.className = 'card';
  panel.innerHTML = `
    <h2>Confirm entry</h2>
    <div class="form-grid">
      <div class="field"><label>Title *</label><input id="b-title" value="${esc(draft.title || '')}"></div>
      <div class="field"><label>Author</label><input id="b-author" value="${esc(draft.author || '')}"></div>
      <div class="field"><label>Series</label><input id="b-series" value="${esc(draft.series_name || '')}"></div>
      <div class="field"><label>Series order</label><input id="b-order" type="number" value="${draft.series_order ?? ''}"></div>
      <div class="field"><label>Pages</label><input id="b-pages" type="number" value="${draft.page_count || ''}" placeholder="for word estimate"></div>
      <div class="field"><label>Audio runtime (minutes)</label><input id="b-runtime" type="number" placeholder="for word estimate"></div>
      <div class="field wide"><label>Cover URL</label><input id="b-cover" value="${esc(draft.cover_url || '')}"></div>
    </div>
    <details class="add-more"><summary>More info</summary>
      <div class="add-more-body muted small">Loading…</div>
    </details>
    ${eventFormHTML()}
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <button class="btn" id="save-entry">Save &amp; log another</button>
      <button class="btn subtle" id="save-entry-done">Save &amp; finish</button>
      <button class="btn ghost" id="save-tbr">📌 Add to TBR</button>
      <button class="btn ghost" id="cancel-entry">Cancel</button>
    </div>`;
  bindEventForm(panel);

  // Same lazy "More info" the recommendation cards carry: Hardcover
  // description + catalog details when the result is HC-sourced, plain
  // title+author search links otherwise. Reads the fields live, so manual
  // entries work too.
  const more = panel.querySelector('.add-more');
  more.addEventListener('toggle', () => {
    if (!more.open || more.dataset.loaded) return;
    more.dataset.loaded = '1';
    loadMoreInfo(more.querySelector('.add-more-body')).catch((err) => {
      more.querySelector('.add-more-body').textContent = `Could not load: ${err.message}`;
    });
  });

  async function loadMoreInfo(body) {
    const hcId = draft.provider === 'hardcover' && /^\d+$/.test(String(draft.source_id || ''))
      ? draft.source_id : null;
    const info = hcId ? await api('/books/hardcover-info/' + hcId).catch(() => null) : null;
    renderInfoBody(body, {
      title: $('#b-title', panel).value.trim(),
      author: $('#b-author', panel).value.trim(),
      ...(info || {}),
    });
  }

  $('#cancel-entry', panel).addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  });
  const readDraft = () => ({
    title: $('#b-title').value.trim(),
    author: $('#b-author').value.trim() || null,
    series_name: $('#b-series').value.trim() || null,
    series_order: +$('#b-order').value || null,
    page_count: +$('#b-pages').value || null,
    audio_runtime_minutes: +$('#b-runtime').value || null,
    cover_url: $('#b-cover').value.trim() || null,
    genres: draft.genres || [],
    moods: draft.moods || [],
    published_year: draft.published_year || null,
    source_provider: draft.provider || 'manual',
    source_id: draft.source_id || null,
  });
  const closePanel = () => {
    // Stay on this page, ready for the next entry.
    panel.classList.add('hidden');
    panel.innerHTML = '';
    $('#add-results').innerHTML = '';
    const q = $('#add-q');
    q.value = '';
    q.focus();
  };
  const saveEntry = async (finish) => {
    const draftOut = readDraft();
    if (!draftOut.title) return toast('Title is required');
    const { book } = await api('/books', { method: 'POST', body: draftOut });
    const ev = collectEventForm(panel, book.id);
    await api('/events', { method: 'POST', body: ev });
    if (ev.status !== 'reading') {
      const words = estWordsClient(book, ev.format);
      toast(`Logged "${book.title}"${words ? ` — +${fmtWords(ev.status === 'dnf' ? Math.round(words * (ev.dnf_percent || 30) / 100) : words)} words` : ''}`);
    } else {
      toast(`"${book.title}" marked as reading now`);
    }
    if (finish) {
      location.hash = '#dashboard';
      return;
    }
    closePanel();
  };
  // Queue it unread — catalog-only save (no entry), straight onto the TBR.
  $('#save-tbr', panel).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const draftOut = readDraft();
      if (!draftOut.title) { toast('Title is required'); btn.disabled = false; return; }
      const { book } = await api('/books', { method: 'POST', body: draftOut });
      const r = await api('/tbr', { method: 'POST', body: { book_id: book.id, source: 'add' } });
      toast(r.existed ? `"${book.title}" is already queued on your TBR` : `"${book.title}" queued on your TBR`);
      closePanel();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  $('#save-entry', panel).addEventListener('click', () => saveEntry(false));
  $('#save-entry-done', panel).addEventListener('click', () => saveEntry(true));
}

registerRoute('#add', addView);

// Deep links from clickable author/series text: #add/author/…, #add/series/….
registerRoute('#add/', () => {
  const [, field, enc = ''] = location.hash.split('/');
  const q = enc ? decodeURIComponent(enc) : '';
  return FIELD_PLACEHOLDER[field] && field !== 'all' && q ? addView({ field, q, exact: true }) : addView();
});
