// SSRF guard for member-supplied cover URLs (the 🖼 picker's paste-a-URL tab
// — the one thing deliberately NOT copied from Audiobookshelf, whose
// equivalent fetch has no guard). https only; no host that is or resolves to
// a loopback/private/link-local address: the server can reach what the
// browser can't, and a household app must not become a port scanner's relay.
// Redirect handling re-validates every hop in the caller's download loop.
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

const privateV4 = (ip) => {
  const o = ip.split('.').map(Number);
  return o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    || o[0] === 0 || o[0] === 10 || o[0] === 127
    || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
    || (o[0] === 192 && o[1] === 168)
    || (o[0] === 169 && o[1] === 254);
};

// ADDRESS literals only — a hostname is always false here (callers that need
// a hostname verdict must resolve it and re-ask). Exported for the smoke.
export const isPrivateAddress = (s) => {
  const a = String(s).toLowerCase();
  if (isIP(a) === 4) return privateV4(a);
  if (isIP(a) === 6) {
    const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (m) return privateV4(m[1]);
    return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  }
  return false;
};

export async function assertFetchableUrl(raw, bad) {
  let u;
  try { u = new URL(String(raw)); } catch { throw bad('that is not a valid URL'); }
  if (u.protocol !== 'https:') throw bad('cover URLs must be https://');
  if (/^localhost$|\.local$/i.test(u.hostname)) throw bad('that host is not allowed for cover URLs');
  // An IP literal is judged as-is; a hostname falls through to resolution.
  if (isIP(u.hostname) && isPrivateAddress(u.hostname)) {
    throw bad('that host is not allowed for cover URLs');
  }
  let addrs;
  try { addrs = await dnsLookup(u.hostname, { all: true, verbatim: true }); } catch {
    throw bad('that cover URL host does not resolve');
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw bad('that host is not allowed for cover URLs');
  }
  return u;
}
