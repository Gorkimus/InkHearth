// Storyteller Selection flight generation. Each scene has a FIXED "set"
// passage (server/storytellers/passages.js — original InkHearth prose, one
// variant picked per flight), and ONE LLM call restyles that exact block in
// every cast author's prose style. Same beats, same length, same characters:
// only the voice moves, which is what makes the blind ranking a fair test.
// No real publisher text is ever requested, quoted, or stored. Passages are
// saved anonymized (keys A, B, C…) in shuffled order; the reveal
// (routes/storytellers.js) re-attaches names plus shelf standing.
import { db } from '../db.js';
import { resolveLlm, llmChat, llmUserMessage, parseJsonLoose } from '../llm.js';
import { libraryAuthors, normName } from './pool.js';
import { SCENE_PASSAGES } from './passages.js';

export const SCENES = {
  action: 'an action or chase scene — high stakes, everything moving',
  grief: 'a grief or heartbreak scene — a character absorbs a painful loss',
  atmosphere: 'an atmospheric scene — a place described so strongly it becomes a character',
  banter: 'a banter scene — two characters sparring with words, wit on both sides',
  dread: 'a dread or suspense scene — something is wrong and slowly revealing itself',
  intimacy: 'a quiet intimacy scene — a small, tender moment between two people',
};

const MIN_AUTHORS = 3;
const MAX_AUTHORS = 6;
const PASSAGE_MIN_WORDS = 80;
const PASSAGE_MAX_WORDS = 400;
const keyFor = (i) => String.fromCharCode(65 + i); // A, B, C…
const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

export const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// The client's checked lineup wins; a bare {scene} call falls back to the
// member's best-rated shelf authors so the job stays runnable from anywhere.
function lineupFor(uid, raw) {
  const list = [...new Set((Array.isArray(raw) ? raw : [])
    .map((a) => String(a || '').trim())
    .filter((a) => a && a.length <= 80))];
  if (list.length >= MIN_AUTHORS && list.length <= MAX_AUTHORS) return list;
  if (list.length) throw new Error(`Pick between ${MIN_AUTHORS} and ${MAX_AUTHORS} authors for a flight.`);
  const fallback = libraryAuthors(uid).slice(0, 4).map((a) => a.name);
  if (fallback.length >= MIN_AUTHORS) return fallback;
  throw new Error(`Not enough rated authors on the shelf yet — pick ${MIN_AUTHORS}+ authors for the flight.`);
}

// Every cast author must come back exactly once, with a passage inside the
// word band (short enough to taste, long enough to be a real voice).
function validatePassages(parsed, authors) {
  if (!Array.isArray(parsed)) throw new Error('reply was not a JSON array');
  const byNorm = new Map(parsed.map((p) => [normName(p?.author), p]));
  const out = [];
  for (const author of authors) {
    const p = byNorm.get(normName(author));
    if (!p) throw new Error(`no passage for ${author}`);
    const passage = String(p.passage || '').trim();
    const wc = wordCount(passage);
    if (wc < PASSAGE_MIN_WORDS || wc > PASSAGE_MAX_WORDS) {
      throw new Error(`the ${author} passage was ${wc} words — expected ${PASSAGE_MIN_WORDS}–${PASSAGE_MAX_WORDS}`);
    }
    const notes = (Array.isArray(p.style_notes) ? p.style_notes : String(p.style_notes || '').split(';'))
      .map((n) => String(n).trim()).filter(Boolean).slice(0, 3);
    const tags = (Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(','))
      .map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 4);
    out.push({ author, passage, style_notes: notes, tags });
  }
  return out;
}

const buildPrompt = (base, authors, scene, retryReason) => [
  {
    role: 'system',
    content: `You are a literary craftsman running a blind "writing style tasting" for a reader. The reader supplies ONE fixed base passage and a list of authors. For each author, rewrite the base passage in that author's distinctive prose style — their sentence rhythm, vocabulary, point-of-view habits, dialogue texture, narrative trademarks. Keep every beat: the same events in the same order, the same characters and images, roughly the same length — the ONLY thing that may change between entries is the prose style. You may shift wording and emphasis in the author's manner, but invent no new plot events or characters. Capture the VOICE, never the plots: no characters, places or events from the author's actual books, and never quote or closely imitate any published text. Never mention an author's name inside a passage. Answer ONLY with a JSON array, no prose around it, one entry per author in the order given:
[{"author":"...","passage":"150-250 words","style_notes":["up to 3 short phrases on this author's signature style"],"tags":["2-4 one-word style adjectives like lyrical, cinematic, wry"]}]`,
  },
  {
    role: 'user',
    content: `Base passage — the only source material, to be restyled for every author:
"""
${base}
"""
Scene: ${scene}
Authors, in order:
${authors.map((a, i) => `${i + 1}. ${a}`).join('\n')}
Write exactly ${authors.length} passages, one per author, each a restyling of the base passage.`
      + (retryReason ? `\n\nYour previous reply was unusable: ${retryReason}. Return ONLY the corrected JSON array.` : ''),
  },
];

export async function runStoryteller(payload, report, uid) {
  const llm = resolveLlm(uid);
  if (!llm) {
    throw new Error('LLM not configured — add your own key under Account → Recommendations (or the admin can set LLM_* in .env)');
  }
  const scene = SCENES[payload.scene];
  if (!scene) throw new Error('Pick a scene for this flight.');
  const authors = lineupFor(uid, payload.authors);
  const variants = SCENE_PASSAGES[payload.scene] || [];
  if (!variants.length) throw new Error('no set passage exists for this scene yet');
  const base = variants[Math.floor(Math.random() * variants.length)];

  let model = null;
  let passages = null;
  let lastReason = null;
  for (let attempt = 0; attempt < 2 && !passages; attempt++) {
    report(30, `Writing ${authors.length} passages…`);
    let text;
    try {
      ({ text, model } = await llmChat(buildPrompt(base, authors, scene, lastReason), {
        llm, temperature: 0.9, timeoutMs: 180000,
      }));
    } catch (err) {
      // Friendly sentence for the member; the raw cause rides along as
      // `detail` and lands in the job row for the admin.
      throw Object.assign(new Error(llmUserMessage(err)), { detail: err.message });
    }
    try {
      passages = validatePassages(parseJsonLoose(text), authors);
    } catch (err) {
      lastReason = err.message; // one re-prompt, then the job fails honestly
    }
  }
  if (!passages) {
    throw new Error(`the LLM kept returning unusable passages (${lastReason}) — give it another go`);
  }

  report(85, 'Pouring the flight…');
  // Blind keys follow a shuffle, so letter A isn't always the first author.
  const blind = shuffle([...passages]).map((p, i) => ({ key: keyFor(i), ...p }));
  const info = db.prepare(`
    INSERT INTO storyteller_rounds (user_id, scene, base, authors, passages, model)
    VALUES (?,?,?,?,?,?)`)
    .run(uid, payload.scene, base, JSON.stringify(blind.map((p) => p.author)),
      JSON.stringify(blind), model);
  return { round_id: Number(info.lastInsertRowid), scene: payload.scene, count: blind.length, model };
}
