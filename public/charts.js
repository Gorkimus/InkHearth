const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtShort = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M'
  : n >= 1e3 ? Math.round(n / 1e3) + 'K'
  : String(n);

// Vertical bars — words per month (or per year); `full` overrides the tooltip.
export function monthBars(months) {
  const max = Math.max(...months.map((m) => m.words), 1);
  return `<div class="chart-bars">${months
    .map((m) => `
      <div class="bar-col" title="${esc(m.full || m.label)}: ${fmtShort(m.words)} words · ${m.books} book${m.books === 1 ? '' : 's'}">
        <div class="bar" style="height:${Math.max(2, Math.round((m.words / max) * 120))}px"></div>
        <div class="bar-label">${esc(m.label)}</div>
      </div>`)
    .join('')}</div>`;
}

// Progress ring — yearly-goal completion (hand-rolled SVG, no library).
export function progressRing(pct, { size = 64, stroke = 7 } = {}) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${Math.round(p)}%">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${(p / 100 * c).toFixed(1)} ${c.toFixed(1)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="${size * 0.22}" fill="var(--text)">${Math.round(p)}%</text>
  </svg>`;
}

// Reading Chemistry ring — same geometry, but the arc's gradient is keyed to
// the score: red at 0 through yellow at 50 (no signal) to green at 100.
let ringSeq = 0;
export function chemistryRing(pct, { size = 92, stroke = 9 } = {}) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const id = `chem-grad-${++ringSeq}`;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${Math.round(p)}% reading chemistry">
    <defs>
      <linearGradient id="${id}" x1="0%" y1="100%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="hsl(${Math.round(p * 0.6)}, 62%, 46%)"/>
        <stop offset="100%" stop-color="hsl(${Math.round(p * 1.2)}, 66%, 52%)"/>
      </linearGradient>
    </defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--panel-2)" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${(p / 100 * c).toFixed(1)} ${c.toFixed(1)}"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-weight="700" font-size="${size * 0.24}" fill="var(--text)">${Math.round(p)}%</text>
  </svg>`;
}

// GitHub-style activity calendar from {date, books, words} day entries.
// Cell color: intensity by words, with any-finish days guaranteed non-empty.
export function heatmap(days) {
  if (!days?.length) return '<div class="muted small">No dated activity yet.</div>';
  const maxWords = Math.max(...days.map((d) => d.words), 1);
  const pad = new Date(days[0].date + 'T00:00:00').getDay();
  const cells = [];
  for (let i = 0; i < pad; i++) cells.push('<div class="hm-cell hm-empty"></div>');
  for (const d of days) {
    const frac = d.words / maxWords;
    const level = d.books === 0 ? 0 : frac >= 0.66 ? 4 : frac >= 0.33 ? 3 : d.books >= 2 ? 2 : 1;
    cells.push(`<div class="hm-cell hm-l${level}" title="${d.date}: ${d.books} book${d.books === 1 ? '' : 's'}${d.words ? ' · ' + fmtShort(d.words) + ' words' : ''}"></div>`);
  }
  const active = days.filter((d) => d.books > 0).length;
  return `<div class="heatmap" role="img" aria-label="Activity calendar: ${active} day${active === 1 ? '' : 's'} with a finish, brightest ${fmtShort(maxWords)} words">${cells.join('')}</div>`;
}

// Horizontal bars — genres, authors, anything ranked.
export function hbars(items, { valueFmt = fmtShort } = {}) {
  if (!items.length) return '<div class="muted small">Not enough data yet.</div>';
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="hbars">${items
    .map(
      (i) => `
      <div class="hbar-row">
        <div class="hbar-label" title="${esc(i.label)}">${esc(i.label)}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(3, Math.round((i.value / max) * 100))}%"></div></div>
        <div class="hbar-val">${esc(valueFmt(i.value))}</div>
      </div>`
    )
    .join('')}</div>`;
}
