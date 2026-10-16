import { api, pollJob } from '../api.js';
import { $, esc, toast } from '../ui.js';
import { view, registerRoute } from '../router.js';

// Storyteller Selection: blind writing-style tasting flights. One job call
// rewrites the same scene in each cast author's voice; the member ranks the
// anonymized passages (drag, or the arrow buttons on touch), and the reveal
// maps each voice back to its author plus that author's standing in their
// own library.

const SCENE_META = {
  action: ['⚔️', 'Action / chase'],
  grief: ['💔', 'Grief / heartbreak'],
  atmosphere: ['🌫️', 'Atmosphere / place'],
  banter: ['😏', 'Banter / dialogue'],
  dread: ['🕯️', 'Dread / suspense'],
  intimacy: ['🤫', 'Quiet intimacy'],
};
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

// The scene choice persists across re-renders (like the recs options).
let selectedScene = 'action';

const sceneLabel = (key) => SCENE_META[key]?.[1] || key;
const sceneIcon = (key) => SCENE_META[key]?.[0] || '🎭';

async function storytellersView() {
  let meta, pool, rounds, acct, cands;
  try {
    [meta, pool, rounds, acct, cands] = await Promise.all([
      api('/meta'), api('/storytellers/pool'), api('/storytellers/rounds'), api('/account/llm'),
      // Admin-only; non-admins get a 403 here and simply no corpus card.
      // Unwrap the payload — the route answers {candidates:[...]}.
      api('/storytellers/snippets/candidates').then((r) => r.candidates).catch(() => null),
    ]);
  } catch (err) {
    view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  renderSetup(pool, rounds.rounds, meta, acct, cands);
}

function renderSetup(pool, flights, meta, acct, cands) {
  const llmOk = acct.has_key || meta.llm_enabled;
  // Authentic coverage: scene → kept-snippet authors, from the corpus the
  // admin curates. An authentic flight needs at least three covered voices.
  const cover = {};
  for (const row of pool.authentic || []) (cover[row.scene] ||= []).push(row);
  const covered = () => cover[selectedScene] || [];
  const canAuthentic = () => covered().length >= 3;
  // Preselect: the member's three best-rated shelf voices plus one house
  // staple for discovery — fewer only when the shelf is short.
  const pre = new Set([
    ...pool.library.slice(0, 3).map((a) => a.name),
    ...pool.staples.slice(0, Math.max(1, 4 - Math.min(3, pool.library.length))).map((a) => a.name),
  ]);
  const castRow = (a) => `
    <label class="cast-row">
      <input type="checkbox" data-name="${esc(a.name)}" ${pre.has(a.name) ? 'checked' : ''}>
      <span class="cast-name">${esc(a.name)}</span>
      <span class="muted small">${a.owned
        ? `${a.books} book${a.books === 1 ? '' : 's'} · avg ${esc(a.avg_tier || '?')}`
        : 'new to you'}</span>
    </label>`;
  const castCard = `
    <div class="card">
      <h3 style="margin-top:0">Tonight's lineup <span class="muted small">(pick 3–6 voices)</span></h3>
      ${pool.library.length ? `<div class="muted small" style="margin:6px 0 2px">From your shelf</div>
      <div class="cast-grid">${pool.library.map(castRow).join('')}</div>` : ''}
      ${pool.staples.length ? `<div class="muted small" style="margin:10px 0 2px">House staples — discoveries</div>
      <div class="cast-grid">${pool.staples.map(castRow).join('')}</div>` : ''}
    </div>`;
  const historyCard = flights.length ? `
    <div class="card">
      <h3 style="margin-top:0">Past flights</h3>
      ${flights.map((f) => {
        const win = f.ranking ? f.authors[f.ranking[0].charCodeAt(0) - 65] : null;
        return `
        <div class="history-row" data-id="${f.id}">
          <span>${sceneIcon(f.scene)}</span>
          <span style="flex:1">${esc(sceneLabel(f.scene))}${f.source === 'authentic' ? ' <span class="pill">authentic</span>' : ''}
            <span class="muted small">· ${esc(f.created_at.slice(0, 10))}</span></span>
          <span class="muted small">${win ? `🏆 ${esc(win)}` : 'unranked'}</span>
          <button class="btn ghost flight-del" data-id="${f.id}" title="Delete flight" style="padding:2px 8px;font-size:12px">✕</button>
        </div>`;
      }).join('')}
    </div>` : '';

  // Admin-only corpus card: scan own ebooks into candidates, approve them.
  const isAdmin = !!meta.user?.is_admin;
  let adminCard = '';
  if (isAdmin) {
    const groups = {};
    for (const c of cands || []) {
      const key = `${c.scan_batch}|${c.author}|${c.title || ''}`;
      (groups[key] ||= { label: `${c.author}${c.title ? ` — ${c.title}` : ''}`, items: {} });
      (groups[key].items[c.scene] ||= []).push(c);
    }
    adminCard = `
    <div class="card">
      <h3 style="margin-top:0">Corpus scanner <span class="muted small">(admin — files stay on this server; nothing enters git)</span></h3>
      <div class="form-grid">
        <div class="field"><label>Author *</label><input id="sc-author"></div>
        <div class="field"><label>Title</label><input id="sc-title"></div>
        <div class="field"><label>Year</label><input id="sc-year" type="number"></div>
        <div class="field wide"><label>Epub file</label><input id="sc-file" type="file" accept=".epub,application/epub+zip"></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn" id="sc-upload">Scan file → candidates</button>
      </div>
      <div id="scan-status" class="muted small" style="margin-top:6px"></div>
      ${(cands || []).length ? `
      <h3 style="margin:16px 0 0">Candidates <span class="muted small">(${cands.length} awaiting review)</span></h3>
      ${Object.values(groups).map((g) => `
        <div style="margin-top:10px">
          <b>${esc(g.label)}</b>
          ${Object.entries(g.items).map(([scene, items]) => `
            <div class="muted small" style="margin:8px 0 4px">${sceneIcon(scene)} ${esc(sceneLabel(scene))} (${items.length})</div>
            ${items.map((c) => `
              <div class="passage-card reveal" style="padding:12px 14px">
                <div class="muted small" style="margin-bottom:4px">${esc(c.note || '')}</div>
                <div class="passage-text muted small">${esc(c.passage.slice(0, 400))}${c.passage.length > 400 ? '…' : ''}</div>
                <div style="display:flex;gap:8px;margin-top:8px">
                  <button class="btn snip-keep" data-id="${c.id}" style="padding:3px 12px">Keep</button>
                  <button class="btn ghost snip-discard" data-id="${c.id}" style="padding:3px 12px">Discard</button>
                </div>
              </div>`).join('')}
          `).join('')}
        </div>`).join('')}` : ''}
    </div>`;
  }

  view.innerHTML = `
    <section class="recs-hero">
      <div>
        <h1>🎭 Storyteller Selection</h1>
        <p>One scene, several authors, all voices anonymized. Rank the passages
        by pure instinct — then meet the writers behind your favourites and see
        how they stack against your own shelf. Pastiche flights are original
        prose written for this flight; authentic flights deal the real thing
        from the household corpus.</p>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn btn-big" id="pour-btn" ${llmOk ? '' : 'disabled'}>🍷 Pour the flight</button>
        <button class="btn btn-big ghost" id="authentic-btn" ${canAuthentic() ? '' : 'disabled'}
          title="Unlocks at 3 kept corpus voices for this scene">🎻 Authentic flight</button>
      </div>
    </section>
    ${llmOk ? '' : `<p class="muted">Pastiche flights need the AI — add your own key under
      Account → Recommendations, or ask the admin to set the household key.</p>`}
    <div class="card">
      <h3 style="margin-top:0">The scene</h3>
      <div class="pill-row" id="scene-chips" role="group" aria-label="Scene type">
        ${Object.entries(SCENE_META).map(([key, [icon, label]]) => `
          <span class="pill link${key === selectedScene ? ' sel' : ''}" data-scene="${key}">${icon} ${label}${cover[key] ? ` · ${cover[key].length}🎙` : ''}</span>`).join('')}
      </div>
      <div class="muted small" style="margin-top:8px" id="authentic-note">
        ${canAuthentic()
          ? `Authentic voices for this scene: ${covered().map((c) => esc(c.author)).join(', ')}.`
          : 'Authentic flights unlock at 3 kept voices for a scene — scan a book in the admin corpus scanner.'}
      </div>
    </div>
    ${castCard}
    ${adminCard}
    ${historyCard}`;

  const authenticBtn = $('#authentic-btn');
  const paintAuthentic = () => {
    authenticBtn.disabled = !canAuthentic();
    $('#authentic-note').innerHTML = canAuthentic()
      ? `Authentic voices for this scene: ${covered().map((c) => esc(c.author)).join(', ')}.`
      : 'Authentic flights unlock at 3 kept voices for a scene — scan a book in the admin corpus scanner.';
  };

  $('#scene-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-scene]');
    if (!chip) return;
    selectedScene = chip.dataset.scene;
    $('#scene-chips').querySelectorAll('.pill').forEach((c) => c.classList.toggle('sel', c === chip));
    paintAuthentic();
  });

  const pour = $('#pour-btn');
  pour.addEventListener('click', async () => {
    const authors = [...view.querySelectorAll('.cast-row input:checked')].map((c) => c.dataset.name);
    if (authors.length < 3 || authors.length > 6) return toast('Pick between 3 and 6 authors for a flight');
    pour.disabled = true;
    pour.textContent = 'Casting…';
    try {
      const { id } = await api('/jobs', { method: 'POST', body: { kind: 'storyteller', payload: { scene: selectedScene, authors } } });
      const result = await pollJob(id, {
        isStale: () => !pour.isConnected,
        onProgress: (j) => { if (j.progress_label) pour.textContent = j.progress_label; },
      });
      if (!result) return;
      const round = await api('/storytellers/rounds/' + result.round_id);
      renderRanking(round);
    } catch (err) {
      toast(err.message, 6000);
      pour.disabled = false;
      pour.textContent = '🍷 Pour the flight';
    }
  });

  authenticBtn.addEventListener('click', async () => {
    if (!canAuthentic()) return;
    authenticBtn.disabled = true;
    try {
      // Up to six covered voices; random draw when coverage exceeds the cast.
      const names = covered().map((c) => c.author);
      for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [names[i], names[j]] = [names[j], names[i]];
      }
      const authors = names.slice(0, 6);
      const result = await api('/storytellers/rounds/authentic', { method: 'POST', body: { scene: selectedScene, authors } });
      const round = await api('/storytellers/rounds/' + result.round_id);
      renderRanking(round);
    } catch (err) {
      toast(err.message, 6000);
      authenticBtn.disabled = false;
    }
  });

  view.querySelectorAll('.history-row').forEach((row) =>
    row.addEventListener('click', async () => {
      try {
        const round = await api('/storytellers/rounds/' + row.dataset.id);
        round.ranking ? renderReveal(round) : renderRanking(round);
      } catch (err) {
        toast(err.message);
      }
    }));
  view.querySelectorAll('.flight-del').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api('/storytellers/rounds/' + btn.dataset.id, { method: 'DELETE' });
        storytellersView();
      } catch (err) {
        toast(err.message);
      }
    }));

  if (!isAdmin) return;
  const scanBtn = $('#sc-upload');
  scanBtn.addEventListener('click', async () => {
    const file = $('#sc-file').files[0];
    const author = $('#sc-author').value.trim();
    const status = $('#scan-status');
    if (!author) return toast('Author is required');
    if (!file) return toast('Choose an .epub file first');
    scanBtn.disabled = true;
    status.textContent = 'Extracting text…';
    try {
      const q = `?author=${encodeURIComponent(author)}&title=${encodeURIComponent($('#sc-title').value.trim())}&year=${encodeURIComponent($('#sc-year').value)}`;
      const scan = await api('/storytellers/scan' + q, {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      status.textContent = `${scan.chunks} chunks extracted — classifying…`;
      const { id } = await api('/jobs', { method: 'POST', body: { kind: 'snippet_scan', payload: { scan_batch: scan.scan_batch } } });
      const result = await pollJob(id, {
        isStale: () => !status.isConnected,
        onProgress: (j) => { if (j.progress_label) status.textContent = j.progress_label; },
      });
      toast(`Scan done: ${result.classified} specimens found, ${result.discarded} set aside`
        + (result.failed_batches ? ` — ${result.failed_batches} batches failed; run the scan again to retry them` : ''), 8000);
      storytellersView();
    } catch (err) {
      toast(err.message, 6000);
      scanBtn.disabled = false;
      status.textContent = '';
    }
  });
  view.querySelectorAll('.snip-keep').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/storytellers/snippets/${btn.dataset.id}/keep`, { method: 'POST' }).catch((err) => toast(err.message));
      storytellersView();
    }));
  view.querySelectorAll('.snip-discard').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/storytellers/snippets/${btn.dataset.id}/discard`, { method: 'POST' }).catch((err) => toast(err.message));
      storytellersView();
    }));
}

function renderRanking(round) {
  view.innerHTML = `
    <h1>🎭 ${esc(sceneLabel(round.scene))}</h1>
    <p class="muted">Same scene, ${round.passages.length} voices, no names. Read each passage,
    then drag them — or use the arrows — into the order you'd want to keep reading.
    The reveal comes when you lock it in.</p>
    ${round.base ? `
    <details class="set-passage">
      <summary>The set passage every voice started from</summary>
      <div class="passage-text muted small">${esc(round.base)}</div>
    </details>` : ''}
    <div class="rank-list" id="rank-list">
      ${round.passages.map((p) => `
        <div class="passage-card" draggable="true" data-key="${p.key}">
          <span class="rank-no"></span>
          <div class="rank-btns">
            <button class="btn ghost rank-up" title="Move up" style="padding:2px 9px">↑</button>
            <button class="btn ghost rank-down" title="Move down" style="padding:2px 9px">↓</button>
          </div>
          <div class="passage-text">${esc(p.passage)}</div>
        </div>`).join('')}
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
      <button class="btn" id="lock-btn">🔒 Lock in my ranking</button>
      <button class="btn ghost" id="abandon-btn">Cancel</button>
    </div>`;

  const list = $('#rank-list');
  const paintOrder = () => [...list.querySelectorAll('.passage-card')].forEach((card, i) => {
    card.querySelector('.rank-no').textContent = ORDINALS[i] || i + 1;
  });
  const move = (card, dir) => {
    const sibling = dir < 0 ? card.previousElementSibling : card.nextElementSibling;
    if (!sibling) return;
    list.insertBefore(card, dir < 0 ? sibling : sibling.nextElementSibling);
    paintOrder();
  };

  let dragEl = null;
  list.querySelectorAll('.passage-card').forEach((card) => {
    card.addEventListener('dragstart', () => {
      dragEl = card;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      dragEl = null;
      paintOrder();
    });
    card.querySelector('.rank-up').addEventListener('click', () => move(card, -1));
    card.querySelector('.rank-down').addEventListener('click', () => move(card, 1));
  });
  // Single-column insertion: a card sits BEFORE the neighbour the pointer is
  // above, unless the pointer is past that neighbour's midline.
  list.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    const next = [...list.querySelectorAll('.passage-card')]
      .filter((c) => c !== dragEl)
      .find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
    if (next) list.insertBefore(dragEl, next);
    else if (dragEl !== list.lastElementChild) list.appendChild(dragEl);
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    paintOrder();
  });

  $('#abandon-btn').addEventListener('click', () => storytellersView());
  $('#lock-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const ranking = [...list.querySelectorAll('.passage-card')].map((c) => c.dataset.key);
    btn.disabled = true;
    try {
      const reveal = await api(`/storytellers/rounds/${round.id}/ranking`, { method: 'POST', body: { ranking } });
      renderReveal(reveal);
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false;
    }
  });
  paintOrder();
}

// Clipboard with a fallback: staging serves plain HTTP on the LAN, where
// navigator.clipboard doesn't exist — then it's the old select-and-execCommand.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// Friend-ready plaintext: the set passage, then every voice by LETTER only
// (so the tasting stays blind when pasted into a group chat), then the
// answer key. Round entries arrive in ranking order; passages go out in
// letter order.
const shareText = (round) => {
  const byKey = [...round.entries].sort((a, b) => a.key.localeCompare(b.key));
  return [
    `🎭 Storyteller Selection — ${sceneLabel(round.scene)}${round.source === 'authentic' ? ' (authentic excerpts)' : ''}`,
    '',
    round.source === 'authentic'
      ? 'Each passage below is the real author, excerpted from the household corpus.'
      : 'THE SET PASSAGE (each voice below restyles this same block):',
    round.base || '(not recorded for this flight)',
    '',
    ...byKey.flatMap((en) => [`PASSAGE ${en.key}`, en.passage || '(text not recorded)', '']),
    '— — —',
    'ANSWER KEY — no peeking until everyone has ranked:',
    ...round.entries.map((en) => `${ORDINALS[en.place - 1] || en.place} — Passage ${en.key}: ${en.author}${en.source_title ? ` — from "${en.source_title}"` : ''}`),
  ].join('\n');
};

function renderReveal(round) {
  const top = round.entries[0];
  const summary = top.in_library
    ? `${esc(top.author)} takes the flight — you've rated ${top.in_library.books}
       book${top.in_library.books === 1 ? '' : 's'} of theirs at an average ${esc(top.in_library.avg_tier || '?')}.`
    : `${esc(top.author)} is new to you — and this voice beat authors you already love.`;
  view.innerHTML = `
    <h1>🎭 The reveal</h1>
    <p class="muted">${esc(sceneLabel(round.scene))} · your order, now with names.</p>
    <div class="card" style="border-left:4px solid var(--accent)">${summary}</div>
    ${round.entries.map((en) => {
      // Authentic rounds carry provenance instead of generated style notes.
      const provenance = en.source_title
        ? `<div class="muted small" style="margin:4px 0">authentic — from <i>${esc(en.source_title)}</i>${en.source_year ? ` (${esc(en.source_year)})` : ''}</div>`
        : `${en.style_notes.length ? `<div class="muted small" style="margin:4px 0">${en.style_notes.map(esc).join(' · ')}</div>` : ''}
        ${en.tags.length ? `<div style="margin:4px 0">${en.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(' ')}</div>` : ''}`;
      return `
      <div class="passage-card reveal">
        <span class="rank-no">${ORDINALS[en.place - 1] || en.place}</span>
        <div class="reveal-head">
          <span class="reveal-author">${esc(en.author)}</span>
          <span class="pill">was passage ${esc(en.key)}</span>
          ${en.in_library
            ? `<span class="pill">${en.in_library.books} book${en.in_library.books === 1 ? '' : 's'} · avg ${esc(en.in_library.avg_tier || '?')}</span>`
            : '<span class="pill">new to you</span>'}
          <a class="muted small" href="${en.hardcover_url}" target="_blank" rel="noopener">Hardcover ↗</a>
        </div>
        ${provenance}
        ${en.passage ? `<div class="passage-text" style="margin-top:8px">${esc(en.passage)}</div>` : ''}
      </div>`;
    }).join('')}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
      <button class="btn" id="again-btn">🍷 New flight</button>
      <button class="btn ghost" id="copy-btn">📋 Copy flight for friends</button>
      <button class="btn subtle" id="delete-btn">Delete this flight</button>
    </div>`;

  $('#again-btn').addEventListener('click', () => storytellersView());
  $('#copy-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const ok = await copyText(shareText(round));
    toast(ok
      ? 'Flight copied — passages by letter for blind tasting, answer key at the bottom'
      : 'Copy failed — your browser blocked it; select the text manually', 6000);
    btn.disabled = false;
  });
  $('#delete-btn').addEventListener('click', async () => {
    try {
      await api('/storytellers/rounds/' + round.id, { method: 'DELETE' });
      toast('Flight deleted');
      storytellersView();
    } catch (err) {
      toast(err.message);
    }
  });
}

registerRoute('#storytellers', storytellersView);
