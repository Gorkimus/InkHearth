// The polls page: every poll, live ones first, plus "Start a poll" — the
// create form seeded from the club's TBR shelves, everyone's ⭐ next-up
// pre-ticked. Cards render through the shared polls.js component, so this
// page, the dashboard banner and the bell's modal all stay in one shape.
import { api } from '../api.js';
import { $, esc, toast } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { openModal, closeModal } from '../book-modal.js';
import { pollCardHTML, bindPoll, endOfDayUtc } from '../polls.js';

async function pollsView() {
  view.innerHTML = `
    <div class="toolbar" style="justify-content:space-between">
      <h1 style="margin:0">Club polls</h1>
      <button class="btn" id="poll-new">🗳 Start a poll</button>
    </div>
    <div id="poll-list" style="display:grid;gap:12px;margin-top:12px">
      <div class="muted small">Loading…</div>
    </div>`;
  $('#poll-new').addEventListener('click', openCreateModal);
  await loadPolls();
}

async function loadPolls() {
  const box = $('#poll-list');
  if (!box) return;
  let data;
  try { data = await api('/polls'); } catch (err) {
    if (box.isConnected) box.innerHTML = `<div class="card"><div class="muted small">${esc(err.message)}</div></div>`;
    return;
  }
  if (!box.isConnected) return; // view changed while fetching
  box.innerHTML = data.polls.length
    ? data.polls.map((p) => `<div class="card" data-poll-card="${p.id}">${pollCardHTML(p)}</div>`).join('')
    : '<div class="card"><div class="muted small">No polls yet. Start one — the club\u2019s ⭐ next-ups are one tap away.</div></div>';
  data.polls.forEach((p) => {
    const card = box.querySelector(`[data-poll-card="${p.id}"]`);
    if (card) bindPoll(card, loadPolls);
  });
}

async function openCreateModal() {
  let seed;
  try { seed = await api('/polls/options'); } catch (err) { toast(err.message); return; }
  openModal(`
    <h2>Start a club poll</h2>
    <div class="field"><label>Question</label>
      <input id="poll-q" maxlength="200" placeholder="What should the club read next?"></div>
    <div class="field"><label>Closes (optional)</label>
      <input id="poll-deadline" type="date" min="${new Date().toLocaleDateString('en-CA')}"></div>
    <div class="muted small" style="margin:2px 0 8px">Pick 2–8 books from the club's TBR shelves — everyone's
    ⭐ next-up is pre-ticked. Voting is live; the winner becomes the Hearth pick.</div>
    <div id="poll-picker" style="max-height:300px;overflow-y:auto">
      ${seed.options.map((o) => `
        <label class="poll-pick-row">
          <input type="checkbox" data-book="${o.book_id}" ${o.is_next_up ? 'checked' : ''}>
          ${o.cover_url ? `<img class="poll-cover" src="${esc(o.cover_url)}" alt="" referrerpolicy="no-referrer">` : ''}
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${esc(o.title)}<span class="muted small"> · ${esc(o.author || 'unknown')}</span></span>
          <span class="muted small" style="flex:none">${o.is_next_up ? '⭐ ' : ''}${esc(o.owners.join(', '))}</span>
        </label>`).join('') || '<div class="muted small">Nothing is queued on anyone\u2019s TBR yet — queue a book or two first.</div>'}
    </div>
    <div class="modal-foot" style="justify-content:space-between;align-items:center">
      <span class="muted small" id="poll-pick-count"></span>
      <button class="btn" id="poll-create">Open the poll</button>
    </div>`);
  const count = () => {
    const n = document.querySelectorAll('#poll-picker input:checked').length;
    const el = $('#poll-pick-count');
    if (el) el.textContent = `${n} selected${n < 2 ? ' — need at least 2' : n > 8 ? ' — 8 max' : ''}`;
  };
  document.querySelectorAll('#poll-picker input').forEach((i) => i.addEventListener('change', count));
  count();
  $('#poll-create').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const book_ids = [...document.querySelectorAll('#poll-picker input:checked')].map((i) => +i.dataset.book);
    if (book_ids.length < 2) return toast('Pick at least 2 books');
    if (book_ids.length > 8) return toast('8 books max');
    const dl = $('#poll-deadline').value;
    btn.disabled = true;
    try {
      await api('/polls', { method: 'POST', body: {
        question: $('#poll-q').value.trim() || undefined,
        closes_at: dl ? endOfDayUtc(dl) : undefined,
        book_ids,
      } });
      toast('Poll is live — the club has been nudged');
      closeModal();
      loadPolls();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
}

registerRoute('#polls', pollsView);
