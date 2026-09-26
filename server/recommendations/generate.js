// Recommendation generation (Phase 4 + guardrails). Full pipeline: taste
// digest → LLM proposes candidates → Hardcover verification drops
// hallucinations → series/length guardrails → cards stored as a batch.
// Two offline switches keep tests/hermetic runs honest:
//   payload.candidates  — skip digest+LLM, verify+store these (like kobo_import's rows)
//   payload.hardcover:false — skip the Hardcover verification pass
// Toggles ride in the payload: adventure (conservative|balanced|wild),
// length (any|short|long), series (any|standalone), count.
import { db } from '../db.js';
import { config } from '../config.js';
import { resolveLlm, llmChat, llmUserMessage, parseJsonLoose } from '../llm.js';
import { hardcoverLookup, pickSeries, genresFrom } from '../metadata/hardcover-import.js';
import { WORDS_PER_PAGE, WORDS_PER_LISTENING_HOUR } from '../wordcount.js';
import { buildDigest } from './digest.js';

const COUNT_DEFAULT = 8;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const ADVENTURE_PROMPT = {
  conservative: 'Stay on safe ground: genres, settings and author-adjacent works the reader clearly already loves.',
  balanced: 'Mostly aligned with the reader\'s taste, with a step or two into adjacent territory.',
  wild: 'Be bold: stretch well beyond their comfort zone — different genres and settings — while still plausibly matching the tone and intensity they rate highly.',
};
const ADVENTURE_TEMP = { conservative: 0.7, balanced: 0.8, wild: 1.0 };
const LENGTH_PROMPT = {
  short: 'Prefer shorter books (under ~200 pages or ~10 hours audio).',
  long: 'Prefer long, immersive books (400+ pages or 15+ hours audio).',
};

const wordsFor = (pages, minutes) => {
  if (pages) return pages * WORDS_PER_PAGE;
  if (minutes) return Math.round((minutes / 60) * WORDS_PER_LISTENING_HOUR);
  return null;
};

async function proposeWithLlm(uid, count, report, llm, opts) {
  if (!llm) {
    throw new Error('LLM not configured — add your own key under Account → Recommendations (or the admin can set LLM_* in .env)');
  }
  report(5, 'Profiling your taste…');
  const digest = buildDigest(uid);
  report(20, 'Asking the LLM…');
  const guardrails = [
    ADVENTURE_PROMPT[opts.adventure] || ADVENTURE_PROMPT.balanced,
    LENGTH_PROMPT[opts.length] || '',
    opts.series === 'standalone'
      ? 'Suggest ONLY standalone books — nothing that belongs to a series.'
      : 'If a suggestion belongs to a series, it MUST be the FIRST book of that series.',
    'Never suggest a book from a series the reader already owns or is reading, and never any book they already own.',
  ].filter(Boolean).join(' ');
  let text, model;
  try {
    ({ text, model } = await llmChat([
      {
        role: 'system',
        content: `You are a candid, well-read friend recommending books to one reader. You reason from their actual ratings — if they love slow epic fantasy with great narration, say so in the reasoning. Never recommend a book they already own or read. ${guardrails} Answer ONLY with a JSON array, no prose around it: [{"title": "...", "author": "...", "reasoning": "1-2 concrete sentences tying it to their taste"}]`,
      },
      {
        role: 'user',
        content: `${digest}\n\nRecommend exactly ${count} books (fiction or nonfiction) this reader has NOT read and probably hasn't heard of. Vary authors. Honour the "not for me" list strictly.`,
      },
    ], { llm, temperature: ADVENTURE_TEMP[opts.adventure] || 0.8 }));
  } catch (err) {
    // Friendly sentence for the member; the raw cause rides along as `detail`
    // and lands in the job row for the admin.
    throw Object.assign(new Error(llmUserMessage(err)), { detail: err.message });
  }
  const parsed = parseJsonLoose(text);
  if (!Array.isArray(parsed)) throw new Error('LLM returned JSON that is not an array');
  const candidates = parsed
    .map((c) => ({
      title: String(c.title || '').trim(),
      author: String(c.author || '').trim() || null,
      reasoning: String(c.reasoning || '').trim() || null,
    }))
    .filter((c) => c.title.length >= 2);
  if (!candidates.length) throw new Error('LLM proposed no usable candidates');
  return { candidates, modelUsed: model };
}

export async function runRecommendations(payload, report, uid) {
  const offline = Array.isArray(payload.candidates);
  const opts = {
    adventure: payload.adventure || 'balanced',
    length: payload.length || 'any',
    series: payload.series || 'any',
  };
  let modelUsed = null;
  let candidates;
  if (offline) {
    candidates = payload.candidates
      .map((c) => ({ title: String(c.title || '').trim(), author: c.author || null, reasoning: c.reasoning || null, series_name: c.series_name || null }))
      .filter((c) => c.title.length >= 2);
  } else {
    const { candidates: proposed, modelUsed: used } =
      await proposeWithLlm(uid, payload.count || COUNT_DEFAULT, report, resolveLlm(uid), opts);
    candidates = proposed;
    modelUsed = used;
  }

  // Guardrail inputs: series and titles the reader already has.
  const ownedSeries = new Set(
    db.prepare('SELECT DISTINCT series_name FROM books WHERE user_id=? AND series_name IS NOT NULL')
      .all(uid).map((r) => norm(r.series_name)));
  const ownedTitles = new Set(
    db.prepare('SELECT title FROM books WHERE user_id=?').all(uid).map((r) => norm(r.title)));

  // Verify each candidate against Hardcover: canonical identity + length
  // fields for the word-commitment total. Hallucinations (no HC match) drop.
  const verify = payload.hardcover !== false && config.hardcoverToken;
  const recs = [];
  const drops = { unverifiable: 0, owned: 0, series: 0, mid_series: 0, length: 0 };
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    report(30 + Math.round((i / candidates.length) * 55), `Verifying "${c.title}"…`);
    let row = null;
    if (verify) {
      try {
        row = await hardcoverLookup(c.title, c.author, null);
      } catch (err) {
        console.warn(`[recommendations] HC lookup failed for "${c.title}":`, err.message);
      }
      if (!row) { drops.unverifiable++; continue; }
    }
    // Series info from Hardcover when verified, else the candidate's own claim.
    const series = row ? pickSeries(row, c.title) : (c.series_name ? { name: c.series_name, order: null } : null);
    if (series && ownedSeries.has(norm(series.name))) { drops.series++; continue; }
    if (series && series.order != null && series.order !== 1) { drops.mid_series++; continue; }
    if (opts.series === 'standalone' && series) { drops.series++; continue; }
    // The owned check runs on the CANONICAL title — the LLM's raw candidate
    // often carries subtitle fluff that would dodge an exact-title match.
    if (ownedTitles.has(norm(row?.title || c.title))) { drops.owned++; continue; }
    const minutes = row?.audio_seconds ? Math.round(row.audio_seconds / 60) : null;
    const estimated = wordsFor(row?.pages, minutes);
    if (opts.length === 'short' && estimated && estimated >= 60000) { drops.length++; continue; }
    if (opts.length === 'long' && estimated && estimated < 150000) { drops.length++; continue; }
    recs.push({
      title: row?.title || c.title,
      author: row?.contributions?.[0]?.author?.name || c.author,
      series_name: series?.name || null,
      hardcover_id: row?.id || null,
      reasoning: c.reasoning,
      estimated_words: estimated,
      page_count: row?.pages || null,
      audio_runtime_minutes: minutes,
    });
  }
  if (!recs.length) {
    throw new Error('no recommendations survived the guardrails — try again or widen the options');
  }

  report(92, 'Saving…');
  const batch = (db.prepare('SELECT MAX(batch_id) m FROM recommendations WHERE user_id=?').get(uid).m || 0) + 1;
  // A fresh run replaces unacted cards; acted-on history stays as digest context.
  db.prepare(`DELETE FROM recommendations WHERE user_id=? AND status='new'`).run(uid);
  const ins = db.prepare(`
    INSERT INTO recommendations
      (user_id, batch_id, title, author, series_name, hardcover_id, reasoning,
       estimated_words, page_count, audio_runtime_minutes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const r of recs) {
    ins.run(uid, batch, r.title, r.author, r.series_name, r.hardcover_id, r.reasoning,
      r.estimated_words, r.page_count, r.audio_runtime_minutes);
  }
  const dropped = drops.unverifiable + drops.owned + drops.series + drops.mid_series + drops.length;
  return {
    batch, proposed: candidates.length,
    verified: recs.filter((r) => r.hardcover_id).length,
    dropped,
    dropped_series: drops.series, dropped_mid_series: drops.mid_series,
    dropped_length: drops.length, model: modelUsed,
  };
}
