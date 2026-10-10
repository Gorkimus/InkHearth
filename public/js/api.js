// Single fetch helper — all views go through this. A 401 from any protected
// call bounces to the sign-in view (auth endpoints excluded: their own 401s
// are form errors, not session loss). JSON bodies are stringified; Blob or
// string bodies (raw uploads like the avatar) pass through untouched.
export async function api(path, opts = {}) {
  const raw = opts.body instanceof Blob || typeof opts.body === 'string';
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body == null ? undefined : raw ? opts.body : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      location.hash = '#login';
      throw new Error('Please sign in');
    }
    throw new Error(data.error || res.statusText);
  }
  return data;
}

// Poll a server job (POST /jobs etc.) until it finishes. Returns the job's
// result, or null when the caller should stop caring without messaging: the
// view that started the job went away (isStale — its DOM is detached) or the
// optional signal fired. The job itself keeps running server-side; only the
// UI stops tracking, so navigating away never leaves a 1s poll running on
// detached nodes. Throws on job error or the hard timeout, so the caller's
// existing catch renders the failure.
export async function pollJob(id, { signal, isStale, timeoutMs = 10 * 60 * 1000, onProgress } = {}) {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    if (signal?.aborted || isStale?.()) return null;
    const job = await api('/jobs/' + id, { signal });
    if (job.status === 'done') return job.result;
    if (job.status === 'error') throw new Error(job.error || 'job failed');
    if (Date.now() - started > timeoutMs) throw new Error('timed out — the job may still finish server-side; check back later');
    onProgress?.(job);
  }
}
