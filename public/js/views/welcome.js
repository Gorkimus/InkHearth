import { api } from '../api.js';
import { $, esc } from '../ui.js';
import { view, registerRoute } from '../router.js';

// Post-invite onboarding: the guided walkthrough that used to live in the
// admin's copy-paste invitation email, now in-app. Shown automatically after
// an invite is claimed (auth.js redirects here) and reachable at #welcome.
// The invited-by banner arrives via sessionStorage from the accept step and
// is consumed on first paint — later visits just show the steps.

async function welcomeView() {
  const invitedBy = sessionStorage.getItem('bt-invited-by') || '';
  sessionStorage.removeItem('bt-invited-by');
  let llmEnabled = false;
  try { llmEnabled = !!(await api('/meta')).llm_enabled; } catch { /* signed-out shouldn't happen here */ }

  const step = (n, icon, title, body, link, linkLabel) => `
    <div class="card" style="display:flex;gap:14px;align-items:flex-start">
      <div style="font-size:26px;line-height:1.2">${icon}</div>
      <div style="flex:1">
        <div style="font-weight:700;margin-bottom:4px">${n}. ${title}</div>
        <div class="muted small" style="margin-bottom:8px">${body}</div>
        <a class="btn ghost" href="${link}" style="padding:4px 14px;font-size:13px">${linkLabel}</a>
      </div>
    </div>`;

  view.innerHTML = `
    <h1>Welcome to InkHearth</h1>
    ${invitedBy ? `<div class="card" style="border-color:var(--accent);margin-bottom:14px">
      <span class="muted">${esc(invitedBy)} invited you — everything below takes a couple of minutes,
      and your books, stats and notes stay yours alone.</span></div>` : ''}
    <p class="muted" style="margin-top:0">Five short steps — do them now or come back to this page any time at <code>#welcome</code>.</p>
    <div style="display:flex;flex-direction:column;gap:12px;max-width:760px">
      ${step(1, '📥', 'Bring your reading history', `
        Import from <b>Goodreads</b> (export your library CSV and upload it — star ratings become
        S–D tiers, shelves become tags), from a <b>Kobo</b> e-reader, or from <b>Audible</b> via a
        helper app. Everything is matched against Hardcover, you confirm each book, and re-uploading
        never creates duplicates.`, '#memory', 'Open Memory lane')}
      ${step(2, '➕', 'Or just log a book right now', `
        Search a title, drop it in a tier, done — metadata fills itself in. Imports can come later
        (or never).`, '#add', 'Log a book')}
      ${step(3, '⭐', 'Rate what you\'ve read', `
        The Tier board is where S–D ratings live — drag books between tiers, and whole series get
        their own average tier with manual overrides.`, '#board', 'Open the Tier board')}
      ${step(4, '🔮', 'Unlock recommendations', llmEnabled ? `
        The household already has a shared key, so the <b>For you</b> page works out of the box —
        taste-based suggestions with reasoning, one click to queue a book. Prefer your own free key
        (quota is yours alone, not shared)? Add it any time under Account → Recommendations.` : `
        The <b>For you</b> page suggests new books from your taste, verified against Hardcover.
        It needs a free API key: create one at aistudio.google.com/apikey (no card required) and
        paste it under Account → Recommendations.`, '#account', 'Open Account settings')}
      ${step(5, '⚖️', 'Compare our taste', `
        Sharing is on by default: we can see how our tier ratings line up on books we\'ve both
        logged. Only tier letters are shared — never dates, notes or formats — and you can switch
        it off under Account → Privacy any time.`, '#compare', 'Open Compare')}
    </div>
    <div style="margin-top:18px;display:flex;gap:12px;align-items:center">
      <a class="btn" href="#memory">Start on Memory lane →</a>
      <a class="btn ghost" href="#dashboard">Skip to my dashboard</a>
    </div>
    <p class="muted small" style="margin-top:14px">💡 Missing something you'd love to do here?
    <a href="#feedback">Request a feature</a> — the admin reads every one.</p>`;
}

registerRoute('#welcome', welcomeView);
