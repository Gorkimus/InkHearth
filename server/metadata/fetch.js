// Timed, retrying JSON fetch for the discovery providers. A hanging provider
// used to stall the whole search (no timeout at all); now each call is capped.
// Timeouts are NOT retried — a provider that just spent its full budget being
// slow will likely be slow again, and doubling the wait is worse than failing
// fast to the other provider. Only quick failures (429/5xx, connection
// resets) earn a retry.
export async function fetchJson(url, { headers, timeout = 8000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      if (timedOut || attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastErr;
}
