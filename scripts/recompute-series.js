// Recompute the series assignment of every Hardcover-linked book with the
// current pickSeries rules. Read-only against Hardcover (bulk id fetch),
// updates only rows whose series actually changed.
//   node scripts/recompute-series.js

import { config } from '../server/config.js';
import { db, currentUserId } from '../server/db.js';
import { pickSeries } from '../server/metadata/hardcover-import.js';

if (!config.hardcoverToken) {
  console.error('HARDCOVER_TOKEN missing in .env');
  process.exit(1);
}
const uid = currentUserId();

const rows = db
  .prepare("SELECT id, title, hardcover_id, series_name, series_order FROM books WHERE user_id=? AND hardcover_id IS NOT NULL")
  .all(uid);
console.log(`Recomputing series for ${rows.length} Hardcover-linked books...`);

const hc = async (ids) => {
  const res = await fetch('https://api.hardcover.app/v1/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.hardcoverToken}` },
    body: JSON.stringify({
      query: `query ($ids: [Int!]) { books(where: {id: {_in: $ids}}) { id title book_series { position series { name } } } }`,
      variables: { ids },
    }),
  });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return new Map((body.data?.books || []).map((b) => [b.id, b]));
};

const update = db.prepare('UPDATE books SET series_name=?, series_order=? WHERE id=?');
let changed = 0;

for (let i = 0; i < rows.length; i += 20) {
  const chunk = rows.slice(i, i + 20);
  const hcById = await hc(chunk.map((r) => r.hardcover_id));
  for (const r of chunk) {
    const b = hcById.get(r.hardcover_id);
    if (!b) continue;
    const series = pickSeries(b, r.title);
    const newName = series?.name || null;
    const newOrder = series?.order ?? null;
    if (newName !== r.series_name || newOrder !== r.series_order) {
      update.run(newName, newOrder, r.id);
      changed++;
      console.log(`  ${r.title}: ${r.series_name || '—'}#${r.series_order ?? '—'} → ${newName || '—'}#${newOrder ?? '—'}`);
    }
    await new Promise((res) => setTimeout(res, 60)); // gentle pacing
  }
}

console.log(`Done — ${changed} of ${rows.length} rows updated.`);
