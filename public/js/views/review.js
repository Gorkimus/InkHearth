import { monthBars, hbars, heatmap } from '../../charts.js';
import { api } from '../api.js';
import { $, esc, fmtWords, fmtNum, tierBadge, guard } from '../ui.js';
import { view, registerRoute } from '../router.js';
import { bookModal } from '../book-modal.js';

// Year-in-review (Phase 5): one year's story — totals, monthly pace, tier
// distribution, format split, genres/authors/narrators, DNFs, biggest books.
const currentYear = () => String(new Date().getFullYear());

async function reviewView() {
  const segs = location.hash.split('/');
  if (segs[2] === 'story') return storyView(segs[1] || currentYear());
  const chosen = segs[1] || currentYear();
  const [{ years }, yr] = await Promise.all([api('/stats'), api('/stats/year/' + chosen)]);

  const options = [...new Set([...years.map((y) => y.year), currentYear()])]
    .sort((a, b) => b.localeCompare(a));
  const t = yr.totals;
  const approx = t.any_estimated ? '≈' : '';
  const tiers = ['S', 'A', 'B', 'C', 'D'].map((k) => ({ k, n: yr.tiers[k] }));
  const bestMonth = [...yr.months].sort((a, b) => b.words - a.words)[0];

  view.innerHTML = `
    <h1>${esc(chosen)} in review</h1>
    <div class="toolbar">
      <select id="rev-year">${options.map((y) =>
        `<option value="${y}" ${y === chosen ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <button class="btn" id="story-go">▶ Story mode</button>
      <span class="muted small">words counted ${t.any_estimated ? '≈ (est.)' : ''}${t.any_unknown ? ' · some books lack length data' : ''}</span>
    </div>
    ${t.books_read === 0 ? `
      <div class="card"><p class="muted" style="margin:4px 0">Nothing was finished in ${esc(chosen)}.
      Memory-lane entries with just a year still count — log some via <a href="#memory">Memory lane</a>.</p></div>` : `
    <div class="headline-cards">
      <div class="card big"><div class="k">Books finished</div><div class="v">${t.books_read}</div>
        <div class="sub">${t.dnfs} DNF${t.dnfs === 1 ? '' : 's'}</div></div>
      <div class="card big"><div class="k">Words read</div><div class="v">${approx}${fmtWords(t.words)}</div>
        <div class="sub">${bestMonth && bestMonth.words ? `best month: ${bestMonth.label}` : ''}</div></div>
      <div class="card"><div class="k">Pages</div><div class="v">${fmtNum(t.pages)}</div>
        <div class="sub">${fmtNum(Math.round(t.hours))} hrs listened</div></div>
      <div class="card"><div class="k">Tier spread</div><div class="v" style="letter-spacing:2px">
        ${tiers.map((x) => `<span class="badge tier-${x.k}" title="${x.k}: ${x.n}">${x.n}</span>`).join(' ')}</div>
        <div class="sub">S ${tiers[0].n} · A ${tiers[1].n} · B ${tiers[2].n} · C ${tiers[3].n} · D ${tiers[4].n}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="k">Pace — words per month</div>${monthBars(yr.months)}</div>
      <div class="card"><div class="k">Format split <span class="muted small">(books)</span></div>${formatSplit(yr.formats)}</div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="k">Genres</div>${hbars(yr.genres.slice(0, 8).map((g) => ({ label: g.genre, value: g.books })), { valueFmt: fmtNum })}</div>
      <div class="card"><div class="k">Authors <span class="muted small">(words; best first)</span></div>${hbars(yr.authors.slice(0, 8).map((a) => ({ label: a.avg_tier ? `${a.author} · ${a.avg_tier}` : a.author, value: a.words })), { valueFmt: fmtWords })}</div>
    </div>
    ${(yr.tags || []).length || (yr.moods || []).length ? `
    <div class="grid-2">
      <div class="card"><div class="k">Tags <span class="muted small">(words)</span></div>${(yr.tags || []).length
        ? hbars(yr.tags.slice(0, 8).map((x) => ({ label: x.tag, value: x.words })), { valueFmt: fmtWords })
        : '<div class="muted small">No tagged books this year.</div>'}</div>
      <div class="card"><div class="k">Moods <span class="muted small">(words)</span></div>${(yr.moods || []).length
        ? hbars(yr.moods.slice(0, 8).map((x) => ({ label: x.mood, value: x.words })), { valueFmt: fmtWords })
        : '<div class="muted small">No mood data this year.</div>'}</div>
    </div>` : ''}
    <div class="card" style="margin-top:14px">
      <div class="k">The books, biggest first</div>
      <table class="lib-table">
        <thead><tr><th>Book</th><th>Tier</th><th>Format</th><th>Words</th><th>Finished</th></tr></thead>
        <tbody>${yr.top_books.map((b) => `
          <tr class="rev-row" data-id="${b.book_id}">
            <td><div class="t">${esc(b.title)}</div><div class="muted small">${esc(b.author || '')}</div></td>
            <td>${b.rating ? tierBadge(b.rating) : '<span class="muted small">—</span>'}</td>
            <td class="muted small">${b.format === 'listened' ? '🎧' : '📖'}</td>
            <td class="muted small">${fmtWords(b.words)}</td>
            <td class="muted small">${esc(b.finished)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
    ${yr.narrators.length ? `
    <div class="card" style="margin-top:14px"><div class="k">Narrators <span class="muted small">(books · narration tier)</span></div>
      ${yr.narrators.map((n) => `<span class="pill" style="margin:0 6px 6px 0">${esc(n.name)} · ${n.books} · ${n.avg_tier || 'unrated'}</span>`).join('')}
    </div>` : ''}
    ${yr.dnfs.length ? `
    <div class="card" style="margin-top:14px"><div class="k">DNFs</div>
      ${yr.dnfs.map((d) => `<div class="rowline">${esc(d.title)} <span class="muted small">${esc(d.author || '')} — abandoned at ${d.dnf_percent || '?'}%</span></div>`).join('')}
    </div>` : ''}
  `}`;

  $('#story-go')?.addEventListener('click', guard(() => storyView(chosen)));
}

function formatSplit(f) {
  const r = f.read || { books: 0, words: 0, pages: 0 };
  const l = f.listened || { books: 0, words: 0, hours: 0 };
  const total = r.books + l.books;
  if (!total) return '<div class="muted small">No finished books.</div>';
  const pct = (n) => Math.round((n / total) * 100);
  return `<div class="split">
    <div class="split-bar"><div class="split-read" style="width:${pct(r.books)}%"></div><div class="split-listen" style="width:${pct(l.books)}%"></div></div>
    <div class="split-legend">
      <div><span class="dot read"></span>Read · ${r.books} · ${fmtNum(r.pages)} pages</div>
      <div><span class="dot listen"></span>Listened · ${l.books} · ${fmtNum(Math.round(l.hours))} hrs</div>
    </div></div>`;
}

// ---------- story mode (Wrapped-style, full-screen) ----------
// One insight per slide from the same /api/stats/year data; swipe, arrow
// keys, dots or the edge buttons move through. The closing slide can export a
// shareable summary card as PNG (text-only canvas — remote covers would taint
// it, per the tier-board export gotcha).

function buildSlides(yr, year) {
  const t = yr.totals;
  const approx = t.any_estimated ? '≈' : '';
  const bestMonth = [...yr.months].sort((a, b) => b.words - a.words)[0];
  const top5 = [...yr.top_books].sort((a, b) => b.words - a.words).slice(0, 5).reverse();
  const topNarr = [...yr.narrators].sort((a, b) => b.books - a.books)[0];
  const activeDays = (yr.days || []).filter((d) => d.books > 0).length;

  const slides = [];
  slides.push(`
    <div class="story-kicker">${year} · InkHearth</div>
    <h1 class="story-h">${t.books_read} book${t.books_read === 1 ? '' : 's'}</h1>
    <p class="story-p">${approx}${fmtWords(t.words)} words${t.dnfs ? ` — and ${t.dnfs} DNF${t.dnfs === 1 ? '' : 's'} along the way` : ' — not a single DNF'}.`);

  slides.push(`
    <div class="story-kicker">The pace</div>
    <h1 class="story-h">${bestMonth?.label || '—'} was your biggest month</h1>
    <div class="story-chart">${monthBars(yr.months)}</div>`);

  if (yr.days?.length) {
    slides.push(`
      <div class="story-kicker">The rhythm</div>
      <h1 class="story-h">${activeDays} day${activeDays === 1 ? '' : 's'} with a finish</h1>
      <div class="story-chart">${heatmap(yr.days)}</div>`);
  }

  if (top5.length) {
    slides.push(`
      <div class="story-kicker">The heavyweights</div>
      <h1 class="story-h">Your top ${top5.length}</h1>
      ${top5.map((b, i) => `
        <div class="story-row"><span class="story-rank">#${top5.length - i}</span>
          <span><strong>${esc(b.title)}</strong> <span class="muted small">${esc(b.author || '')}</span><br>
          <span class="muted small">${fmtWords(b.words)} words${b.rating ? ` · ${b.rating}-tier` : ''}</span></span></div>`).join('')}`);
  }

  slides.push(`
    <div class="story-kicker">The verdicts</div>
    <h1 class="story-h">How you ranked them</h1>
    <div class="story-tiers">${['S', 'A', 'B', 'C', 'D'].map((k) =>
      `<span class="badge tier-${k}" title="${k}: ${yr.tiers[k]}">${k} · ${yr.tiers[k]}</span>`).join(' ')}</div>
    <p class="story-p">${yr.genres[0] ? `Favorite shelf: <strong>${esc(yr.genres[0].genre)}</strong> (${yr.genres[0].books} books).` : ''}`);

  if (topNarr) {
    slides.push(`
      <div class="story-kicker">The voice of the year</div>
      <h1 class="story-h">${esc(topNarr.name)}</h1>
      <p class="story-p">Narrated ${topNarr.books} book${topNarr.books === 1 ? '' : 's'} for you${topNarr.avg_tier ? ` — average tier ${topNarr.avg_tier}` : ', unrated'}.</p>`);
  }

  slides.push(`
    <div class="story-kicker">That's a wrap</div>
    <h1 class="story-h">${year}, you showed up.</h1>
    <p class="story-p">${approx}${fmtWords(t.words)} words. ${fmtNum(t.pages)} pages. ${fmtNum(Math.round(t.hours))} hours listened.</p>
    <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px">
      <button class="btn" id="story-breakdown">Full breakdown</button>
      <button class="btn ghost" id="story-export">Export as image</button>
    </div>`);
  return slides;
}

// Text-only canvas summary — the shareable artifact for the closing slide.
function exportStoryCard(yr, year) {
  const t = yr.totals;
  const top3 = [...yr.top_books].sort((a, b) => b.words - a.words).slice(0, 3);
  const W = 1080, H = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#e8ebf2';
  ctx.textAlign = 'center';
  ctx.font = '600 40px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`${year} in books`, W / 2, 130);
  ctx.font = '700 120px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#6ea8fe';
  ctx.fillText(String(t.books_read), W / 2, 280);
  ctx.font = '400 34px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#e8ebf2';
  ctx.fillText(`books · ≈${fmtWords(t.words)} words`, W / 2, 350);
  ctx.fillText(`${fmtNum(t.pages)} pages · ${fmtNum(Math.round(t.hours))} hrs listened`, W / 2, 404);
  if (top3.length) {
    ctx.textAlign = 'left';
    ctx.font = '600 26px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#8b93a7';
    ctx.fillText('HEAVYWEIGHTS', 140, 530);
    ctx.font = '400 30px -apple-system, "Segoe UI", Roboto, sans-serif';
    top3.forEach((b, i) => {
      ctx.fillStyle = '#e8ebf2';
      ctx.fillText(`${i + 1}. ${b.title.slice(0, 38)}`, 140, 590 + i * 56);
      ctx.fillStyle = '#8b93a7';
      ctx.textAlign = 'right';
      ctx.fillText(fmtWords(b.words), W - 140, 590 + i * 56);
      ctx.textAlign = 'left';
    });
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b93a7';
  ctx.font = '400 24px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('tracked with InkHearth', W / 2, H - 70);
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `book-tracker-${year}.png`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

async function storyView(year) {
  const yr = await api('/stats/year/' + year);
  const slides = buildSlides(yr, year);
  const overlay = document.createElement('div');
  overlay.id = 'story-overlay';
  overlay.innerHTML = `
    <div class="story-dots">${slides.map((_, i) => `<span data-i="${i}" class="${i === 0 ? 'on' : ''}"></span>`).join('')}</div>
    <div class="story-stage"><div class="story-slide">${slides[0]}</div></div>
    <button class="story-nav prev" aria-label="previous">‹</button>
    <button class="story-nav next" aria-label="next">›</button>
    <button class="story-close" aria-label="close">✕</button>
    <div class="story-hint muted small">swipe or use ← →</div>`;
  document.body.appendChild(overlay);

  let i = 0;
  const stage = overlay.querySelector('.story-stage');
  const dots = [...overlay.querySelectorAll('.story-dots span')];
  const show = (n) => {
    i = Math.max(0, Math.min(slides.length - 1, n));
    stage.innerHTML = `<div class="story-slide">${slides[i]}</div>`;
    dots.forEach((d, di) => d.classList.toggle('on', di === i));
    stage.querySelector('#story-breakdown')?.addEventListener('click', () => { location.hash = '#review/' + year; });
    stage.querySelector('#story-export')?.addEventListener('click', () => exportStoryCard(yr, year));
  };
  const close = () => {
    window.removeEventListener('hashchange', onClose);
    overlay.remove();
  };
  const onClose = () => close(); // leaving via back/navigation tears the overlay down
  window.addEventListener('hashchange', onClose);
  const move = (d) => {
    if (d > 0 && i === slides.length - 1) return close();
    show(i + d);
  };

  overlay.querySelector('.story-close').addEventListener('click', close);
  overlay.querySelector('.story-nav.prev').addEventListener('click', () => move(-1));
  overlay.querySelector('.story-nav.next').addEventListener('click', () => move(1));
  dots.forEach((d) => d.addEventListener('click', () => show(+d.dataset.i)));
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') move(1);
    if (e.key === 'ArrowLeft') move(-1);
  });
  overlay.tabIndex = -1;
  overlay.focus();
  let touchX = null;
  overlay.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  overlay.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) move(dx < 0 ? 1 : -1);
    touchX = null;
  }, { passive: true });
}

registerRoute('#review/', reviewView);
registerRoute('#review', reviewView);
