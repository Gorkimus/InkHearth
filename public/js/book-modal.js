// The book detail modal — opened from the Library and the TBR queue.
import { api } from './api.js';
import { $, esc, fmtNum, toast, toastUndo, tierBadge, today, guard, eventFormHTML, bindEventForm, collectEventForm } from './ui.js';
import { rerender } from './router.js';

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

let lastFocus = null;
export function openModal(html, cls) {
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const card = $('#modal-card');
  card.className = 'modal-card' + (cls ? ` ${cls}` : '');
  card.innerHTML = html;
  const title = card.querySelector('h1, h2, h3');
  if (title) {
    title.id ||= 'modal-title';
    $('#modal').setAttribute('aria-labelledby', title.id);
  }
  $('#modal').classList.remove('hidden');
  // Keyboard users land on the first control; the card itself is the fallback.
  (card.querySelector(FOCUSABLE) || card).focus();
}

// Quick actions refresh the modal in place and defer the page behind to the
// close: markViewDirty() records that the view went stale, and closeModal
// turns that into exactly one rerender. With no modal open there is no later
// close to flush it, so it renders immediately.
let viewDirty = false;
function markViewDirty() {
  if ($('#modal').classList.contains('hidden')) rerender();
  else viewDirty = true;
}

export function closeModal() {
  const wasOpen = !$('#modal').classList.contains('hidden');
  $('#modal').classList.add('hidden');
  $('#modal-card').innerHTML = '';
  if (wasOpen) lastFocus?.focus();
  lastFocus = null;
  if (viewDirty) {
    viewDirty = false;
    rerender();
  }
}
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
// While the dialog is open, Tab cycles inside it — focus must not escape to
// the (hidden-from-interaction but still focusable) page behind the overlay.
$('#modal').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const items = [...$('#modal-card').querySelectorAll(FOCUSABLE)]
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const outside = !$('#modal-card').contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || outside)) {
    e.preventDefault();
    first.focus();
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// Delayed-commit entry deletion (the ✕ next to an entry): the row hides
// immediately and an Undo toast counts down ~6s; only then does the DELETE
// fire. The event row is never destroyed-and-recreated, so its id, position
// and "latest entry carries the rating" are untouched — a re-POSTed
// replacement would become the newest entry and could flip the tier board's
// rating source. Fails safe both ways: Undo before the timer keeps the row,
// and closing the tab mid-countdown still sends the delete (keepalive).
const pendingDeletes = new Map(); // event id -> { bookId, row, timer }

function commitDelete(evId) {
  const p = pendingDeletes.get(evId);
  if (!p) return;
  pendingDeletes.delete(evId);
  api('/events/' + evId, { method: 'DELETE' })
    .then(() => {
      markViewDirty();
      // Refresh the open modal in place so quick-row highlights and the
      // entry list match; still-pending deletes re-hide their rows after it.
      if (!$('#modal').classList.contains('hidden')) refreshModal(p.bookId);
    })
    .catch((err) => {
      if (p.row?.isConnected) p.row.style.display = '';
      toast(err.message || 'Delete failed', 6000);
    });
}

function rehidePendingRows() {
  for (const [id, p] of pendingDeletes) {
    const btn = $('#ev-list')?.querySelector(`.del-ev[data-id="${id}"]`);
    if (!btn) continue;
    p.row = btn.closest('.rowline');
    p.row.style.display = 'none';
  }
}

// Leaving the page mid-countdown must still send the intended deletes.
window.addEventListener('pagehide', () => {
  for (const id of pendingDeletes.keys()) {
    fetch('/api/events/' + id, { method: 'DELETE', keepalive: true }).catch(() => {});
  }
});

function evHTML(ev) {
  const when = ev.finished_at || (ev.finished_year ? String(ev.finished_year) : null);
  const bits = [
    ev.status === 'reading'
      ? (ev.format === 'listened' ? '🎧 listening' : '📖 reading')
      : (ev.format === 'listened' ? '🎧 listened' : '📖 read'),
    ev.status === 'dnf' ? `DNF @ ${ev.dnf_percent}%` : ev.status === 'reading' ? 'in progress' : when || 'date unknown',
    ev.rating ? tierBadge(ev.rating) : '',
    ev.narration_rating ? `<span class="muted small">narration</span> ${tierBadge(ev.narration_rating)}` : '',
    ev.medium ? `<span class="pill">${esc(ev.medium)}</span>` : '',
    ev.notes ? `<div class="muted small">${esc(ev.notes)}</div>` : '',
  ];
  return `<div class="rowline" style="display:flex;gap:10px;align-items:center">
    <span style="flex:1">${bits.filter(Boolean).join(' ')}</span>
    <button class="btn ghost edit-ev" data-id="${ev.id}" title="Edit entry" style="padding:3px 10px;font-size:12px">✎</button>
    <button class="btn ghost del-ev" data-id="${ev.id}" style="padding:3px 10px;font-size:12px">✕</button>
  </div>`;
}

// Refresh the modal contents in place — the same render path as opening it,
// but without a close/open cycle, so quick actions don't flash. Focus returns
// to the control that had it (by element id); the originally-focused page
// element stays the restore target for when the modal finally closes.
async function refreshModal(bookId) {
  const outerFocus = lastFocus?.isConnected ? lastFocus : null;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && $('#modal-card').contains(active) ? active.id : null;
  await bookModal(bookId, { restoreFocusId: focused });
  if (outerFocus) lastFocus = outerFocus;
  rehidePendingRows();
}

export async function bookModal(id, { restoreFocusId } = {}) {
  const { book, events } = await api('/books/' + id);
  // Same external links the "more info" panels carry (book-info.js), built
  // from title+author — but no description blurb, this modal is the blurb.
  const q = encodeURIComponent([book.title, book.author].filter(Boolean).join(' '));
  const extLinks = [
    ['Hardcover', `https://hardcover.app/search?q=${q}`],
    ['Google Books', `https://www.google.com/search?tbm=bks&q=${q}`],
    ['Goodreads', `https://www.goodreads.com/search?q=${q}`],
    ['Open Library', `https://openlibrary.org/search?q=${q}`],
  ];
  const FRIENDLY = {
    cover_url: 'cover', page_count: 'page count', audio_runtime_minutes: 'audio runtime',
    published_year: 'published year', series_name: 'series', series_order: 'series order',
    hardcover_id: 'Hardcover link', genres: 'genres', moods: 'moods',
  };
  openModal(`
    <div class="modal-head">
      ${book.cover_url ? `<img class="cover-m" src="${esc(book.cover_url)}">` : '<div class="cover-m blank"></div>'}
      <div>
        <h2>${esc(book.title)}</h2>
        <div class="muted">${esc(book.author || 'Unknown author')}${book.published_year ? ' · ' + book.published_year : ''}</div>
        ${book.series_name ? `<div class="muted small">${esc(book.series_name)}${book.series_order ? ' #' + book.series_order : ''}</div>` : ''}
        <div class="muted small">
          ${book.word_count ? `${fmtNum(book.word_count)} words (${esc(book.word_count_source)})` : book.page_count ? `${book.page_count} pages` : ''}
          ${book.audio_runtime_minutes ? ` ${book.page_count ? '·' : ''} ${Math.round((book.audio_runtime_minutes / 60) * 10) / 10}h audio` : ''}
          ${!book.word_count && !book.page_count && !book.audio_runtime_minutes ? 'no length data — edit details to add' : ''}
        </div>
        ${(book.moods || []).length ? `<div style="margin-top:6px">${book.moods.map((m) => `<span class="pill">${esc(m)}</span>`).join(' ')}</div>` : ''}
        ${(book.tags || []).length ? `<div style="margin-top:6px">${book.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          ${extLinks.map(([label, href]) => `<a class="muted small" href="${href}" target="_blank" rel="noopener">${label} ↗</a>`).join('')}
          <button class="btn ghost" id="repull-book" title="Re-pull series, genres, year, lengths and cover from Hardcover"
            style="margin-left:auto;padding:3px 10px;font-size:12px">↻ Re-pull data</button>
        </div>
      </div>
    </div>
    <div class="quick-row">
      <button class="btn ghost${book.in_tbr ? ' sel' : ''}" id="qs-tbr">${book.in_tbr ? '✓ In TBR — remove' : '📌 TBR'}</button>
      <button class="btn ghost${events[0]?.status === 'reading' ? ' sel' : ''}" id="qs-start">▶ Reading</button>
      <button class="btn ghost${events[0]?.status === 'finished' ? ' sel' : ''}" id="qs-read">✅ Read</button>
      <button class="btn ghost${events[0]?.status === 'dnf' ? ' sel' : ''}" id="qs-dnf">🚫 DNF</button>
      <button class="btn ghost${book.on_pause ? ' sel' : ''}" id="qs-pause">${book.on_pause ? '▶ Resume' : '⏸ On pause'}</button>
    </div>
    ${book.needs_refresh ? `
    <div class="card" style="margin:12px 0;padding:10px 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span class="muted small" style="flex:1;min-width:200px">Missing Hardcover data — a re-pull can fetch the cover, lengths, series, genres &amp; moods.</span>
      <button class="btn" id="qs-refresh">↻ Get Hardcover data</button>
      <button class="btn ghost" id="qs-no-hc" title="For books Hardcover doesn't list (novellas, niche editions): skips all Hardcover lookups and hides this flag for good">No HC profile</button>
    </div>` : ''}
    <h3>Reads &amp; listens</h3>
    <div id="ev-list">${events.map(evHTML).join('') || '<div class="muted small">No entries yet.</div>'}</div>
    <details class="add-ev"><summary>+ Log another read / listen</summary><div id="ev-form"></div></details>
    <details class="edit-book"><summary>Edit details</summary>
      <div class="form-grid">
        <div class="field"><label>Title</label><input id="e-title" value="${esc(book.title)}"></div>
        <div class="field"><label>Author</label><input id="e-author" value="${esc(book.author || '')}"></div>
        <div class="field"><label>Narrator</label><input id="e-narrator" value="${esc(book.narrator || '')}"></div>
        <div class="field"><label>Series</label><input id="e-series" value="${esc(book.series_name || '')}"></div>
        <div class="field"><label>Series order</label><input id="e-order" type="number" value="${book.series_order || ''}"></div>
        <div class="field"><label>Published year</label><input id="e-year" type="number" value="${book.published_year || ''}"></div>
        <div class="field"><label>Pages</label><input id="e-pages" type="number" value="${book.page_count || ''}"></div>
        <div class="field"><label>Audio runtime (minutes)</label><input id="e-runtime" type="number" value="${book.audio_runtime_minutes || ''}"></div>
        <div class="field wide"><label>Genres (comma separated)</label><input id="e-genres" value="${esc(book.genres.join(', '))}"></div>
        <div class="field wide"><label>Moods (comma separated)</label><input id="e-moods" value="${esc((book.moods || []).join(', '))}" placeholder=" dark, adventurous, funny…"></div>
        <div class="field wide"><label>Tags (comma separated)</label><input id="e-tags" value="${esc((book.tags || []).join(', '))}" placeholder=" favourites, doorstopper, re-read…"></div>
        <div class="field wide"><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal">
          <input type="checkbox" id="e-no-hc" ${book.hardcover_excluded ? 'checked' : ''}>
          No Hardcover profile — skip all Hardcover lookups for this book</label>
          <div class="muted small" style="margin-top:3px">For novellas / niche editions Hardcover doesn't list: hides the "needs re-pull" flag, and re-pulls fall back to Google Books for cover &amp; pages.</div>
        </div>
      </div>
      <button class="btn" id="save-book">Save details</button>
    </details>
    <div class="modal-foot"><button class="btn danger" id="del-book">Delete book</button></div>`);

  // In-place refresh keeps the modal's own focus; only a first open moves it.
  if (restoreFocusId) document.getElementById(restoreFocusId)?.focus();

  renderEventForm($('#ev-form'), book, {
    onSaved: () => { markViewDirty(); closeModal(); },
  });

  // Quick status row: TBR flips the queue (POST /tbr also closes any open
  // 'reading' events server-side); Read/DNF hit the quick-status route, which
  // closes an open reading event in place or logs a minimal new one; Pause is
  // the on_pause shelf flag. All refresh the modal in place; the view behind
  // catches up with one rerender when the modal closes (markViewDirty).
  const reopen = () => { markViewDirty(); refreshModal(book.id); };
  // Shared by the promoted "↻ Re-pull data" button in the header and the
  // needs-refresh card (for books still missing Hardcover data).
  const doRefresh = async (btn, label = '↻ Re-pull data') => {
    btn.disabled = true;
    btn.textContent = 'Re-pulling…';
    try {
      const r = await api(`/books/${book.id}/refresh`, { method: 'POST' });
      // Books flagged "no HC profile" (or with no HC match) still return the
      // Google Books fallback fill — report it when it fetched something.
      const fb = (r.fallback_changed || []).map((c) => FRIENDLY[c] || c).join(', ');
      if (r.matched && !r.changed.length) toast('Already up to date with Hardcover');
      else if (r.matched) toast(`Updated: ${r.changed.map((c) => FRIENDLY[c] || c).join(', ')}`, 5000);
      else if (fb) toast(`No Hardcover match — filled ${fb} from Google Books`, 5000);
      else if (r.excluded) toast('Skipped Hardcover — book is marked as having no HC profile', 5000);
      else toast('No Hardcover match found for this book', 5000);
      reopen();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      toast(err.message);
    }
  };
  $('#repull-book').addEventListener('click', (e) => doRefresh(e.currentTarget));
  $('#qs-refresh')?.addEventListener('click', (e) => doRefresh(e.currentTarget, '↻ Get Hardcover data'));
  // One-tap opt-out from the missing-data card: this book isn't on Hardcover
  // at all, so stop flagging it (also settable via Edit details).
  $('#qs-no-hc')?.addEventListener('click', guard(async () => {
    await api('/books/' + book.id, { method: 'PUT', body: { hardcover_excluded: 1 } });
    toast('Marked as having no Hardcover profile — Hardcover lookups will skip this book');
    reopen();
  }));
  $('#qs-tbr').addEventListener('click', guard(async () => {
    if (book.in_tbr) {
      await api('/tbr/book/' + book.id, { method: 'DELETE' });
      toast('Removed from TBR');
    } else {
      await api('/tbr', { method: 'POST', body: { book_id: book.id } });
      toast('Added to TBR');
    }
    reopen();
  }));
  $('#qs-start').addEventListener('click', guard(async () => {
    await api(`/books/${book.id}/quick-status`, { method: 'POST', body: { status: 'reading' } });
    toast(`"${book.title}" marked as currently reading`);
    reopen();
  }));
  $('#qs-read').addEventListener('click', guard(async () => {
    // Re-reads are legal (multiple finishes per book), but silent ones are how
    // a batch-rating session quietly doubles a library's finish count — ask
    // when this book already has one.
    const prior = events.find((e) => e.status === 'finished');
    if (prior && !confirm(`"${book.title}" is already logged as finished${prior.finished_at ? ` (${prior.finished_at})` : ''}.\n\nLog this as a re-read (a second finish)?`)) return;
    await api(`/books/${book.id}/quick-status`, { method: 'POST', body: { status: 'read', finished_at: today() } });
    toast(prior
      ? `"${book.title}" logged as a re-read — add details any time`
      : `"${book.title}" logged as read — add details any time`);
    reopen();
  }));
  $('#qs-dnf').addEventListener('click', guard(async () => {
    await api(`/books/${book.id}/quick-status`, { method: 'POST', body: { status: 'dnf', finished_at: today() } });
    toast(`"${book.title}" marked as DNF`);
    reopen();
  }));
  $('#qs-pause').addEventListener('click', guard(async () => {
    await api('/books/' + book.id, { method: 'PUT', body: { on_pause: book.on_pause ? 0 : 1 } });
    toast(book.on_pause ? `"${book.title}" resumed` : `"${book.title}" put on pause`);
    reopen();
  }));

  $('#save-book').addEventListener('click', guard(async () => {
    await api('/books/' + book.id, {
      method: 'PUT',
      body: {
        title: $('#e-title').value.trim(),
        author: $('#e-author').value.trim(),
        narrator: $('#e-narrator').value.trim(),
        series_name: $('#e-series').value.trim(),
        series_order: +$('#e-order').value || null,
        published_year: +$('#e-year').value || null,
        page_count: +$('#e-pages').value || null,
        audio_runtime_minutes: +$('#e-runtime').value || null,
        genres: $('#e-genres').value.split(',').map((g) => g.trim()).filter(Boolean),
        moods: $('#e-moods').value.split(',').map((m) => m.trim()).filter(Boolean),
        tags: $('#e-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
        hardcover_excluded: $('#e-no-hc').checked ? 1 : 0,
      },
    });
    toast('Details saved');
    markViewDirty();
    closeModal();
  }));

  $('#del-book').addEventListener('click', guard(async () => {
    if (!confirm(`Delete "${book.title}" and all its entries?`)) return;
    await api('/books/' + book.id, { method: 'DELETE' });
    toast('Deleted');
    closeModal();
    rerender();
  }));

  $('#ev-list').querySelectorAll('.del-ev').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const evId = btn.dataset.id;
      if (pendingDeletes.has(evId)) return; // already counting down
      const row = btn.closest('.rowline');
      pendingDeletes.set(evId, { bookId: book.id, row, timer: null });
      row.style.display = 'none';
      toastUndo('Entry deleted', () => {
        const p = pendingDeletes.get(evId);
        if (!p) return; // already committed
        clearTimeout(p.timer);
        pendingDeletes.delete(evId);
        if (row.isConnected) row.style.display = '';
      });
      pendingDeletes.get(evId).timer = setTimeout(() => commitDelete(evId), 6000);
    }));

  // Edit an entry in place (✎): the row becomes the shared entry form,
  // prefilled; saving PUTs the event — the row keeps its id, so "latest
  // entry carries the rating" and tier-board order stay intact. Saving and
  // deleting land on reopen(), so the view behind (library "Finished" dates,
  // tier board, counts) updates too — no page refresh needed.
  $('#ev-list').querySelectorAll('.edit-ev').forEach((btn) =>
    btn.addEventListener('click', () => {
      const ev = events.find((e) => String(e.id) === btn.dataset.id);
      if (!ev) return;
      const row = btn.closest('.rowline');
      row.innerHTML = `<div class="edit-ev">${eventFormHTML({
        format: ev.format,
        medium: ev.medium || '',
        status: ev.status,
        dnf_percent: ev.dnf_percent || undefined,
        finished_at: ev.finished_at || '',
        unknown_date: !ev.finished_at && ev.status !== 'reading',
        finished_year: ev.finished_year || undefined,
        rating: ev.rating,
        narration_rating: ev.narration_rating,
        notes: ev.notes || '',
      })}<div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn" data-save>Save changes</button>
        <button class="btn ghost" data-cancel>Cancel</button>
      </div></div>`;
      const form = row.querySelector('.edit-ev');
      bindEventForm(form);
      form.querySelector('[data-save]').addEventListener('click', guard(async () => {
        const body = collectEventForm(form, book.id);
        delete body.book_id; // an event never moves between books
        await api('/events/' + ev.id, { method: 'PUT', body });
        toast('Entry updated');
        reopen();
      }));
      form.querySelector('[data-cancel]').addEventListener('click', () => bookModal(book.id));
    }));
}

async function renderEventForm(container, book, { onSaved } = {}) {
  container.innerHTML = eventFormHTML() + '<div style="margin-top:10px"><button class="btn" id="save-ev">Save entry</button></div>';
  bindEventForm(container);
  $('#save-ev', container).addEventListener('click', guard(async () => {
    const ev = collectEventForm(container, book.id);
    await api('/events', { method: 'POST', body: ev });
    toast(`Entry saved for "${book.title}"`);
    onSaved?.();
  }));
}
