// Entry point. View modules register themselves with the router on import;
// this file just needs their side effects, then boots.
import { startRouter } from './js/router.js';
import { renderUserMenu } from './js/views/auth.js';
import { api } from './js/api.js';
import { toast, applyTheme } from './js/ui.js';
import './js/views/dashboard.js';
import './js/views/review.js';
import './js/views/library.js';
import './js/views/tierboard.js';
import './js/views/compare.js';
import './js/views/tbr.js';
import './js/views/recommendations.js';
// HIBERNATING Sept 25 2026 (Storyteller Selection): re-add to wake —
// import './js/views/storytellers.js';
import './js/views/members.js';
import './js/views/add.js';
import './js/views/memory.js';
import './js/views/admin.js';
import './js/views/auth.js';
import './js/views/invites.js';
import './js/views/welcome.js';
import './js/views/feedback.js';

// The markup ships warm; index.html's inline script restores a saved classic
// before first paint. This re-asserts whichever the visitor last used so the
// two paths agree even when localStorage was written by an older build.
applyTheme(localStorage.getItem('bt-theme') || 'warm');

renderUserMenu();
startRouter();

// PWA: installable ("add to home screen") and always current. The service
// worker is network-first, so a refresh fetches the latest deploy; this toast
// just announces that a new version went live since the last visit.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* http contexts only */ });
}
(async () => {
  try {
    const { build, label } = await api('/meta');
    const seen = localStorage.getItem('bt-build');
    if (seen && seen !== build) toast('InkHearth was updated — you are on the latest version', 6000);
    localStorage.setItem('bt-build', build);
    if (label) markInstance(label);
    // ABS sync notice: one toast per unseen sync, compared against a local
    // marker — the first visit just sets the baseline silently. 401s (signed
    // out) and missing links fall through quietly.
    try {
      const { last_synced_at } = await api('/abs/notice');
      const marker = localStorage.getItem('bt-abs-seen');
      if (last_synced_at && marker && last_synced_at > marker) {
        toast(`🎧 Audiobookshelf synced while you were away (${last_synced_at.slice(0, 16).replace('T', ' ')})`, 6000);
      }
      if (last_synced_at) localStorage.setItem('bt-abs-seen', last_synced_at);
    } catch { /* no link / signed out */ }
  } catch { /* signed-out boot still gets meta; ignore failures */ }
})();

// Non-production instances announce themselves in the tab (title + an orange
// badge favicon) and in the header, so staging and prod open side by side are
// unmistakable. Production sends no label and stays untouched.
function markInstance(label) {
  document.title = `InkHearth (${label})`;
  const brand = document.querySelector('.brand');
  if (brand) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.style.cssText = 'margin-left:8px;color:#ff8c00;border-color:#ff8c00';
    pill.textContent = label;
    brand.appendChild(pill);
  }
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#ff8c00';
  if (x.roundRect) { x.beginPath(); x.roundRect(0, 0, 64, 64, 12); x.fill(); }
  else x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#10131a';
  x.font = 'bold 40px system-ui, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(label[0].toUpperCase(), 32, 36);
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = c.toDataURL('image/png');
}
