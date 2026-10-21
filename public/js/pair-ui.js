// Sign-in approval watcher: while signed in, quietly check for locked-out
// device pairing requests this member (or, for the admin, anyone) can decide,
// and surface them as a dismissible card. The approval is a deliberate click
// that should only happen when the card's code matches the one shown on the
// device asking in — that comparison is what ties the approval to the right
// request. Polling mirrors the bell: on every view render, every 20s while
// the tab is visible, and on window focus. Raw fetch: a 401 just means
// "signed out", never a bounce to #login.
import { esc, toast } from './ui.js';

const MOUNT_ID = 'pair-watch';
let dismissed = [];
try { dismissed = JSON.parse(sessionStorage.getItem('bt-pair-dismissed') || '[]'); } catch { /* fresh */ }

export function startPairWatch() {
  document.addEventListener('inkhearth:view', check);
  window.addEventListener('focus', check);
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 20_000);
  check();
}

function hide() {
  document.getElementById(MOUNT_ID)?.remove();
}

async function check() {
  if ((location.hash || '').startsWith('#login') || (location.hash || '').startsWith('#pair')) { hide(); return; }
  let data;
  try {
    const res = await fetch('/api/auth/pair-requests');
    if (res.status === 401) { hide(); return; } // signed out — nothing to approve
    if (!res.ok) return;
    data = await res.json();
  } catch { return; } // offline — the next tick retries
  const requests = (data.requests || []).filter((rq) => !dismissed.includes(rq.id));
  if (!requests.length) { hide(); return; }
  render(requests);
}

// "Windows NT 10.0; Win64" + the browser token — enough for the approver to
// recognise which device is asking without reading a raw UA string.
function uaBits(ua) {
  if (!ua) return '';
  const platform = (/\(([^)]*)\)/.exec(ua) || [])[1]
    ?.split(';').map((s) => s.trim()).slice(0, 2).join(' ') || '';
  const browser = (/Edg\/|OPR\/|Chrome\/|Firefox\/|Safari\//.exec(ua) || [])[0].slice(0, -1);
  return [browser, platform].filter(Boolean).join(' · ');
}

function render(requests) {
  let mount = document.getElementById(MOUNT_ID);
  if (!mount) {
    mount = document.createElement('div');
    mount.id = MOUNT_ID;
    mount.className = 'pair-watch'; // the stylesheet targets the class, not the id
    // In flow, directly below the sticky header — the card leads the page
    // (and scrolls with it) instead of overlaying the navigation ribbon.
    document.querySelector('header')?.after(mount);
  }
  mount.innerHTML = requests.map((rq) => `
    <div class="pair-card" data-id="${rq.id}">
      <div class="pair-title">🔐 Sign-in request — <strong>${rq.name ? esc(rq.name) : 'unknown member'}</strong>${rq.mine ? ' (you)' : ''}</div>
      <div class="pair-code">${esc(rq.code.slice(0, 3))} ${esc(rq.code.slice(3))}</div>
      <div class="muted small">${uaBits(rq.ua) ? esc(uaBits(rq.ua)) + ' · ' : ''}approve only if this code matches
      the one on the device asking in. Approving lets it set a new password.</div>
      <div class="pair-actions">
        <button class="btn" data-act="approve">Approve</button>
        <button class="btn danger" data-act="deny">Deny</button>
        <button class="btn ghost" data-act="dismiss" title="Decide later — comes back next visit">✕</button>
      </div>
    </div>`).join('');

  mount.querySelectorAll('.pair-card').forEach((card) => {
    const id = +card.dataset.id;
    card.querySelectorAll('button').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'dismiss') {
          dismissed.push(id);
          sessionStorage.setItem('bt-pair-dismissed', JSON.stringify(dismissed.slice(-20)));
          card.remove();
          if (!mount.children.length) hide();
          return;
        }
        btn.disabled = true;
        try {
          await fetch(`/api/auth/pair-requests/${id}/${act}`, { method: 'POST' });
          toast(act === 'approve' ? 'Approved — that device can set a new password now' : 'Request denied');
          card.remove();
          if (!mount.children.length) hide();
        } catch { btn.disabled = false; }
      }));
  });
}
