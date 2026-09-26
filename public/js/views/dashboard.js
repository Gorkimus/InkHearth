import { monthBars, hbars, progressRing, heatmap } from '../../charts.js';
import { api } from '../api.js';
import { $, esc, fmtWords, fmtNum, tierBadge, toast, applyTheme, togetherRows, bindTogetherTbr } from '../ui.js';
import { view, registerRoute } from '../router.js';

// The Hearth (dashboard): headline cards are always on; every other section can be toggled
// per user (prefs.dashboard.sections, persisted on the account).

// Pace strip year selector — module-level so the picked year survives the
// dashboard's frequent full re-renders (same idea as the library's filters).
let paceYear = null;

const DASH_SECTIONS = [
  ['together', 'Reading together'],
  ['goals', 'Goals & momentum'],
  ['journey', 'Series journey'],
  ['months', 'Pace — words per month'],
  ['pace', 'Pace — all-time trend'],
  ['formats', 'Format split'],
  ['genres', 'Genres'],
  ['authors', 'Authors'],
  ['tags', 'Tags'],
  ['moods', 'Moods'],
  ['tiers', 'Tier spread'],
  ['narrators', 'Narrators'],
  ['years', 'Years overview'],
];

async function dashboard() {
  // Local stats render immediately; series lookups (HC-paced, seconds when
  // caches are cold) hydrate their card afterwards so they never delay the page.
  const [s, prefs] = await Promise.all([api('/stats'), api('/account/prefs')]);
  // The dashboard is the first surface to fetch prefs on a fresh device —
  // picking up a style saved elsewhere here keeps both devices in agreement.
  if (prefs.theme) applyTheme(prefs.theme);
  const sections = { readingNow: true, months: true, formats: true, genres: true, authors: true,
    tiers: true, narrators: true, years: true, ...(prefs.dashboard?.sections || {}) };
  const show = (key) => sections[key] !== false;

  if (s.all_time.books_read === 0) {
    view.innerHTML = `
      <h1>Let's get your library started</h1>
      <div style="display:flex;flex-direction:column;gap:12px;max-width:760px">
        <div class="card" style="display:flex;gap:14px;align-items:flex-start">
          <div style="font-size:26px;line-height:1.2">📥</div>
          <div style="flex:1"><div style="font-weight:700;margin-bottom:4px">Import your history</div>
            <div class="muted small">Goodreads CSV, a Kobo e-reader, or an Audible export — matched
            against Hardcover, you confirm each book before it saves.</div>
            <a class="btn ghost" href="#memory" style="margin-top:8px;padding:4px 14px;font-size:13px">Open Memory lane</a></div>
        </div>
        <div class="card" style="display:flex;gap:14px;align-items:flex-start">
          <div style="font-size:26px;line-height:1.2">➕</div>
          <div style="flex:1"><div style="font-weight:700;margin-bottom:4px">Or log a book right now</div>
            <div class="muted small">Search a title, drop it in a tier, done — imports can come later.</div>
            <a class="btn ghost" href="#add" style="margin-top:8px;padding:4px 14px;font-size:13px">Log a book</a></div>
        </div>
        <div class="card" style="display:flex;gap:14px;align-items:flex-start">
          <div style="font-size:26px;line-height:1.2">⭐</div>
          <div style="flex:1"><div style="font-weight:700;margin-bottom:4px">Rate what you've read</div>
            <div class="muted small">Drag books into S–D tiers — series get their own average tier.</div>
            <a class="btn ghost" href="#board" style="margin-top:8px;padding:4px 14px;font-size:13px">Open the Tier board</a></div>
        </div>
      </div>
      <p class="muted small" style="margin-top:14px">Want the full walkthrough? It's on the
      <a href="#welcome">welcome page</a>.</p>`;
    return;
  }
  const y = new Date().getFullYear();
  const t = s.this_year, a = s.all_time;
  const approx = a.any_estimated ? '≈' : '';
  const sel = (id, options, current) =>
    `<select id="${id}">${options.map(([v, label]) =>
      `<option value="${v}" ${String(current) === v ? 'selected' : ''}>${label}</option>`).join('')}</select>`;

  const sectionHTML = {
    together: `<div class="card" id="together-card"><div class="k">Reading together</div><div class="muted small">Loading…</div></div>`,
    goals: goalsHTML(s, y),
    months: `<div class="card"><div class="k">Words read per month</div>${monthBars(s.months)}</div>`,
    pace: `<div class="card"><div class="k">Words per year</div>
      ${s.years.length ? monthBars(s.years.map((yy) => ({ label: yy.year, full: yy.year, words: yy.words, books: yy.books }))) : '<div class="muted small">No dated books yet.</div>'}
      ${s.months_all?.length ? `<div style="margin:18px 0 0;display:flex;justify-content:space-between;align-items:center;gap:8px">
      <div class="k" style="margin:0">Every month of <span id="pace-year"></span></div>
      <span style="display:inline-flex;gap:4px">
        <button type="button" class="btn ghost" id="pace-prev" aria-label="Previous year" style="padding:0 10px">‹</button>
        <button type="button" class="btn ghost" id="pace-next" aria-label="Next year" style="padding:0 10px">›</button>
      </span></div>
      <div id="pace-strip"></div>` : ''}
      ${s.days?.length ? `<div class="k" style="margin:18px 0 0">Every day this year</div>${heatmap(s.days)}` : ''}</div>`,
    formats: `<div class="card"><div class="k">Format split <span class="muted small">(words)</span></div>${formatSplit(s.formats)}</div>`,
    genres: `<div class="card"><div class="k">Genres <span class="muted small">(books finished)</span></div>${hbars(s.genres.slice(0, 8).map((g) => ({ label: g.genre, value: g.books })), { valueFmt: fmtNum })}</div>`,
    authors: `<div class="card"><div class="k">Author leaderboard</div>${hbars(s.authors.map((a2) => ({ label: a2.author, value: a2.words })), { valueFmt: fmtWords })}</div>`,
    tags: `<div class="card"><div class="k">Tags <span class="muted small">(words)</span></div>${(s.tags || []).length
      ? hbars(s.tags.map((x) => ({ label: x.tag, value: x.words })), { valueFmt: fmtWords })
      : '<div class="muted small">Tag books from their detail panels and this fills in.</div>'}</div>`,
    moods: `<div class="card"><div class="k">Moods <span class="muted small">(words)</span></div>${(s.moods || []).length
      ? hbars(s.moods.map((x) => ({ label: x.mood, value: x.words })), { valueFmt: fmtWords })
      : '<div class="muted small">Moods import from Hardcover — re-pull books missing them.</div>'}</div>`,
    tiers: `<div class="card"><div class="k">Tier spread <span class="muted small">(all time)</span></div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">
        ${['S', 'A', 'B', 'C', 'D'].map((t2) => `<span class="badge tier-${t2}" style="font-size:15px;padding:6px 12px" title="${t2}: ${s.tiers?.[t2] || 0}">${t2} · ${s.tiers?.[t2] || 0}</span>`).join('')}
      </div></div>`,
    narrators: `<div class="card"><div class="k">Narrators <span class="muted small">(books · narration tier)</span></div>
      ${s.narrators?.length ? hbars(s.narrators.slice(0, 8).map((n) => ({ label: `${n.name} · ${n.avg_tier || '—'}`, value: n.books })), { valueFmt: fmtNum }) : '<div class="muted small">No narrated audiobooks yet.</div>'}</div>`,
    years: `<div class="card"><div class="k">Years</div>
      ${s.years.length ? `<table class="lib-table static">
        <thead><tr><th>Year</th><th>Books</th><th>Words</th></tr></thead>
        <tbody>${[...s.years].reverse().slice(0, 8).map((yy) => `
          <tr><td><a href="#review/${yy.year}">${yy.year}</a></td>
            <td>${yy.books}</td><td>${fmtWords(yy.words)}</td></tr>`).join('')}</tbody>
      </table>` : '<div class="muted small">No years yet.</div>'}</div>`,
  };

  view.innerHTML = `
    <div class="toolbar" style="justify-content:space-between;margin-bottom:0">
      <div id="streak-strip" class="muted small"></div>
      <div style="display:flex;gap:12px;align-items:center">
        <a class="muted small" href="#review/${y}">${y} in review →</a>
        <a class="muted small" href="#review/${y}/story">▶ story</a>
        <button class="btn ghost" id="dash-gear" style="padding:4px 12px;font-size:13px">⚙ Customize</button>
      </div>
    </div>
    ${s.reading_now.length ? heroHTML(s.reading_now) : ''}
    <div class="card hidden" id="dash-customize">
      <div class="k">Show sections</div>
      ${DASH_SECTIONS.map(([key, label]) => `
        <label style="display:block;margin:4px 0">
          <input type="checkbox" data-sec="${key}" ${show(key) ? 'checked' : ''}> ${esc(label)}
        </label>`).join('')}
    </div>
    <div class="headline-cards">
      <div class="card big"><div class="k">Books read · ${y}</div><div class="v">${t.books_read}</div><div class="sub">all time: ${a.books_read}</div></div>
      <div class="card big"><div class="k">Words read · ${y}</div><div class="v">${approx}${fmtWords(t.words)}</div><div class="sub">all time: ${approx}${fmtWords(a.words)}${a.any_estimated ? ` <span title="Words are estimated: pages × 275 for reads, audio minutes × 9,300 words/hour at 1× listening speed.">(est.)</span>` : ''}${a.any_unknown ? ` · <span title="Edit the book to add pages or runtime">some books lack length data</span>` : ''}</div></div>
      <div class="card"><div class="k">Pages read · ${y}</div><div class="v">${fmtNum(t.pages)}</div><div class="sub">all time: ${fmtNum(a.pages)}</div></div>
      <div class="card"><div class="k">Hours listened · ${y}</div><div class="v">${fmtNum(t.hours)}</div><div class="sub">all time: ${fmtNum(a.hours)}</div></div>
    </div>
    ${show('goals') ? sectionHTML.goals : ''}
    ${show('together') ? sectionHTML.together : ''}
    ${show('journey') ? `<div class="card" id="journey-card"><div class="k">Series journey</div><div class="muted small">Loading…</div></div>` : ''}
    ${(show('months') || show('formats')) ? `<div class="grid-2">${show('months') ? sectionHTML.months : ''}${show('formats') ? sectionHTML.formats : ''}</div>` : ''}
    ${show('pace') ? sectionHTML.pace : ''}
    ${(show('genres') || show('authors')) ? `<div class="grid-2">${show('genres') ? sectionHTML.genres : ''}${show('authors') ? sectionHTML.authors : ''}</div>` : ''}
    ${(show('tags') || show('moods')) ? `<div class="grid-2">${show('tags') ? sectionHTML.tags : ''}${show('moods') ? sectionHTML.moods : ''}</div>` : ''}
    ${(show('tiers') || show('narrators')) ? `<div class="grid-2">${show('tiers') ? sectionHTML.tiers : ''}${show('narrators') ? sectionHTML.narrators : ''}</div>` : ''}
    ${show('years') ? sectionHTML.years : ''}`;

  $('#dash-gear').addEventListener('click', () => $('#dash-customize').classList.toggle('hidden'));
  bindHeroes(s.reading_now);
  $('#goal-edit-toggle')?.addEventListener('click', () => $('#goal-edit').classList.toggle('hidden'));
  $('#goal-save')?.addEventListener('click', async () => {
    await api('/account/prefs', { method: 'PUT', body: { goals: {
      books: +$('#g-books').value || 0,
      words: +$('#g-words').value || 0,
      hours: +$('#g-hours').value || 0,
    } } });
    toast('Goals saved');
    dashboard();
  });
  hydrateJourney();
  hydrateStreak();
  // Pace month strip: the selected year, all 12 bars, no scrollbar. Months
  // missing from months_all (before the first entry, or ahead of now) render
  // as zero bars; ‹ › walk the years between the first entry and today.
  if (s.months_all?.length) {
    const years = [...new Set(s.months_all.map((m) => m.key.slice(0, 4)))].sort();
    const nowYear = String(new Date().getFullYear());
    if (!paceYear || paceYear < years[0] || paceYear > nowYear) paceYear = years[years.length - 1];
    const monthName = (i) => new Date(Number(paceYear), i, 1).toLocaleString('en', { month: 'short' });
    const renderStrip = () => {
      const months = Array.from({ length: 12 }, (_, i) => {
        const key = `${paceYear}-${String(i + 1).padStart(2, '0')}`;
        return s.months_all.find((m) => m.key === key)
          || { key, label: monthName(i), full: `${monthName(i)} ${paceYear}`, words: 0, books: 0 };
      });
      $('#pace-year').textContent = paceYear;
      $('#pace-strip').innerHTML = monthBars(months);
      $('#pace-prev').disabled = paceYear <= years[0];
      $('#pace-next').disabled = paceYear >= nowYear;
    };
    renderStrip();
    $('#pace-prev').addEventListener('click', () => { paceYear = String(Number(paceYear) - 1); renderStrip(); });
    $('#pace-next').addEventListener('click', () => { paceYear = String(Number(paceYear) + 1); renderStrip(); });
  }
  hydrateTogether();  $('#dash-customize').querySelectorAll('input[data-sec]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const patch = { sections: {} };
      for (const def of $('#dash-customize').querySelectorAll('input[data-sec]')) {
        patch.sections[def.dataset.sec] = def.checked;
      }
      await api('/account/prefs', { method: 'PUT', body: { dashboard: patch } });
      dashboard();
    }));
}

// Now-reading hero: the one-tap loop for whatever is mid-way. Data comes from
// /api/stats reading_now (enriched server-side). Progress/pause taps refresh
// ONLY the hero (they touch nothing else on this page); Finish/DNF change
// every aggregate and keep the full dashboard() render. RULE: a mutation may
// join the targeted path only after verifying it affects nothing outside
// reading_now.
const leftLabel = (r) => r.est_hours_left
  ? `≈ ${r.est_hours_left} hrs left`
  : r.est_pages_left ? `≈ ${r.est_pages_left} pages left` : '';

function heroHTML(rows) {
  return `<div class="hero-stack">${rows.map((r) => `
    <div class="card reading-hero" data-ev="${r.event_id}" data-book="${r.book_id}">
      ${r.cover_url ? `<img class="hero-cover" src="${esc(r.cover_url)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div class="hero-main">
        <div class="k">In progress · ${r.format === 'listened' ? '🎧 listening' : '📖 reading'}${r.on_pause ? ' · ⏸ paused' : ''}</div>
        <div class="t" style="font-size:17px;font-weight:650">${esc(r.title)}</div>
        <div class="muted small">${esc(r.author || '')}</div>
        <div class="hero-bar"><div style="width:${r.percent || 0}%"></div></div>
        <div class="muted small hero-meta">${r.percent ? `${r.percent}% through` : 'Just started'}${leftLabel(r) ? ' · ' + leftLabel(r) : ''}</div>
        <div class="hero-actions">
          <button class="btn ghost" data-act="minus">-10%</button>
          <button class="btn ghost" data-act="minus1">-1%</button>
          <button class="btn ghost" data-act="plus1">+1%</button>
          <button class="btn ghost" data-act="plus">+10%</button>
          <button class="btn ghost" data-act="finish">✅ Finish</button>
          <button class="btn ghost" data-act="dnf">🚫 DNF</button>
          <button class="btn ghost" data-act="pause">${r.on_pause ? '▶ Resume' : '⏸ Pause'}</button>
        </div>
        <div class="muted small hero-msg" style="min-height:16px"></div>
      </div>
    </div>`).join('')}</div>`;
}

function bindHeroes(rows) {
  const cards = view.querySelectorAll('.reading-hero');
  rows.forEach((r, i) => {
    const card = cards[i];
    if (!card) return;
    const msg = card.querySelector('.hero-msg');
    const act = (btn, fn) => {
      // Disable while in flight — a double-click on Finish would log a second
      // completion event.
      if (btn.disabled) return;
      btn.disabled = true;
      fn().catch((err) => { msg.textContent = err.message; }).finally(() => { btn.disabled = false; });
    };
    card.querySelector('[data-act="minus"]').addEventListener('click', (e) => act(e.target, async () => {
      // Floor 1, not 0 — the progress route only accepts 1-99, and 'just
      // started' stays a state only a fresh reading event carries.
      await api(`/events/${r.event_id}/progress`, { method: 'POST', body: { percent: Math.max(1, (r.percent || 0) - 10) } });
      refreshHero(r.event_id, 'minus');
    }));
    card.querySelector('[data-act="minus1"]').addEventListener('click', (e) => act(e.target, async () => {
      await api(`/events/${r.event_id}/progress`, { method: 'POST', body: { percent: Math.max(1, (r.percent || 0) - 1) } });
      refreshHero(r.event_id, 'minus1');
    }));
    card.querySelector('[data-act="plus1"]').addEventListener('click', (e) => act(e.target, async () => {
      // +1 tops at 99 (the route's ceiling); 100 is Finish's job.
      await api(`/events/${r.event_id}/progress`, { method: 'POST', body: { percent: Math.min(99, (r.percent || 0) + 1) } });
      refreshHero(r.event_id, 'plus1');
    }));
    card.querySelector('[data-act="plus"]').addEventListener('click', (e) => act(e.target, async () => {
      await api(`/events/${r.event_id}/progress`, { method: 'POST', body: { percent: Math.min(90, (r.percent || 0) + 10) } });
      refreshHero(r.event_id, 'plus');
    }));
    card.querySelector('[data-act="finish"]').addEventListener('click', (e) => act(e.target, async () => {
      await api(`/books/${r.book_id}/quick-status`, { method: 'POST', body: { status: 'read' } });
      toast(`Finished “${r.title}” — don't forget to tier it`);
      dashboard();
    }));
    card.querySelector('[data-act="dnf"]').addEventListener('click', (e) => act(e.target, async () => {
      await api(`/books/${r.book_id}/quick-status`, { method: 'POST', body: { status: 'dnf', dnf_percent: r.percent || 50 } });
      toast('Marked as DNF');
      dashboard();
    }));
    card.querySelector('[data-act="pause"]').addEventListener('click', (e) => act(e.target, async () => {
      await api(`/books/${r.book_id}`, { method: 'PUT', body: { on_pause: r.on_pause ? 0 : 1 } });
      refreshHero(r.event_id, 'pause');
    }));
  });
}

// Hero-only refresh for the targeted actions above: the server stays the
// source of truth (a fresh /stats) but just the hero stack is redrawn — no
// full-page flash, no scroll or focus reset, and the post-paint hydration
// (journey/together) doesn't refire. Focus lands back on the button that was
// tapped, so rapid ±10% needs no mouse move between taps.
async function refreshHero(srcEv, srcAct) {
  const s = await api('/stats');
  const old = view.querySelector('.hero-stack');
  if (!old) return; // the hero that launched this is gone — route changed
  if (s.reading_now.length) {
    old.outerHTML = heroHTML(s.reading_now);
    bindHeroes(s.reading_now);
  } else {
    old.remove(); // unreachable from these actions, but stay correct
  }
  const btn = view.querySelector(`.reading-hero[data-ev="${srcEv}"] [data-act="${srcAct}"]`);
  btn?.focus();
}

// Goals & momentum: yearly targets live in users.prefs.goals (edited inline);
// momentum compares this month's words against the trailing 3-month average.
function goalsHTML(s, year) {
  const goals = s.goals || {};
  const defs = [['books', 'Books', fmtNum], ['words', 'Words', fmtWords], ['hours', 'Hours', fmtNum]];
  const set = defs.filter(([k]) => goals[k]);
  const mo = s.momentum || {};
  let momentumLine = '';
  if (mo.trailing_avg > 0) {
    const diff = Math.round(((mo.this_month - mo.trailing_avg) / mo.trailing_avg) * 100);
    const arrow = diff > 5 ? '↑' : diff < -5 ? '↓' : '→';
    momentumLine = `<div class="muted small" style="margin-top:10px">${arrow}
      This month: ${fmtWords(mo.this_month)} words · ${diff >= 0 ? '+' : ''}${diff}% vs your 3-month pace</div>`;
  }
  const streak = s.streaks || {};
  const streakLine = streak.current > 0
    ? `<div class="muted small" style="margin-top:10px">🔥 <strong>${streak.current}-day streak</strong>${streak.longest > streak.current ? ` · best ${streak.longest}` : streak.longest ? ` · your best` : ''}</div>`
    : '';
  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
      <div class="k">${year} goals</div>
      <button class="btn ghost" id="goal-edit-toggle" style="padding:2px 10px;font-size:12px">${set.length ? 'Edit' : '🎯 Set a goal'}</button>
    </div>
    ${set.length ? `<div class="goal-row">${set.map(([k, label, fmt]) => `
      <div class="goal">${progressRing(goals[k].pct)}
        <div class="small"><strong>${label}</strong><br><span class="muted">${fmt(goals[k].done)} of ${fmt(goals[k].target)}</span></div>
      </div>`).join('')}</div>`
      : `<div class="muted small" style="margin:8px 0 2px">Pick a ${year} target — books, words or listening hours — and watch the rings fill.</div>`}
    ${streakLine}
    ${momentumLine}
    <div class="${set.length ? 'hidden' : ''}" id="goal-edit" style="margin-top:10px">
      <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="field"><label>Books</label><input id="g-books" type="number" min="0" value="${goals.books?.target || ''}"></div>
        <div class="field"><label>Words</label><input id="g-words" type="number" min="0" step="100000" value="${goals.words?.target || ''}"></div>
        <div class="field"><label>Hours</label><input id="g-hours" type="number" min="0" value="${goals.hours?.target || ''}"></div>
      </div>
      <button class="btn ghost" id="goal-save" style="margin-top:8px">Save goals</button>
      <span class="muted small" style="margin-left:8px">empty or 0 clears a goal</span>
    </div>
  </div>`;
}

// Series journey: "4 of 6, next: Dark Age" — most recently read first; the
// series title links into a prefilled Log-a-book series search (the
// #add/series deep link), and See all expands past the recent five. TBR
// buttons queue the next book deduped on its hardcover_id (same anchor the
// recommendations use).
const actHero = (btn, fn) => fn().catch((err) => toast(err.message));

function journeyHTML(series) {
  return series.length ? series.map((sr) => `
      <div class="journey-row">
        <div style="flex:1;min-width:0">
          <div class="t" style="font-size:14px;font-weight:600"><a href="#add/series/${encodeURIComponent(sr.name)}">${esc(sr.name)}</a></div>
          <div class="muted small">${sr.total ? `${sr.current ?? '?'} of ${sr.total} · ` : ''}${
            sr.next ? `next: <strong>${esc(sr.next.title)}</strong>${sr.next.author ? ` · ${esc(sr.next.author)}` : ''}`
              : sr.owned_next ? 'you already own the next one 📖'
              // No roster = no claim: Hardcover down or the series unknown
              // there. "You're up to date" would be a guess dressed as fact —
              // it once masked a half-finished Wheel of Time.
              : sr.total ? 'you’re up to date ✓' : `${sr.finished_count} finished · roster unavailable`}</div>
        </div>
        ${sr.next ? `<button class="btn ghost j-tbr" data-title="${esc(sr.next.title)}" data-author="${esc(sr.next.author || '')}"
          data-hc="${sr.next.hardcover_id}" data-series="${esc(sr.name)}" style="padding:2px 10px;font-size:12px">📌 TBR</button>` : ''}
      </div>`).join('')
    : '<div class="muted small">Books with a series show up here — keep going, or check the For-you page for new ones.</div>';
}

async function hydrateJourney() {
  const slot = $('#journey-card');
  if (!slot) return;
  // Load → paint → bind, with the See-all toggle re-running the whole load
  // at a higher limit (the endpoint's HC lookups are cached, so re-fetches
  // are cheap; the first expansion may take a few seconds per new series).
  const load = async (limit) => {
    let data = { series: [], total_series: 0 };
    try { data = await api('/series/journey' + (limit ? `?limit=${limit}` : '')); } catch { /* keep the empty state */ }
    if (!$('#journey-card')) return; // view changed while we were waiting
    const series = data.series || [];
    const hidden = Math.max((data.total_series || 0) - series.length, 0);
    const expanded = limit === 'all';
    const more = hidden > 0 || (expanded && series.length > 5)
      ? `<div class="muted small" style="margin-top:8px"><a id="journey-more" style="cursor:pointer">${hidden > 0
        ? `See all (${data.total_series} series)`
        : 'Show recent 5'}</a>${expanded ? ` <span class="muted small">· newest first</span>` : ''}</div>`
      : '';
    slot.innerHTML = `<div class="k">Series journey</div>${journeyHTML(series)}${more}`;
    slot.querySelectorAll('.j-tbr').forEach((btn) =>
      btn.addEventListener('click', () => actHero(btn, async () => {
        const { book } = await api('/books', { method: 'POST', body: {
          title: btn.dataset.title,
          author: btn.dataset.author || null,
          series_name: btn.dataset.series,
          source_provider: 'hardcover',
          source_id: btn.dataset.hc,
        } });
        await api('/tbr', { method: 'POST', body: { book_id: book.id } });
        btn.textContent = '✓ Queued';
        btn.disabled = true;
        toast(`“${btn.dataset.title}” added to your TBR`);
      })));
    $('#journey-more')?.addEventListener('click', () => load(expanded ? undefined : 'all'));
  };
  await load();
}

// Reading streak: consecutive days with any logged progress (entries or the
// ±% buttons). Hydrated like the journey card so it never delays the page.
async function hydrateStreak() {
  const slot = $('#streak-strip');
  if (!slot) return;
  let st = null;
  try { st = await api('/streaks'); } catch { /* stays empty */ }
  if (!$('#streak-strip')) return; // view changed while we were waiting
  slot.innerHTML = !st || (!st.current && !st.best)
    ? '<span class="muted small">🔥 Log progress today to start a streak.</span>'
    : `<b>🔥 ${st.current}-day streak</b><span class="muted small"> · best ${st.best}</span>`;
}

// Reading together: circle members' in-progress books, hydrated after paint
// (like the journey card) so the dashboard's own stats never wait on it.
async function hydrateTogether() {
  const slot = $('#together-card');
  if (!slot) return;
  let readers = [];
  try { readers = (await api('/members/reading-now')).readers || []; } catch { /* stays empty */ }
  if (!$('#together-card')) return; // view changed while we were waiting
  slot.innerHTML = `<div class="k">Reading together</div>${togetherRows(readers,
    '<div class="muted small">Star friends with ☆ on the <a href="#members">Members</a> page — the books they\'re mid-way through show up here.</div>')}`;
  bindTogetherTbr(slot);
}

function formatSplit(f) {
  const total = (f.read?.books || 0) + (f.listened?.books || 0);
  if (!total) return '<div class="muted small">No finished books yet.</div>';
  const r = f.read || { books: 0, words: 0, pages: 0 };
  const l = f.listened || { books: 0, words: 0, hours: 0 };
  const pct = (n) => Math.round((n / total) * 100);
  return `<div class="split">
    <div class="split-bar"><div class="split-read" style="width:${pct(r.books)}%"></div><div class="split-listen" style="width:${pct(l.books)}%"></div></div>
    <div class="split-legend">
      <div><span class="dot read"></span>Read · ${r.books} books · ${fmtWords(r.words)} words · ${fmtNum(r.pages)} pages</div>
      <div><span class="dot listen"></span>Listened · ${l.books} books · ${fmtWords(l.words)} words · ${fmtNum(Math.round(l.hours))} hrs</div>
    </div></div>`;
}

registerRoute('#dashboard', dashboard);
