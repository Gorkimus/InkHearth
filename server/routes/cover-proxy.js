import { Router } from 'express';
import { readSessionCookie, sessionUser } from '../auth.js';
import { config } from '../config.js';

const r = Router();

// Same-origin re-serving of remote cover art, so the tier board's canvas
// export can paint every cover. The main CDNs (assets.hardcover.app, books
// .google.com) send no CORS headers — an <img> on the page displays them
// fine, but a crossOrigin image load for canvas drawing is refused, and the
// export degraded to letter tiles for exactly those books. The server
// fetches instead and hands the bytes back same-origin, keeping the canvas
// exportable (untainted). Host-whitelisted: this must never become an open
// proxy. Lives OUTSIDE /api on purpose — the service worker's offline cache
// owns that prefix and these bytes aren't account data — so it does its own
// session check.

// Matching is on host or host:port (a URL's hostname alone drops the port),
// so entries like `127.0.0.1:34878` work alongside bare CDN hostnames.

const ALLOWED_HOSTS = new Set([
  'assets.hardcover.app',
  'covers.openlibrary.org',
  'books.google.com',
  // Admin knob for extra origins (private CDNs, the smoke suite's mock) —
  // entries are host or host:port, same idea as ABS_LINK_ALLOWLIST.
  ...(config.coverProxyExtraHosts || []),
]);
// Raster types only: an image response this route never needs to be anything
// a canvas can't draw, and excluding svg keeps script-carrying markup out.
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 10 * 1024 * 1024;

r.get('/cover-proxy', async (req, res) => {
  if (!sessionUser(readSessionCookie(req))) return res.status(401).json({ error: 'not signed in' });
  let target;
  try { target = new URL(String(req.query.url || '')); } catch { return res.status(400).json({ error: 'bad url' }); }
  const hostKey = target.hostname + (target.port ? ':' + target.port : '');
  if (!ALLOWED_HOSTS.has(hostKey)) return res.status(400).json({ error: 'host not allowed' });
  try {
    const upstream = await fetch(target, { signal: AbortSignal.timeout(10_000) });
    const type = (upstream.headers.get('content-type') || '').split(';')[0].trim();
    if (!upstream.ok || !ALLOWED_TYPES.has(type)) throw new Error(`upstream ${upstream.status} ${type || 'no type'}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('too large');
    res.setHeader('Content-Type', type);
    res.set({
      // Cover URLs are stable content addresses (edition/<id>/<uuid>.jpg) —
      // the browser may hold them for a week instead of re-fetching per export.
      'Cache-Control': 'private, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
      // If navigated to directly: render, run nothing (an <img> embed ignores
      // response CSP, so this costs nothing there).
      'Content-Security-Policy': 'sandbox; default-src \'none\'',
    });
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: 'cover fetch failed: ' + err.message });
  }
});

export default r;
