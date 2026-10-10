import { api } from '../api.js';
import { $, esc, toast, tierBadge, fmtWords, fmtNum } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { bookModal } from '../book-modal.js';
import { chemistryRing } from '../../charts.js';

// Compare (Phase 3 + stat blocks): overlap, rating deltas, series agreement,
// and side-by-side taste stats between two members of this instance.
// Cross-user reads are consent-based — the other member must opt in (server
// 403s otherwise); only tier letters and book/series names cross accounts.
// The visible stat sections are per-user preferences (account prefs).

const deltaHTML = (d) => {
  if (d === null || d === undefined) return '<span class="muted">—</span>';
  if (d > 0) return `<span class="delta-pos">+${d}</span>`;
  if (d < 0) return `<span class="delta-neg">${d}</span>`;
  return '<span class="muted">0</span>';
};

const avgFmt = (a) => (a ? `${a.tier} (${a.score})` : '<span class="muted">—</span>');

const CMP_SECTIONS = [
  ['totals', 'Totals'],
  ['race', 'This year\u2019s race'],
  ['tiers', 'Tier spread'],
  ['formats', 'Formats'],
  ['genres', 'Genres'],
  ['books', 'Books in common'],
  ['series', 'Series rollups'],
];

async function compareHome() {
  const [{ share }, { users }] = await Promise.all([api('/compare/consent'), api('/compare/users')]);
  view.innerHTML = `
    <h1>Compare</h1>
    <p class="muted">See where your taste lines up with another member of this instance:
    books you've both logged, rating deltas, and series agreement.</p>
    <div class="card">
      <h3 style="margin-top:0">Share my tiers</h3>
      <p class="muted small" style="margin:6px 0 12px">New accounts share by default: other members can see your tier
      letters (S–D) for books and series you've logged — never dates, notes,
      formats, or your TBR. Turn it off any time (also under Account → Privacy).</p>
      <button class="btn ${share ? 'ghost' : ''}" id="cmp-consent">${share ? '✓ Sharing — turn off' : 'Sharing is off — turn it on'}</button>
    </div>
    <h3 style="margin-top:26px">Pick a member</h3>
    <div class="toolbar">
      <select id="cmp-user">${users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <button class="btn" id="cmp-go" ${users.length ? '' : 'disabled'}>Compare</button>
    </div>
    ${users.length ? '' : '<div class="muted small" style="margin-top:10px">No one has opted in yet — share your tiers, then invite the other member to do the same.</div>'}`;
  $('#cmp-consent').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { share: now } = await api('/compare/consent', { method: 'PUT', body: { share: !share } });
      toast(now ? 'Sharing your tiers — others can compare with you' : 'Sharing off — you can no longer be compared');
      compareHome(); // re-render so the button reflects the new state
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  });
  $('#cmp-go').addEventListener('click', () => {
    location.hash = '#compare/' + $('#cmp-user').value;
  });
}

function customizeHTML(ns, sections, defs) {
  return `
    <div class="card hidden" id="${ns}-customize">
      <div class="k">Show sections</div>
      ${defs.map(([key, label]) => `
        <label style="display:block;margin:4px 0">
          <input type="checkbox" data-sec="${key}" ${sections[key] !== false ? 'checked' : ''}> ${esc(label)}
        </label>`).join('')}
    </div>`;
}

function bindCustomize(ns, defs, rerender) {
  const gear = $(`#${ns}-gear`);
  const box = $(`#${ns}-customize`);
  gear.addEventListener('click', () => box.classList.toggle('hidden'));
  box.querySelectorAll('input[data-sec]').forEach((cb) =>
    cb.addEventListener('change', async () => {
      const patch = { sections: {} };
      for (const def of box.querySelectorAll('input[data-sec]')) patch.sections[def.dataset.sec] = def.checked;
      await api('/account/prefs', { method: 'PUT', body: { [ns]: patch } });
      rerender();
    }));
}

async function compareWith(id) {
  let cmp;
  try {
    cmp = await api('/compare/with/' + id);
  } catch (err) {
    view.innerHTML = `
      <h1>Compare</h1>
      <div class="card"><p class="muted" style="margin:0 0 12px">${esc(err.message)}</p>
      <a href="#compare">← Back to Compare</a></div>`;
    return;
  }
  const { summary, books, series, stats, user, me } = cmp;
  const prefs = await api('/account/prefs');
  const sections = { totals: true, tiers: true, formats: true, genres: true, books: true, series: true,
    ...(prefs.compare?.sections || {}) };
  const tilt = summary.avg_delta === null ? ''
    : summary.avg_delta > 0 ? `On average you rate ${summary.avg_delta} tier${Math.abs(summary.avg_delta) === 1 ? '' : 's'} higher.`
    : summary.avg_delta < 0 ? `On average you rate ${Math.abs(summary.avg_delta)} tier${Math.abs(summary.avg_delta) === 1 ? '' : 's'} lower.`
    : 'You rate in lockstep on average.';
  const taste = summary.taste || { raw: 0, damped: 0, pct: 50, n: 0 };
  // Per-genre chemistry bars (raw correlation mapped 0–100; server skips
  // genres with fewer than 3 commonly-rated books).
  const alignByGenre = new Map((cmp.genre_alignment || []).map((g) => [g.genre, g]));
  const chemBar = (a) => a
    ? `<div class="chem-bar"><div class="chem-bar-track"><div class="chem-bar-fill" style="width:${a.pct}%;background:hsl(${Math.round(a.pct * 1.2)}, 62%, 46%)"></div></div>
       <div class="muted small" style="margin-top:3px">${a.pct}% · ${a.n} rated</div></div>`
    : '<span class="muted small">—</span>';

  const sideBySide = (rows) => `
    <table class="lib-table static">
      <thead><tr><th></th><th>You</th><th>${esc(user.name)}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // Genres: union of both members' genre lists, biggest combined first.
  const genreUnion = new Map();
  for (const g of [...stats.me.genres, ...stats.them.genres]) {
    if (!genreUnion.has(g.genre)) {
      genreUnion.set(g.genre, {
        me: stats.me.genres.find((x) => x.genre === g.genre) || { read: 0, listened: 0 },
        them: stats.them.genres.find((x) => x.genre === g.genre) || { read: 0, listened: 0 },
      });
    }
  }
  const genreRows = [...genreUnion.entries()]
    .sort((a, b) => ((b[1].me.read + b[1].me.listened + b[1].them.read + b[1].them.listened)
      - (a[1].me.read + a[1].me.listened + a[1].them.read + a[1].them.listened)))
    .map(([genre, c]) => `
      <tr><td><div class="t">${esc(genre)}</div></td>
        <td class="muted small">${c.me.read} 📖 · ${c.me.listened} 🎧</td>
        <td class="muted small">${c.them.read} 📖 · ${c.them.listened} 🎧</td>
        <td>${chemBar(alignByGenre.get(genre))}</td></tr>`)
    .join('');

  const sectionHTML = {
    totals: `
      <h3>Totals <span class="muted small">(all time)</span></h3>
      <div class="card">${sideBySide(`
        <tr><td>Books finished</td><td>${fmtNum(stats.me.totals.books_read)}</td><td>${fmtNum(stats.them.totals.books_read)}</td></tr>
        <tr><td>Average rating <span class="muted small">(D=1 … S=5)</span></td><td>${avgFmt(stats.me.avg)}</td><td>${avgFmt(stats.them.avg)}</td></tr>
        <tr><td>Words</td><td>${fmtWords(stats.me.totals.words)}</td><td>${fmtWords(stats.them.totals.words)}</td></tr>
        <tr><td>Pages</td><td>${fmtNum(stats.me.totals.pages)}</td><td>${fmtNum(stats.them.totals.pages)}</td></tr>
        <tr><td>Hours listened</td><td>${fmtNum(stats.me.totals.hours)}</td><td>${fmtNum(stats.them.totals.hours)}</td></tr>
        <tr><td>DNFs</td><td>${fmtNum(stats.me.totals.dnfs)}</td><td>${fmtNum(stats.them.totals.dnfs)}</td></tr>`)}</div>`,
    race: `
      <h3>This year\u2019s race <span class="muted small">(${new Date().getFullYear()})</span></h3>
      <div class="card">
        <div class="race-row race-head"><span>${esc(me.name)}</span><span></span><span>${esc(user.name)}</span></div>
        ${[
          ['Books finished', 'books', (v) => fmtNum(v)],
          ['Words', 'words', (v) => fmtWords(v)],
          ['Hours listened', 'hours', (v) => fmtNum(v)],
          ['DNFs', 'dnfs', (v) => fmtNum(v)],
          ['Current streak', 'streak', (v) => `${v} day${v === 1 ? '' : 's'}`],
        ].map(([label, key, fmt]) => {
          const a = stats.me.race?.[key] ?? 0;
          const b = stats.them.race?.[key] ?? 0;
          return `<div class="race-row">
            <span class="${a > b ? 'race-lead' : ''}">${fmt(a)}</span>
            <span class="muted small">${label}</span>
            <span class="${b > a ? 'race-lead' : ''}">${fmt(b)}</span>
          </div>`;
        }).join('')}
      </div>`,
    tiers: `
      <h3>Tier spread</h3>
      <div class="card">${sideBySide(['S', 'A', 'B', 'C', 'D'].map((t) => `
        <tr><td>${tierBadge(t)}</td>
          <td>${stats.me.tiers[t] || 0}</td>
          <td>${stats.them.tiers[t] || 0}</td></tr>`).join(''))}</div>`,
    formats: `
      <h3>Formats <span class="muted small">(books · words)</span></h3>
      <div class="card">${sideBySide(`
        <tr><td>📖 Read</td>
          <td class="muted small">${stats.me.formats.read.books} books · ${fmtWords(stats.me.formats.read.words)} words</td>
          <td class="muted small">${stats.them.formats.read.books} books · ${fmtWords(stats.them.formats.read.words)} words</td></tr>
        <tr><td>🎧 Listened</td>
          <td class="muted small">${stats.me.formats.listened.books} books · ${fmtWords(stats.me.formats.listened.words)} words · ${fmtNum(Math.round(stats.me.formats.listened.hours))}h</td>
          <td class="muted small">${stats.them.formats.listened.books} books · ${fmtWords(stats.them.formats.listened.words)} words · ${fmtNum(Math.round(stats.them.formats.listened.hours))}h</td></tr>`)}</div>`,
    genres: `
      <h3>Genres <span class="muted small">(finished · read / listened · chemistry from 3+ commonly rated)</span></h3>
      <div class="card">${genreRows.length ? `
        <table class="lib-table static">
          <thead><tr><th></th><th>You</th><th>${esc(user.name)}</th><th>Chemistry</th></tr></thead>
          <tbody>${genreRows}</tbody>
        </table>` : '<div class="muted small">No genre data yet.</div>'}</div>`,
    books: `
      <h3>Rating deltas ${summary.both_rated ? `<span class="muted small">(${summary.agree} of ${summary.both_rated} identical tiers)</span>` : ''}</h3>
      <div class="card" id="cmp-books">${books.length ? `
        <table class="lib-table">
          <thead><tr><th>Book</th><th>You</th><th>${esc(user.name)}</th><th>Δ</th></tr></thead>
          <tbody>${books.map((b) => `
            <tr class="cmp-row" data-id="${b.id}" title="Open your copy">
              <td><div class="t">${esc(b.title)}</div>
                <div class="muted small">${b.author ? `<a class="text-link" href="#add/author/${encodeURIComponent(b.author)}">${esc(b.author)}</a>` : ''}${b.series_name ? ` · <a class="text-link" href="#add/series/${encodeURIComponent(b.series_name)}">${esc(b.series_name)}</a>` : ''}</div></td>
              <td>${b.mine ? tierBadge(b.mine) : '<span class="muted small">unrated</span>'}</td>
              <td>${b.theirs ? tierBadge(b.theirs) : '<span class="muted small">unrated</span>'}</td>
              <td>${deltaHTML(b.delta)}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<div class="muted small">No overlap yet — no book has entries on both accounts.</div>'}
      </div>`,
    series: `
      <h3>Series agreement</h3>
      <p class="muted small">Your series rollup vs theirs (avg of members' tiers, D=1 … S=5; overrides apply).</p>
      <div class="card" id="cmp-series">${series.length ? `
        <table class="lib-table">
          <thead><tr><th>Series</th><th>You</th><th>${esc(user.name)}</th><th>Δ</th></tr></thead>
          <tbody>${series.map((s) => `
            <tr>
              <td><div class="t"><a class="text-link" href="#add/series/${encodeURIComponent(s.series)}">${esc(s.series)}</a></div></td>
              <td>${tierBadge(s.mine.tier)} <span class="muted small">avg ${s.mine.score.toFixed(2)}</span></td>
              <td>${tierBadge(s.theirs.tier)} <span class="muted small">avg ${s.theirs.score.toFixed(2)}</span></td>
              <td>${deltaHTML(s.delta)}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<div class="muted small">No series rated by you both (needs 2+ rated members on each side).</div>'}
      </div>`,
  };

  view.innerHTML = `
    <h1>You × ${esc(user.name)}</h1>
    <div class="toolbar">
      <a href="#compare">← All members</a>
      <a class="btn ghost" href="#board/${id}" style="padding:4px 12px;font-size:13px">🎲 View ${esc(user.name)}'s tier board</a>
      <span class="muted small">${esc(me.name)} vs ${esc(user.name)}</span>
      <button class="btn ghost" id="cmp-gear" style="padding:4px 12px;font-size:13px">⚙ Customize</button>
    </div>
    ${customizeHTML('cmp', sections, CMP_SECTIONS)}
    <div class="grid-2">
      <div class="card"><div class="k">Books in common</div><div class="v">${summary.shared}</div>
        <div class="sub">${summary.both_rated} rated by you both</div></div>
      <div class="card">
        <div class="k">Reading Chemistry</div>
        <div class="chem-row">
          ${taste.n ? chemistryRing(taste.pct, { size: 92, stroke: 9 }) : '<span class="muted small">—</span>'}
          <div class="muted small" style="flex:1">${taste.n
            ? `${taste.n} commonly rated · ${tilt.toLowerCase()}`
            : 'rate some of the same books to get a score'}</div>
        </div>
      </div>
    </div>
    ${CMP_SECTIONS.map(([key]) => (sections[key] !== false ? sectionHTML[key] : '')).join('')}`;

  bindCustomize('cmp', CMP_SECTIONS, () => compareWith(id));
  $('#cmp-books')?.querySelectorAll('.cmp-row').forEach((row) =>
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // author/series links go to Log a book
      bookModal(+row.dataset.id);
    }));
}

function compareRoute() {
  const id = location.hash.split('/')[1];
  return id ? compareWith(+id) : compareHome();
}

registerRoute('#compare/', compareRoute);
registerRoute('#compare', compareRoute);
