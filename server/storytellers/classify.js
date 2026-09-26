// Scene classification over one scan batch. The only trip passage text takes
// outside the instance is to the configured LLM — the household's own key —
// in numbered batches, asking which of six scene types dominates each chunk
// and what makes it (or doesn't) a strong style specimen. Results stay in
// the instance DB; 'none' rows auto-discard. Scene updates commit per batch,
// so an interrupted run resumes where it stopped on the next job.
import { db } from '../db.js';
import { resolveLlm, llmChat, llmUserMessage, parseJsonLoose } from '../llm.js';

const SCENES = ['action', 'grief', 'atmosphere', 'banter', 'dread', 'intimacy'];
const BATCH = 12;

const classifyPrompt = (slice, retryReason) => [
  {
    role: 'system',
    content: `You are cataloguing prose specimens for a blind writing-style tasting game. For each numbered chunk from a novel, decide which single scene type dominates it: "action" (chase, fight, high-stakes movement), "grief" (loss, mourning, heartbreak), "atmosphere" (a place or weather rendered vividly for its own sake), "banter" (witty sparring dialogue), "dread" (suspense, wrongness, mounting fear), "intimacy" (a small tender personal moment), or "none" (exposition, plain event-reporting, front matter). Also judge it AS A SPECIMEN OF PROSE STYLE in one short sentence — what makes the writing itself distinctive, or why it's too plain to use. Answer ONLY with a JSON array, one entry per chunk in order, no prose around it:
[{"n":1,"scene":"action|grief|atmosphere|banter|dread|intimacy|none","why":"one short sentence"}]`,
  },
  {
    role: 'user',
    content: slice.map((r, i) => `--- Chunk ${i + 1} ---\n${r.passage}`).join('\n\n')
      + (retryReason ? `\n\nYour previous reply was unusable: ${retryReason}. Return ONLY the corrected JSON array.` : ''),
  },
];

function validateClass(text, slice) {
  const parsed = parseJsonLoose(text);
  if (!Array.isArray(parsed)) throw new Error('reply was not a JSON array');
  const out = [];
  for (let i = 0; i < slice.length; i++) {
    const e = parsed.find((x) => Number(x?.n) === i + 1) || parsed[i];
    if (!e) throw new Error(`missing classification for chunk ${i + 1}`);
    const scene = String(e.scene || '').toLowerCase();
    if (![...SCENES, 'none'].includes(scene)) throw new Error(`unknown scene "${e.scene}"`);
    out.push({ n: i + 1, scene, why: String(e.why || '').trim() || null });
  }
  return out;
}

export async function runSnippetScan(payload, report, uid) {
  const llm = resolveLlm(uid);
  if (!llm) {
    throw new Error('LLM not configured — add your own key under Account → Recommendations (or the admin can set LLM_* in .env)');
  }
  const rows = db.prepare(`
    SELECT id, passage FROM storyteller_snippets
    WHERE scan_batch=? AND status='candidate' AND scene IS NULL ORDER BY id`)
    .all(String(payload.scan_batch || ''));
  if (!rows.length) throw new Error('no unclassified chunks for that scan');

  const setScene = db.prepare('UPDATE storyteller_snippets SET scene=?, note=? WHERE id=?');
  const discard = db.prepare(`UPDATE storyteller_snippets SET scene='none', status='discarded' WHERE id=?`);
  let classified = 0;
  let discarded = 0;
  let failedBatches = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    report(Math.round((i / rows.length) * 95),
      `Classifying ${i + 1}–${Math.min(i + BATCH, rows.length)} of ${rows.length}…`);
    let entries = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !entries; attempt++) {
      let text;
      try {
        ({ text } = await llmChat(classifyPrompt(slice, lastErr), {
          llm, temperature: 0.2, timeoutMs: 120000,
        }));
      } catch (err) {
        // Transport-level failure kills the job (the friendly-message
        // pattern); scene updates already committed per batch, so a re-run
        // of this job resumes at the first unclassified chunk.
        throw Object.assign(new Error(llmUserMessage(err)), { detail: err.message });
      }
      try {
        entries = validateClass(text, slice);
      } catch (err) {
        lastErr = err.message; // one re-prompt, then skip the batch
      }
    }
    if (!entries) {
      failedBatches++;
      continue;
    }
    for (const e of entries) {
      const row = slice[e.n - 1];
      if (!row) continue;
      if (e.scene === 'none') {
        discard.run(row.id);
        discarded++;
      } else {
        setScene.run(e.scene, e.why, row.id);
        classified++;
      }
    }
  }
  return { classified, discarded, failed_batches: failedBatches, total: rows.length };
}
