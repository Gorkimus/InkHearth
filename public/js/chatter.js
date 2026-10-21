// Book chatter — the reusable comment-thread component plus the dashboard's
// "Chatter by the Fire" card. One thread per work (server-resolved): the book
// modal loads it with a book id, the standalone thread modal with a work key.
// Comments carry their author's position, and the server withholds a spoiler
// until you reach where it was posted from — spoilers are structural, not
// honor-system.
import { api } from './api.js';
import { $, esc, toast } from './ui.js';
import { openModal, bookModal } from './book-modal.js';

const EMOJI = ['👏', '❤️', '😂', '😮', '😭', '🔥'];

// The @-picker's member list, fetched on first need and cached for the
// tab's life — households don't churn mid-session. A failed fetch resets
// the cache so the next @ retries instead of staying broken.
let mentionables = null;
function fetchMentionables() {
  if (!mentionables) {
    mentionables = api('/chatter/mentionable').then((d) => d.members);
    mentionables.catch(() => { mentionables = null; });
  }
  return mentionables;
}

// "@Name" → an accent chip, for every name the server says the comment
// tagged. Matching runs on the ESCAPED body against escaped names, so
// names carrying &/'/< line up with the escaped text; longest-first so a
// "Patricia" tag isn't half-matched by a "Pat" tag. Hand-typed lookalikes
// stay plain text — the picker is the real thing, the prose is sugar.
const mentionify = (body, names) => {
  const escd = esc(body);
  if (!names?.length) return escd;
  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escaped = names.map((n) => '@' + rx(esc(n))).sort((a, b) => b.length - a.length);
  return escd.replace(new RegExp(`(${escaped.join('|')})(?!\\w)`, 'g'), '<span class="mention-chip">$1</span>');
};

// The @-picker: typing "@" (or "@fr…") in the composer opens a member menu
// above the textarea — arrows walk it, enter/tab or click picks, esc closes.
// A pick writes "@Name " into the text and records the id; the recorded set
// rides the post as mentions[].
function bindMentionPicker(container) {
  const input = $('#chat-input', container);
  const menu = $('#mention-menu', container);
  if (!input || !menu) return;
  const picked = new Map(); // id → name, pruned again at send time
  container._pickedMentions = picked;
  let open = false, items = [], idx = -1;

  const close = () => { open = false; idx = -1; menu.classList.add('hidden'); };
  // The @-fragment the caret sits in, with its start offset — null when the
  // caret isn't inside a tag being typed.
  const tokenAt = () => {
    const upToCaret = input.value.slice(0, input.selectionStart);
    const m = upToCaret.match(/(?:^|\s)@([^\s@]*)$/);
    return m ? { start: input.selectionStart - m[1].length - 1, query: m[1] } : null;
  };
  const render = async () => {
    const tok = tokenAt();
    if (!tok) return close();
    const q = tok.query.toLowerCase();
    const hits = (await fetchMentionables())
      .filter((mem) => mem.name.toLowerCase().includes(q)).slice(0, 6);
    if (!hits.length) return close();
    items = hits;
    if (idx < 0 || idx >= items.length) idx = 0;
    menu.innerHTML = items.map((mem, i) => `
      <button type="button" class="mention-opt${i === idx ? ' sel' : ''}" role="option"
        data-id="${mem.id}" data-name="${esc(mem.name)}">
        <img class="avatar avatar-s" src="/api/avatar/${mem.id}" alt="">
        <span>${esc(mem.name)}</span></button>`).join('');
    menu.classList.remove('hidden');
    open = true;
    menu.querySelectorAll('.mention-opt').forEach((btn) =>
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keeps the caret in the textarea
        pick(+btn.dataset.id, btn.dataset.name);
      }));
  };
  const pick = (id, name) => {
    const tok = tokenAt();
    if (!tok) return close();
    input.value = input.value.slice(0, tok.start) + '@' + name + ' ' + input.value.slice(input.selectionStart);
    const caret = tok.start + name.length + 2;
    input.setSelectionRange(caret, caret);
    picked.set(id, name);
    close();
    input.focus();
  };
  input.addEventListener('input', () => { idx = -1; render(); });
  input.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      menu.querySelectorAll('.mention-opt').forEach((b, i) => b.classList.toggle('sel', i === idx));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(items[idx].id, items[idx].name);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
}

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
        ${(c.mentions || []).some((m) => m.you) ? '<span class="pill mention-pill">📌 you</span>' : ''}
        <span class="muted small">${ago(c.created_at)}</span>
        ${c.can_delete ? `<button class="chat-del" data-del="${c.id}" title="Delete comment">✕</button>` : ''}
      </div>
      <div class="chat-bubble">${mentionify(c.body, (c.mentions || []).map((m) => m.name))}</div>
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
    ${d.hidden_count ? `<div class="chat-locked">🔒 ${d.hidden_count} spoiler comment${d.hidden_count === 1 ? ' is' : 's are'} ahead of your progress — keep reading to reveal.</div>` : ''}
    <div class="chat-list">${d.comments.map(commentHTML).join('')
      || '<div class="muted small">No chatter yet — say something below.</div>'}</div>
    <div class="chat-composer">
      <div class="mention-wrap">
        <textarea id="chat-input" maxlength="1000" placeholder="Say something — @ tags a member${d.viewer_percent > 0 && d.viewer_percent < 100 ? ` · spoilers you post stay hidden below your ${d.viewer_percent}%` : ''}…"></textarea>
        <div id="mention-menu" class="mention-menu hidden" role="listbox"></div>
      </div>
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
  // Only picked names still written in the text go out as tags — deleting
  // the "@Name" deletes the tag.
  const mentions = [...(container._pickedMentions || new Map())]
    .filter(([, name]) => body.includes('@' + name))
    .map(([id]) => id);
  await api('/chatter', { method: 'POST', body: {
    ...(ref.bookId ? { book_id: ref.bookId } : { work: ref.work }),
    body,
    contains_spoiler: $('#chat-spoiler', container).checked ? 1 : 0,
    ...(mentions.length ? { mentions } : {}),
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
  bindMentionPicker(container);
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
        <div class="muted">${author ? `<a class="text-link" href="#search/author/${encodeURIComponent(author)}">${esc(author)}</a>` : ''}</div>
        <div class="muted small">Thread by the fire · tap a comment's % to see where it was written</div>
      </div>
    </div>
    <div id="chat-thread" class="chat-card"><div class="muted small">Loading…</div></div>`);
  loadChatter($('#chat-thread'), { work });
}

// Dashboard "Chatter by the Fire" card: newest comments household-wide,
// spoiler-gated for the viewer server-side and walked ten at a time — page 1
// is the latest talk, ‹ › step through the older pages like the pace card
// steps through years. A row opens the viewer's own book modal when they own
// the work, else the standalone thread modal.
export async function renderRecentCard(slot, page = 1) {
  let data;
  try {
    data = await api(`/chatter/recent?page=${page}`);
  } catch {
    if (slot.isConnected) slot.innerHTML = '<div class="k">Chatter by the Fire</div><div class="muted small">Chatter unavailable right now.</div>';
    return;
  }
  if (!slot.isConnected) return; // view changed while we were waiting
  const rows = (data.comments || []).map((c) => `
    <div class="chat-recent-row${c.mentions_you ? ' mentioned' : ''}" data-work="${esc(c.work)}" data-vb="${c.viewer_book_id || ''}"
      data-title="${esc(c.title || '')}" data-author="${esc(c.author || '')}" data-cover="${esc(c.cover_url || '')}">
      ${avatarHTML(c)}
      <div class="chat-recent-main">
        <div class="chat-meta">
          <strong>${esc(c.name)}</strong>
          <span class="muted small">${ago(c.created_at)} · ${esc(c.title || 'a book')}</span>
          ${c.progress_percent != null ? `<span class="pill chat-pct">${c.progress_percent}%</span>` : ''}
          ${c.contains_spoiler ? '<span class="pill">spoiler</span>' : ''}
          ${c.mentions_you ? '<span class="pill mention-pill">📌 mentioned you</span>' : ''}
        </div>
        <div class="chat-snippet">${mentionify(c.body.length > 140 ? c.body.slice(0, 140) + '…' : c.body, (c.mentions || []).map((m) => m.name))}</div>
      </div>
    </div>`).join('');
  const pager = data.page_count > 1 ? `
    <div class="chat-pager">
      <button type="button" class="btn ghost" data-pg="${data.page - 1}" aria-label="Newer comments"
        style="padding:0 10px"${data.page <= 1 ? ' disabled' : ''}>‹</button>
      <span class="muted small">page ${data.page} of ${data.page_count}</span>
      <button type="button" class="btn ghost" data-pg="${data.page + 1}" aria-label="Older comments"
        style="padding:0 10px"${data.page >= data.page_count ? ' disabled' : ''}>›</button>
    </div>` : '';
  const hidden = data.hidden_count
    ? `<div class="muted small" style="text-align:center;margin-top:6px">🔒 ${data.hidden_count} spoiler comment${data.hidden_count === 1 ? '' : 's'} hidden until you catch up</div>`
    : '';
  slot.innerHTML = `<div class="k">Chatter by the Fire</div>${rows
    || '<div class="muted small">No chatter yet — open any book\u2019s panel and say something.</div>'}${pager}${hidden}`;
  slot.querySelectorAll('.chat-recent-row').forEach((row) =>
    row.addEventListener('click', () => {
      if (row.dataset.vb) return bookModal(+row.dataset.vb);
      openThreadModal({ work: row.dataset.work, title: row.dataset.title, author: row.dataset.author, cover_url: row.dataset.cover });
    }));
  slot.querySelectorAll('[data-pg]').forEach((btn) =>
    btn.addEventListener('click', () => renderRecentCard(slot, +btn.dataset.pg)));
}
