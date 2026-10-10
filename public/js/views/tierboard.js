import { api } from '../api.js';
import { $, esc, toast, tierBadge, TIERS } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { bookModal, openModal } from '../book-modal.js';
import { renderInfoBody } from '../book-info.js';
import { planExport, planTextSection, textColW, TEXT_LAYOUT, LAYOUT } from '../tier-export-layout.js';

const TIER_DESC = { S: 'Loved it!', A: 'excellent', B: 'liked it', C: 'fine', D: 'disliked' };
const SCORE_TIERS = ['D', 'C', 'B', 'A', 'S'];
const TIER_COLORS = { S: '#e6b84c', A: '#7fb069', B: '#5b9bd5', C: '#9a9aa5', D: '#c0504d' };

let boardBooks = [];
// Drag state lives at module level: the delegated board listeners are bound
// once (bindBoard early-returns on re-render), so per-call locals would go
// stale after the first drop and every later drag would silently no-op.
let dragEl = null;
let dropped = false;
let overCell = null;
// Set when the route is `#board/<userId>` — a read-only view of another
// member's board (linked from Compare). No dragging, tagging or rollups.
let viewing = null;
// Owner of the viewed board ({ id, name }) — chip clicks open the book's
// shared info panel, fetched from their shelf.
let boardOwner = null;
// Covers-only display (title spans hidden, chips shrink to the cover). A
// viewer preference (prefs.board.coversOnly), so it follows the member and
// applies to other members' read-only boards too.
let coversOnly = false;
// Whether the PNG export appends the stylised text listing (tier pills,
// wrapped title + author per book). Same viewer preference pattern as
// coversOnly (prefs.board.exportList).
let exportList = false;
// Board filters — transient, module level like the library's (they survive
// the re-renders that tagging and dragging trigger, but not a reload). Year
// read only ever applies on your own board: the read-only member board
// travels without dates, per the share_compare privacy promise.
let boardFilter = { on: false, author: '', year: '' };

const shortTitle = (t) => (t.length > 38 ? t.slice(0, 37) + '…' : t);
const authorLabel = (b) => (b.author?.trim() || 'Unknown author');
// A book wears the DNF badge when its LATEST entry was a DNF — the same
// latest-entry semantics the rating uses, so a book DNF'd and later
// finished loses the badge again. Own boards carry last_status from
// GET /books; member boards travel a precomputed dnf flag.
const bookDnf = (b) => (viewing ? !!b.dnf : b.last_status === 'dnf');
// A book's read year = its latest finish (finished_at, falling back to a
// year-only entry). Reading / TBR entries have none.
const finishYear = (b) => (/^\d{4}/.test(b.last_finished || '') ? b.last_finished.slice(0, 4) : null);

// The set the board shows: both filters AND-combined, the whole board when
// the toggle is off.
const visibleBooks = () => boardBooks.filter((b) => {
  if (!boardFilter.on) return true;
  if (boardFilter.author && authorLabel(b) !== boardFilter.author) return false;
  if (boardFilter.year && !viewing) {
    const y = finishYear(b);
    if (boardFilter.year === 'none' ? y !== null : y !== boardFilter.year) return false;
  }
  return true;
});

async function tierboard() {
  const parts = location.hash.split('/');
  viewing = parts[0] === '#board' && Number.isInteger(+parts[1]) && parts[1] !== '' ? +parts[1] : null;
  const prefs = await api('/account/prefs').catch(() => ({}));
  coversOnly = !!prefs?.board?.coversOnly;
  exportList = !!prefs?.board?.exportList;

  let boardOwnerName = null;
  if (viewing) {
    const mine = await api('/meta');
    if (mine.user?.id === viewing) { location.hash = '#board'; return; }
    const theirs = await api('/board/' + viewing);
    boardOwnerName = theirs.user.name;
    boardOwner = { id: viewing, name: boardOwnerName };
    boardBooks = theirs.books;
  } else {
    boardOwner = null;
  }

  view.innerHTML = viewing ? `
    <h1>${esc(boardOwnerName)}'s tier board</h1>
    <p class="muted">Read-only — this is ${esc(boardOwnerName)}'s arrangement. Their tiers are visible
    because they opted into comparisons.</p>
    <div class="toolbar">
      <a class="btn ghost" href="#compare/${viewing}">← Back to compare</a>
      <label class="chk" title="Add a text listing of every tier below the covers">
        <input type="checkbox" id="board-export-list"${exportList ? ' checked' : ''}> Include book list</label>
      <button class="btn ghost" id="board-image">⬇ Export as image</button>
      <button class="btn ghost" id="board-image-list" title="Download just the book list as its own picture — post it beside the covers image">⬇ Export list only</button>
      <button class="btn ghost${coversOnly ? ' sel' : ''}" id="board-covers" aria-pressed="${coversOnly}" title="Show covers only, without titles">🖼 Covers only</button>
      <button class="btn ghost${boardFilter.on ? ' sel' : ''}" id="board-filter" aria-pressed="${boardFilter.on}" title="Show only part of the board — by author or year read">▽ Filter</button>
      <span id="board-count" class="muted small"></span>
    </div>
    <div id="filter-row" class="toolbar${boardFilter.on ? '' : ' hidden'}"></div>
    <div class="board" id="board"><div class="loading">Loading…</div></div>`
    : `
    <h1>Tier board</h1>
    <p class="muted">Drag books between tiers, or within a tier to arrange them — changes save instantly.
    Books without entries (TBR / catalog-only) don't appear here.</p>
    <div class="toolbar">
      <label class="chk" title="Add a text listing of every tier below the covers">
        <input type="checkbox" id="board-export-list"${exportList ? ' checked' : ''}> Include book list</label>
      <button class="btn ghost" id="board-image">⬇ Export as image</button>
      <button class="btn ghost" id="board-image-list" title="Download just the book list as its own picture — post it beside the covers image">⬇ Export list only</button>
      <button class="btn ghost${coversOnly ? ' sel' : ''}" id="board-covers" aria-pressed="${coversOnly}" title="Show covers only, without titles">🖼 Covers only</button>
      <button class="btn ghost${boardFilter.on ? ' sel' : ''}" id="board-filter" aria-pressed="${boardFilter.on}" title="Show only part of the board — by author or year read">▽ Filter</button>
      <span id="board-count" class="muted small"></span>
    </div>
    <div id="filter-row" class="toolbar${boardFilter.on ? '' : ' hidden'}"></div>
    <div class="board" id="board"><div class="loading">Loading…</div></div>
    <div id="tag-pop" class="tag-pop hidden"></div>
    <h3 style="margin-top:26px">Series rollups</h3>
    <p class="muted small">Average of members' current tiers (D=1 … S=5) across series with 2+ rated books.
    The override column wins over the math.</p>
    <div class="card" id="rollups"><div class="loading">Loading…</div></div>`;
  $('#board-image').addEventListener('click', exportImage);
  $('#board-image-list').addEventListener('click', exportListImage);
  // Include-book-list toggle: same persist-the-viewer-preference pattern as
  // covers-only (prefs.board.exportList via the deep-merge route).
  $('#board-export-list').addEventListener('change', async (e) => {
    exportList = e.currentTarget.checked;
    try { await api('/account/prefs', { method: 'PUT', body: { board: { exportList } } }); }
    catch (err) { toast(err.message); }
  });
  // Covers-only toggle: flips the chip renderer and persists the viewer
  // preference (prefs.board.coversOnly). The button lives outside #board, so
  // refreshBoard's re-render doesn't touch it.
  $('#board-covers').addEventListener('click', async (e) => {
    coversOnly = !coversOnly;
    const btn = e.currentTarget;
    btn.setAttribute('aria-pressed', String(coversOnly));
    btn.classList.toggle('sel', coversOnly);
    try { await api('/account/prefs', { method: 'PUT', body: { board: { coversOnly } } }); }
    catch (err) { toast(err.message); }
    await refreshBoard();
  });
  // Filter toggle: off hides the option row and shows the whole board
  // (selections stay remembered, so toggling back on restores them).
  $('#board-filter').addEventListener('click', (e) => {
    boardFilter.on = !boardFilter.on;
    const btn = e.currentTarget;
    btn.setAttribute('aria-pressed', String(boardFilter.on));
    btn.classList.toggle('sel', boardFilter.on);
    $('#filter-row').classList.toggle('hidden', !boardFilter.on);
    renderBoard();
  });
  if (viewing) {
    await refreshBoard(true);
  } else {
    await Promise.all([refreshBoard(), refreshRollups()]);
  }
}

const chip = (b) => `
  <div class="book-chip${viewing ? ' chip-view' : ''}${coversOnly ? ' covers-only' : ''}" draggable="${viewing || boardFilter.on ? 'false' : 'true'}" data-id="${b.id}" title="${esc(b.title)}">
    ${b.cover_url ? `<img src="${esc(b.cover_url)}" loading="lazy" draggable="false">` : `<div class="chip-cover blank${coversOnly ? ' chip-blank-covers' : ''}">${coversOnly ? esc((b.title || '?')[0]) : ''}</div>`}
    ${bookDnf(b) ? '<span class="chip-dnf">DNF</span>' : ''}
    ${coversOnly ? '' : `<span>${esc(shortTitle(b.title))}</span>`}
    ${viewing ? '' : `<button type="button" class="chip-tag${(b.tags || []).length ? ' has-tags' : ''}" data-id="${b.id}" title="${(b.tags || []).length ? 'Tags: ' + esc(b.tags.join(', ')) : 'Add tags'}">🏷</button>`}
  </div>`;

async function refreshBoard() {
  if (!viewing) {
    const { books } = await api('/books');
    boardBooks = books.filter((b) => b.event_count > 0);
  }
  renderBoard();
}

// Draw the board from boardBooks through the active filter. Filter changes
// call this directly — no refetch — so flipping a dropdown is instant.
function renderBoard() {
  // Rows render S→D then unrated; within a tier, hand-arranged books keep
  // their saved position (tier_order), the rest trail newest-first.
  const rank = (b) => {
    const i = TIERS.indexOf(b.rating || '');
    return (i === -1 ? TIERS.length : i) * 1e9 + (b.tier_order ?? 1e9);
  };
  boardBooks.sort((a, b) => (rank(a) - rank(b)) || (b.id - a.id));
  const visible = visibleBooks();
  $('#board-count').textContent = boardFilter.on && visible.length < boardBooks.length
    ? `${visible.length} of ${boardBooks.length} books with entries`
    : `${boardBooks.length} books with entries`;
  const byTier = Object.fromEntries([...TIERS, ''].map((t) => [t, []]));
  for (const b of visible) byTier[b.rating || ''].push(b);
  $('#board').innerHTML = [...TIERS, ''].map((t) => `
    <div class="tier-row">
      <div class="tier-label ${t ? 'tier-' + t : 'unrated'}">${t || '?'}${t ? `<span class="tier-desc">${TIER_DESC[t]}</span>` : '<span class="tier-desc">to be rated</span>'}</div>
      <div class="tier-cell" data-tier="${t}">${byTier[t].map(chip).join('') || `<span class="muted small cell-hint">${viewing ? '' : 'drop here'}</span>`}</div>
    </div>`).join('');
  renderFilterRow();
  bindBoard();
}

// The filter option row (visible only while the toggle is on). Dropdown
// choices always come from the FULL board, so narrowing one facet never
// collapses the other's options. Year read is own-board only — the member
// board's payload travels without dates on purpose.
function renderFilterRow() {
  const row = $('#filter-row');
  if (!row || row.classList.contains('hidden')) return;
  const authors = [...new Set(boardBooks.map(authorLabel))].sort((a, b) => a.localeCompare(b));
  const years = [...new Set(boardBooks.map(finishYear).filter(Boolean))].sort().reverse();
  const unfinished = boardBooks.some((b) => !finishYear(b));
  row.innerHTML = `
    <select id="filter-author" title="Show only one author's books">
      <option value="">All authors</option>
      ${authors.map((a) => `<option${boardFilter.author === a ? ' selected' : ''}>${esc(a)}</option>`).join('')}
    </select>
    ${viewing ? '' : `
    <select id="filter-year" title="By latest finish date — 'Not finished yet' catches reading / TBR entries">
      <option value="">All years read</option>
      ${years.map((y) => `<option${boardFilter.year === y ? ' selected' : ''}>${y}</option>`).join('')}
      ${unfinished ? `<option value="none"${boardFilter.year === 'none' ? ' selected' : ''}>Not finished yet</option>` : ''}
    </select>`}
    ${viewing ? '' : '<span class="muted small">dragging is off while a filter is on</span>'}`;
  $('#filter-author').addEventListener('change', (e) => { boardFilter.author = e.target.value; renderBoard(); });
  $('#filter-year')?.addEventListener('change', (e) => { boardFilter.year = e.target.value; renderBoard(); });
}

// Mini tag editor, opened from a chip's 🏷 button — the same tags field the
// book modal's Edit details has, without leaving the board. Lives outside
// #board so refreshBoard() (which re-renders the chips) can't wipe it.
function openTagPopover(book, anchor) {
  const pop = $('#tag-pop');
  pop.classList.remove('hidden');
  pop.innerHTML = `
    <input id="tag-input" value="${esc((book.tags || []).join(', '))}" placeholder="tags, comma separated…">
    <button class="btn" id="tag-save">Save</button>
    <button class="btn ghost" id="tag-cancel">✕</button>`;
  const r = anchor.getBoundingClientRect();
  pop.style.top = Math.max(8, Math.min(window.innerHeight - 60, r.bottom + 6)) + 'px';
  pop.style.left = Math.max(8, Math.min(window.innerWidth - 330, r.left)) + 'px';
  $('#tag-input').focus();
  const close = () => { pop.classList.add('hidden'); pop.innerHTML = ''; };
  $('#tag-cancel').addEventListener('click', close);
  const save = async () => {
    const tags = $('#tag-input').value.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      await api('/books/' + book.id, { method: 'PUT', body: { tags } });
      book.tags = tags;
      toast('Tags saved');
      close();
      await refreshBoard(); // chips re-render with the has-tags dot + tooltip
    } catch (err) {
      toast(err.message, 5000);
    }
  };
  $('#tag-save').addEventListener('click', save);
  $('#tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') close();
  });
}

function bindBoard() {
  const board = $('#board');
  if (viewing) {
    // Read-only board: chips open the book's shared info panel instead of
    // the interactive handlers (drag/tag/own-book modal).
    board.querySelectorAll('.book-chip').forEach((el) =>
      el.addEventListener('click', () => {
        const book = boardBooks.find((b) => String(b.id) === el.dataset.id);
        if (book) openBoardBookInfo(book);
      }));
    return;
  }

  board.querySelectorAll('.book-chip').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
      dragEl = el;
      dropped = false;
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      dragEl = null;
      overCell?.classList.remove('over');
      overCell = null;
      // A drag that never landed (dropped outside the board) may have shuffled
      // chips around visually mid-flight — re-render the saved order.
      if (!dropped) refreshBoard().catch((err) => toast(err.message));
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('.chip-tag')) return; // the 🏷 button handles itself
      bookModal(+el.dataset.id);
    });
  });
  board.querySelectorAll('.chip-tag').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTagPopover(boardBooks.find((b) => String(b.id) === btn.dataset.id), btn);
    }));

  // Drag/drop is delegated on the board (bound once — refreshBoard re-renders
  // the chips but keeps this element), so the WHOLE board accepts drops: tier
  // labels, the gaps between rows, and cell edges are no longer dead zones.
  if (board.dataset.dndBound) return;
  board.dataset.dndBound = '1';

  // Rows are matched by pointer Y — nearest row wins the gaps between them.
  const rowFor = (y) => {
    let best = null, bestDist = Infinity;
    for (const row of board.querySelectorAll('.tier-row')) {
      const r = row.getBoundingClientRect();
      const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (dist < bestDist) { best = row; bestDist = dist; }
    }
    return best;
  };

  // Line-aware insertion: a chip sits BEFORE the pointer unless the pointer is
  // below its line, or on its line and past its midpoint. (The old X-only
  // midpoint test broke on tiers that wrap onto several lines — the preview
  // contradicted the cursor and drops landed in the wrong place.)
  const placePreview = (cell, x, y) => {
    if (!dragEl) return;
    const neighbours = [...cell.querySelectorAll('.book-chip')].filter((c) => c !== dragEl);
    const next = neighbours.find((c) => {
      const r = c.getBoundingClientRect();
      if (y > r.bottom) return false; // the pointer is on a later line — chip stays ahead
      return !(y >= r.top && x > r.left + r.width / 2);
    });
    if (next) cell.insertBefore(dragEl, next);
    else if (dragEl.parentElement !== cell) cell.appendChild(dragEl);
  };

  board.addEventListener('dragover', (e) => {
    if (!dragEl) return; // not one of our chips (e.g. a file dragged in)
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = rowFor(e.clientY);
    if (!row) return;
    const cell = row.querySelector('.tier-cell');
    placePreview(cell, e.clientX, e.clientY);
    if (overCell !== cell) {
      overCell?.classList.remove('over');
      cell.classList.add('over');
      overCell = cell;
    }
  });

  board.addEventListener('drop', async (e) => {
    if (!dragEl) return;
    e.preventDefault();
    dropped = true;
    const row = rowFor(e.clientY);
    const cell = row ? row.querySelector('.tier-cell') : dragEl.parentElement;
    if (cell && dragEl.parentElement !== cell) cell.appendChild(dragEl);
    overCell?.classList.remove('over');
    overCell = null;
    const id = e.dataTransfer.getData('text/plain') || dragEl.dataset.id;
    if (!id || !cell) return;
    const tier = cell.dataset.tier || null;
    const ids = [...cell.querySelectorAll('.book-chip')].map((el) => +el.dataset.id);
    const book = boardBooks.find((b) => String(b.id) === id);
    if (!book) return;
    const tierChanged = (book.rating || '') !== tier;
    if (!tierChanged && sameOrder(tier, ids)) return; // let go exactly where it was
    try {
      if (tierChanged) {
        await api(`/books/${id}/rating`, { method: 'PUT', body: { rating: tier } });
      }
      await api('/board/reorder', { method: 'POST', body: { ids } });
      toast(tierChanged
        ? (tier ? `"${shortTitle(book.title)}" → ${tier}` : `Rating cleared for "${shortTitle(book.title)}"`)
        : `Order saved in ${tier || '?'}`);
      await Promise.all([refreshBoard(), refreshRollups()]);
    } catch (err) {
      toast(err.message, 5000);
      await refreshBoard();
    }
  });
}

// The order the server currently has for a tier, from the sorted boardBooks.
const sameOrder = (tier, ids) => {
  const cur = boardBooks.filter((b) => (b.rating || '') === tier).map((b) => b.id);
  return cur.length === ids.length && cur.every((v, i) => v === ids[i]);
};

// Someone else's board: a chip click opens the shared info panel — Hardcover
// catalog details (gated by the owner's share_compare, the same opt-in that
// makes the board visible) with the owner's tier letter on top. The panel is
// the same renderInfoBody used by member profiles and recommendation cards.
async function openBoardBookInfo(book) {
  openModal(`
    <div class="modal-head">
      ${book.cover_url ? `<img class="cover-m" src="${esc(book.cover_url)}">` : '<div class="cover-m blank"></div>'}
      <div>
        <h2>${esc(book.title)}</h2>
        <div class="muted">${esc(book.author || 'Unknown author')}${book.series_name ? ' · ' + esc(book.series_name) : ''}</div>
        <div style="margin-top:4px">${book.rating ? tierBadge(book.rating) : '<span class="muted small">unrated</span>'}
          <span class="muted small">— ${esc(boardOwner?.name || 'member')}'s tier</span></div>
        <div class="muted small" style="margin-top:6px" id="board-info-note">Loading details…</div>
      </div>
    </div>
    <div id="board-info-body"></div>`);
  try {
    const info = await api(`/board/${boardOwner.id}/books/${book.id}/info`);
    $('#board-info-note')?.remove();
    renderInfoBody($('#board-info-body'), info);
  } catch (err) {
    const note = $('#board-info-note');
    if (note) note.textContent = err.message;
  }
}

async function refreshRollups() {
  const { rollups } = await api('/series-rollups');
  $('#rollups').innerHTML = rollups.length ? `
    <table class="lib-table">
      <thead><tr><th>Series</th><th>Rated</th><th>Tier</th><th>Override</th></tr></thead>
      <tbody>${rollups.map((s) => `
        <tr>
          <td><div class="t">${esc(s.series)}</div></td>
          <td class="muted small">${s.rated}</td>
          <td>${s.override
            ? `${tierBadge(s.override)} <span class="muted small">override</span>`
            : `${tierBadge(s.suggested)} <span class="muted small">avg ${s.score.toFixed(2)}</span>`}</td>
          <td><select class="rollup-override" data-series="${esc(s.series)}">
            <option value="">auto (${s.suggested})</option>
            ${TIERS.map((t) => `<option value="${t}" ${s.override === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select></td>
        </tr>`).join('')}</tbody>
    </table>`
    : '<div class="muted small">No series with 2+ rated books yet.</div>';
  $('#rollups').querySelectorAll('.rollup-override').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const series = sel.dataset.series;
      try {
        await api('/series-overrides', { method: 'PUT', body: { series_name: series, rating: sel.value || null } });
        toast(sel.value ? `"${series}" locked to ${sel.value}` : `"${series}" back to auto`);
        await refreshRollups();
      } catch (err) {
        toast(err.message, 5000);
      }
    }));
}

// ---------- shareable image (client-side canvas) ----------

// Remote cover CDNs send no CORS headers, so a crossOrigin image load for
// canvas drawing is refused and the export degraded to letter tiles. The
// server relays them same-origin instead (routes/cover-proxy.js) — local
// /covers/… files were always fine and pass through untouched.
const coverSrc = (u) => (u.startsWith('/') ? u : '/cover-proxy?url=' + encodeURIComponent(u));

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // falls back to a letter tile below
    img.src = src;
  });
}

function tileRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// The text listing (the "include book list" option and the list-only export):
// titles are pre-wrapped with an offscreen measuring context (the pure
// planner only takes line counts), then the section is planned below the
// covers — or alone. Fonts here must match drawTextSection's below, or wrap
// widths drift from what gets painted.
const TITLE_FONT = '600 15px sans-serif';
const AUTHOR_FONT = '13px sans-serif';

function buildTextGroups(rows) {
  const colW = textColW();
  const measure = document.createElement('canvas').getContext('2d');
  const fit = (font, s, maxW) => {
    measure.font = font;
    let out = String(s);
    while (out.length > 1 && measure.measureText(out).width > maxW) out = out.slice(0, -1);
    return out === String(s) ? out : out + '…';
  };
  const wrap = (t) => {
    const maxW = colW - 4;
    measure.font = TITLE_FONT;
    const words = String(t || '?').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (measure.measureText(test).width <= maxW) { cur = test; continue; }
      if (cur) lines.push(cur);
      cur = measure.measureText(w).width <= maxW ? w : '';
      if (!cur) lines.push(w); // one unbreakable word wider than the column rides alone
    }
    if (cur) lines.push(cur);
    if (lines.length > 3) {
      lines.length = 3;
      lines[2] = fit(TITLE_FONT, lines[2], colW - measure.measureText('…').width);
    }
    return lines.length ? lines : ['?'];
  };
  const wraps = new Map();
  const groups = rows.filter((r) => r.books.length).map((r) => {
    for (const b of r.books) {
      wraps.set(b.id, { lines: wrap(b.title), author: fit(AUTHOR_FONT, authorLabel(b), colW) });
    }
    return {
      tier: r.tier,
      desc: r.tier ? TIER_DESC[r.tier] : 'to be rated',
      items: r.books.map((b) => ({ titleLines: wraps.get(b.id).lines.length })),
    };
  });
  return { groups, wraps };
}

// The rows both exports draw: the board in S→D order plus the unrated shelf
// (the gray "?" row) when it has books. An active filter carries over — the
// export is what you see.
function exportRows() {
  const pool = visibleBooks();
  const rows = TIERS.map((t) => ({ tier: t, books: pool.filter((b) => b.rating === t) }));
  const unrated = pool.filter((b) => !b.rating);
  if (unrated.length) rows.push({ tier: '', books: unrated });
  return { pool, rows };
}

// Shared right-hand header label ("N books · date") for both exports.
function boardCountLabel(pool) {
  const n = boardFilter.on && pool.length < boardBooks.length
    ? pool.length + ' of ' + boardBooks.length
    : boardBooks.length;
  return `${n} books · ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

async function exportImage() {
  const toastBtn = $('#board-image');
  toastBtn.disabled = true;
  toastBtn.textContent = 'Rendering…';
  try {
    const { pool, rows } = exportRows();

    const geo = planExport(rows.map((r) => ({
      tier: r.tier,
      desc: r.tier ? TIER_DESC[r.tier] : 'to be rated',
      count: r.books.length,
    })));

    let text = null;
    let wraps = null;
    if (exportList) {
      const built = buildTextGroups(rows);
      wraps = built.wraps;
      text = planTextSection(built.groups, geo.H);
    }

    const fullH = geo.H + (text?.H || 0);
    if (fullH > 10000) throw new Error('too many books for one image — narrow it with ▽ Filter');
    // Safari caps canvas AREA (~16.7M px²) — huge boards silently blanked
    // there. DPI steps down for tall exports instead (retina sharpness for
    // typical sizes, gracefully lower for whoppers).
    const scale = Math.max(1, Math.min(2, Math.sqrt(16e6 / (geo.W * fullH))));
    const canvas = document.createElement('canvas');
    canvas.width = geo.W * scale;
    canvas.height = fullH * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, geo.W, fullH);
    ctx.fillStyle = '#8b93a7';
    ctx.font = '600 15px sans-serif';
    ctx.textBaseline = 'top';
    const title = boardOwner ? `InkHearth — ${boardOwner.name}'s tier list` : 'InkHearth — tier list';
    ctx.fillText(title, geo.pad, geo.titleTop);
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(boardCountLabel(pool), geo.W - geo.pad, geo.titleTop + 3);
    ctx.textAlign = 'left';

    const wanted = pool.filter((b) => b.cover_url);
    const coverJobs = new Map();
    let done = 0;
    await Promise.all(wanted.map((b) => loadImage(coverSrc(b.cover_url)).then((img) => {
      coverJobs.set(b.id, img);
      toastBtn.textContent = `Rendering… ${++done}/${wanted.length}`;
    })));

    const drawTile = (b, x, y) => {
      tileRect(ctx, x, y, geo.coverW, geo.coverH, 4);
      ctx.fillStyle = '#1f2532';
      ctx.fill();
      const img = coverJobs.get(b.id);
      if (img) {
        // Aspect-fit inside the tile — covers from different CDNs drift off
        // the exact 2:3 box, and stretch looks worse than a hairline bar.
        const s = Math.min(geo.coverW / img.width, geo.coverH / img.height);
        ctx.drawImage(img, x + (geo.coverW - img.width * s) / 2, y + (geo.coverH - img.height * s) / 2,
          img.width * s, img.height * s);
      } else {
        ctx.fillStyle = '#8b93a7';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((b.title || '?')[0], x + geo.coverW / 2, y + 36);
        ctx.textAlign = 'left';
      }
      if (bookDnf(b)) {
        tileRect(ctx, x + geo.coverW - 29, y + 3, 26, 13, 6.5);
        ctx.fillStyle = '#c0504d';
        ctx.fill();
        ctx.font = 'bold 8px sans-serif';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('DNF', x + geo.coverW - 16, y + 10);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
      }
    };

    for (const row of geo.rows) {
      const books = rows.find((r) => r.tier === row.tier).books;
      const isUnrated = row.tier === '';
      tileRect(ctx, geo.pad, row.y, geo.labelW, row.h, 8);
      ctx.fillStyle = isUnrated ? '#232936' : TIER_COLORS[row.tier];
      ctx.fill();
      if (isUnrated) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#3a4152';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = isUnrated ? '#8b93a7' : '#10131a';
      ctx.textAlign = 'center';
      ctx.font = 'bold 40px sans-serif';
      ctx.fillText(isUnrated ? '?' : row.tier, geo.pad + geo.labelW / 2, row.y + row.h / 2 - 26);
      ctx.font = '600 10px sans-serif';
      ctx.fillText(row.desc.toUpperCase(), geo.pad + geo.labelW / 2, row.y + row.h / 2 + 22);
      ctx.textAlign = 'left';
      books.forEach((b, i) => drawTile(b, row.cells[i].x, row.cells[i].y));
    }

    // The text listing below the covers (shared with the list-only export).
    if (text && text.groups.length) drawTextSection(ctx, text, rows, wraps);

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('canvas export failed');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tier-list-${new Date().getFullYear()}${text && text.groups.length ? '-with-list' : ''}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Tier list image downloaded');
  } catch (err) {
    toast('Image export failed: ' + err.message, 6000);
  } finally {
    toastBtn.disabled = false;
    toastBtn.textContent = '⬇ Export as image';
  }
}

// Per tier a divider, a colored pill (letter + description), then wrapped
// title + author columns — drawn below the covers in the combined export,
// or alone by exportListImage.
function drawTextSection(ctx, text, rows, wraps) {
  const booksFor = new Map(rows.map((r) => [r.tier, r.books]));
  for (const g of text.groups) {
    ctx.strokeStyle = '#232936';
    ctx.beginPath();
    ctx.moveTo(LAYOUT.pad, g.dividerY + 0.5);
    ctx.lineTo(LAYOUT.W - LAYOUT.pad, g.dividerY + 0.5);
    ctx.stroke();

    const isUnrated = g.tier === '';
    ctx.font = '600 12px sans-serif';
    const label = `${isUnrated ? '?' : g.tier} · ${g.desc.toUpperCase()}`;
    const pillW = Math.ceil(ctx.measureText(label).width) + 22;
    tileRect(ctx, LAYOUT.pad, g.pillY, pillW, TEXT_LAYOUT.pillH, 13);
    ctx.fillStyle = isUnrated ? '#232936' : TIER_COLORS[g.tier];
    ctx.fill();
    ctx.fillStyle = isUnrated ? '#8b93a7' : '#10131a';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, LAYOUT.pad + 11, g.pillY + TEXT_LAYOUT.pillH / 2 + 1);
    ctx.textBaseline = 'top';

    const books = booksFor.get(g.tier);
    for (const col of g.cols) {
      for (const it of col.items) {
        const w = wraps.get(books[it.i].id);
        ctx.font = TITLE_FONT;
        ctx.fillStyle = '#e8ebf2';
        w.lines.forEach((ln, i) => ctx.fillText(ln, it.x, it.y + i * TEXT_LAYOUT.titleLineH));
        ctx.font = AUTHOR_FONT;
        ctx.fillStyle = '#c9a06b';
        ctx.fillText(w.author, it.x, it.y + w.lines.length * TEXT_LAYOUT.titleLineH);
        if (bookDnf(books[it.i])) {
          // A small DNF mark rides right beside the title; when a long
          // title leaves no room on its lines, it tucks onto the author
          // line instead.
          ctx.font = TITLE_FONT;
          const lastW = ctx.measureText(w.lines[w.lines.length - 1]).width;
          const firstW = ctx.measureText(w.lines[0]).width;
          ctx.font = AUTHOR_FONT;
          const authW = ctx.measureText(w.author).width;
          const colEnd = col.x + text.colW;
          const spots = [
            { x: it.x + lastW + 8, y: it.y + (w.lines.length - 1) * TEXT_LAYOUT.titleLineH + 4 },
            { x: it.x + authW + 8, y: it.y + w.lines.length * TEXT_LAYOUT.titleLineH + 2 },
            { x: it.x + firstW + 8, y: it.y + 4 },
          ];
          const spot = spots.find((s) => s.x + 28 <= colEnd) || spots[2];
          tileRect(ctx, spot.x, spot.y, 28, 13, 6.5);
          ctx.fillStyle = '#c0504d';
          ctx.fill();
          ctx.font = 'bold 8px sans-serif';
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('DNF', spot.x + 14, spot.y + 7);
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
        }
      }
    }
  }
}

// The book list as its OWN picture — no covers. Posts beside the covers
// export as a second, much smaller image.
async function exportListImage() {
  const toastBtn = $('#board-image-list');
  toastBtn.disabled = true;
  toastBtn.textContent = 'Rendering…';
  try {
    const { pool, rows } = exportRows();
    if (!pool.length) throw new Error('nothing on the board to list');

    const { groups, wraps } = buildTextGroups(rows);
    const text = planTextSection(groups, LAYOUT.headerH);
    const fullH = LAYOUT.headerH + text.H;
    if (fullH > 10000) throw new Error('too many books for one image — narrow it with ▽ Filter');
    // Safari caps canvas AREA (~16.7M px²) — same DPI step-down as the
    // combined export.
    const scale = Math.max(1, Math.min(2, Math.sqrt(16e6 / (LAYOUT.W * fullH))));
    const canvas = document.createElement('canvas');
    canvas.width = LAYOUT.W * scale;
    canvas.height = fullH * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, LAYOUT.W, fullH);
    ctx.fillStyle = '#8b93a7';
    ctx.font = '600 15px sans-serif';
    ctx.textBaseline = 'top';
    const title = boardOwner ? `InkHearth — ${boardOwner.name}'s book list` : 'InkHearth — book list';
    ctx.fillText(title, LAYOUT.pad, LAYOUT.titleTop);
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(boardCountLabel(pool), LAYOUT.W - LAYOUT.pad, LAYOUT.titleTop + 3);
    ctx.textAlign = 'left';

    drawTextSection(ctx, text, rows, wraps);

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('canvas export failed');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tier-list-${new Date().getFullYear()}-book-list.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Book list image downloaded');
  } catch (err) {
    toast('List export failed: ' + err.message, 6000);
  } finally {
    toastBtn.disabled = false;
    toastBtn.textContent = '⬇ Export list only';
  }
}

// '#board' = your own interactive board; '#board/<userId>' = read-only view
// of another member's board (the prefix form the router matches by startsWith).
registerRoute('#board', tierboard);
registerRoute('#board/', tierboard);
