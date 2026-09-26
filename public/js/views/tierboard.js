import { api } from '../api.js';
import { $, esc, toast, tierBadge, TIERS } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { bookModal, openModal } from '../book-modal.js';
import { renderInfoBody } from '../book-info.js';

const TIER_DESC = { S: 'Loved it!', A: 'excellent', B: 'liked it', C: 'fine', D: 'disliked / DNF' };
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

const shortTitle = (t) => (t.length > 38 ? t.slice(0, 37) + '…' : t);

async function tierboard() {
  const parts = location.hash.split('/');
  viewing = parts[0] === '#board' && Number.isInteger(+parts[1]) && parts[1] !== '' ? +parts[1] : null;

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
      <button class="btn ghost" id="board-image">⬇ Export as image</button>
      <span id="board-count" class="muted small"></span>
    </div>
    <div class="board" id="board"><div class="loading">Loading…</div></div>`
    : `
    <h1>Tier board</h1>
    <p class="muted">Drag books between tiers, or within a tier to arrange them — changes save instantly.
    Books without entries (TBR / catalog-only) don't appear here.</p>
    <div class="toolbar">
      <button class="btn ghost" id="board-image">⬇ Export as image</button>
      <span id="board-count" class="muted small"></span>
    </div>
    <div class="board" id="board"><div class="loading">Loading…</div></div>
    <div id="tag-pop" class="tag-pop hidden"></div>
    <h3 style="margin-top:26px">Series rollups</h3>
    <p class="muted small">Average of members' current tiers (D=1 … S=5) across series with 2+ rated books.
    The override column wins over the math.</p>
    <div class="card" id="rollups"><div class="loading">Loading…</div></div>`;
  $('#board-image').addEventListener('click', exportImage);
  if (viewing) {
    await refreshBoard(true);
  } else {
    await Promise.all([refreshBoard(), refreshRollups()]);
  }
}

const chip = (b) => `
  <div class="book-chip${viewing ? ' chip-view' : ''}" draggable="${viewing ? 'false' : 'true'}" data-id="${b.id}" title="${esc(b.title)}">
    ${b.cover_url ? `<img src="${esc(b.cover_url)}" loading="lazy" draggable="false">` : '<div class="chip-cover blank"></div>'}
    <span>${esc(shortTitle(b.title))}</span>
    ${viewing ? '' : `<button type="button" class="chip-tag${(b.tags || []).length ? ' has-tags' : ''}" data-id="${b.id}" title="${(b.tags || []).length ? 'Tags: ' + esc(b.tags.join(', ')) : 'Add tags'}">🏷</button>`}
  </div>`;

async function refreshBoard() {
  if (!viewing) {
    const { books } = await api('/books');
    boardBooks = books.filter((b) => b.event_count > 0);
  }
  // Rows render S→D then unrated; within a tier, hand-arranged books keep
  // their saved position (tier_order), the rest trail newest-first.
  const rank = (b) => {
    const i = TIERS.indexOf(b.rating || '');
    return (i === -1 ? TIERS.length : i) * 1e9 + (b.tier_order ?? 1e9);
  };
  boardBooks.sort((a, b) => (rank(a) - rank(b)) || (b.id - a.id));
  $('#board-count').textContent = `${boardBooks.length} books with entries`;
  const byTier = Object.fromEntries([...TIERS, ''].map((t) => [t, []]));
  for (const b of boardBooks) byTier[b.rating || ''].push(b);
  $('#board').innerHTML = [...TIERS, ''].map((t) => `
    <div class="tier-row">
      <div class="tier-label ${t ? 'tier-' + t : 'unrated'}">${t || '?'}${t ? `<span class="tier-desc">${TIER_DESC[t]}</span>` : '<span class="tier-desc">to be rated</span>'}</div>
      <div class="tier-cell" data-tier="${t}">${byTier[t].map(chip).join('') || `<span class="muted small cell-hint">${viewing ? '' : 'drop here'}</span>`}</div>
    </div>`).join('');
  bindBoard();
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

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    // Remote covers (Hardcover CDN) load only if they send CORS headers;
    // failures fall back to a text tile and keep the canvas exportable.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function exportImage() {
  const toastBtn = $('#board-image');
  toastBtn.disabled = true;
  toastBtn.textContent = 'Rendering…';
  try {
    const rows = TIERS.map((t) => ({ t, books: boardBooks.filter((b) => b.rating === t) }));
    const scale = 2, W = 1280, labelW = 130, rowH = 96, pad = 20;
    const H = pad * 2 + rows.length * rowH + 46;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#8b93a7';
    ctx.font = '600 15px sans-serif';
    ctx.fillText(`InkHearth — tier list`, pad, pad + 4);

    const coverJobs = new Map();
    for (const b of boardBooks) if (b.cover_url) coverJobs.set(b.id, loadImage(b.cover_url));
    // Settle the resolved images back into the map — the Promises themselves
    // are not valid drawImage sources.
    for (const [id, job] of coverJobs) coverJobs.set(id, await job);

    const oy = pad + 26;
    rows.forEach((row, i) => {
      const y = oy + i * rowH;
      ctx.fillStyle = TIER_COLORS[row.t];
      ctx.fillRect(pad, y, labelW - 14, rowH - 10);
      ctx.fillStyle = '#10131a';
      ctx.font = 'bold 40px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(row.t, pad + 44, y + 18);

      let x = labelW + pad;
      let shown = 0;
      for (const b of row.books) {
        const img = coverJobs.get(b.id);
        if (img) {
          ctx.drawImage(img, x, y + 3, 52, 76);
        } else {
          ctx.fillStyle = '#1f2532';
          ctx.fillRect(x, y + 3, 52, 76);
          ctx.fillStyle = '#8b93a7';
          ctx.font = 'bold 22px sans-serif';
          ctx.fillText((b.title || '?')[0], x + 20, y + 28);
        }
        x += 60;
        shown++;
        if (x > W - pad - 70) {
          const rest = row.books.length - shown;
          if (rest > 0) {
            ctx.fillStyle = '#8b93a7';
            ctx.font = '13px sans-serif';
            ctx.fillText(`+${rest} more`, x, y + 32);
          }
          break;
        }
      }
      if (!row.books.length) {
        ctx.fillStyle = '#4a5164';
        ctx.font = '14px sans-serif';
        ctx.fillText('—', labelW + pad, y + 32);
      }
    });

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('canvas export failed');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tier-list-${new Date().getFullYear()}.png`;
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

// '#board' = your own interactive board; '#board/<userId>' = read-only view
// of another member's board (the prefix form the router matches by startsWith).
registerRoute('#board', tierboard);
registerRoute('#board/', tierboard);
