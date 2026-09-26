import { api } from '../api.js';
import { $, esc, guard } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { bookModal } from '../book-modal.js';

// Active mood chip survives re-renders (next-up toggles rerun the route).
let moodPick = '';

async function tbrView() {
  view.innerHTML = `<h1>TBR queue</h1><div id="tbr-list"><div class="loading">Loading…</div></div>`;
  const { entries } = await api('/tbr');
  if (!entries.length) {
    $('#tbr-list').innerHTML = `<div class="empty">Nothing queued.<br>
      Mark books as TBR from their page in the <a href="#library">Library</a> —
      or from recommendation cards, once V3 lands.</div>`;
    return;
  }

  // Moods across the queue drive the "in the mood for" chips; picking one
  // narrows the table, and 🎲 opens a random book from whatever is showing.
  const moodSet = new Set();
  for (const e of entries) for (const m of e.moods || []) moodSet.add(m);
  const moods = [...moodSet].sort((a, b) => a.localeCompare(b));
  if (moodPick && !moods.includes(moodPick)) moodPick = '';
  const shown = moodPick ? entries.filter((e) => (e.moods || []).includes(moodPick)) : entries;

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
        <td><div class="t">${esc(e.title)}</div><div class="muted small">${esc(e.author || '')}${e.series_name ? ` · ${esc(e.series_name)}${e.series_order ? ' #' + e.series_order : ''}` : ''}</div>
          ${(e.moods || []).length ? `<div>${e.moods.map((m) => `<span class="pill">${esc(m)}</span>`).join(' ')}</div>` : ''}</td>
        <td class="muted small">${esc((e.added_at || '').slice(0, 10))}</td>
        <td style="white-space:nowrap">
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
      if (e.target.closest('button')) return;
      bookModal(+tr.dataset.id);
    }));
  $('#tbr-list').querySelectorAll('.next-up').forEach((btn) =>
    btn.addEventListener('click', guard(async () => {
      await api('/tbr/next-up', { method: 'POST', body: { book_id: +btn.dataset.id } });
      tbrView();
    })));
  $('#tbr-list').querySelectorAll('.tbr-remove').forEach((btn) =>
    btn.addEventListener('click', guard(async () => {
      await api('/tbr/book/' + btn.dataset.id, { method: 'DELETE' });
      tbrView();
    })));
}

registerRoute('#tbr', tbrView);
