import { api, pollJob } from '../api.js';
import { $, esc, toast, fmtWords } from '../ui.js';
import { renderInfoBody } from '../book-info.js';
import { view, registerRoute } from '../router.js';

// "For you" (Phase 4): LLM-generated recommendation cards. Generation runs as
// the `recommendations` job (digest → LLM → Hardcover verification); cards
// accept to TBR, dismiss, or feed "Not for me" avoid signals.


// The last failed run's friendly message. A failure after a multi-minute
// generation must not vanish with its toast, so it renders as a card until
// the next successful run (or the user dismisses it).
let runError = null;

// Generation options persist across re-renders (like library filters).
const recOpts = { adventure: 'balanced', length: 'any', series: 'any', count: 8 };

async function recommendationsView() {
  const [meta, data, acct] = await Promise.all([
    api('/meta'), api('/recommendations'), api('/account/llm'),
  ]);
  const { recs, avoid_signals, batch_id } = data;
  // Acted-on cards leave the grid entirely (no stub tiles) — here on load,
  // and live the moment an action lands. #N pick keeps the batch rank.
  const fresh = recs.filter((rec) => rec.status === 'new');
  const keyNote = acct.has_key
    ? `Using your own key${acct.effective_model ? ` · ${esc(acct.effective_model)}` : ''}`
    : meta.llm_enabled ? 'Using the household’s shared key' : '';
  // Gentle nudge for members still riding the shared key: point at the free
  // personal-key option once, don't nag. "Got it" dismisses for good via
  // localStorage; saving a personal key hides it on its own.
  const showKeyNudge = !acct.has_key && meta.llm_enabled && !localStorage.getItem('bt-llm-nudge-done');
  const sel = (id, options, current) =>
    `<select id="${id}">${options.map(([v, label]) =>
      `<option value="${v}" ${String(current) === v ? 'selected' : ''}>${label}</option>`).join('')}</select>`;

  const avoidHTML = `
    <div class="card" id="avoid-card">
      <h3 style="margin-top:0">Not for me</h3>
      <p class="muted small" style="margin:4px 0 10px">Authors, series or genres future
      recommendations should steer away from.</p>
      <div id="avoid-pills">${avoid_signals.length
        ? avoid_signals.map((a) => `
          <span class="pill avoid-pill">${esc(a.label)}
            <button class="avoid-remove" data-id="${a.id}" title="Remove">×</button></span>`).join('')
        : '<span class="muted small">none yet</span>'}</div>
      <div class="form-grid" style="grid-template-columns:1fr auto;align-items:end;margin-top:10px">
        <input id="avoid-input" placeholder="add an author, series or genre…">
        <button class="btn ghost" id="avoid-add">Add</button>
      </div>
    </div>`;

  view.innerHTML = `
    <section class="recs-hero">
      <div>
        <h1>✨ For you</h1>
        <p>Picked from your tiers, series rollups, DNFs and narrators — then verified
        against Hardcover so no ghost titles slip in. Series picks are always
        first-in-series, and never anything you already own or are reading.</p>
      </div>
      <button class="btn btn-big" id="recs-generate" ${meta.llm_enabled ? '' : 'disabled'}>
        ${batch_id ? '↻ Run again' : '✨ Generate recommendations'}</button>
    </section>
    <div class="toolbar">
      <label class="muted small">Adventure ${sel('opt-adventure', [['conservative', 'Conservative'], ['balanced', 'Balanced'], ['wild', 'Wild']], recOpts.adventure)}</label>
      <label class="muted small">Length ${sel('opt-length', [['any', 'Any'], ['short', 'Short'], ['long', 'Long']], recOpts.length)}</label>
      <label class="muted small">Series ${sel('opt-series', [['any', 'First books OK'], ['standalone', 'Standalones only']], recOpts.series)}</label>
      <label class="muted small">Count ${sel('opt-count', [['6', '6'], ['8', '8'], ['12', '12']], recOpts.count)}</label>
      <span class="muted small" id="recs-note">${batch_id ? `Batch #${batch_id}` : ''}${keyNote ? ` · ${keyNote}` : ''}</span>
    </div>
    ${showKeyNudge ? `
    <div class="card" id="llm-nudge" style="margin:0 0 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <span class="muted small" style="flex:1;min-width:260px">💡 Your recommendations currently run on the
      <b>household's shared LLM key</b> — fine to try, but its free-tier quota is shared by everyone.
      Your own key is <b>free</b> (Google AI Studio, no card), takes about a minute to make, and its
      quota is yours alone: <a href="#account">Account → Recommendations</a>.</span>
      <button class="btn ghost" id="llm-nudge-dismiss" style="padding:3px 10px;font-size:12px">Got it</button>
    </div>` : ''}
    ${meta.llm_enabled ? '' : `<div class="muted small" style="margin:-6px 0 14px">No LLM key — add yours under
      <a href="#account">Account → Recommendations</a> (free Google AI Studio key works; see PLAN.md).</div>`}
    ${runError ? `
    <div class="card" id="recs-error" style="margin:0 0 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;border-color:var(--t-d)">
      <span style="flex:1;min-width:260px" class="small">⚠ ${esc(runError)}</span>
      <button class="btn ghost" id="recs-error-dismiss" style="padding:3px 10px;font-size:12px">Dismiss</button>
    </div>` : ''}
    ${fresh.length ? `
      <div class="rec-grid" id="rec-grid">
        ${recs.map((rec, i) => rec.status === 'new' ? recCard(rec, i) : '').join('')}
      </div>` : `
      <div class="card" style="text-align:center;padding:34px 20px">
        <div style="font-size:30px">🔮</div>
        <p class="muted" style="margin:10px 0 0">${batch_id
          ? 'That batch is fully triaged — hit <strong>↻ Run again</strong> when you want another round.'
          : 'No recommendations yet.'}</p>
      </div>`}
    ${avoidHTML}`;

  $('#recs-generate').addEventListener('click', () => generate($('#recs-generate')));
  $('#recs-error-dismiss')?.addEventListener('click', () => {
    runError = null;
    $('#recs-error')?.remove();
  });
  $('#llm-nudge-dismiss')?.addEventListener('click', () => {
    localStorage.setItem('bt-llm-nudge-done', '1');
    $('#llm-nudge')?.remove();
  });
  for (const [id, key, num] of [['opt-adventure', 'adventure'], ['opt-length', 'length'], ['opt-series', 'series'], ['opt-count', 'count', true]]) {
    $(`#${id}`).addEventListener('change', (e) => { recOpts[key] = num ? +e.target.value : e.target.value; });
  }
  bindAvoid();
  bindCards();
  hydrateCovers();
}

// Paint covers onto the fresh cards without blocking the first render — the
// first fetch after a new batch takes a few paced HC calls, then it's cached.
function hydrateCovers() {
  api('/recommendations/covers').then(({ covers }) => {
    for (const [recId, url] of Object.entries(covers)) {
      const slot = view.querySelector(`.rec-card[data-id="${recId}"] .rec-cover`);
      if (!slot || !url) continue;
      slot.innerHTML = '';
      const img = new Image();
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      slot.appendChild(img);
    }
  }).catch(() => { /* covers are decoration; the page works without them */ });
}

const recCard = (rec, i) => `
  <div class="rec-card" data-id="${rec.id}">
    <button class="rec-dismiss" data-id="${rec.id}" title="Dismiss">×</button>
    <div class="rec-main">
      <div class="rec-cover"></div>
      <div>
        <div class="t">${esc(rec.title)}</div>
        <div class="muted small">${esc(rec.author || '')}${rec.series_name ? ` · ${esc(rec.series_name)}` : ''}</div>
        ${rec.reasoning ? `<p class="rec-why">${esc(rec.reasoning)}</p>` : ''}
      </div>
    </div>
    <div class="rec-meta">
      <span class="pill rank">#${i + 1} pick</span>
      ${rec.estimated_words ? `<span class="pill">≈ ${fmtWords(rec.estimated_words)} words</span>` : '<span class="pill">length unknown</span>'}
      ${rec.hardcover_id ? '' : '<span class="pill">unverified</span>'}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn rec-tbr" data-id="${rec.id}">📌 Add to TBR</button>
      <button class="btn ghost rec-read" data-id="${rec.id}">✅ Read</button>
      <button class="btn ghost rec-avoid" data-id="${rec.id}">Not for me</button>
    </div>
    <details class="rec-more" data-id="${rec.id}"><summary>More info</summary>
      <div class="rec-more-body muted small">Loading…</div>
    </details>
  </div>`;

async function generate(btn) {
  btn.disabled = true;
  runError = null;
  try {
    const { id } = await api('/jobs', {
      method: 'POST',
      body: { kind: 'recommendations', payload: { ...recOpts } },
    });
    const r = await pollJob(id, {
      isStale: () => !btn.isConnected, // view left — job runs on, no re-render yank
      onProgress: (j) => { btn.textContent = (j.progress_label || 'Thinking…'); },
    });
    if (!r) return;
    toast(`Batch ready: ${r.verified} verified${r.dropped ? `, ${r.dropped} dropped as unverifiable` : ''}${r.model ? ` · via ${r.model}` : ''}`, 6000);
  } catch (err) {
    // The message comes from the job: a friendly, classified sentence. It
    // also renders as a persistent card — a six-second toast after a
    // multi-minute wait is how failures get reported as "nothing happened".
    runError = err.message;
    toast('Generation failed: ' + err.message, 8000);
  }
  recommendationsView();
}

function bindCards() {
  view.querySelectorAll('.rec-tbr').forEach((btn) =>
    btn.addEventListener('click', () => acceptToTbr(btn)));
  view.querySelectorAll('.rec-read').forEach((btn) =>
    btn.addEventListener('click', () => acceptToRead(btn)));
  view.querySelectorAll('.rec-avoid').forEach((btn) =>
    btn.addEventListener('click', () => actCard(btn, 'avoided')));
  view.querySelectorAll('.rec-dismiss').forEach((btn) =>
    btn.addEventListener('click', () => actCard(btn, 'dismissed')));
  view.querySelectorAll('.rec-more').forEach((d) =>
    d.addEventListener('toggle', () => {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = '1';
      loadMoreInfo(d).catch((err) => {
        d.querySelector('.rec-more-body').textContent = `Could not load: ${err.message}`;
      });
    }));
}

// The create-book draft both "Add to TBR" and "I've read this" share.
async function recDraft(id) {
  const rec = (await api('/recommendations')).recs.find((r) => r.id === id);
  if (!rec) throw new Error('recommendation vanished');
  // Dedupe on the HC anchor when verified, else on this rec's own id.
  return {
    rec,
    draft: {
      title: rec.title, author: rec.author, series_name: rec.series_name,
      page_count: rec.page_count, audio_runtime_minutes: rec.audio_runtime_minutes,
      source_provider: rec.hardcover_id ? 'hardcover' : 'rec',
      source_id: rec.hardcover_id ? String(rec.hardcover_id) : String(rec.id),
    },
  };
}

// The ✓ moment between a successful action and the card's removal: the tile
// flashes a done note, fades, then leaves so the rest reflow into the space.
function flashCard(card, icon, label) {
  card.innerHTML = `<div class="rec-done-flash"><span class="big">${icon}</span><span>${label}</span></div>`;
  setTimeout(() => {
    card.classList.add('rec-leaving');
    setTimeout(() => removeCard(card), 320);
  }, 900);
}

// Acted cards leave the grid so the rest reflow into the space; when the
// last one goes, the grid itself swaps for a wrap-up card.
function removeCard(card) {
  const grid = document.getElementById('rec-grid');
  card.remove();
  if (grid && !grid.querySelector('.rec-card')) {
    grid.outerHTML = `<div class="card" style="text-align:center;padding:34px 20px">
      <div style="font-size:30px">🔮</div>
      <p class="muted" style="margin:10px 0 0">That's the batch triaged — hit <strong>↻ Run again</strong> when you want another round.</p></div>`;
  }
}

async function acceptToTbr(btn) {
  const id = +btn.dataset.id;
  const card = btn.closest('.rec-card');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const { rec, draft } = await recDraft(id);
    const { book } = await api('/books', { method: 'POST', body: draft });
    await api('/tbr', { method: 'POST', body: { book_id: book.id, source: 'rec' } });
    await api(`/recommendations/${id}/status`, { method: 'POST', body: { status: 'tbr' } });
    toast(`"${rec.title}" queued — find it in your TBR queue`);
    flashCard(card, '📌', 'Queued');
  } catch (err) {
    toast(err.message, 6000);
    btn.disabled = false;
    btn.textContent = '📌 Add to TBR';
  }
}

async function acceptToRead(btn) {
  const id = +btn.dataset.id;
  const card = btn.closest('.rec-card');
  btn.disabled = true;
  btn.textContent = 'Logging…';
  try {
    const { rec, draft } = await recDraft(id);
    const { book } = await api('/books', { method: 'POST', body: draft });
    // "I've already read this" must not double-log an existing finish.
    const det = await api('/books/' + book.id);
    const already = det.events.some((e) => e.status === 'finished');
    if (!already) {
      await api(`/books/${book.id}/quick-status`, { method: 'POST', body: { status: 'read' } });
    }
    await api(`/recommendations/${id}/status`, { method: 'POST', body: { status: 'read' } });
    toast(already ? `"${rec.title}" was already in your library as read` : `"${rec.title}" logged as read — find it in the Library`);
    flashCard(card, '✓', 'Logged as read');
  } catch (err) {
    toast(err.message, 6000);
    btn.disabled = false;
    btn.textContent = '✅ Read';
  }
}

// Lazy "More info" body: description + catalog details from Hardcover (via
// /recommendations/:id/info), plus search links that work for every card.
async function loadMoreInfo(d) {
  const id = +d.dataset.id;
  const info = await api(`/recommendations/${id}/info`).catch(() => null);
  renderInfoBody(d.querySelector('.rec-more-body'), info);
}

async function actCard(btn, status) {
  const id = +btn.dataset.id;
  try {
    await api(`/recommendations/${id}/status`, { method: 'POST', body: { status } });
    flashCard(btn.closest('.rec-card'), '✓', status === 'avoided' ? 'Noted' : 'Dismissed');
    if (status === 'avoided') toast('Noted — future recommendations will steer away');
  } catch (err) {
    toast(err.message, 5000);
  }
}

function bindAvoid() {
  view.querySelectorAll('.avoid-remove').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api('/avoid-signals/' + btn.dataset.id, { method: 'DELETE' });
      recommendationsView();
    }));
  $('#avoid-add').addEventListener('click', async () => {
    const label = $('#avoid-input').value.trim();
    if (label.length < 2) return;
    await api('/avoid-signals', { method: 'POST', body: { label } });
    toast(`Will avoid "${label}"`);
    recommendationsView();
  });
}

registerRoute('#recs', recommendationsView);
