import { api } from '../api.js';
import { $, esc, tierBadge, debounce, TIERS, toast, guard } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { bookModal } from '../book-modal.js';

// Library filters live at module level so they survive view re-renders
// (rating a book re-runs the route; the selected filter should stick).
// `selected` is the multi-select for bulk actions — also a Set so ticked rows
// survive the re-renders that rating/filtering trigger. `sort` is the column
// sort ({ key, dir } | null = default newest-first).
const libState = { query: '', tier: '', format: '', needs_refresh: false,
  picked: { tag: [], mood: [], genre: [] }, selected: new Set(), sort: null };

const TIER_RANK = { S: 5, A: 4, B: 3, C: 2, D: 1 };
const SORTS = {
  title: { get: (b) => (b.title || '').toLowerCase(), dir: 'asc' },
  author: { get: (b) => (b.author || '').toLowerCase(), dir: 'asc' },
  series: { get: (b) => `${(b.series_name || '').toLowerCase()} ${String(b.series_order ?? 999999).padStart(6, '0')}`, dir: 'asc' },
  tier: { get: (b) => TIER_RANK[b.rating] || 0, dir: 'desc' },
  year: { get: (b) => b.published_year || 0, dir: 'desc' },
  finished: { get: (b) => b.last_finished || '', dir: 'desc' },
};

// The three label types a book carries — personal tags, imported moods, and
// imported genres — filter identically: clicking a pill narrows the pile to
// books carrying that value, clicking another pill narrows further (ALL picked
// values must match), clicking a lit pill untoggles it. Each dropdown is the
// reset lever for its type ("All tags" clears that type's picks; picking a
// value collapses that type's picks to just it).
const LABELS = [
  { key: 'tag', all: 'All tags', list: (b) => b.tags || [] },
  { key: 'mood', all: 'All moods', list: (b) => b.moods || [] },
  { key: 'genre', all: 'All genres', list: (b) => b.genres || [] },
];

async function library() {
  view.innerHTML = `
    <h1>Library</h1>
    <details class="muted small help-tips" style="margin:0 0 10px">
      <summary style="cursor:pointer">Tips — pills, re-pulling, logging and editing</summary>
      <ul style="margin:10px 0 4px 18px;padding:0;display:grid;gap:7px">
        <li><b>Click a book</b> — opens its detail panel: log reads or listens, rate it, edit
        details, or ↻ re-pull its Hardcover data.</li>
        <li><b>Click a column header</b> — Book, Series, Year Published, Tier or Finished — to sort the pile;
        click again to flip the direction.</li>
        <li><b>Pills on each book</b> (genre · mood · tag) — click one to narrow the pile to books
        carrying it; click another pill to narrow further; click a lit pill to untoggle it.</li>
        <li><b>The dropdowns reset each type</b> — "All genres — resets 2 picked" clears that
        type's picks; picking a value from it collapses to just that one.</li>
        <li><b>↻ Needs re-pull</b> — flags books missing Hardcover data (cover, lengths, series,
        moods); it filters the pile, and bulk re-pull then fetches everything in one pass. Books
        Hardcover doesn't list at all (some novellas) can be marked "No HC profile" in their detail
        panel — they stop flagging, and re-pulls fall back to Google Books.</li>
        <li><b>Tick rows</b> (or the header ☑ for everything shown) to select several books, then
        <b>Set read date unknown</b> — or type a year and <b>Set year</b> to land them in that
        year's stats without claiming a day. For books an import stamped with the import day, or
        ones you only roughly remember.</li>
        <li><b>Search box</b> — matches title, author, series and tags.</li>
      </ul>
    </details>
    <div class="toolbar">
      <input id="lib-q" placeholder="Search title, author, series, tag…">
      <select id="lib-tier"><option value="">All tiers</option><option value="unrated">To be rated</option><option value="tbr">📌 TBR</option><option value="paused">⏸ On pause</option>${TIERS.map((t) => `<option>${t}</option>`).join('')}</select>
      <select id="lib-format"><option value="">Read + listened</option><option value="read">Read</option><option value="listened">Listened</option></select>
      ${LABELS.map((l) => `<select id="lib-${l.key}"><option value="">${l.all}</option></select>`).join('')}
      <button class="btn ghost hidden" id="lib-needs" title="Books missing Hardcover data — cover, lengths, series or moods"></button>
      <span id="lib-count" class="muted small"></span>
    </div>
    <div id="lib-bulk" class="card hidden" style="margin:0 0 10px;padding:8px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="muted small" id="lib-bulk-count" style="flex:1;min-width:120px"></span>
      <button class="btn" id="lib-bulk-read" title="Creates a finished 'read' entry dated today for selected books that don't have one — books already marked read are skipped, and dates stay fixable with the tools beside this">✅ Mark as read</button>
      <input id="lib-bulk-year" type="number" min="1901" max="2100" placeholder="Year…" style="width:86px"
        title="Optional: land the selected books in this year instead of clearing dates entirely">
      <button class="btn" id="lib-bulk-year-btn" title="Entries keep their ratings and all-time counts; a full date is replaced by just this year">🗓 Set year</button>
      <button class="btn" id="lib-bulk-unknown" title="Clears the finished dates on the selected books' entries — entries and ratings stay, they just count all-time instead of in a year">🗓 Set read date unknown</button>
      <button class="btn ghost" id="lib-bulk-clear">Clear selection</button>
    </div>
    <div id="lib-list"><div class="loading">Loading…</div></div>`;
  $('#lib-q').value = libState.query;
  $('#lib-tier').value = libState.tier;
  $('#lib-format').value = libState.format;

  // Label sets fill from refresh()'s payload below — one fetch serves both
  // the table and the dropdowns; the filters themselves are applied
  // client-side so a dropdown never filters its own options away. Editing
  // books in the modal re-renders this view.
  const sets = Object.fromEntries(LABELS.map((l) => [l.key, new Set()]));

  // A dropdown announces its type's pile: "All moods — resets 2 picked" when
  // two mood pills are lit (clicking it clears them); exactly one pick shows
  // as the selected option.
  const options = (l) => {
    const n = libState.picked[l.key].length;
    return `<option value="">${n ? `${l.all} — resets ${n} picked` : l.all}</option>`
      + [...sets[l.key]].sort((a, b) => a.localeCompare(b))
        .map((v) => `<option${n === 1 && libState.picked[l.key][0] === v ? ' selected' : ''}>${esc(v)}</option>`).join('');
  };
  const syncDropdowns = () => { for (const l of LABELS) $(`#lib-${l.key}`).innerHTML = options(l); };

  // The "Needs re-pull" toggle: label carries the whole-library count from the
  // API; hidden entirely once every book has its Hardcover data.
  let needsCount = 0;
  let currentShown = [];
  const updateNeedsBtn = () => {
    const btn = $('#lib-needs');
    btn.textContent = `↻ Needs re-pull (${needsCount})`;
    btn.classList.toggle('hidden', needsCount === 0 && !libState.needs_refresh);
    btn.classList.toggle('sel', libState.needs_refresh);
  };
  $('#lib-needs').addEventListener('click', () => {
    libState.needs_refresh = !libState.needs_refresh;
    updateNeedsBtn();
    refresh();
  });

  // Bulk-selection bar: count text, visibility, and the header ☑'s
  // checked/indeterminate state. The bar itself lives outside #lib-list so a
  // re-render (filter change, rating) never wipes it mid-selection.
  const syncSelectionUI = () => {
    const n = libState.selected.size;
    $('#lib-bulk').classList.toggle('hidden', n === 0);
    if (n) $('#lib-bulk-count').innerHTML = `<b>${n}</b> selected`;
    const all = $('#lib-sel-all');
    if (all) {
      const shownIds = currentShown.map((b) => b.id);
      const picked = shownIds.filter((id) => libState.selected.has(id)).length;
      all.checked = shownIds.length > 0 && picked === shownIds.length;
      all.indeterminate = picked > 0 && !all.checked;
    }
  };

  async function refresh() {
    lastSelBox = null; // the table is rebuilt — a shift-click anchor would point at a stranger
    const params = new URLSearchParams({ query: libState.query, tier: libState.tier, format: libState.format });
    const { books, needs_refresh_count } = await api('/books?' + params);
    needsCount = needs_refresh_count;
    updateNeedsBtn();
    // Column sort indicator, rendered with the (re-created) headers.
    const sortInd = (key) => libState.sort?.key === key
      ? `<span class="sort-ind">${libState.sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    // Every lit pill is a requirement: the book must carry all of them.
    const shown = books.filter((b) => LABELS.every((l) => libState.picked[l.key].every((v) => l.list(b).includes(v)))
      && (!libState.needs_refresh || b.needs_refresh));
    if (libState.sort) {
      const { key, dir } = libState.sort;
      const get = SORTS[key].get;
      shown.sort((a, b) => {
        const va = get(a), vb = get(b);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    currentShown = shown;
    for (const b of books) for (const l of LABELS) for (const v of l.list(b)) sets[l.key].add(v);
    syncDropdowns();
    // Sortable headers are keyboard-reachable and announce their state.
    $('#lib-list').querySelectorAll('[data-sort]').forEach((el) => {
      el.tabIndex = 0;
      if (libState.sort?.key === el.dataset.sort) {
        el.closest('th')?.setAttribute('aria-sort', libState.sort.dir === 'asc' ? 'ascending' : 'descending');
      }
    });
    $('#lib-count').textContent = `${shown.length} book${shown.length === 1 ? '' : 's'}`;
    // Books missing Hardcover details get a plain-language banner with a
    // one-click "Update all" — the filtered view's bulk button, surfaced
    // without requiring anyone to find the toolbar toggle first. The count
    // reflects what's actually on screen (search/pill filters included).
    const shownNeeding = shown.filter((b) => b.needs_refresh).length;
    $('#lib-list').innerHTML = (libState.needs_refresh && shown.length
      ? `<div style="margin:0 0 10px;display:flex;gap:10px;align-items:center">
          <button class="btn" id="lib-repull-all">↻ Re-pull all (${shown.length})</button>
          <span class="muted small">fetches cover, lengths, series &amp; moods from Hardcover</span>
        </div>`
      : (!libState.needs_refresh && shownNeeding > 0
      ? `<div class="card" style="margin:0 0 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span class="muted small" style="flex:1;min-width:260px"><b>${shownNeeding}</b> of your books are missing
          details — covers, page counts, series, genres &amp; moods. A re-pull fetches them from Hardcover
          (about a second per book); your titles, authors, ratings and logs are never changed.</span>
          <button class="btn ghost" id="lib-show-needs">Show just these</button>
          <button class="btn" id="lib-repull-all">↻ Update all (${shownNeeding})</button>
        </div>`
      : ''))
      + (shown.length
      ? `<table class="lib-table"><thead><tr><th style="width:30px" title="Select all shown"><input type="checkbox" id="lib-sel-all"></th><th></th><th class="sortable" data-sort="title">Book ${sortInd('title')}<span class="sort-alt" data-sort="author" title="Sort by author">Author ${sortInd('author')}</span></th><th class="sortable lib-series-col" data-sort="series">Series ${sortInd('series')}</th><th class="sortable lib-year-col" data-sort="year">Year Published ${sortInd('year')}</th><th class="sortable" data-sort="tier">Tier ${sortInd('tier')}</th><th class="lib-entry-col">Last entry</th><th class="sortable" data-sort="finished">Finished ${sortInd('finished')}</th><th></th></tr></thead>
        <tbody>${shown.map((b) => `
          <tr data-id="${b.id}">
            <td><input type="checkbox" class="lib-sel" data-id="${b.id}"${libState.selected.has(b.id) ? ' checked' : ''} title="Select for bulk actions"></td>
            <td>${b.cover_url ? `<img class="cover-s" src="${esc(b.cover_url)}" loading="lazy">` : '<div class="cover-s blank"></div>'}</td>
            <td><div class="t">${esc(b.title)}${b.in_tbr ? ' 📌' : ''}${b.on_pause ? ' ⏸' : ''}</div><div class="muted small">${b.author ? `<a class="text-link" href="#add/author/${encodeURIComponent(b.author)}">${esc(b.author)}</a>` : ''}</div>
              ${b.series_name ? `<div class="muted small lib-series-inline"><a class="text-link" href="#add/series/${encodeURIComponent(b.series_name)}">${esc(b.series_name)}</a>${b.series_order ? ` #${b.series_order}` : ''}</div>` : ''}
              ${pillRow(b)}</td>
            <td class="muted lib-series-col">${b.series_name ? `<a class="text-link" href="#add/series/${encodeURIComponent(b.series_name)}">${esc(b.series_name)}</a>${b.series_order ? ` #${b.series_order}` : ''}` : ''}</td>
            <td class="muted small lib-year-col">${b.published_year || '—'}</td>
            <td>${b.rating ? tierBadge(b.rating) : '<span class="muted">—</span>'}</td>
            <td class="lib-entry-col">${b.last_format === 'listened' ? '🎧' : '📖'} <span class="muted small">${esc(b.last_status || '')}</span></td>
            <td class="muted small lib-finished">${esc(b.last_finished || '')}</td>
            <td>${b.event_count > 1 ? `<span class="pill">${b.event_count}×</span>` : ''}</td>
          </tr>`).join('')}</tbody></table>`
      : '<div class="empty">No books match.</div>');
    $('#lib-list').querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, .pill.link, input, a')) return; // links go to Log a book
        bookModal(+tr.dataset.id);
      }));
    syncSelectionUI();
  }

  const toggleSort = (key) => {
    libState.sort = libState.sort?.key === key
      ? { key, dir: libState.sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: SORTS[key].dir };
    refresh();
  };
  // Enter/Space activates a focused header (a <th> is not natively activatable).
  $('#lib-list').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const sortEl = e.target.closest('[data-sort]');
    if (!sortEl) return;
    e.preventDefault();
    toggleSort(sortEl.dataset.sort);
  });

  // Tags/moods/genres as pills — all three behave the same: clicking toggles
  // that value in the narrowing filter (highlighted while it's part of it).
  // Books missing Hardcover data also carry a ↻ badge that re-pulls inline.
  const pillRow = (b) => {
    const pills = LABELS.flatMap((l) => l.list(b).map((v) => ({ key: l.key, v })));
    if (!pills.length && !b.needs_refresh) return '';
    return `<div class="pill-row">${pills.map((p) => `<span class="pill link${libState.picked[p.key].includes(p.v) ? ' sel' : ''}" data-kind="${p.key}" title="Toggle ${p.key} filter">${esc(p.v)}</span>`).join(' ')}
      ${b.needs_refresh ? '<span class="pill link refresh-pill" title="Missing Hardcover data — tap to fetch it">↻ Hardcover</span>' : ''}</div>`;
  };
  $('#lib-list').addEventListener('click', async (e) => {
    // Column header sort: Book / Author / Series / Tier / Finished — click
    // again to flip. Data-side sorting in refresh(), so it survives filter
    // re-renders. Closest [data-sort] (not the th) so the Author toggle
    // inside the Book header resolves to itself, not its parent column.
    const sortEl = e.target.closest('[data-sort]');
    if (sortEl) {
      toggleSort(sortEl.dataset.sort);
      return;
    }
    // "Show just these" (banner) narrows the list to books needing a re-pull.
    // Bound by delegation — the banner is re-created on every refresh().
    if (e.target.closest('#lib-show-needs')) {
      libState.needs_refresh = true;
      updateNeedsBtn();
      refresh();
      return;
    }
    const badge = e.target.closest('.refresh-pill');
    if (badge) {
      const tr = badge.closest('tr[data-id]');
      badge.textContent = '↻ …';
      badge.style.pointerEvents = 'none';
      try {
        const r = await api(`/books/${tr.dataset.id}/refresh`, { method: 'POST' });
        toast(r.matched
          ? (r.changed.length ? `Updated: ${r.changed.join(', ')}` : 'Already up to date with Hardcover')
          : 'No Hardcover match found for this book', 5000);
      } catch (err) {
        toast(err.message);
      }
      refresh();
      return;
    }
    const pill = e.target.closest('.pill.link');
    if (!pill) return;
    const arr = libState.picked[pill.dataset.kind];
    const v = pill.textContent;
    const i = arr.indexOf(v);
    i >= 0 ? arr.splice(i, 1) : arr.push(v);
    syncDropdowns();
    refresh();
  });

  // Bulk re-pull of the filtered view: sequential per-book calls — the
  // server's paced HC client keeps the quota polite.
  $('#lib-list').addEventListener('click', guard(async (e) => {
    const btn = e.target.closest('#lib-repull-all');
    if (!btn) return;
    btn.disabled = true;
    let updated = 0, missed = 0;
    const targets = currentShown.filter((b) => b.needs_refresh);
    try {
      for (let i = 0; i < targets.length; i++) {
        btn.textContent = `↻ Re-pulling ${i + 1}/${targets.length}…`;
        try {
          const r = await api(`/books/${targets[i].id}/refresh`, { method: 'POST' });
          if (r.matched) updated++; else missed++;
        } catch { missed++; }
      }
      toast(`Re-pull done: ${updated} updated${missed ? `, ${missed} with no Hardcover match` : ''}`, 6000);
      await refresh();
    } finally {
      btn.disabled = false; // stale after re-render; harmless on the detached node
    }
  }));

  // Shift-click range select: from the last-ticked box to this one, checked.
  // The change event carries no shift key, so ranges live here on click. No
  // preventDefault: the browser's own toggle of the clicked box lands on
  // "checked" and the change handler re-adds the same id harmlessly.
  let lastSelBox = null;
  $('#lib-list').addEventListener('click', (e) => {
    const box = e.target.closest('.lib-sel');
    if (!box) return;
    const boxes = [...$('#lib-list').querySelectorAll('.lib-sel')];
    const idx = boxes.indexOf(box);
    if (e.shiftKey && lastSelBox !== null) {
      for (let i = Math.min(lastSelBox, idx); i <= Math.max(lastSelBox, idx); i++) {
        boxes[i].checked = true;
        libState.selected.add(+boxes[i].dataset.id);
      }
    } else {
      box.checked ? libState.selected.add(+box.dataset.id) : libState.selected.delete(+box.dataset.id);
    }
    lastSelBox = idx;
    syncSelectionUI();
  });

  // Selection checkboxes — delegated change handling, since refresh() rebuilds
  // the whole table (and the header ☑ with it) on every filter change.
  $('#lib-list').addEventListener('change', (e) => {
    if (e.target.id === 'lib-sel-all') {
      for (const b of currentShown) {
        e.target.checked ? libState.selected.add(b.id) : libState.selected.delete(b.id);
      }
      $('#lib-list').querySelectorAll('.lib-sel')
        .forEach((box) => { box.checked = libState.selected.has(+box.dataset.id); });
      syncSelectionUI();
      return;
    }
    const box = e.target.closest('.lib-sel');
    if (!box) return;
    box.checked ? libState.selected.add(+box.dataset.id) : libState.selected.delete(+box.dataset.id);
    syncSelectionUI();
  });

  // Bulk read-date fixup: "unknown" clears the dates, a typed year lands the
  // entries in that year (full dates are replaced by the year alone). One
  // request per action; the confirm is the only guard — a cleared full date
  // can't be restored in-app, so say exactly what will happen first.
  const applyBulkDates = async (btn, year) => {
    const ids = [...libState.selected];
    if (!ids.length) return;
    const what = year ? `the year ${year}` : '"date unknown"';
    if (!confirm(`Set ${what} on ${ids.length} selected book${ids.length === 1 ? '' : 's'}?\n\nTheir entries, ratings and all-time counts stay${year ? ' — a full date on an entry is replaced by the year alone' : ' — they just stop claiming a "finished on …" date'}. For books you read long before the import stamped them.`)) return;
    btn.disabled = true;
    try {
      const r = await api('/books/read-dates-set', { method: 'POST', body: { ids, year } });
      toast(`Done — ${r.events} ${r.events === 1 ? 'entry is' : 'entries are'} now ${year ? `finished in ${year}` : '"date unknown"'} across ${r.books} ${r.books === 1 ? 'book' : 'books'}`, 6000);
      libState.selected.clear();
      refresh();
    } catch (err) {
      toast(err.message);
    }
    btn.disabled = false;
  };
  $('#lib-bulk-unknown').addEventListener('click', (e) => applyBulkDates(e.currentTarget, null));
  // Bulk mark-as-read: the member-shelf ✅ Read, batched — finished entries
  // dated today for selected books without one; already-read books skip.
  $('#lib-bulk-read').addEventListener('click', async (e) => {
    const ids = [...libState.selected];
    if (!ids.length) return;
    if (!confirm(`Mark ${ids.length} selected book${ids.length === 1 ? '' : 's'} as read?\n\nEach gets a finished entry dated today unless it already has one (those are skipped) — fix dates afterwards with "Set year" / "Set read date unknown".`)) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api('/books/mark-read', { method: 'POST', body: { ids } });
      const marked = r.created + r.closed;
      toast(`Marked ${marked} of ${r.books} book${r.books === 1 ? '' : 's'} as read${r.skipped ? ` — ${r.skipped} already read, skipped` : ''}`, 6000);
      libState.selected.clear();
      refresh();
    } catch (err) {
      toast(err.message);
    }
    btn.disabled = false;
  });
  $('#lib-bulk-year-btn').addEventListener('click', (e) => {
    const v = +$('#lib-bulk-year').value;
    if (!Number.isInteger(v) || v <= 1900 || v > 2100) {
      toast('Type a 4-digit year first (e.g. 2021) — or use "Set read date unknown".');
      return;
    }
    applyBulkDates(e.currentTarget, v);
  });
  $('#lib-bulk-clear').addEventListener('click', () => {
    libState.selected.clear();
    $('#lib-list').querySelectorAll('.lib-sel').forEach((box) => { box.checked = false; });
    syncSelectionUI();
  });

  $('#lib-q').addEventListener('input', debounce((e) => { libState.query = e.target.value; refresh(); }));
  $('#lib-tier').addEventListener('change', (e) => { libState.tier = e.target.value; refresh(); });
  $('#lib-format').addEventListener('change', (e) => { libState.format = e.target.value; refresh(); });
  for (const l of LABELS) {
    const sel = $(`#lib-${l.key}`);
    // With 2+ pills lit, the dropdown's *displayed* option is the reset row
    // itself — and a <select> fires no change event when the already-shown
    // option is re-picked, which made "All genres" a dead zone exactly when
    // a reset was needed. Detaching the selection on press means any choice
    // (including "All") registers; blur restores the label if the dropdown
    // was closed without choosing.
    sel.addEventListener('mousedown', () => {
      if (libState.picked[l.key].length) sel.selectedIndex = -1;
    });
    sel.addEventListener('blur', () => syncDropdowns());
    sel.addEventListener('change', (e) => {
      libState.picked[l.key] = e.target.value ? [e.target.value] : [];
      refresh();
    });
  }
  await refresh();
}

registerRoute('#library', library);
