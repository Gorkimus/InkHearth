// Minimal OpenAI-compatible chat client (Google AI Studio's /v1beta/openai/
// endpoint speaks the same shape). One POST, one parsed string out — no
// streaming, no tool use; recommendations is the only consumer.
import { db } from './db.js';
import { config } from './config.js';

export function llmEnabled() {
  return Boolean(config.llm.baseUrl && config.llm.apiKey && config.llm.model);
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const DEFAULT_MODEL = 'gemini-3.6-flash';
// When the configured model is out of capacity (or retired), walk down this
// chain with the same credentials — newest Flash first.
const FALLBACK_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash'];

const modelChain = (primary) => [...new Set([primary, ...FALLBACK_MODELS].filter(Boolean))];
export { modelChain };

// Per-user keys win; the instance-wide .env key is the shared fallback.
// Returns null when neither source is configured. Never exposes the key —
// callers only pass it to the chat endpoint.
export function resolveLlm(uid) {
  if (uid != null) {
    const u = db.prepare('SELECT llm_api_key, llm_base_url, llm_model FROM users WHERE id=?').get(uid);
    if (u?.llm_api_key) {
      return {
        baseUrl: u.llm_base_url || DEFAULT_BASE,
        apiKey: u.llm_api_key,
        // A member without a model preference follows the instance's choice,
        // then the fallback chain.
        model: u.llm_model || config.llm.model || DEFAULT_MODEL,
        source: 'user',
      };
    }
  }
  if (!llmEnabled()) return null;
  return { baseUrl: config.llm.baseUrl || DEFAULT_BASE, apiKey: config.llm.apiKey, model: config.llm.model, source: 'env' };
}

async function chatWithModel(messages, llm, { timeoutMs, tries, temperature = 0.8 }) {
  // Free tiers throw 429/503 "high demand" bursts — retry with backoff like
  // the Hardcover client does, so one spike doesn't kill a whole generation.
  const base = (llm.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify({ model: llm.model, messages, temperature }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt >= tries) throw new Error(`unreachable: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      // Auth fails identically on every model — no point walking the chain.
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`LLM auth failed (HTTP ${res.status}): ${body.slice(0, 150)}`), { authError: true });
    }
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const wait = res.status === 429 ? 15000 * attempt : 5000 * attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 150)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('no content returned');
    return text;
  }
}

// Tries the configured model first, then the fallback chain (same key).
// Returns { text, model } — model reports which one actually answered.
export async function llmChat(messages, { llm = config.llm, timeoutMs = 120000, tries = 2, temperature = 0.8 } = {}) {
  const chain = modelChain(llm.model);
  let lastError = null;
  for (const model of chain) {
    try {
      const text = await chatWithModel(messages, { ...llm, model }, { timeoutMs, tries, temperature });
      return { text, model };
    } catch (err) {
      if (err.authError) throw err;
      lastError = err;
    }
  }
  throw new Error(`all LLM models failed (${chain.join(' → ')}): ${lastError?.message}`);
}

// Member-facing translation of LLM failures. The thrown error keeps the
// technical detail (models, HTTP bodies) for the job record; users get one
// actionable sentence instead of raw HTTP JSON.
export function llmUserMessage(err) {
  const msg = String(err?.message || '');
  if (err?.authError || /auth failed/i.test(msg)) {
    return 'The AI key was rejected — add a fresh one under Account → Recommendations (a free Google AI Studio key works).';
  }
  if (/HTTP 429|HTTP 5\d\d|high demand|overloaded|unreachable/i.test(msg)) {
    return 'The AI service is temporarily overloaded — give it a few minutes and run recommendations again.';
  }
  return 'The AI service hit an unexpected error — try again, and ask the admin if it keeps happening.';
}

// Models wrap JSON in prose or ```fences``` despite instructions — extract
// the first JSON array or object. Throws with a short excerpt on failure.
export function parseJsonLoose(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error(`LLM response had no JSON: ${text.slice(0, 120)}`);
  const openChar = cleaned[start];
  const closeChar = openChar === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(closeChar);
  if (end <= start) throw new Error(`LLM JSON was truncated: ${cleaned.slice(start, start + 120)}`);
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (err) {
    throw new Error(`LLM JSON failed to parse: ${err.message} — ${cleaned.slice(start, start + 160)}`);
  }
}
