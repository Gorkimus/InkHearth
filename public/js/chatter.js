// Book chatter — the reusable comment-thread component plus the dashboard's
// "Household chatter" card. One thread per work (server-resolved): the book
// modal loads it with a book id, the standalone thread modal with a work key.
// Comments carry their author's position, and the server withholds anything
// past the viewer's own progress — spoilers are structural, not honor-system.
import { api } from './api.js';
import { $, esc, toast } from './ui.js';
import { openModal, bookModal } from './book-modal.js';

const EMOJI = ['👏', '❤️', '😂', '😮', '😭', '🔥'];

// SQLite datetimes are UTC "YYYY-MM-DD HH:MM:SS".
export function ago(iso) {
  const t = new Date(String(iso).replace(' ', 'T') + 'Z').getTime();
  const s = (Date.now() - t) / 1000;
  if (!Number.isFinite(s) || s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 14 * 86400) return `${Math.round(s / 86400)}d ago`;
  return String(iso).slice(0, 10);
}

const avatarHTML = (c) => c.has_avatar
  ? `<img class="avatar avatar-s" src="/api/avatar/${c.user_id}" alt="">`
  : '<span class="avatar avatar-s blank"></span>';

function commentHTML(c) {
  return `<div class="chat-item" data-id="${c.id}">
    ${avatarHTML(c)}
    <div class="chat-main">
      <div class="chat-meta">
        <strong>${esc(c.name)}</strong>
        ${c.progress_percent != null ? `<span class="pill chat-pct">${c.progress_percent}%</span>` : ''}
        ${c.contains_spoiler ? '<span class="pill">spoiler</span>' : ''}
        <span class="muted small">${ago(c.created_at)}</span>
        ${c.can_delete ? `<button class="chat-del" data-del="${c.id}" title="Delete comment">✕</button>` : ''}
      </div>
      <div class="chat-bubble">${esc(c.body)}</div>
      <div class="react-row">${EMOJI.map((e) => {
        const r = (c.reactions || []).find((x) => x.emoji === e);
        return `<button class="react-btn${r?.mine ? ' sel' : ''}" data-react="${e}" title="React ${e}">${e}${r?.count ? ' ' + r.count : ''}</button>`;
      }).join('')}</div>
    </div>
  </div>`;
}

function threadHTML(d) {
  const at = d.viewer_percent >= 100 ? 'You finished this 🎉' : d.viewer_percent > 0 ? `You're at ${d.viewer_percent}%` : 'General chatter only — you haven\u2019t started this one';
  return `
    ${d.hidden_count ? `<div class="chat-locked">🔒 ${d.hidden_count} comment${d.hidden_count === 1 ? ' is' : 's are'} ahead of your progress — keep reading to reveal.</div>` : ''}
    <div class="chat-list">${d.comments.map(commentHTML).join('')
      || '<div class="muted small">No chatter yet — say something below.</div>'}</div>
    <div class="chat-composer">
      <textarea id="chat-input" maxlength="1000" placeholder="Say something${d.viewer_percent > 0 && d.viewer_percent < 100 ? ` — others see it gated at your ${d.viewer_percent}%` : ''}…"></textarea>
      <div class="chat-composer-row">
        <label class="muted small" style="display:inline-flex;align-items:center;gap:5px;cursor:pointer">
          <input type="checkbox" id="chat-spoiler"> mark spoilers</label>
        <span class="muted small" style="margin-left:auto">${at}</span>
        <button class="btn" id="chat-post" style="padding:4px 14px">Post</button>
      </div>
    </div>`;
}

async function post(container, ref, onMutate) {
  const body = $('#chat-input', container).value.trim();
  if (!body) return;
  await api('/chatter', { method: 'POST', body: {
    ...(ref.bookId ? { book_id: ref.bookId } : { work: ref.work }),
    body,
    contains_spoiler: $('#chat-spoiler', container).checked ? 1 : 0,
  } });
  toast('Posted');
  onMutate?.();
  await loadChatter(container, ref, onMutate);
}

// Render/bind the thread inside `container`. Re-runs itself after posts;
// `onMutate` lets hosts keep their own surfaces honest (the book modal marks
// the page behind dirty; the dashboard re-renders its card).
export async function loadChatter(container, ref, onMutate) {
  const q = ref.bookId ? `book=${ref.bookId}` : `work=${encodeURIComponent(ref.work)}`;
  let data;
  try {
    data = await api('/chatter?' + q);
  } catch (err) {
    // First render failing gets an inline note; a failed reload keeps the
    // thread that's already on screen.
    if (container.isConnected && !container.querySelector('.chat-list')) {
      container.innerHTML = `<div class="k">Chatter</div><div class="muted small">Chatter unavailable: ${esc(err.message)}</div>`;
    }
    return;
  }
  if (!container.isConnected) return; // view/modal changed while fetching
  container.innerHTML = `<div class="k">Chatter</div>${threadHTML(data)}`;
  $('#chat-post', container).addEventListener('click', (e) => {
    e.currentTarget.disabled = true;
    post(container, ref, onMutate).catch((err) => { toast(err.message); e.currentTarget.disabled = false; });
  });
  container.querySelectorAll('.react-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = await api(`/chatter/comments/${btn.closest('.chat-item').dataset.id}/react`, {
        method: 'POST', body: { emoji: btn.dataset.react },
      }).catch((err) => { toast(err.message); return null; });
      if (!r) return;
      btn.classList.toggle('sel', r.mine);
      btn.textContent = r.emoji + (r.count ? ' ' + r.count : '');
    }));
  container.querySelectorAll('.chat-del').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/chatter/comments/${btn.dataset.del}`, { method: 'DELETE' }).catch((err) => { toast(err.message); });
      onMutate?.();
      await loadChatter(container, ref, onMutate);
    }));
}

// 👏 buttons on the social rows (together rows + the activity feed): toggle
// the viewer's cheer and repaint the button from the response.
export function bindCheers(container) {
  container.querySelectorAll('.cheer-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = await api('/chatter/cheer', { method: 'POST', body: { event_id: +btn.dataset.event } })
        .catch((err) => { toast(err.message); return null; });
      if (!r) return;
      btn.classList.toggle('sel', r.mine);
      btn.textContent = r.emoji + (r.count ? ' ' + r.count : '');
    }));
}

// The standalone thread modal — for works the viewer doesn't own (a card row
// about someone else's book). Posting works here too: you join the talk
// without a shelf copy, percent-gated like everyone else.
export function openThreadModal({ work, title, author, cover_url }) {
  openModal(`
    <div class="modal-head">
      ${cover_url ? `<img class="cover-m" src="${esc(cover_url)}">` : '<div class="cover-m blank"></div>'}
      <div>
        <h2>${esc(title || 'Chatter by the Fire')}</h2>
        <div class="muted">${esc(author || '')}</div>
        <div class="muted small">Thread by the fire · tap a comment's % to see where it was written</div>
      </div>
    </div>
    <div id="chat-thread" class="chat-card"><div class="muted small">Loading…</div></div>`);
  loadChatter($('#chat-thread'), { work });
}

// Dashboard "Household chatter" card: newest comments household-wide. A row
// opens the viewer's own book modal when they own the work, else the
// standalone thread modal.
export async function renderRecentCard(slot) {
  let data;
  try {
    data = await api('/chatter/recent?limit=6');
  } catch {
    if (slot.isConnected) slot.innerHTML = '<div class="k">Chatter by the Fire</div><div class="muted small">Chatter unavailable right now.</div>';
    return;
  }
  if (!slot.isConnected) return; // view changed while we were waiting
  const rows = (data.comments || []).map((c) => `
    <div class="chat-recent-row" data-work="${esc(c.work)}" data-vb="${c.viewer_book_id || ''}"
      data-title="${esc(c.title || '')}" data-author="${esc(c.author || '')}" data-cover="${esc(c.cover_url || '')}">
      ${avatarHTML(c)}
      <div class="chat-recent-main">
        <div class="chat-meta">
          <strong>${esc(c.name)}</strong>
          <span class="muted small">${ago(c.created_at)} · ${esc(c.title || 'a book')}</span>
          ${c.progress_percent != null ? `<span class="pill chat-pct">${c.progress_percent}%</span>` : ''}
          ${c.contains_spoiler ? '<span class="pill">spoiler</span>' : ''}
        </div>
        <div class="chat-snippet">${esc(c.body.length > 140 ? c.body.slice(0, 140) + '…' : c.body)}</div>
      </div>
    </div>`).join('');
  slot.innerHTML = `<div class="k">Chatter by the Fire</div>${rows
    || '<div class="muted small">No chatter yet — open any book\u2019s panel and say something.</div>'}`;
  slot.querySelectorAll('.chat-recent-row').forEach((row) =>
    row.addEventListener('click', () => {
      if (row.dataset.vb) return bookModal(+row.dataset.vb);
      openThreadModal({ work: row.dataset.work, title: row.dataset.title, author: row.dataset.author, cover_url: row.dataset.cover });
    }));
}
