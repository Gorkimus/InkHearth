// The unified search's merge — a pure function so the tokenless smoke can
// pin it with fixtures (live provider results can't be scripted).
//
// The household's shelves answer first; the catalogs back them up two ways:
// a provider hit matching an owned work is ABSORBED — its missing display
// fields (cover, year) back the local card up, HC-as-field-level-backup —
// and everything else becomes the catalogs section in provider order, at
// full provider rank. Work identity is the compare/members-search key chain:
// hc:<hardcover_id> when both sides have one, normalized title+author
// otherwise; a local work matches a provider hit on EITHER key (a Google hit
// of an HC-keyed local book still dedupes by title+author).

const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const workKeys = (hardcoverId, title, author) => {
  const t = `t:${normKey(title)}|${normKey(author)}`;
  return hardcoverId ? [`hc:${hardcoverId}`, t] : [t];
};
const providerHcId = (r) => (r.provider === 'hardcover' && /^\d+$/.test(String(r.source_id || ''))
  ? Number(r.source_id) : null);

export function mergeUnified(localGroups, externalResults, field = 'all') {
  const shelves = [];
  const byKey = new Map();
  for (const g of localGroups) {
    const item = { ...g, local: true };
    shelves.push(item);
    for (const k of workKeys(g.hardcover_id, g.title, g.author)) {
      if (k !== 't:|') byKey.set(k, item);
    }
  }
  const catalogs = [];
  for (const ext of externalResults) {
    if (!ext.title) continue;
    const hit = workKeys(providerHcId(ext), ext.title, ext.author)
      .map((k) => byKey.get(k))
      .find(Boolean);
    if (hit) {
      // Field-level backup: the local row leads; the provider fills holes.
      if (!hit.cover_url && ext.cover_url) hit.cover_url = ext.cover_url;
      if (hit.published_year == null && ext.published_year != null) hit.published_year = ext.published_year;
      if (!hit.page_count && ext.page_count) hit.page_count = ext.page_count;
      continue;
    }
    catalogs.push({ ...ext, local: false });
  }
  // Series mode reads like a roster — owned positions in order. Everything
  // else keeps the shelf sort (owner count, title) the members page uses.
  if (field === 'series') {
    shelves.sort((a, b) => (a.series_order ?? 1e9) - (b.series_order ?? 1e9) || a.title.localeCompare(b.title));
  }
  return { shelves, catalogs };
}
