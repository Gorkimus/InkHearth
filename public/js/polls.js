// Club polls — the reusable poll card, the dashboard's Hearth-pick banner,
// and the modal the bell's poll/pick nudges deep-link into. Every surface
// (the #polls page, the dashboard banner, the modal) renders from the same
// server payload through pollCardHTML/bindPoll, so a vote looks and behaves
// the same everywhere and repaints from the fresh tally the response carries.
import { api } from './api.js';
import { $, esc, toast } from './ui.js';
import { openModal, bookModal } from './book-modal.js';
import { ago, loadChatter } from './chatter.js';

// Future-facing sibling of ago(): "closes in 3d" for a live deadline.
export function until(iso) {
  const t = new Date(String(iso).replace(' ', 'T') + 'Z').getTime() - Date.now();
  if (!Number.isFinite(t) || t <= 0) return 'closing…';
  const s = t / 1000;
  if (s < 3600) return `closes in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `closes in ${Math.round(s / 3600)}h`;
  return `closes in ${Math.round(s / 86400)}d`;
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// The member's local end-of-day as the UTC stamp the server stores — a
// "closes Sep 30" deadline means the day is over where the member lives
// (poll deadlines and readalong targets share the conversion).
export function endOfDayUtc(d) {
  const end = new Date(`${d}T23:59:59`);
  return Number.isNaN(end.getTime()) ? null : end.toISOString().slice(0, 19).replace('T', ' ');
}

const avatarXs = (p) => p.has_avatar
  ? `<img class="avatar avatar-xs" src="/api/avatar/${p.user_id}" alt="" title="${esc(p.name)}">`
  : `<span class="avatar avatar-xs blank" title="${esc(p.name)}"></span>`;

// One option row. Live tallies: the vote button carries the count (cheer
// convention) and flips to ✓ for the viewer's own vote; a closed poll's
// leader gets the winner highlight.
function optionHTML(o, p) {
  const open = p.status === 'open';
  const top = Math.max(...p.options.map((x) => x.votes));
  const winner = !open && o.votes > 0 && o.votes === top;
  return `<div class="poll-option${winner ? ' winner' : ''}">
    <button class="poll-vote${o.mine ? ' sel' : ''}" data-vote="${o.id}" data-poll="${p.id}" ${open ? '' : 'disabled'}
      aria-label="${o.mine ? 'Your vote' : 'Vote'} for ${esc(o.title)}${o.votes ? ` (${o.votes} vote${o.votes === 1 ? '' : 's'})` : ''}"
      title="${open ? (o.mine ? 'Your vote — tap another to switch' : 'Vote for this') : 'Voting is closed'}">${o.mine ? '✓' : (o.votes || '')}</button>
    ${o.cover_url ? `<img class="poll-cover" src="${esc(o.cover_url)}" alt="" referrerpolicy="no-referrer">` : ''}
    <div class="poll-opt-main">
      <div class="poll-opt-title">${esc(o.title)}${o.author ? ` <span class="muted small">· ${esc(o.author)}</span>` : ''}</div>
      <div class="poll-voters">${o.votes
        ? `${o.voters.map(avatarXs).join('')}<span class="muted small">${o.votes} vote${o.votes === 1 ? '' : 's'}</span>`
        : '<span class="muted small">no votes yet</span>'}</div>
    </div>
  </div>`;
}

// The pick strip inside a poll card (the winner, who's in, the join button).
function pickStripHTML(pick) {
  return `<div class="pick-strip">
    <div style="font-size:20px;flex:none">👑</div>
    <div class="pick-main">
      <div class="poll-opt-title">${esc(pick.title)}${pick.author ? ` <span class="muted small">· ${esc(pick.author)}</span>` : ''}</div>
      <div class="poll-voters">${pick.participants.length
        ? `${pick.participants.map(avatarXs).join('')}<span class="muted small">${pick.participants.length} in</span>`
        : '<span class="muted small">nobody\u2019s in yet — be first</span>'}</div>
    </div>
    ${pick.viewer_in
      ? `<button class="btn ghost" data-leave="${pick.id}" title="Leave — your shelf copy stays">✓ You\u2019re in</button>`
      : `<button class="btn" data-join="${pick.id}">I\u2019m in</button>`}
  </div>`;
}

// A whole poll: head, options, pick strip, creator controls.
export function pollCardHTML(p) {
  const open = p.status === 'open';
  return `<div class="poll-head">
      <div class="poll-q">${esc(p.question)}</div>
      <div class="muted small">${open
        ? (p.closes_at ? until(p.closes_at) : 'open — closes when its creator decides')
        : `closed ${p.closed_at ? ago(p.closed_at) : ''}`}
        · started by ${esc(p.created_by?.name || 'a member')} ${ago(p.created_at)}</div>
    </div>
    <div class="poll-options">${p.options.map((o) => optionHTML(o, p)).join('')}</div>
    ${p.pick ? pickStripHTML(p.pick)
      : (!open ? '<div class="muted small" style="margin-top:8px">Closed with no votes — no pick was made.</div>' : '')}
    ${p.can_close ? `<div class="poll-foot">
      ${open ? `<button class="btn ghost" data-close="${p.id}">Close &amp; crown the winner</button>` : ''}
      <button class="btn ghost" data-del="${p.id}">Delete</button>
    </div>` : ''}`;
}

// The dashboard's Hearth-pick banner: cover, who's in, one-tap join. The
// title opens the viewer's own copy when they have one; an active readalong
// restyles the banner into its pace card (days left + the wall behind the
// modal's Open button).
export function pickBannerHTML(pick) {
  const ra = pick.readalong;
  const end = ra ? String(ra.target_finish).slice(0, 10) : '';
  return `<div class="card pick-banner" data-pick="${pick.id}">
    ${pick.cover_url
      ? `<img class="pick-cover" src="${esc(pick.cover_url)}" alt="" referrerpolicy="no-referrer">`
      : '<div class="pick-cover blank"></div>'}
    <div class="pick-main">
      <div class="k">${ra
        ? `🔥 Readalong · ${ra.days_left} day${ra.days_left === 1 ? '' : 's'} left`
        : '🔥 The Hearth pick'}</div>
      ${pick.viewer_book_id
        ? `<div class="t poll-open-book" style="font-size:16px;font-weight:650" data-open-book="${pick.viewer_book_id}">${esc(pick.title)}</div>`
        : `<div class="t" style="font-size:16px;font-weight:650">${esc(pick.title)}</div>`}
      <div class="muted small">${pick.author ? `${esc(pick.author)} · ` : ''}${
        ra ? `ends ${esc(end)} · expected pace today: ${ra.expected_percent}%`
          : `crowned ${ago(pick.created_at)}`}</div>
      <div class="poll-voters" style="margin-top:4px">${pick.participants.length
        ? `${pick.participants.map((p) => avatarXs(p)).join('')}<span class="muted small">${pick.participants.length} reading along</span>`
        : '<span class="muted small">nobody\u2019s in yet — be first</span>'}</div>
    </div>
    <div class="pick-actions">
      ${pick.viewer_in
        ? `<button class="btn ghost" data-leave="${pick.id}" title="Leave — your shelf copy stays">✓ You\u2019re in</button>`
        : `<button class="btn" data-join="${pick.id}">I\u2019m in</button>`}
      ${ra ? `<button class="btn ghost" data-ra="${pick.id}">Open readalong</button>` : ''}
      <button class="btn ghost" data-results="${pick.poll_id}">Results</button>
    </div>
  </div>`;
}

// The dashboard's open-poll prompt: one-tap voting right on the page.
export function pollPromptHTML(p) {
  return `<div class="card poll-prompt">
    <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
      <div class="k" style="margin:0">🗳️ Club poll ${p.closes_at ? '· ' + until(p.closes_at) : ''}</div>
      <div style="flex:1;min-width:200px;font-weight:650">${esc(p.question)}</div>
      <a class="muted small" href="#polls">all polls →</a>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
      ${p.options.map((o) => `<button class="pill poll-inline-vote${o.mine ? ' sel' : ''}" data-vote="${o.id}" data-poll="${p.id}"
        title="${o.mine ? 'Your vote — tap another to switch' : 'Vote'}">${esc(trunc(o.title, 34))}${o.votes ? ` · ${o.votes}` : ''}</button>`).join('')}
    </div>
  </div>`;
}

// Wire every poll action inside `root`; `reload` re-fetches and re-renders
// the host's own surface (the modal re-fetches its poll, the banner its
// payload, the polls page the list).
export function bindPoll(root, reload) {
  const run = (fn) => fn().then(reload).catch((err) => toast(err.message));
  root.querySelectorAll('[data-vote]').forEach((btn) =>
    btn.addEventListener('click', () =>
      run(() => api(`/polls/${btn.dataset.poll}/vote`, { method: 'POST', body: { option_id: +btn.dataset.vote } }))));
  root.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (!confirm('Close this poll and crown the winner?')) return;
      run(() => api(`/polls/${btn.dataset.close}/close`, { method: 'POST' }));
    }));
  root.querySelectorAll('[data-del]').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (!confirm('Delete this poll? Its votes and pick go with it.')) return;
      run(() => api(`/polls/${btn.dataset.del}`, { method: 'DELETE' }));
    }));
  root.querySelectorAll('[data-join]').forEach((btn) =>
    btn.addEventListener('click', () =>
      run(() => api(`/polls/picks/${btn.dataset.join}/join`, { method: 'POST' })
        .then((res) => { toast(res.queued ? 'You\u2019re in — queued on your TBR' : 'You\u2019re in'); return res; }))));
  root.querySelectorAll('[data-leave]').forEach((btn) =>
    btn.addEventListener('click', () =>
      run(() => api(`/polls/picks/${btn.dataset.leave}/join`, { method: 'DELETE' }))));
  root.querySelectorAll('[data-results]').forEach((btn) =>
    btn.addEventListener('click', () => openPollModal(+btn.dataset.results)));
  root.querySelectorAll('[data-ra]').forEach((btn) =>
    btn.addEventListener('click', () => openReadalongModal(+btn.dataset.ra)));
  root.querySelectorAll('[data-open-book]').forEach((el) =>
    el.addEventListener('click', () => bookModal(+el.dataset.openBook)));
}

// The modal the bell's poll/pick nudges open — the full card, voting and
// joining included, from any view.
export async function openPollModal(pollId) {
  openModal(`<h2>Club poll</h2><div id="poll-modal-body"><div class="muted small">Loading…</div></div>`);
  const slot = $('#poll-modal-body');
  const load = async () => {
    let p;
    try { p = (await api(`/polls/${pollId}`)).poll; } catch (err) {
      if (slot.isConnected) slot.innerHTML = `<div class="muted small">${esc(err.message)}</div>`;
      return;
    }
    if (!slot.isConnected) return; // modal closed while fetching
    slot.innerHTML = pollCardHTML(p);
    bindPoll(slot, load);
  };
  await load();
}

// The readalong's progress wall: one row per member — how far they've
// actually gotten (the server computes it from their real events) against
// the pace chip for where the calendar says they should be.
const PACE_CHIP = { finished: '✓ finished', ahead: '▲ ahead', on: '● on pace', behind: '▼ behind' };

function raWallHTML(pick) {
  return `<div class="ra-wall">${pick.participants.map((p) => `
    <div class="ra-row">
      ${avatarXs(p)}
      <div class="ra-main">
        <div class="ra-name">${esc(p.name)}</div>
        <div class="ra-bar"><div style="width:${p.percent || 0}%"></div></div>
      </div>
      <span class="pill ra-chip ${p.pace || ''}">${PACE_CHIP[p.pace] || `${p.percent || 0}%`}</span>
    </div>`).join('')
    || '<div class="muted small">nobody\u2019s in yet — be the first.</div>'}</div>`;
}

// The readalong modal: pace line, progress wall, the work's chatter thread
// (gating applies automatically — nobody sees past their own spot), join /
// leave, and — for the poll's creator or an admin — the pace controls.
export async function openReadalongModal(pickId) {
  openModal(`<h2>Readalong</h2><div id="ra-body"><div class="muted small">Loading…</div></div>`);
  const slot = $('#ra-body');
  const load = async () => {
    let pick;
    try { pick = (await api(`/polls/picks/${pickId}`)).pick; } catch (err) {
      if (slot.isConnected) slot.innerHTML = `<div class="muted small">${esc(err.message)}</div>`;
      return;
    }
    if (!slot.isConnected) return; // modal closed while fetching
    const ra = pick.readalong;
    const end = ra ? String(ra.target_finish).slice(0, 10) : '';
    slot.innerHTML = `
      <div class="modal-head">
        ${pick.cover_url ? `<img class="cover-m" src="${esc(pick.cover_url)}" alt="">` : '<div class="cover-m blank"></div>'}
        <div>
          <h2>${esc(pick.title)}</h2>
          <div class="muted">${esc(pick.author || '')}</div>
          <div class="muted small">${ra
            ? `🔥 Readalong · ends ${esc(end)} · ${ra.days_left} day${ra.days_left === 1 ? '' : 's'} left · expected pace today: ${ra.expected_percent}%`
            : 'The club\u2019s crowned pick — no readalong running.'}</div>
        </div>
      </div>
      ${ra ? `<div class="k" style="margin-top:12px">Progress wall</div>${raWallHTML(pick)}` : ''}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px">
        ${pick.viewer_in
          ? `<button class="btn ghost" data-leave="${pick.id}" title="Leave — your shelf copy stays">✓ You\u2019re in — leave</button>`
          : `<button class="btn" data-join="${pick.id}">I\u2019m in</button>`}
        <span class="muted small">${ra ? 'join to get the book on your shelf and onto the wall' : ''}</span>
      </div>
      ${pick.can_pace ? `<div class="ra-pace-ctl">
        <input type="date" id="ra-target" min="${new Date().toLocaleDateString('en-CA')}" value="${end}">
        <button class="btn ghost" id="ra-set">${ra ? 'Re-date' : 'Start readalong'}</button>
        ${ra ? '<button class="btn danger" id="ra-end">End readalong</button>' : ''}
      </div>` : ''}
      <div class="k" style="margin-top:14px">Chatter by the Fire</div>
      <div id="ra-chat" class="chat-card"><div class="muted small">Loading…</div></div>`;
    bindPoll(slot, load);
    if (pick.can_pace) {
      $('#ra-set')?.addEventListener('click', async (e) => {
        const d = $('#ra-target').value;
        const target = d ? endOfDayUtc(d) : null;
        if (!target) return toast('Pick an end date');
        e.currentTarget.disabled = true;
        try {
          await api(`/polls/picks/${pickId}/readalong`, { method: 'POST', body: { target_finish: target } });
          toast('Readalong pace saved');
          load();
        } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      });
      $('#ra-end')?.addEventListener('click', async (e) => {
        if (!confirm('End the readalong? The pace wall goes; everyone\u2019s books stay.')) return;
        e.currentTarget.disabled = true;
        try {
          await api(`/polls/picks/${pickId}/readalong`, { method: 'DELETE' });
          toast('Readalong ended');
          load();
        } catch (err) { toast(err.message); e.currentTarget.disabled = false; }
      });
    }
    loadChatter($('#ra-chat'), { work: pick.work_key });
  };
  await load();
}

// Dashboard banner hydration: the pick stays pinned while a fresh poll
// collects votes; a poll older than the last pick waits on the polls page.
export async function renderPickBanner(slot) {
  let data;
  try { data = await api('/polls/banner'); } catch { return; }
  if (!slot.isConnected) return; // view changed while fetching
  const { pick, open_poll: openPoll } = data;
  if (!pick && !openPoll) { slot.classList.add('hidden'); return; }
  slot.classList.remove('hidden');
  slot.innerHTML = (pick ? pickBannerHTML(pick) : '')
    + (openPoll && (!pick || openPoll.id > pick.poll_id) ? pollPromptHTML(openPoll) : '');
  bindPoll(slot, () => renderPickBanner(slot));
}
