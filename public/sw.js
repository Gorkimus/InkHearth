// InkHearth service worker — deliberately boring. Network-first for
// everything, and with `cache: 'no-cache'` so the browser revalidates assets
// (ETag 304s are cheap) instead of serving its own stale copies for hours —
// deploys must reach users on their next load, not 4 hours later. The cache
// exists to make the app installable, keep icons/manifest offline, and —
// since bt-api-v1 — keep GET /api responses readable with no server at all.

const CACHE = 'bt-static-v2';
const API_CACHE = 'bt-api-v1';
const ASSETS = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== API_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// GET /api responses are per-account (the session cookie selects the data),
// so the runtime cache must never survive an account switch: login, invite
// acceptance and password reset all hand the device to a (possibly different)
// identity. Wiped as soon as the switch is *attempted*, not only on success —
// a failed or offline logout would otherwise leave this account's data cached.
const AUTH_CLEARING = ['/api/auth/login', '/api/auth/logout', '/api/auth/invite/accept', '/api/auth/reset/accept'];

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
    if (e.request.method !== 'GET') return;
    e.respondWith(
      fetch(new Request(e.request, { cache: 'no-cache' }))
        .catch(() => caches.match(e.request).then((r) => r || Response.error()))
    );
    return;
  }

  // API writes: try the network; offline, fail with a structured body the
  // app's api() helper surfaces as a toast instead of hanging forever.
  if (e.request.method !== 'GET') {
    const isAuthSwitch = AUTH_CLEARING.includes(url.pathname);
    e.respondWith(
      fetch(e.request).then((res) => {
        if (isAuthSwitch) caches.delete(API_CACHE); // even on failure — see above
        return res;
      }).catch(() => {
        // Offline switch (e.g. logout while unreachable): wipe anyway, then
        // fail with a structured body the app's api() helper surfaces as a toast.
        if (isAuthSwitch) caches.delete(API_CACHE);
        return new Response(
          JSON.stringify({ error: 'offline — change not saved' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // API reads: network-first with a runtime fallback, so the dashboard,
  // library and stats stay browsable with the server unreachable. /api/meta
  // and /api/health are excluded — a stale build stamp would lie about
  // available updates, and health must tell the truth.
  if (url.pathname === '/api/meta' || url.pathname === '/api/health') {
    e.respondWith(fetch(e.request).catch(() => Response.error()));
    return;
  }
  e.respondWith(
    fetch(new Request(e.request, { cache: 'no-cache' }))
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(API_CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || Response.error()))
  );
});
