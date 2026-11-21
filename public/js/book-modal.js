// The book detail modal — opened from the Library and the TBR queue.
import { api } from './api.js';
import { $, esc, fmtNum, toast, toastAction, toastUndo, tierBadge, today, guard, eventFormHTML, bindEventForm, collectEventForm } from './ui.js';
import { rerender } from './router.js';
import { loadChatter } from './chatter.js';

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

let lastFocus = null;
export function openModal(html, cls) {
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const card = $('#modal-card');
  card.className = 'modal-card' + (cls ? ` ${cls}` : '');
  card.innerHTML = html;
  // Explicit close affordance in the top corner — on phones the card fills
  // the screen and the tappable backdrop isn't discoverable. Last in the DOM
  // so keyboard focus still lands on the modal's first real control.
  const x = document.createElement('button');
  x.className = 'modal-x';
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.textContent = '✕';
  x.addEventListener('click', closeModal);
  card.append(x);
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
// Nav links inside a modal (author, series, member deep links) must not
// linger over the view they navigate to: one delegated listener closes the
// modal on any in-card hash link, before the anchor's default navigation
// fires the route. The card element persists across opens, so this binds
// exactly once at module load.
$('#modal-card').addEventListener('click', (e) => {
  if (!$('#modal').classList.contains('hidden') && e.target.closest('a[href^="#"]')) closeModal();
});
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
    ev.notes ? `<div class="muted small" style="margin-top:2px">${esc(ev.notes)}
      <button class="btn ghost note-priv" data-id="${ev.id}"
        title="${ev.private
          ? 'Private — only you see this note. Click to share it with the household.'
          : 'Shared — members viewing this book can read this note. Click to make it private.'}"
        style="padding:0 6px;font-size:11px">${ev.private ? '🔒' : '🌐'}</button></div>` : '',
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

// The "Rate it" landing from the finish toasts (book modal, hero, the
// copy-from-a-member flows): make sure this book's modal is open, drop the
// just-finished entry into its in-place edit form, and put the tier picker
// on screen — one tap from "finished" to a rating.
export async function openRating(bookId, eventId) {
  if ($('#modal').classList.contains('hidden')
    || !$('#ev-list')?.querySelector(`.edit-ev[data-id="${eventId}"]`)) {
    await bookModal(bookId);
  }
  const btn = eventId != null && $('#ev-list')?.querySelector(`.edit-ev[data-id="${eventId}"]`);
  if (!btn) return; // entry vanished mid-flight — the open modal is the fallback
  btn.click();
  $('#ev-list .tier-picker')?.scrollIntoView({ block: 'center' });
}

export async function bookModal(id, { restoreFocusId } = {}) {
  const { book, events } = await api('/books/' + id);
  // Same external links the "more info" panels carry (book-info.js), built
  // from title+author; the collapsed More info panel below the header carries
  // the description blurb they show.
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
        <h2><a class="text-link" href="#search/title/${encodeURIComponent(book.title)}"
          title="Search this title — who here has it, and how they rated it">${esc(book.title)}</a></h2>
        <div class="muted">${book.author ? `<a class="text-link" href="#search/author/${encodeURIComponent(book.author)}">${esc(book.author)}</a>` : 'Unknown author'}${book.published_year ? ' · ' + book.published_year : ''}</div>
        ${book.series_name ? `<div class="muted small"><a class="text-link" href="#search/series/${encodeURIComponent(book.series_name)}">${esc(book.series_name)}</a>${book.series_order != null ? ' #' + book.series_order : ''}</div>` : ''}
        <div class="muted small">
          ${book.word_count ? `${fmtNum(book.word_count)} words (${esc(book.word_count_source)})` : book.page_count ? `${book.page_count} pages` : ''}
          ${book.audio_runtime_minutes ? ` ${book.page_count ? '·' : ''} ${Math.round((book.audio_runtime_minutes / 60) * 10) / 10}h audio` : ''}
          ${!book.word_count && !book.page_count && !book.audio_runtime_minutes ? 'no length data — edit details to add' : ''}
        </div>
        ${(book.moods || []).length ? `<div style="margin-top:6px">${book.moods.map((m) => `<span class="pill">${esc(m)}</span>`).join(' ')}</div>` : ''}
        ${(book.tags || []).length ? `<div style="margin-top:6px">${book.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          ${extLinks.map(([label, href]) => `<a class="muted small" href="${href}" target="_blank" rel="noopener">${label} ↗</a>`).join('')}
          <button class="btn ghost" id="pick-cover" title="Search Hardcover editions, Audible, Google Books or Open Library for a different cover — or upload one"
            style="padding:3px 10px;font-size:12px">🖼 Different cover</button>
          <button class="btn ghost" id="repull-book" title="Re-pull series, genres, year, lengths and cover from Hardcover (a picked cover is kept)"
            style="margin-left:auto;padding:3px 10px;font-size:12px">↻ Re-pull data</button>
        </div>
      </div>
    </div>
    ${book.hardcover_id ? `
    <details class="modal-more"><summary>More info</summary>
      <div class="modal-more-body muted small">Loading…</div>
    </details>` : ''}
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
    <div class="card chat-card" id="chatter-box"><div class="k">Chatter</div><div class="muted small">Loading…</div></div>
    <h3>Reads &amp; listens</h3>
    <div id="ev-list">${events.map(evHTML).join('') || '<div class="muted small">No entries yet.</div>'}</div>
    <details class="add-ev"><summary>+ Log another read / listen</summary><div id="ev-form"></div></details>
    <details class="edit-book"><summary>Edit details</summary>
      <div class="form-grid">
        <div class="field"><label>Title</label><input id="e-title" value="${esc(book.title)}"></div>
        <div class="field"><label>Author</label><input id="e-author" value="${esc(book.author || '')}"></div>
        <div class="field"><label>Narrator</label><input id="e-narrator" value="${esc(book.narrator || '')}"></div>
        <div class="field"><label>Series</label><input id="e-series" value="${esc(book.series_name || '')}"></div>
        <div class="field"><label>Series order</label><input id="e-order" type="number" min="0" step="0.1" value="${book.series_order ?? ''}"></div>
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

  // The collapsed synopsis the other surfaces call "More info": lazily
  // fetched from the paced Hardcover info cache on first open. The header
  // already carries lengths, series, moods and the external links, so the
  // body is just the description plus the genre pills the header lacks.
  const more = $('.modal-more');
  more?.addEventListener('toggle', () => {
    if (!more.open || more.dataset.loaded) return;
    more.dataset.loaded = '1';
    const body = more.querySelector('.modal-more-body');
    api(`/books/hardcover-info/${book.hardcover_id}`).then((info) => {
      if (!info?.description) { body.textContent = 'No description on file.'; return; }
      body.classList.remove('muted', 'small');
      body.innerHTML = `<p style="margin:6px 0">${esc(info.description)}</p>
        ${(info.genres || []).length ? `<div style="margin-top:6px">${info.genres.map((g) => `<span class="pill">${esc(g)}</span>`).join(' ')}</div>` : ''}`;
    }).catch((err) => {
      body.textContent = `Could not load: ${err.message}`;
    });
  });

  renderEventForm($('#ev-form'), book, {
    onSaved: () => { markViewDirty(); closeModal(); },
  });

  // The work's comment thread, lazy-loaded after paint like "More info".
  // Posting/deleting marks the view dirty so the dashboard's household
  // chatter card catches up on close (same convention as the quick actions).
  loadChatter($('#chatter-box'), { bookId: book.id }, markViewDirty);

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
      // A manually-picked cover survives the re-pull by design — say so, or
      // the kept cover reads like the re-pull silently failed.
      const kept = r.cover_locked ? ' · your chosen cover was kept' : '';
      if (r.matched && !r.changed.length) toast(`Already up to date with Hardcover${kept}`);
      else if (r.matched) toast(`Updated: ${r.changed.map((c) => FRIENDLY[c] || c).join(', ')}${kept}`, 5000);
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
  $('#pick-cover').addEventListener('click', () => openCoverPicker(book));
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
    const res = await api(`/books/${book.id}/quick-status`, { method: 'POST', body: { status: 'read', finished_at: today() } });
    // The finish toast carries the next step: one tap drops the fresh entry
    // into its edit form, tier picker on screen. reopen() first so the entry
    // row (and its ✎) exists by the time the button is clicked.
    toastAction(prior
      ? `"${book.title}" logged as a re-read`
      : `"${book.title}" logged as read`, '⭐ Rate it',
      () => openRating(book.id, res.touched_event ?? res.events?.[0]?.id));
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
        // 0 is a real position (prequels) — only an empty field means "unset".
        series_order: $('#e-order').value === '' ? null : +$('#e-order').value,
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

  // Share/lock a note (🌐/🔒): flips the entry's privacy and re-renders the
  // modal in place — the icon is the whole UI, no dialog needed.
  $('#ev-list').querySelectorAll('.note-priv').forEach((btn) =>
    btn.addEventListener('click', guard(async () => {
      btn.disabled = true;
      try {
        await api('/events/' + btn.dataset.id + '/private', { method: 'POST', body: {} });
        await refreshModal(book.id);
      } catch (err) { toast(err.message); btn.disabled = false; }
    })));

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

// ---------- cover picker (🖼 Different cover) ----------
// Modeled on Audiobookshelf's cover tab: search providers, paste a URL, or
// upload a file. The server downloads/validates the pick and stores the bytes
// locally (data/covers), flagging the book cover_locked so metadata re-pulls
// never overwrite the choice. Previews hotlink the provider CDNs — display
// only; what gets saved is the server's own copy.
function openCoverPicker(book) {
  const q0 = [book.title, book.author].filter(Boolean).join(' ');
  openModal(`
    <h2 style="margin-top:0">Cover for "${esc(book.title)}"</h2>
    <p class="muted small" style="margin:0 0 12px">Your pick is downloaded to the server, so it can never break or change on its own —
    re-pulls keep it. Unlock + re-pull returns to Hardcover's choice.</p>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
      ${book.cover_url ? `<img class="cover-m" src="${esc(book.cover_url)}">` : '<div class="cover-m blank"></div>'}
      <div class="muted small">Current cover${book.cover_locked ? ' <span class="pill">picked by you</span>' : ''}</div>
    </div>
    <div class="cover-tabs">
      <button class="btn ghost sel" data-tab="search">🔍 Search</button>
      <button class="btn ghost" data-tab="url">🔗 URL</button>
      <button class="btn ghost" data-tab="upload">📤 Upload</button>
    </div>
    <div id="cover-search-pane">
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        <select id="cover-provider">
          <option value="all">All sources</option>
          <option value="hardcover">Hardcover editions</option>
          <option value="audible">Audible</option>
          <option value="google">Google Books</option>
          <option value="openlibrary">Open Library</option>
        </select>
        <input id="cover-q" style="flex:1;min-width:160px" value="${esc(q0)}">
        <button class="btn ghost" id="cover-search">Search</button>
      </div>
      <div id="cover-grid" class="cover-grid"><div class="muted small">Search to see covers from every source.</div></div>
    </div>
    <div id="cover-url-pane" class="hidden">
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <input id="cover-url" style="flex:1;min-width:200px" placeholder="https://… address of an image">
        <button class="btn ghost" id="cover-url-save">Use this cover</button>
      </div>
      <div class="muted small">https:// only — the server downloads it and checks the image before using it.</div>
    </div>
    <div id="cover-upload-pane" class="hidden">
      <input type="file" id="cover-file" accept="image/jpeg,image/png,image/webp,image/gif">
      <div id="cover-preview" class="cover-grid" style="margin-top:10px"></div>
      <button class="btn ghost" id="cover-upload-save" style="margin-top:10px" disabled>Use this image</button>
    </div>
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn ghost" id="cover-back">← Back to book</button>
      ${book.cover_locked ? `<button class="btn ghost" id="cover-unlock">Use Hardcover's pick (unlock)</button>` : ''}
    </div>`);

  const panes = { search: $('#cover-search-pane'), url: $('#cover-url-pane'), upload: $('#cover-upload-pane') };
  document.querySelectorAll('.cover-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.cover-tabs button').forEach((x) => x.classList.toggle('sel', x === b));
    for (const [k, el] of Object.entries(panes)) el.classList.toggle('hidden', k !== b.dataset.tab);
  }));

  const pickCover = async (btn, body) => {
    btn.disabled = true;
    try {
      await api(`/books/${book.id}/cover`, { method: 'POST', body });
      toast('Cover updated — re-pulls will keep it');
      markViewDirty();
      refreshModal(book.id);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 6000);
    }
  };

  const runSearch = guard(async () => {
    const grid = $('#cover-grid');
    grid.innerHTML = '<div class="loading">Searching the sources…</div>';
    try {
      const r = await api(`/books/${book.id}/cover-candidates?provider=${encodeURIComponent($('#cover-provider').value)}&q=${encodeURIComponent($('#cover-q').value.trim())}`);
      if (!r.covers.length) {
        grid.innerHTML = `<div class="muted small">No covers found.${(r.notes || []).length ? `<br>${esc(r.notes.join(' · '))}` : ''}</div>`;
        return;
      }
      grid.innerHTML = r.covers.map((c, i) => `
        <button class="cover-pick" data-i="${i}" title="${esc(c.source)}${c.label ? ` · ${esc(c.label)}` : ''}">
          <img src="${esc(c.url)}" loading="lazy" alt="">
        </button>`).join('');
      grid.querySelectorAll('.cover-pick').forEach((b) => b.addEventListener('click', () => {
        b.classList.add('sel');
        pickCover(b, { url: r.covers[+b.dataset.i].url });
      }));
    } catch (err) {
      grid.innerHTML = `<div class="muted small">Search failed: ${esc(err.message)}</div>`;
    }
  });
  $('#cover-search').addEventListener('click', runSearch);
  $('#cover-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  $('#cover-url-save').addEventListener('click', (e) => {
    const v = $('#cover-url').value.trim();
    if (!/^https:\/\//i.test(v)) return toast('Cover URL must start with https://');
    pickCover(e.currentTarget, { url: v });
  });

  // Uploads resize in the browser (max 600×900 JPEG) so a phone photo doesn't
  // try to squeeze through a JSON field; the server sniffs the bytes anyway.
  let uploadData = null;
  $('#cover-file').addEventListener('change', async () => {
    const f = $('#cover-file').files[0];
    const save = $('#cover-upload-save');
    uploadData = null;
    save.disabled = true;
    $('#cover-preview').innerHTML = '';
    if (!f) return;
    try {
      const img = await createImageBitmap(f);
      const scale = Math.min(1, 600 / img.width, 900 / img.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      uploadData = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      $('#cover-preview').innerHTML = `<div class="cover-pick sel"><img src="${canvas.toDataURL('image/jpeg', 0.85)}" alt=""></div>`;
      save.disabled = false;
    } catch { toast('Could not read that image'); }
  });
  $('#cover-upload-save').addEventListener('click', (e) => {
    if (uploadData) pickCover(e.currentTarget, { data: uploadData });
  });

  $('#cover-back').addEventListener('click', () => bookModal(book.id));
  $('#cover-unlock')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Re-pulling…';
    try {
      await api('/books/' + book.id, { method: 'PUT', body: { cover_locked: 0 } });
      await api(`/books/${book.id}/refresh`, { method: 'POST' });
      toast("Cover unlocked — Hardcover's pick restored");
      markViewDirty();
      refreshModal(book.id);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Use Hardcover's pick (unlock)";
      toast(err.message, 6000);
    }
  });
}
