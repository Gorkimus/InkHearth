// genres/moods/tags cells hold JSON arrays, but corrupt cells are a deliberate
// persistent state — migrations 29/30 skip unparseable cells and leave them
// "for a re-pull" rather than stall every boot. Reads must therefore survive
// them: one corrupt row must never 500 the whole library, stats, compare or
// the reconciler that's supposed to overwrite the cell.
export const parseJsonArr = (s) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
