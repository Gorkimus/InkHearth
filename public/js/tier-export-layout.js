// Pure layout math for the tier board's PNG export. No DOM, no canvas — the
// renderer in tierboard.js consumes the returned geometry, and a Node scratch
// test can import this exact module to pin the math down without a browser.

export const LAYOUT = {
  W: 1600,
  pad: 28,        // canvas margin, all sides
  labelW: 128,    // tier letter block width
  labelGap: 12,   // label block → first cover column
  coverW: 64,
  coverH: 96,
  cellGapX: 10,   // horizontal gap between cover tiles
  cellGapY: 12,   // vertical gap between cover lines
  rowGap: 14,     // vertical gap between tier rows
  headerH: 64,    // title strip above the first tier row
  titleTop: 24,   // title text's top edge (textBaseline 'top')
};

// rows: [{ tier, desc, count }] in draw order. Returns the canvas height and,
// per row, the label block rect and an exact {x, y} origin for every book's
// cover tile — wrapped onto as many lines as the count needs, so the export
// always fits the whole board (the old fixed-height canvas truncated with
// "+N more" once a tier outgrew its single strip).
export function planExport(rows, L = LAYOUT) {
  const cellX0 = L.pad + L.labelW + L.labelGap;
  const perLine = Math.max(1, Math.floor((L.W - L.pad - cellX0) / (L.coverW + L.cellGapX)));
  let y = L.headerH;
  const out = [];
  for (const row of rows) {
    const lines = Math.max(1, Math.ceil(row.count / perLine));
    const h = Math.max(L.coverH, lines * L.coverH + (lines - 1) * L.cellGapY);
    const cells = [];
    for (let i = 0; i < row.count; i++) {
      cells.push({
        x: cellX0 + (i % perLine) * (L.coverW + L.cellGapX),
        y: y + Math.floor(i / perLine) * (L.coverH + L.cellGapY),
      });
    }
    out.push({ ...row, y, h, lines, cells, perLine });
    y += h + L.rowGap;
  }
  const contentBottom = out.length ? y - L.rowGap : L.headerH;
  return { ...L, cellX0, perLine, H: contentBottom + L.pad, rows: out };
}

// ---- the text listing (the "include book list" export) ----
// A bookadoro-style section rendered BELOW the covers board in the same
// canvas: per tier, a colored pill then the tier's books as wrapped
// title + author lines flowing down three columns. Pure math again — the
// browser pre-wraps each title with canvas measureText and hands the
// planner line COUNTS; this module turns counts into geometry.

export const TEXT_LAYOUT = {
  pad: 28,       // canvas margin, mirrors LAYOUT.pad
  cols: 3,
  colGap: 40,    // gutter between text columns
  dividerTop: 14,   // divider hairline → tier pill
  pillH: 26,
  listTop: 16,   // tier pill → first entry
  entryGap: 12,  // between entries in a column
  titleLineH: 20,   // bold 15px wrapped title line
  authorLineH: 17,  // 13px author line
  groupGap: 30,  // last entry → the next tier's divider
};

// The renderer measures wrapped titles against this width BEFORE planning,
// so both sides must derive it identically.
export function textColW(W = LAYOUT.W, L = TEXT_LAYOUT) {
  return (W - 2 * L.pad - (L.cols - 1) * L.colGap) / L.cols;
}

// groups: [{ tier, desc, items: [{ titleLines }] }] in draw order (the '?'
// unrated group included when non-empty). Columns fill in reading order —
// a column takes entries until it holds its share of the group's total
// height, then the next column starts — so long tiers spread evenly and a
// short tier never borrows a second column. Returns the section height
// (relative to startY) and, per group, the divider/pill Y origins and
// absolute per-item {x, y}.
export function planTextSection(groups, startY, L = TEXT_LAYOUT) {
  const W = LAYOUT.W;
  const colW = textColW(W, L);
  const out = [];
  let y = startY;
  for (const g of groups) {
    if (!g.items.length) continue;
    const heights = g.items.map((it) => it.titleLines * L.titleLineH + L.authorLineH);
    const totalH = heights.reduce((a, b) => a + b, 0) + (heights.length - 1) * L.entryGap;
    const target = totalH / L.cols;
    const cols = [];
    let ci = 0;
    let cy = 0;
    g.items.forEach((it, i) => {
      if (!cols[ci]) cols[ci] = [];
      cols[ci].push({ i, y: cy, h: heights[i] });
      cy += heights[i] + L.entryGap;
      if (cy >= target && ci < L.cols - 1) { ci++; cy = 0; }
    });
    const colH = Math.max(...cols.map((c) => c.reduce((a, it) => a + it.h, 0) + (c.length - 1) * L.entryGap));
    const dividerY = y;
    const pillY = dividerY + L.dividerTop;
    const itemsTop = pillY + L.pillH + L.listTop;
    const h = L.dividerTop + L.pillH + L.listTop + colH + L.groupGap;
    out.push({
      tier: g.tier, desc: g.desc, dividerY, pillY, itemsTop, h,
      cols: cols.map((c, cIdx) => ({
        x: L.pad + cIdx * (colW + L.colGap),
        items: c.map((it) => ({ i: it.i, x: L.pad + cIdx * (colW + L.colGap), y: itemsTop + it.y, h: it.h })),
      })),
    });
    y += h;
  }
  // The trailing groupGap belongs to no tier — the canvas's bottom pad
  // replaces it. No groups → no section (H 0, renderer skips it).
  const H = out.length ? (y - L.groupGap + L.pad) - startY : 0;
  return { W, cols: L.cols, colW, H, groups: out };
}
