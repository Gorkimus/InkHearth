// Shared UI helpers + the read/listen entry form used by quick add, Memory
// lane, and the book modal. String templates + idempotent event binding.
import { api } from './api.js';

export const TIERS = ['S', 'A', 'B', 'C', 'D'];
// Fixed medium options; anything else (typed under "other", or legacy import
// values) is itself a valid medium and displays as-is.
const MEDIUMS = ['', 'physical', 'ebook', 'audiobook', 'library', 'other'];

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtWords = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));
export const fmtNum = (n) => (n || 0).toLocaleString();
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer;
export function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// Undo toast: message + an Undo button for `ms`. Clicking hides early and
// runs onUndo; otherwise it expires like a normal toast and whatever the
// caller scheduled alongside (the actual commit) proceeds. Reuses the single
// #toast — a newer toast replaces a pending Undo, by design one notice at
// a time.
export function toastUndo(msg, onUndo, ms = 6000) {
  const t = $('#toast');
  const hide = () => { clearTimeout(toastTimer); t.classList.add('hidden'); };
  t.innerHTML = `<span>${esc(msg)}</span><button class="btn ghost" style="padding:2px 12px;font-size:12px;margin-left:12px">Undo</button>`;
  t.querySelector('button').addEventListener('click', () => { hide(); onUndo(); });
  clearTimeout(toastTimer);
  t.classList.remove('hidden');
  toastTimer = setTimeout(hide, ms);
}

// Colour style — 'warm' (ember, the default) or 'classic' (the original cool
// slate). Flips the data-theme hook the stylesheet's variable overrides hang
// off, caches in localStorage so the next boot paints right, and keeps the
// mobile browser chrome's theme-color honest.
export function applyTheme(theme) {
  const t = theme === 'classic' ? 'classic' : 'warm';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('bt-theme', t); } catch { /* storage can be blocked */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'classic' ? '#10131a' : '#171310';
}

// Wrap an async event handler so a failure toasts instead of dying as an
// unhandled rejection — silent console errors read as "the button did nothing".
export const guard = (fn) => (...a) =>
  Promise.resolve(fn(...a)).catch((e) => toast(e.message || 'Something went wrong', 6000));

export const tierBadge = (t) => `<span class="badge tier-${t}">${t}</span>`;

// ---------- segmented controls + tier pickers ----------

export function segHTML(id, options, selected) {
  return `<div class="seg" id="${id}">${options
    .map(([val, label]) => `<button type="button" data-val="${val}" aria-pressed="${selected === val}" class="${selected === val ? 'sel' : ''}">${label}</button>`)
    .join('')}</div>`;
}
export const segVal = (sel, el = document) => $(sel, el)?.querySelector('.sel')?.dataset.val || '';

// Programmatically select a segmented-control value and fire its change event.
function setSeg(sel, value, el = document) {
  const seg = $(sel, el);
  if (!seg) return;
  seg.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.val === value;
    b.classList.toggle('sel', on);
    b.setAttribute('aria-pressed', String(on));
  });
  seg.dispatchEvent(new Event('change'));
}

export function bindSeg(container) {
  container.querySelectorAll('.seg').forEach((seg) => {
    if (seg.dataset.bound) return; // idempotent — double binding breaks toggles
    seg.dataset.bound = '1';
    seg.addEventListener('click', (e) => {
      if (!e.target.dataset.val) return;
      seg.querySelectorAll('button').forEach((b) => {
        const on = b === e.target;
        b.classList.toggle('sel', on);
        b.setAttribute('aria-pressed', String(on));
      });
      seg.dispatchEvent(new Event('change'));
    });
  });
}

export function bindTierPicker(container) {
  container.querySelectorAll('.tier-picker').forEach((tp) => {
    if (tp.dataset.bound) return; // idempotent — double binding clears selections
    tp.dataset.bound = '1';
    tp.addEventListener('click', (e) => {
      const btn = e.target.closest('.tier-btn');
      if (!btn) return;
      const wasSel = btn.classList.contains('sel');
      tp.querySelectorAll('.tier-btn').forEach((b) => {
        const on = !wasSel && b === btn;
        b.classList.toggle('sel', on);
        b.setAttribute('aria-pressed', String(on));
      });
    });
  });
}
export const pickerVal = (sel, el = document) => $(sel, el)?.querySelector('.tier-btn.sel')?.dataset.val || '';

// ---------- password peek ----------

// Wrap every selected password input with an eye toggle. Purely client-side —
// flipping input.type touches nothing on the wire — and the reveal is
// deliberately momentary: leaving the field (or Escape) re-hides, so a peeked
// password can't linger for the next person at the screen.
export function bindPasswordPeek(sel) {
  const EYE = '<svg class="eye" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg class="eye-off" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  document.querySelectorAll(sel).forEach((input) => {
    if (input.dataset.peek) return; // idempotent — double binding would stack wrappers
    input.dataset.peek = '1';
    const wrap = document.createElement('div');
    wrap.className = 'pass-wrap';
    input.replaceWith(wrap);
    wrap.append(input);
    const btn = document.createElement('button');
    btn.type = 'button'; // never a submit — clicking must only toggle, not send
    btn.className = 'peek-pass';
    btn.title = 'Show password';
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = EYE + EYE_OFF;
    wrap.append(btn);
    const setPeek = (on) => {
      const pos = input.selectionStart;
      input.type = on ? 'text' : 'password';
      try { input.setSelectionRange(pos, pos); } catch { /* caret restore is best-effort */ }
      btn.classList.toggle('on', on);
      const label = on ? 'Hide password' : 'Show password';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', String(on));
    };
    // Tapping the eye must not move focus: keeping it in the input means no
    // blur (so the auto-hide can't fight the click) and the on-screen
    // keyboard stays open mid-peek.
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      setPeek(input.type === 'password');
      if (input.type === 'text') input.focus(); // peek mid-typing, then keep typing
    });
    input.addEventListener('blur', (e) => {
      if (input.type === 'text' && e.relatedTarget !== btn) setPeek(false);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.type === 'text') setPeek(false);
    });
  });
}

// ---------- read/listen entry form ----------

export function eventFormHTML(o = {}) {
  // A medium outside the fixed list (a typed custom source like "graphic
  // audio", or a legacy import value) edits as "other" with the real value
  // kept in the source input — selecting a fixed option and saving would
  // otherwise silently erase it.
  const customMedium = o.medium && !MEDIUMS.includes(o.medium) ? o.medium : '';
  const mediumVal = customMedium ? 'other' : (o.medium || '');
  return `
  <div class="form-grid">
    <div class="field"><label>Format</label>${segHTML('f-format', [['read', '📖 Read'], ['listened', '🎧 Listened']], o.format || 'read')}</div>
    <div class="field"><label>Medium</label>
      <select id="f-medium">${MEDIUMS.map((m) => `<option value="${m}" ${mediumVal === m ? 'selected' : ''}>${m || '—'}</option>`).join('')}</select>
    </div>
    <div class="field${customMedium ? '' : ' hidden'}" id="f-medium-custom-wrap"><label>Source <span class="muted small">(e.g. graphic audio)</span></label>
      <input id="f-medium-custom" value="${esc(customMedium)}" placeholder="what was the source?">
    </div>
    <div class="field"><label>Status</label>${segHTML('f-status', [['finished', 'Finished'], ['dnf', 'DNF'], ['reading', 'Reading now']], o.status || 'finished')}</div>
    <div class="field hidden" id="f-dnf-wrap"><label>Abandoned at %</label><input id="f-dnf" type="number" min="1" max="99" value="${o.dnf_percent || 30}"></div>
    <div class="field" id="f-date-wrap"><label>Finished</label><input id="f-date" type="date" value="${o.finished_at ?? today()}">
      <div class="muted small" style="margin-top:4px"><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="f-unknown"${o.unknown_date ? ' checked' : ''}> date unknown</label></div>
    </div>
    <div class="field hidden" id="f-year-wrap"><label>Year finished <span class="muted small">(optional)</span></label><input id="f-year" type="number" min="1900" max="2100" value="${o.finished_year || ''}"></div>
    <div class="field"><label>Tier</label>
      <div class="tier-picker" id="f-rating">${TIERS.map((t) => `<button type="button" class="tier-btn tier-${t}${o.rating === t ? ' sel' : ''}" data-val="${t}" aria-pressed="${o.rating === t}">${t}</button>`).join('')}</div>
    </div>
    <div class="field hidden" id="f-narr-wrap"><label>Narration</label>
      <div class="tier-picker" id="f-narr"><button type="button" class="tier-btn${o.narration_rating ? '' : ' sel'}" data-val="" aria-pressed="${!o.narration_rating}">—</button>${TIERS.map((t) => `<button type="button" class="tier-btn tier-${t}${o.narration_rating === t ? ' sel' : ''}" data-val="${t}" aria-pressed="${o.narration_rating === t}">${t}</button>`).join('')}</div>
    </div>
    <div class="field wide"><label>Notes</label><textarea id="f-notes" rows="2" placeholder="optional">${esc(o.notes || '')}</textarea></div>
  </div>`;
}

export function bindEventForm(root) {
  bindSeg(root);
  bindTierPicker(root);
  const sync = () => {
    const status = segVal('#f-status', root);
    const unknown = !!$('#f-unknown', root)?.checked;
    $('#f-dnf-wrap', root).classList.toggle('hidden', status !== 'dnf');
    $('#f-date-wrap', root).classList.toggle('hidden', status === 'reading');
    $('#f-date', root)?.classList.toggle('hidden', unknown);
    $('#f-year-wrap', root).classList.toggle('hidden', status === 'reading' || !unknown);
    $('#f-narr-wrap', root).classList.toggle('hidden', segVal('#f-format', root) !== 'listened');
  };
  ['#f-status', '#f-format'].forEach((s) => $(s, root).addEventListener('change', sync));
  $('#f-unknown', root)?.addEventListener('change', sync);
  // Picking a medium implies the format: audiobooks are listen-only, physical
  // and ebook are read-only. "other" (or a custom typed source) implies
  // nothing — graphic audio is listened, a paperback is read, their call.
  $('#f-medium', root).addEventListener('change', (e) => {
    const m = e.target.value;
    if (m === 'audiobook') setSeg('#f-format', 'listened', root);
    else if (m === 'physical' || m === 'ebook') setSeg('#f-format', 'read', root);
    $('#f-medium-custom-wrap', root)?.classList.toggle('hidden', m !== 'other');
  });
  // A prefilled custom medium edits as "other" — reveal its source input.
  $('#f-medium-custom-wrap', root)?.classList.toggle('hidden', $('#f-medium', root).value !== 'other');
  sync();
}

export function collectEventForm(root, bookId) {
  const status = segVal('#f-status', root) || 'finished';
  // "date unknown" swaps the date for an optional year: with a year the entry
  // still lands in that year's stats/year-in-review; blank counts all-time only.
  const unknown = !!$('#f-unknown', root)?.checked;
  const mediumSel = $('#f-medium', root).value;
  const mediumCustom = $('#f-medium-custom', root)?.value.trim();
  return {
    book_id: bookId,
    format: segVal('#f-format', root) || 'read',
    medium: mediumSel === 'other' ? (mediumCustom || 'other') : (mediumSel || null),
    status,
    dnf_percent: status === 'dnf' ? +$('#f-dnf', root).value || 30 : null,
    finished_at: !unknown && status !== 'reading' ? $('#f-date', root)?.value || null : null,
    finished_year: unknown ? +$('#f-year', root)?.value || null : null,
    rating: pickerVal('#f-rating', root) || null,
    narration_rating: pickerVal('#f-narr', root) || null,
    notes: $('#f-notes', root)?.value.trim() || null,
  };
}

export const estWordsClient = (b, format) =>
  b.word_count ? b.word_count
  : format === 'listened' && b.audio_runtime_minutes ? Math.round((b.audio_runtime_minutes / 60) * 9300)
  : b.page_count ? b.page_count * 275
  : b.audio_runtime_minutes ? Math.round((b.audio_runtime_minutes / 60) * 9300)
  : 0;

// ---------- sortable tables ----------

// Click a <th> to sort the body by that column; click again to flip. `cols`
// maps a column index to an optional first-click direction — cells carrying a
// data-v attribute sort by that computed value (tier ranks, dates), plain text
// otherwise. Purely DOM-side: works on any rendered table, survives in-place
// cell edits, and resets when the table re-renders.
export function bindTableSort(table, cols) {
  const head = table.querySelector('thead');
  const body = table.querySelector('tbody');
  if (!head || !body) return;
  const ths = [...head.querySelectorAll('th')];
  const clearInds = () => ths.forEach((t) => t.querySelectorAll('.sort-ind').forEach((s) => s.remove()));
  cols.forEach((c) => {
    const th = ths[c.th];
    if (!th) return;
    // `trigger` lets a second control share a header cell (Author beside
    // Book): it carries its own direction state and stops the event before
    // the th-level sort sees it.
    const trigger = c.trigger ? th.querySelector(c.trigger) : th;
    if (!trigger || trigger.dataset.sortBound) return;
    trigger.dataset.sortBound = '1';
    th.classList.add('sortable');
    if (!trigger.hasAttribute('tabindex')) trigger.tabIndex = 0;
    // `ind` places the arrow inside a label span rather than at the end of
    // the th — otherwise a secondary trigger (Author) sitting in the same
    // header would visually "own" the Book column's arrow.
    const indEl = c.ind ? th.querySelector(c.ind) : null;
    let dir = null;
    // A column marked `initial` already holds the table's order as served —
    // show its arrow up front, or nothing tells you the headers sort at all.
    const setInd = (d) => {
      clearInds();
      ths.forEach((t) => t.removeAttribute('aria-sort'));
      th.setAttribute('aria-sort', d === 'asc' ? 'ascending' : 'descending');
      const ind = document.createElement('span');
      ind.className = 'sort-ind';
      ind.textContent = d === 'asc' ? ' ▲' : ' ▼';
      (indEl || trigger).appendChild(ind);
    };
    if (c.initial && c.dir) setInd(c.dir);
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger.click(); }
    });
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      dir = dir === 'asc' ? 'desc' : dir === 'desc' ? 'asc' : (c.dir || 'asc');
      setInd(dir);
      const val = (tr) => {
        const cell = tr.children[c.th];
        const raw = c.get ? c.get(cell) : cell?.dataset.v ?? cell?.textContent ?? '';
        const v = String(raw).trim().toLowerCase();
        return v;
      };
      [...body.children]
        .sort((a, b) => {
          const va = val(a), vb = val(b);
          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
          return dir === 'desc' ? -cmp : cmp;
        })
        .forEach((tr) => body.appendChild(tr));
    });
  });
}

// ---------- social: reading together ----------

// One row per in-progress book in the viewer's circle — shared by the
// dashboard's Together card and the Members page panel. `empty` lets each
// surface phrase the no-circle state in its own words.
export function togetherRows(readers, empty) {
  if (!readers || !readers.length) return empty;
  return readers.map((r0) => `
    <div class="together-row">
      ${r0.has_avatar ? `<img class="avatar avatar-s" src="/api/avatar/${r0.member_id}" alt="">` : '<div class="avatar avatar-s"></div>'}
      <div class="together-main">
        <div class="t">${esc(r0.title)}</div>
        <div class="muted small">${esc(r0.author || '')} · ${esc(r0.name)}${r0.on_pause ? ' · ⏸ paused' : ''}${r0.streak ? ` · 🔥 ${r0.streak}` : ''}</div>
        <div class="hero-bar"><div style="width:${r0.percent}%"></div></div>
      </div>
      <div class="together-side">
        <span class="muted small">${r0.percent ? r0.percent + '%' : 'just started'}</span>
        ${r0.in_my_tbr ? '<span class="pill">📌 queued</span>'
          : r0.in_my_library ? '<span class="pill">on your shelf</span>'
          : `<button class="btn ghost together-tbr" data-title="${esc(r0.title)}" data-author="${esc(r0.author || '')}" data-hc="${r0.hardcover_id || ''}" style="padding:2px 10px;font-size:12px">📌 TBR it too</button>`}
      </div>
    </div>`).join('');
}

// Click-flow for every "TBR it too" button on the social surfaces (together
// rows and activity-feed rows): create the viewer's own deduped copy of the
// book (Hardcover anchor when known), queue it, mark the button done.
export function bindTogetherTbr(container) {
  container.querySelectorAll('.together-tbr').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const draft = { title: btn.dataset.title, author: btn.dataset.author || null };
        if (btn.dataset.hc) { draft.source_provider = 'hardcover'; draft.source_id = btn.dataset.hc; }
        const { book } = await api('/books', { method: 'POST', body: draft });
        await api('/tbr', { method: 'POST', body: { book_id: book.id, source: 'friend' } });
        btn.textContent = '✓ Queued';
        toast(`"${btn.dataset.title}" added to your TBR`);
      } catch (err) {
        btn.disabled = false;
        toast(err.message);
      }
    }));
}
