// Pure layout math for the TBR queue's PNG export. No DOM, no canvas — the
// renderer in views/tbr.js consumes the returned geometry, and a Node scratch
// test can import this exact module to pin the math down without a browser
// (same pattern as tier-export-layout.js).

export const TBR_LAYOUT = {
  W: 1600,
  pad: 28,       // canvas margin, all sides
  coverW: 96,    // fallback cover size for the empty-queue header strip
  coverH: 144,
  maxCoverW: 256, // rows are sized so `perLineMax` covers fill the width,
                  // capped here — covers never render larger than this
  perLineMax: 5,  // the grid wraps: a new row every 5 entries
  cellGapX: 10,
  cellGapY: 12,
  headerH: 64,   // title strip above the grid
  titleTop: 24,  // title text's top edge (textBaseline 'top')
};

// count: number of tiles (the caller has already rolled series up). Returns
// the canvas height, the rendered cover size, and an exact {x, y} origin for
// every tile. Rows hold at most `perLineMax` tiles, sized so a full row fills
// the canvas width; a shorter last row is centered rather than left-hung.
export function planTbrGrid(count, L = TBR_LAYOUT) {
  const inner = L.W - 2 * L.pad;
  const perLine = Math.min(L.perLineMax, Math.max(1, count));
  const coverW = count > 0
    ? Math.min(L.maxCoverW, Math.floor((inner - (perLine - 1) * L.cellGapX) / perLine))
    : L.coverW;
  const coverH = Math.round(coverW * 1.5);
  const lines = Math.max(1, Math.ceil(count / perLine));
  const gridTop = L.headerH;
  const H = count
    ? gridTop + lines * coverH + (lines - 1) * L.cellGapY + L.pad
    : gridTop + L.pad; // empty queue still renders the header strip
  const cells = [];
  for (let i = 0; i < count; i++) {
    const line = Math.floor(i / perLine);
    const inLine = Math.min(perLine, count - line * perLine);
    const lineW = inLine * coverW + (inLine - 1) * L.cellGapX;
    const x0 = L.pad + Math.max(0, Math.floor((inner - lineW) / 2)); // every row centers; the guard is for configs wider than the canvas
    cells.push({
      x: x0 + (i % perLine) * (coverW + L.cellGapX),
      y: gridTop + line * (coverH + L.cellGapY),
    });
  }
  return { ...L, coverW, coverH, perLine, lines, H, cells };
}
