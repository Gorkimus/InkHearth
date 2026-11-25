import { api } from '../api.js';
import { $, esc, guard, toast } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { bookModal } from '../book-modal.js';
import { planTbrGrid } from '../tbr-export-layout.js';
import { mdEntry, listMarkdown, saveTextList } from '../text-export.js';

// Active mood chip survives re-renders (next-up toggles rerun the route).
let moodPick = '';
// Series collapsing is a per-device choice, like the search page's toggles.
let collapseSeries = localStorage.getItem('bt-tbr-collapse') === '1';

async function tbrView() {
  view.innerHTML = `<h1>TBR queue</h1>
    <div class="toolbar"><button class="btn ghost" id="tbr-image" hidden
      title="Download the queue as a shareable PNG — series roll up to their next unread volume">⬇ Export as image</button>
      <button class="btn ghost" id="tbr-text" hidden
        title="Download the queue as Markdown text — one line per series, like the image — to paste under it in a post">⬇ Export as text</button>
      <button class="btn ghost" id="tbr-collapse" aria-pressed="${collapseSeries}"
        title="One row per series — show only the next volume you haven't read">📚 Collapse series</button>
      <span id="tbr-note" class="muted small"></span></div>
    <div id="tbr-list"><div class="loading">Loading…</div></div>`;
  const { entries } = await api('/tbr');
  renderList(entries);
}

// Row actions refresh the list in place: the heading and scroll position stay
// put instead of collapsing through the loading state and bouncing to the top.
async function refreshList() {
  const y = window.scrollY;
  const { entries } = await api('/tbr');
  renderList(entries);
  window.scrollTo(0, y);
}

// The next unread volume of a series: unread before read (queued ≠ unread —
// re-queues and read-out-of-order are supported flows), then lowest series
// order (a null order never displaces a known one), then earliest queued.
// A series whose every volume is read still sorts to its first volume —
// re-read queues deserve a face too.
const unreadFirst = (a, b) => (!!a.finished - !!b.finished)
  || ((a.series_order ?? Infinity) - (b.series_order ?? Infinity))
  || ((a.added_at || '') < (b.added_at || '') ? -1 : (a.added_at || '') > (b.added_at || '') ? 1 : 0);

function renderList(entries) {
  const imageBtn = $('#tbr-image');
  const textBtn = $('#tbr-text');
  if (!entries.length) {
    if (imageBtn) imageBtn.hidden = true;
    if (textBtn) textBtn.hidden = true;
    $('#tbr-list').innerHTML = `<div class="empty">Nothing queued.<br>
      Mark books as TBR from their page in the <a href="#library">Library</a> —
      or from recommendation cards, once V3 lands.</div>`;
    return;
  }

  // Moods across the queue drive the "in the mood for" chips; picking one
  // narrows the table, and 🎲 opens a random book from whatever is showing.
  // Chips build from ALL entries so collapsing never starves a mood of its
  // color; the collapse itself runs first so the survivor pick is stable
  // regardless of the mood filter.
  const moodSet = new Set();
  for (const e of entries) for (const m of e.moods || []) moodSet.add(m);
  const moods = [...moodSet].sort((a, b) => a.localeCompare(b));
  if (moodPick && !moods.includes(moodPick)) moodPick = '';

  // One row per series when collapsing: the series keeps the queue position
  // of its first-seen entry (a pinned series still leads), the row itself is
  // the series' next unread volume, and what got hidden rides along for the
  // "+N queued" pill (with a ⭐ if the next-up star is inside).
  let collapsedCount = 0;
  let collapsed = entries;
  if (collapseSeries) {
    const rows = [];
    const bySeries = new Map();
    for (const e of entries) {
      const series = (e.series_name || '').trim();
      if (!series) { rows.push(e); continue; }
      const group = bySeries.get(series);
      if (group) group.push(e);
      else { const arr = [e]; bySeries.set(series, arr); rows.push(arr); }
    }
    collapsed = rows.map((row) => Array.isArray(row)
      ? (() => {
        const group = [...row].sort(unreadFirst);
        const [survivor, ...hidden] = group;
        if (hidden.length) collapsedCount++;
        return { ...survivor, hidden };
      })()
      : row);
  }
  const shown = moodPick ? collapsed.filter((e) => (e.moods || []).includes(moodPick)) : collapsed;

  const collapseBtn = $('#tbr-collapse');
  if (collapseBtn) {
    collapseBtn.classList.toggle('sel', collapseSeries);
    collapseBtn.setAttribute('aria-pressed', String(collapseSeries));
    // Assignment, not addEventListener: renderList re-runs on every refresh
    // and the button lives outside #tbr-list — listeners would stack.
    collapseBtn.onclick = () => {
      collapseSeries = !collapseSeries;
      localStorage.setItem('bt-tbr-collapse', collapseSeries ? '1' : '0');
      renderList(entries);
    };
  }
  const note = $('#tbr-note');
  if (note) note.textContent = collapseSeries && collapsedCount
    ? `${collapsedCount} series collapsed to their next unread volume` : '';

  // Both export buttons ride the same shown list: a mood filter that matches
  // nothing exports nothing, either way.
  if (imageBtn) {
    imageBtn.hidden = false;
    imageBtn.disabled = !shown.length;
    // Assignment, not addEventListener: renderList runs on every refresh and
    // the button lives outside #tbr-list, so listeners would stack.
    imageBtn.onclick = () => exportTbrImage(shown, imageBtn);
  }
  if (textBtn) {
    textBtn.hidden = false;
    textBtn.disabled = !shown.length;
    textBtn.onclick = () => exportTbrText(shown, textBtn); // same assignment rule
  }

  $('#tbr-list').innerHTML = `
    ${moods.length ? `
    <div class="card" style="margin-bottom:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="muted small">In the mood for…</span>
      <span class="chips">
        ${moods.map((m) => `<button class="chip${m === moodPick ? ' sel' : ''}" data-mood="${esc(m)}">${esc(m)}</button>`).join('')}
      </span>
      <button class="btn ghost" id="tbr-surprise" style="padding:4px 12px;font-size:13px" ${shown.length ? '' : 'disabled'}>🎲 Surprise me</button>
    </div>` : ''}
    <table class="lib-table"><thead><tr><th></th><th>Book</th><th>Queued</th><th></th></tr></thead><tbody>
    ${shown.map((e) => `
      <tr data-id="${e.book_id}">
        <td>${e.cover_url ? `<img class="cover-s" src="${esc(e.cover_url)}" loading="lazy">` : '<div class="cover-s blank"></div>'}</td>
        <td><div class="t">${esc(e.title)}</div><div class="muted small">${e.author ? `<a class="text-link" href="#search/author/${encodeURIComponent(e.author)}">${esc(e.author)}</a>` : ''}${e.series_name ? ` · <a class="text-link" href="#search/series/${encodeURIComponent(e.series_name)}">${esc(e.series_name)}</a>${e.series_order != null ? ' #' + e.series_order : ''}` : ''}</div>
          ${(e.moods || []).length ? `<div>${e.moods.map((m) => `<span class="pill">${esc(m)}</span>`).join(' ')}</div>` : ''}
          ${e.hidden && e.hidden.length ? `<div><span class="pill" title="${esc(e.hidden.map((h) => h.title).join(', '))} — queued in this series, hidden by Collapse series">📚${e.hidden.some((h) => h.is_next_up) ? ' ⭐' : ''} +${e.hidden.length} queued</span></div>` : ''}</td>
        <td class="muted small">${esc((e.added_at || '').slice(0, 10))}</td>
        <td style="white-space:nowrap">
          ${e.bumps ? `<span class="pill" title="Bumped by ${esc((e.bumpers || []).join(', '))} — the household votes you read this next">👍 ${e.bumps}</span> ` : ''}
          <button class="btn ghost next-up" data-id="${e.book_id}" style="padding:4px 10px;font-size:12px">${e.is_next_up ? '⭐ Next up' : '☆ Next up'}</button>
          <button class="btn ghost tbr-remove" data-id="${e.book_id}" style="padding:4px 10px;font-size:12px">Remove</button>
        </td>
      </tr>`).join('')}
    </tbody></table>
    ${!shown.length ? '<div class="empty">Nothing in the queue matches that mood.</div>' : ''}`;

  $('#tbr-list').querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      moodPick = moodPick === chip.dataset.mood ? '' : chip.dataset.mood;
      tbrView();
    }));
  const surprise = $('#tbr-surprise');
  if (surprise) surprise.addEventListener('click', () => {
    const pick = shown[Math.floor(Math.random() * shown.length)];
    if (pick) bookModal(pick.book_id);
  });
  $('#tbr-list').querySelectorAll('tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return; // author/series links go to Log a book
      bookModal(+tr.dataset.id);
    }));
  $('#tbr-list').querySelectorAll('.next-up').forEach((btn) =>
    btn.addEventListener('click', guard(async () => {
      await api('/tbr/next-up', { method: 'POST', body: { book_id: +btn.dataset.id } });
      await refreshList();
    })));
  $('#tbr-list').querySelectorAll('.tbr-remove').forEach((btn) =>
    btn.addEventListener('click', guard(async () => {
      await api('/tbr/book/' + btn.dataset.id, { method: 'DELETE' });
      await refreshList();
    })));
}

// ---------- shareable image (client-side canvas) ----------

// Remote cover CDNs send no CORS headers, so canvas images ride the
// same-origin relay (routes/cover-proxy.js); local /covers/… pass through.
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

// One tile per series: the entry sitting earliest in the queue owns the
// slot's position (so a pinned series leads the image), and the tile's face
// is the series' next UNREAD volume — the same rule the list's Collapse
// series toggle uses (unread first, then lowest series_order, then earliest
// queued), so the image and the list tell the same story.
function rollupSeries(entries) {
  const bySeries = new Map();
  const tiles = [];
  for (const e of entries) {
    const series = (e.series_name || '').trim();
    if (!series) {
      tiles.push({ ...e, extra: 0 });
      continue;
    }
    const slot = bySeries.get(series);
    if (!slot) {
      const tile = { ...e, extra: 0 };
      bySeries.set(series, tile);
      tiles.push(tile);
      continue;
    }
    slot.extra++;
    if (unreadFirst(e, slot) < 0) {
      Object.assign(slot, { ...e, extra: slot.extra });
    }
  }
  return tiles;
}

// The tiles both exports draw: one per series, whatever the Collapse series
// toggle says. Toggle off, the full queue arrives and is rolled up here.
// Toggle on, renderList has already handed over one entry per series with the
// rest of its volumes parked in `hidden`, so those counts come back out —
// without this the same queue exported a bare tile and a shorter count just
// because the toggle was on.
function tbrTiles(shown) {
  return collapseSeries ? shown.map((e) => ({ ...e, extra: (e.hidden || []).length })) : rollupSeries(shown);
}

// The header's right-hand label: how many books (rolled-in volumes count),
// how many series rolled up, the date — shared by the image and its text.
function tbrCountLabel(tiles) {
  const books = tiles.reduce((n, t) => n + 1 + t.extra, 0);
  const rolled = tiles.reduce((n, t) => n + (t.extra ? 1 : 0), 0);
  return `${books} book${books === 1 ? '' : 's'}`
    + `${rolled ? ` · ${rolled} series rolled up` : ''}`
    + ` · ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

async function exportTbrImage(shown, toastBtn) {
  toastBtn.disabled = true;
  toastBtn.textContent = 'Rendering…';
  try {
    const tiles = tbrTiles(shown);
    const geo = planTbrGrid(tiles.length);
    if (geo.H > 10000) throw new Error('too many books for one image');

    // Safari caps canvas AREA (~16.7M px²) — DPI steps down for huge queues
    // (retina sharpness for typical sizes, gracefully lower for whoppers).
    const scale = Math.max(1, Math.min(2, Math.sqrt(16e6 / (geo.W * geo.H))));
    const canvas = document.createElement('canvas');
    canvas.width = geo.W * scale;
    canvas.height = geo.H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#10131a';
    ctx.fillRect(0, 0, geo.W, geo.H);
    ctx.fillStyle = '#8b93a7';
    ctx.font = '600 15px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('InkHearth — TBR', geo.pad, geo.titleTop);
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(tbrCountLabel(tiles), geo.W - geo.pad, geo.titleTop + 3);
    ctx.textAlign = 'left';

    // Covers key on book_id — /tbr entries have no other stable id, and one
    // shared key would leave every tile painting whichever image loaded last.
    const wanted = tiles.filter((t) => t.cover_url);
    const coverJobs = new Map();
    let done = 0;
    await Promise.all(wanted.map((t) => loadImage(coverSrc(t.cover_url)).then((img) => {
      coverJobs.set(t.book_id, img);
      toastBtn.textContent = `Rendering… ${++done}/${wanted.length}`;
    })));

    tiles.forEach((t, i) => {
      const { x, y } = geo.cells[i];
      tileRect(ctx, x, y, geo.coverW, geo.coverH, 4);
      ctx.fillStyle = '#1f2532';
      ctx.fill();
      const img = coverJobs.get(t.book_id);
      if (img) {
        // Aspect-fit inside the tile — covers from different CDNs drift off
        // the exact 2:3 box, and stretch looks worse than a hairline bar.
        const s = Math.min(geo.coverW / img.width, geo.coverH / img.height);
        ctx.drawImage(img, x + (geo.coverW - img.width * s) / 2, y + (geo.coverH - img.height * s) / 2,
          img.width * s, img.height * s);
      } else {
        ctx.fillStyle = '#8b93a7';
        ctx.font = `bold ${Math.round(geo.coverW * 0.3)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText((t.title || '?')[0], x + geo.coverW / 2, y + geo.coverH * 0.38);
        ctx.textAlign = 'left';
      }
      if (t.extra) {
        // Rolled-up series wear a ×N badge (N = queued volumes, shown one
        // included) so the collapsed books stay legible in the share.
        const label = `×${t.extra + 1}`;
        ctx.font = 'bold 11px sans-serif';
        const w = Math.ceil(ctx.measureText(label).width) + 12;
        tileRect(ctx, x + geo.coverW - w - 4, y + 4, w, 17, 8.5);
        ctx.fillStyle = '#5b9bd5';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + geo.coverW - w / 2 - 4, y + 13);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
      }
    });

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('canvas export failed');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tbr-${new Date().getFullYear()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('TBR image downloaded');
  } catch (err) {
    toast('Image export failed: ' + err.message, 6000);
  } finally {
    toastBtn.disabled = false;
    toastBtn.textContent = '⬇ Export as image';
  }
}

// The queue as TEXT — the image's own tiles (tbrTiles: one line per series,
// its next unread volume, a note for the volumes rolled in), as Markdown.
// No covers to load, so it is instant.
function exportTbrText(shown, toastBtn) {
  toastBtn.disabled = true;
  try {
    const tiles = tbrTiles(shown);
    if (!tiles.length) throw new Error('nothing in the queue to list');
    const text = listMarkdown({
      heading: 'InkHearth — TBR',
      note: tbrCountLabel(tiles),
      sections: [{
        items: tiles.map((t) => mdEntry({
          title: t.title, author: t.author, series: t.series_name, seriesOrder: t.series_order,
          notes: t.extra ? [`+${t.extra} queued`] : [],
        })),
      }],
    });
    saveTextList({
      filename: `tbr-${new Date().getFullYear()}.md`,
      text,
      what: 'TBR list',
    });
  } catch (err) {
    toast('Text export failed: ' + err.message, 6000);
  } finally {
    toastBtn.disabled = false;
  }
}

registerRoute('#tbr', tbrView);
