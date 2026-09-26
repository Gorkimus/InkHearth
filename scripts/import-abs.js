// CLI wrapper around the in-app import runner (server/imports/abs-import.js).
// Usage:
//   node scripts/import-abs.js          import new ABS items
//   REMATCH=1 node scripts/import-abs.js   retry HC matching for unmatched rows
// The same import also runs in-app (Memory lane) as the abs_import job.
import { runAbsImport } from '../server/imports/abs-import.js';

const result = await runAbsImport(
  { rematch: Boolean(process.env.REMATCH) },
  (pct, label) => { if (label) console.log(`  ${pct}% — ${label}`); }
);

if (result.rematch) {
  console.log(`Re-matched: ${result.rematched}/${result.candidates} | still unmatched: ${result.still_unmatched.length}`);
  for (const t of result.still_unmatched) console.log(`  - ${t}`);
} else {
  console.log(`Imported: ${result.imported} | Skipped (already present): ${result.skipped} | Without runtime: ${result.no_runtime}`);
  console.log(`Hardcover matches: ${result.hardcover_matched}/${result.imported}`);
  if (result.unmatched.length) {
    console.log('Unmatched (kept ABS metadata, may need manual attention):');
    for (const t of result.unmatched) console.log(`  - ${t}`);
  }
}
for (const w of result.warnings || []) console.log(`  ! ${w}`);
