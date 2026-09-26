// Hash router. View modules call registerRoute(hash, fn) at import time, so
// app.js only needs their side effects — no router→views import cycle.
// Prefix routes (key ending in '/') pass the raw hash through — e.g. '#invite/<token>'.

import { $, esc } from './ui.js';

export const view = $('#view');

const routes = {};
export function registerRoute(hash, fn) { routes[hash] = fn; }

function resolve(hash) {
  if (routes[hash]) return routes[hash];
  for (const key of Object.keys(routes)) {
    if (key.endsWith('/') && hash.startsWith(key)) return routes[key];
  }
  return null;
}

export async function rerender() {
  // Keep the active link highlighted AND visible — on phones the strip scrolls,
  // so navigating to a far-right page centers that link in the strip.
  const active = [...document.querySelectorAll('header nav a')]
    .find((a) => a.getAttribute('href') === (location.hash || '#dashboard'));
  document.querySelectorAll('header nav a').forEach((a) => a.classList.toggle('active', a === active));
  active?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  const fn = resolve(location.hash) || routes['#dashboard'];
  view.innerHTML = '<div class="loading">Loading…</div>';
  try { await fn(); } catch (err) { view.innerHTML = `<div class="empty">Something broke: ${esc(err.message)}</div>`; }
}

export function startRouter() {
  window.addEventListener('hashchange', rerender);
  rerender();
}
