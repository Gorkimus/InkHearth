// The bell: an unread badge refreshed on every view render (router.js
// announces each one) plus once a minute while the tab is visible, and the
// notification list behind it, rendered in the shared modal chrome. The
// fetches here deliberately bypass api(): a 401 just means "signed out" —
// hide the bell, never bounce to #login.
import { $, esc, toast } from './ui.js';
import { api } from './api.js';
import { openModal, closeModal, bookModal } from './book-modal.js';
import { openThreadModal, ago } from './chatter.js';
import { openPollModal, openReadalongModal } from './polls.js';

let bound = false;

export function startBell() {
  if (bound) return;
  bound = true;
  $('#notif-bell')?.addEventListener('click', openNotifications);
  document.addEventListener('inkhearth:view', () => { refreshBell(); });
  setInterval(() => { if (document.visibilityState === 'visible') refreshBell(); }, 60_000);
  refreshBell();
}

async function fetchNotif(path, body) {
  const res = await fetch('/api/notifications' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'request failed');
  return res.json();
}

export async function refreshBell() {
  const btn = $('#notif-bell');
  if (!btn) return;
  const h = location.hash || '';
  if (h.startsWith('#login') || h.startsWith('#invite/') || h.startsWith('#reset/')) return;
  try {
    const data = await fetchNotif('/unread');
    if (!data) { btn.classList.add('hidden'); return; }
    btn.classList.remove('hidden');
    const badge = $('#notif-count');
    badge.textContent = data.count > 9 ? '9+' : String(data.count);
    badge.classList.toggle('hidden', !data.count);
  } catch { /* network hiccup — keep whatever the badge showed */ }
}

const KIND_TEXT = {
  finish: (n) => `finished “${esc(n.payload.title || 'a book')}”${n.payload.author ? ` · ${esc(n.payload.author)}` : ''}`,
  cheer: (n) => `${esc(String(n.payload.emoji || '👏'))} cheered your finish of “${esc(n.payload.title || 'a book')}”`,
  comment: (n) => `commented on “${esc(n.payload.title || 'a book')}”`,
  poll: (n) => `opened a club poll: “${esc(n.payload.question || 'What should the club read next?')}”`,
  pick: (n) => n.payload.title
    ? `closed the poll — the club is reading “${esc(n.payload.title)}”`
    : 'closed a club poll without a winner',
  readalong: (n) => n.payload.act === 'join'
    ? `joined the readalong for “${esc(n.payload.title || 'a book')}”`
    : `started a readalong: “${esc(n.payload.title || 'a book')}”${n.payload.target_finish ? ` — ends ${esc(String(n.payload.target_finish).slice(0, 10))}` : ''}`,
};

function rowHTML(n) {
  const text = (KIND_TEXT[n.kind] || (() => n.kind))(n);
  return `<div class="notif-row${n.seen ? '' : ' unseen'}" data-id="${n.id}">
    ${n.actor?.has_avatar ? `<img class="avatar avatar-s" src="/api/avatar/${n.actor.id}" alt="">` : '<span class="avatar avatar-s blank"></span>'}
    <div class="notif-main">
      <div>${n.actor ? `<strong>${esc(n.actor.name)}</strong>` : 'Someone'}
        <span class="notif-text">${text}</span>${n.seen ? '' : '<span class="notif-dot" title="new"></span>'}</div>
      <div class="muted small">${ago(n.created_at)}</div>
    </div>
    ${n.react ? `<button class="react-btn notif-react${n.react.mine ? ' sel' : ''}" type="button"
      data-kind="${n.react.type}" data-id="${n.react.id}"
      title="${n.react.type === 'event' ? 'Cheer this finish' : 'React 👏 to the comment'}">👏${n.react.count ? ' ' + n.react.count : ''}</button>` : ''}
    <span class="muted">→</span>
  </div>`;
}

function openNotifications() {
  // First bell click ever (per device): a one-time tip to where the dial
  // lives — circle finishes ring by default, and that should never be a
  // surprise with no visible off-switch.
  const firstTime = !localStorage.getItem('bt-bell-tip');
  if (firstTime) localStorage.setItem('bt-bell-tip', '1');
  openModal(`
    <h2>Notifications</h2>
    ${firstTime ? `<div class="notif-tip"><span>👋 When someone in your circle finishes a book, it rings here.
      Change that any time in <a href="#account" id="notif-tip-link">Account → Privacy &amp; notifications</a>.</span>
      <button class="chat-del" id="notif-tip-x" type="button" aria-label="Dismiss tip">✕</button></div>` : ''}
    <div id="notif-list"><div class="muted small">Loading…</div></div>
    <div class="modal-foot" style="justify-content:space-between;align-items:center">
      <span class="muted small" id="notif-hint"></span>
      <button class="btn ghost" id="notif-seen-all">Mark all seen</button>
    </div>`);
  if (firstTime) {
    $('#notif-tip-link')?.addEventListener('click', (e) => {
      e.preventDefault();
      closeModal();
      location.hash = '#account';
    });
    $('#notif-tip-x')?.addEventListener('click', (e) => e.target.closest('.notif-tip')?.remove());
  }
  loadList();
  $('#notif-seen-all').addEventListener('click', async () => {
    try {
      await fetchNotif('/seen', { all: true });
      await loadList();
      refreshBell();
    } catch (err) { toast(err.message); }
  });
}

async function loadList() {
  const box = $('#notif-list');
  if (!box) return;
  let data;
  try { data = await fetchNotif('/'); } catch (err) {
    box.innerHTML = `<div class="muted small">${esc(err.message)}</div>`;
    return;
  }
  if (!box.isConnected) return; // modal closed while fetching
  box.innerHTML = data.items.length ? data.items.map(rowHTML).join('')
    : '<div class="muted small">All quiet. Cheers and comments on books you\u2019ve touched land here.</div>';
  const hint = $('#notif-hint');
  if (hint) hint.textContent = data.unread ? `${data.unread} unseen` : '';
  // Inline 👏 — cheer a finish or react to a comment without leaving the
  // bell. stopPropagation keeps the row's deep link out of it.
  box.querySelectorAll('.notif-react').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = +btn.dataset.id;
      btn.disabled = true;
      try {
        const r = btn.dataset.kind === 'event'
          ? await api('/chatter/cheer', { method: 'POST', body: { event_id: id } })
          : await api(`/chatter/comments/${id}/react`, { method: 'POST', body: { emoji: '👏' } });
        btn.classList.toggle('sel', r.mine);
        btn.textContent = '👏' + (r.count ? ' ' + r.count : '');
      } catch (err) { toast(err.message); }
      btn.disabled = false;
    }));
  box.querySelectorAll('.notif-row').forEach((row) =>
    row.addEventListener('click', () => {
      const n = data.items.find((x) => String(x.id) === row.dataset.id);
      if (!n) return;
      fetchNotif('/seen', { ids: [n.id] }).then(refreshBell).catch(() => {});
      // Deep link: a readalong nudge opens the pace wall; otherwise a club
      // poll or its crowned pick opens the poll modal; else your own copy
      // when the nudge carries one, else the standalone thread modal.
      if (n.kind === 'readalong' && n.payload.pick_id) openReadalongModal(n.payload.pick_id);
      else if (n.payload.poll_id) openPollModal(n.payload.poll_id);
      else if (n.payload.book_id) bookModal(n.payload.book_id);
      else if (n.payload.work) openThreadModal({ work: n.payload.work, title: n.payload.title });
    }));
}
