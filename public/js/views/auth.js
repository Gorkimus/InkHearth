import { api } from '../api.js';
import { $, esc, toast, bindPasswordPeek, applyTheme, PALETTE_SLOTS, validPalette, WARM } from '../ui.js';
import { view, registerRoute } from '../router.js';

// The stock portrait wall (keys mirror the server's set in
// server/routes/avatar.js; the SVGs live in public/avatars/).
const STOCK_AVATARS = ['hearth', 'lantern', 'openbook', 'stack', 'mug'];
const STOCK_NAMES = {
  hearth: 'hearth fire', lantern: 'reading lantern', openbook: 'open book',
  stack: 'book pile', mug: 'tea on a book',
};

// Header user menu — click-to-toggle (hover menus drop the moment the
// pointer crosses the gap between the name and the popup).
let outsideBound = false;
function bindOutsideClose() {
  if (outsideBound) return;
  outsideBound = true;
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.user-menu.open').forEach((m) => {
      if (!m.contains(e.target)) m.classList.remove('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.user-menu.open').forEach((m) => m.classList.remove('open'));
  });
}

export async function renderUserMenu() {
  let user = null;
  try { user = (await api('/auth/me')).user; } catch { user = null; }
  bindOutsideClose();
  const slot = document.getElementById('user-menu');
  if (!slot) return;
  slot.innerHTML = !user
    ? `<a class="user-link" href="#login">Sign in</a>`
    : `<button id="user-name-toggle" type="button" class="user-name">${user.has_avatar ? `<img class="avatar avatar-s" src="/api/avatar/${user.id}?v=${Date.now()}" alt="">` : ''}<span>${esc(user.name)}${user.is_admin ? ' · admin' : ''}</span> ▾</button>
       <div class="user-dropdown">
         <a href="#account">Account</a>
         <a href="#feedback">💡 Feature requests</a>
         ${user.is_admin ? '<a href="#invites">Invites</a><a href="#admin">Admin</a>' : ''}
         <button id="menu-logout" type="button">Log out</button>
       </div>`;
  slot.querySelector('#menu-logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    toast('Signed out');
    location.hash = '#login';
    renderUserMenu();
  });
  if (user) {
    slot.classList.remove('open');
    slot.querySelector('#user-name-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      slot.classList.toggle('open');
    });
    // Choosing an item closes the menu (the href handles the navigation).
    slot.querySelectorAll('.user-dropdown a').forEach((el) =>
      el.addEventListener('click', () => slot.classList.remove('open')));
  }
}

async function signIn() {
  try {
    const user = await api('/auth/login', {
      method: 'POST',
      body: { name: $('#l-name').value.trim(), password: $('#l-pass').value },
    });
    toast(`Welcome back, ${user.name}`);
    await renderUserMenu();
    location.hash = '#dashboard';
  } catch (err) {
    $('#l-err').textContent = err.message;
  }
}

function loginView() {
  view.innerHTML = `
    <h1>Sign in</h1>
    <div class="card auth-card">
      <div class="form-grid">
        <div class="field"><label>Name</label><input id="l-name" autocomplete="username" autofocus></div>
        <div class="field"><label>Password</label><input id="l-pass" type="password" autocomplete="current-password"></div>
      </div>
      <button class="btn" id="l-go">Sign in</button>
      <div class="muted small" id="l-err" style="margin-top:10px;min-height:18px"></div>
      <div style="margin-top:14px"><a href="#pair" class="muted small">Locked out? Get approved from a signed-in device →</a></div>
    </div>`;
  $('#l-go').addEventListener('click', signIn);
  $('#l-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
  bindPasswordPeek('#l-pass');
  $('#l-name').focus();
}

// ---------- locked-out device pairing (#pair) ----------
// Forgot the password but still signed in somewhere else? This device shows a
// short code and waits; a signed-in device of the same member (or the admin)
// approves it by matching the code, and this page lands on the usual
// set-a-new-password screen. Nothing here needs the old password.

function pairView() {
  view.innerHTML = `
    <h1>Locked out?</h1>
    <p class="muted">If you're still signed in on another device — laptop, tablet, anything —
    approve this one from there and pick a new password. No password needed to start.</p>
    <div class="card auth-card">
      <div class="form-grid">
        <div class="field"><label>Your member name</label><input id="p-name" autocomplete="username" autofocus></div>
      </div>
      <button class="btn" id="p-go">Ask for approval</button>
      <div class="muted small" id="p-err" style="margin-top:10px;min-height:18px"></div>
      <div class="muted small" style="margin-top:14px">Not signed in anywhere? Ask the admin for a reset link
      (Invites &amp; resets) — they can mint one in seconds.</div>
    </div>`;
  $('#p-go').addEventListener('click', startPairing);
  $('#p-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') startPairing(); });
  $('#p-name').focus();

  async function startPairing() {
    const err = $('#p-err');
    err.textContent = '';
    let out;
    try {
      out = await api('/auth/pair', { method: 'POST', body: { name: $('#p-name').value.trim() } });
    } catch (e) {
      err.textContent = e.message;
      return;
    }
    view.innerHTML = `
      <h1>Waiting for approval</h1>
      <div class="card auth-card" style="text-align:center">
        <p class="muted" style="margin:4px 0 10px">On a signed-in device, approve the request with this code:</p>
        <div class="pair-code">${out.code.slice(0, 3)} ${out.code.slice(3)}</div>
        <p class="muted small" id="p-note">Asking every few seconds — keep this page open (requests expire in 10 minutes).</p>
        <div class="muted small" id="p-state" style="min-height:20px"></div>
        <button class="btn ghost" id="p-cancel">Cancel</button>
      </div>`;
    $('#p-cancel').addEventListener('click', () => { location.hash = '#login'; });
    const deadline = Date.now() + 11 * 60 * 1000;
    const tick = async () => {
      if ((location.hash || '') !== '#pair') return; // navigated away
      if (Date.now() > deadline) { $('#p-state').textContent = 'Request expired — start again.'; return; }
      let s;
      try { s = await api('/auth/pair/' + out.token); } catch { s = { status: 'pending' }; }
      if (s.status === 'approved' && s.reset_token) {
        $('#p-note').textContent = 'Approved!';
        location.hash = '#reset/' + s.reset_token;
        return;
      }
      if (s.status === 'approved') { $('#p-state').textContent = 'Approved — continue on the device that started the reset.'; return; }
      if (s.status === 'denied') {
        $('#p-note').textContent = 'That request was denied. Ask the admin for a reset link instead.';
        $('#p-cancel').textContent = '← Back to sign in';
        return;
      }
      if (s.status === 'expired') {
        $('#p-note').textContent = 'Request expired — start again.';
        $('#p-cancel').textContent = '← Start over';
        return;
      }
      setTimeout(tick, 2500);
    };
    tick();
  }
}

// ---------- invite signup (#invite/<token>) ----------

function inviteView() {
  const token = location.hash.split('/').slice(1).join('/');
  view.innerHTML = `
    <h1>You're invited</h1>
    <div class="card auth-card" id="invite-banner" style="margin-bottom:14px"><div class="loading">Loading…</div></div>
    <p class="muted">Create your account to start tracking your own reading — your imports,
    tiers and stats are yours alone. Step-by-step guidance follows right after signup.</p>
    <div class="card auth-card">
      <div class="form-grid">
        <div class="field"><label>Your name *</label><input id="i-name" placeholder="what you'll sign in with"></div>
        <div class="field"><label>Password *</label><input id="i-pass" type="password" placeholder="8+ characters"></div>
        <div class="field"><label>Confirm password *</label><input id="i-pass2" type="password" placeholder="same again"></div>
      </div>
      <button class="btn" id="i-go">Create account</button>
      <div class="muted small" id="i-err" style="margin-top:10px;min-height:18px"></div>
    </div>`;
  // Who sent the link — surfaces as a warm banner while the form is filled in.
  // A dead token gets called out immediately instead of failing on submit.
  api('/auth/invite/info?token=' + encodeURIComponent(token))
    .then((info) => {
      const reserved = info.recipient ? ` — this link was reserved for ${esc(info.recipient)}` : '';
      $('#invite-banner').innerHTML = `<span>📨 ${esc(info.invited_by)} invited you to join our book
        tracker${reserved}. Pick a name and password — a guided walkthrough follows.</span>`;
    })
    .catch(() => {
      // Covers every way a link dies: claimed (single), its uses filled up
      // (community), revoked, or expired.
      $('#invite-banner').innerHTML = `<span style="color:var(--t-d)">This invite link is no longer
        available — it was used, filled up, or revoked. Ask for a fresh one.</span>`;
      const go = $('#i-go');
      if (go) go.disabled = true;
    });
  $('#i-go').addEventListener('click', async () => {
    const err = $('#i-err');
    if ($('#i-pass').value !== $('#i-pass2').value) {
      err.textContent = 'Passwords do not match.';
      return;
    }
    try {
      const user = await api('/auth/invite/accept', {
        method: 'POST',
        body: { token, name: $('#i-name').value.trim(), password: $('#i-pass').value },
      });
      toast(`Welcome, ${user.name}!`);
      if (user.invited_by) sessionStorage.setItem('bt-invited-by', user.invited_by);
      await renderUserMenu();
      location.hash = '#welcome';
    } catch (e) {
      err.textContent = e.message;
    }
  });
  bindPasswordPeek('#i-pass, #i-pass2');
  $('#i-name').focus();
}

// ---------- account management ----------

// Square-crop any image the browser can decode into a small JPEG. Resizing
// client-side keeps uploads tiny (~10-30 KB) so the server needs no image
// library — it stores the bytes as-is. Cover-fit: the center square wins,
// portraits don't squash.
function squareJpeg(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) { URL.revokeObjectURL(url); return reject(new Error('that file does not look like an image')); }
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').drawImage(img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('could not read that image'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('that file does not look like an image')); };
    img.src = url;
  });
}

async function accountView() {
  const me = (await api('/auth/me')).user;
  if (!me) { location.hash = '#login'; return; }
  const llm = await api('/account/llm');
  const priv = await api('/auth/privacy');
  const prefs = await api('/account/prefs');
  const theme = ['classic', 'custom'].includes(prefs.theme) ? prefs.theme : 'warm';
  const abs = await api('/abs/link').catch(() => ({ link: null }));
  const kos = await api('/kosync/docs').catch(() => ({ connected: false, last_push_at: null, docs: [] }));
  view.innerHTML = `
    <h1>Account</h1>
    <div class="grid-2">
      <div class="card">
        <div style="display:flex;gap:14px;align-items:center">
          ${me.has_avatar
            ? `<img class="avatar avatar-xl" src="/api/avatar/${me.id}?v=${Date.now()}" alt="Your avatar">`
            : `<div class="avatar avatar-xl blank">${esc((me.name || '?')[0].toUpperCase())}</div>`}
          <div>
            <div class="k">Signed in as</div>
            <div class="v" style="font-size:22px">${esc(me.name)}</div>
            <div class="sub">${me.is_admin ? 'admin' : 'reader'}</div>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input type="file" id="a-avatar-file" accept="image/*" class="hidden">
          <button class="btn ghost" id="a-avatar-upload">${me.avatar_custom ? 'Change picture' : 'Upload a picture'}</button>
          ${me.avatar_custom ? '<button class="btn ghost" id="a-avatar-remove">Remove</button>' : ''}
          <span class="muted small">square-cropped, shrunk to 256px — shown next to your name across the app</span>
        </div>
        <h3>Hearth portraits</h3>
        <div class="muted small">${me.avatar_custom
          ? 'Your uploaded photo is showing. Remove it to wear your hearth portrait instead.'
          : 'No photo? Wear one of the house portraits — everyone gets one to start, and it shows wherever your name does.'}</div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap" id="a-stock-row">
          ${STOCK_AVATARS.map((k) => `<button type="button" class="stock-pick${!me.avatar_custom && me.avatar_effective === k ? ' sel' : ''}"
            data-key="${k}" title="Wear the ${STOCK_NAMES[k] || k} portrait"><img src="/avatars/${k}.svg" alt="${STOCK_NAMES[k] || k}"></button>`).join('')}
          <button type="button" class="btn ghost" id="a-stock-auto" style="padding:4px 10px;font-size:12px"
            title="Let the house assign one by your name">Auto</button>
        </div>
        <h3>Display name</h3>
        <div class="form-grid" style="grid-template-columns:1fr auto;align-items:end">
          <div class="field"><input id="a-name" value="${esc(me.name)}"></div>
          <button class="btn ghost" id="a-name-go">Save</button>
        </div>
        <div class="muted small" id="a-name-msg"></div>
      </div>
      <div class="card">
        <h3 style="margin-top:0">Change password</h3>
        <div class="form-grid">
          <div class="field"><label>Current</label><input id="a-cur" type="password" autocomplete="current-password"></div>
          <div class="field"><label>New (8+)</label><input id="a-new" type="password" autocomplete="new-password"></div>
          <div class="field wide"><label>Confirm new</label><input id="a-new2" type="password" autocomplete="new-password"></div>
        </div>
        <button class="btn ghost" id="a-pass-go">Update password</button>
        <div class="muted small" id="a-pass-msg" style="margin-top:8px"></div>
        <h3>Sessions</h3>
        <button class="btn danger" id="a-logout-all">Log out everywhere</button>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Style</h3>
      <div class="seg" id="a-theme-seg" role="group" aria-label="Colour style">
        <button type="button" data-val="warm" class="${theme === 'warm' ? 'sel' : ''}" aria-pressed="${theme === 'warm'}">🔥 Warm</button>
        <button type="button" data-val="classic" class="${theme === 'classic' ? 'sel' : ''}" aria-pressed="${theme === 'classic'}">❄️ Classic</button>
        <button type="button" data-val="custom" class="${theme === 'custom' ? 'sel' : ''}" aria-pressed="${theme === 'custom'}">🎨 Custom</button>
      </div>
      <div id="a-palette" class="${theme === 'custom' ? '' : 'hidden'}" style="margin-top:12px">
        <div class="palette-grid">
          ${PALETTE_SLOTS.map(([slot, label]) => `
            <div class="palette-slot" title="${label}">
              <div class="pal-row">
                <input type="color" id="a-pal-${slot}" data-slot="${slot}" aria-label="${label} colour">
                <input type="text" id="a-pal-hex-${slot}" class="palette-hex" maxlength="7" spellcheck="false"
                  autocomplete="off" placeholder="#rrggbb" aria-label="${label} hex code">
              </div>
              <span>${label}</span>
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
          <button class="btn" id="a-pal-save" style="padding:5px 14px">Save palette</button>
          <button class="btn ghost" id="a-pal-warm" style="padding:5px 14px">Start from Warm</button>
          <span class="muted small">pick or paste a code — preview is live, Save makes it yours on every device</span>
        </div>
      </div>
      <div class="muted small" style="margin-top:8px">Warm is the hearth-and-ember palette; Classic is the
        original cool slate; Custom wears your own colours — plain colour values only, so a palette can
        never be anything but a palette. Saved to your account, so it follows you across devices — and it
        applies instantly, no reload.</div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Privacy &amp; notifications</h3>
      <label style="display:block;margin:6px 0">
        <input type="checkbox" id="a-priv-finish" ${priv.notify_finishes ? 'checked' : ''}>
        Ring my bell when someone in my circle finishes a book
      </label>
      <label style="display:block;margin:6px 0">
        <input type="checkbox" id="a-priv-polls" ${priv.notify_polls ? 'checked' : ''}>
        Ring my bell when the club opens a poll, picks its next read, or starts a readalong
      </label>
      <label style="display:block;margin:6px 0">
        <input type="checkbox" id="a-priv-profile" ${priv.profile_public ? 'checked' : ''}>
        Public profile — list me on the Members page with my recent activity
      </label>
      <label style="display:block;margin:6px 0">
        <input type="checkbox" id="a-priv-share" ${priv.share_compare ? 'checked' : ''}>
        Share my tiers — let members who opt in compare their ratings with mine
      </label>
      <div class="muted small">Turning any of these off takes effect immediately; nothing is deleted.
      The Compare page has a shortcut to the same share setting.</div>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost" id="a-export">⬇ Download my data</button>
        <span class="muted small">every book, entry, tier and preference as one JSON file</span>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Recommendations — your own LLM key</h3>
      <div class="muted small" id="a-llm-status" style="margin:4px 0 10px"></div>
      ${llm.has_key ? '' : `
      <details class="muted small" style="margin:0 0 10px" open>
        <summary style="cursor:pointer">How to get a free key — takes about a minute</summary>
        <ol style="margin:8px 0 0 18px;padding:0;display:grid;gap:5px">
          <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with any Google account.</li>
          <li>Click <b>Create API key</b> — free, no card required.</li>
          <li>Copy it, paste it into the field below, and hit <b>Save key</b>. The model field is optional — leave it empty to follow the household default.</li>
        </ol>
        <div style="margin-top:6px">Your key is stored against your account only — no other member ever sees
        it — and you can remove it any time. Until then, For you quietly runs on the shared key.</div>
      </details>`}
      <div class="form-grid">
        <div class="field wide"><label>API key ${llm.has_key ? '<span class="muted small">(saved — paste to replace)</span>' : ''}</label>
          <input id="a-llm-key" type="password" placeholder="${llm.has_key ? '•••••••• saved' : 'paste your Google AI Studio / OpenAI-compatible key'}" autocomplete="off"></div>
        <div class="field"><label>Model <span class="muted small">(optional)</span></label>
          <input id="a-llm-model" value="${esc(llm.model)}" placeholder="gemini-3.6-flash"></div>
        <div class="field"><label>Base URL <span class="muted small">(optional)</span></label>
          <input id="a-llm-base" value="${esc(llm.base_url)}" placeholder="https://generativelanguage.googleapis.com/v1beta/openai/"></div>
      </div>
      <button class="btn ghost" id="a-llm-save">Save key</button>
      ${llm.has_key ? '<button class="btn danger" id="a-llm-clear">Remove my key</button>' : ''}
      <div class="muted small" id="a-llm-msg" style="margin-top:8px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">🎧 Audiobookshelf — sync your listening</h3>
      <div class="muted small" id="a-abs-status" style="margin:4px 0 10px"></div>
      ${abs.link ? `
      <div class="muted small" style="margin-bottom:10px">
        Linked as <b>${esc(abs.link.username)}</b> on ${esc(abs.link.server_url)} —
        library <b>${esc(abs.link.library_name)}</b>.
        ${abs.link.last_synced_at ? `Last synced ${esc(abs.link.last_synced_at)}.` : 'Never synced yet.'}
        ${abs.link.last_error ? `<span style="color:var(--t-d)">Last error: ${esc(abs.link.last_error)}</span>` : ''}
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn" id="a-abs-sync">🔄 Sync now</button>
        <button class="btn danger" id="a-abs-unlink">Unlink</button>
        <span class="muted small">progress syncs itself hourly too — part-listened books show on your dashboard, finishes date themselves</span>
      </div>
      <div id="a-abs-ignores" style="margin-top:8px"></div>` : `
      <div class="muted small" style="margin-bottom:10px">Link your Audiobookshelf account and your listening progress
      tracks itself: part-listened books show under your dashboard with live percentages, and finishes date themselves.
      Everyone links their own — sharing a server? Just enter the same details.</div>`}
      <details class="muted small" style="margin:8px 0" ${abs.link ? '' : 'open'}>
        <summary style="cursor:pointer">${abs.link ? 'Change the linked server or token' : 'How to link — your server URL and API token'}</summary>
        <ol style="margin:8px 0 0 18px;padding:0;display:grid;gap:5px">
          <li>In Audiobookshelf open <b>Settings → Users → your user</b> and copy the <b>API token</b>.</li>
          <li>Paste your server's URL (how you reach ABS in the browser) and the token below, then <b>Check connection</b>.</li>
          <li>Pick your library and hit <b>Link</b>. Your token is stored server-side and never shown again.</li>
        </ol>
        <div class="muted small" style="margin-top:8px">Your server needs an <b>https://</b> address this app can reach
        from its server (a tunnel or reverse proxy works great) — plain home-LAN addresses are blocked for members.
        Running yours on the household network? Ask the admin to sanction it.</div>
      </details>
      <div class="form-grid">
        <div class="field wide"><label>Server URL</label>
          <input id="a-abs-url" placeholder="https://your-abs-server" value="${esc(abs.link?.server_url || '')}"></div>
        <div class="field wide"><label>API token</label>
          <input id="a-abs-token" type="password" placeholder="${abs.link ? '•••••••• saved — paste to replace' : 'paste your ABS API token'}" autocomplete="off"></div>
        <div class="field"><label>Library</label>
          <select id="a-abs-lib">${abs.link ? `<option>${esc(abs.link.library_name)}</option>` : '<option value="">— check connection first —</option>'}</select></div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:4px">
        <button class="btn ghost" id="a-abs-validate">Check connection</button>
        <button class="btn" id="a-abs-link" disabled>Link</button>
      </div>
      <div class="muted small" id="a-abs-msg" style="margin-top:8px"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">📖 KOReader — sync your reading</h3>
      <div class="muted small" id="a-kos-status" style="margin:4px 0 10px">${
        kos.connected
          ? `${kos.docs.length} ${kos.docs.length === 1 ? 'book' : 'books'} syncing · ${kos.last_push_at ? `last push ${esc(kos.last_push_at.slice(0, 16).replace('T', ' '))}` : 'waiting for the first push from your e-reader'}.`
          : 'Read on KOReader? Point its progress sync at InkHearth and your reading tracks itself — the e-reader pushes as you turn pages; no exports, no button presses.'
      }</div>
      <div id="a-kos-row">${kos.connected ? `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn ghost" id="a-kos-regen">Regenerate key</button>
          <button class="btn danger" id="a-kos-unlink">Disconnect</button>
        </div>` : `
        <button class="btn" id="a-kos-connect">Connect KOReader</button>`}
      </div>
      <div id="a-kos-pending" style="margin-top:8px"></div>
      <div id="a-kos-new" style="margin-top:10px"></div>
      <details class="muted small" style="margin:8px 0">
        <summary style="cursor:pointer">How to set it up on the e-reader</summary>
        <ol style="margin:8px 0 0 18px;padding:0;display:grid;gap:5px">
          <li>Connect above — you'll get a server address, a username and a one-time key.</li>
          <li>In KOReader open the menu → <b>Tools → Progress sync</b>, set <b>Custom sync server</b> to the address, and sign in with the username + key.</li>
          <li>In the same menu turn <b>Send metadata</b> on — that's how InkHearth recognizes which book you're in.</li>
        </ol>
        <div class="muted small" style="margin-top:8px">Books it can't recognize appear below as "unrecognized" — map them once and they sync from then on.</div>
      </details>
      <div class="muted small" id="a-kos-msg" style="margin-top:8px"></div>
    </div>`;

  bindPasswordPeek('#a-cur, #a-new, #a-new2, #a-llm-key');

  $('#a-avatar-upload').addEventListener('click', () => $('#a-avatar-file').click());
  $('#a-avatar-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = ''; // a re-pick of the same file after a failed try must still fire
    if (!f) return;
    try {
      const blob = await squareJpeg(f);
      await api('/account/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      toast('Avatar updated');
      renderUserMenu();
      accountView();
    } catch (err) { toast(err.message, 5000); }
  });
  $('#a-avatar-remove')?.addEventListener('click', async () => {
    await api('/account/avatar', { method: 'DELETE' });
    toast('Photo removed — back to your hearth portrait');
    renderUserMenu();
    accountView();
  });
  // Hearth portraits: pick one (or hand the choice back to the auto-assign).
  // A photo still wins over the pick, so the picker works while wearing one.
  view.querySelectorAll('#a-stock-row .stock-pick').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api('/account/avatar-stock', { method: 'PUT', body: { key: btn.dataset.key } });
        toast('Portrait updated');
        renderUserMenu();
        accountView();
      } catch (err) { toast(err.message); btn.disabled = false; }
    }));
  $('#a-stock-auto')?.addEventListener('click', async () => {
    try {
      await api('/account/avatar-stock', { method: 'PUT', body: { key: null } });
      toast('Portrait set to auto');
      renderUserMenu();
      accountView();
    } catch (err) { toast(err.message); }
  });

  $('#a-name-go').addEventListener('click', async () => {
    try {
      await api('/auth/name', { method: 'POST', body: { name: $('#a-name').value.trim() } });
      $('#a-name-msg').textContent = 'Saved.';
      toast('Name updated');
      renderUserMenu();
    } catch (err) { $('#a-name-msg').textContent = err.message; }
  });

  $('#a-pass-go').addEventListener('click', async () => {
    const msg = $('#a-pass-msg');
    if ($('#a-new').value !== $('#a-new2').value) {
      msg.textContent = 'New passwords do not match.';
      return;
    }
    try {
      await api('/auth/password', {
        method: 'POST',
        body: { current: $('#a-cur').value, password: $('#a-new').value },
      });
      msg.textContent = 'Password updated.';
      $('#a-cur').value = ''; $('#a-new').value = ''; $('#a-new2').value = '';
      toast('Password updated');
    } catch (err) { msg.textContent = err.message; }
  });

  $('#a-logout-all').addEventListener('click', async () => {
    await api('/auth/logout-all', { method: 'POST' });
    location.hash = '#login';
    renderUserMenu();
  });

  // Data export: a plain fetch (the api() helper JSON-parses; we want the blob).
  $('#a-export')?.addEventListener('click', async () => {
    const btn = $('#a-export');
    btn.disabled = true;
    try {
      const res = await fetch('/api/account/export');
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'booktracker-export.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Data exported');
    } catch (err) {
      toast(err.message, 5000);
    } finally {
      btn.disabled = false;
    }
  });

  const bindPrivacy = (id, key) => {
    $(id).addEventListener('change', async (e) => {
      try {
        await api('/auth/privacy', { method: 'PUT', body: { [key]: e.target.checked } });
        toast(e.target.checked ? 'Privacy setting on' : 'Privacy setting off');
      } catch (err) {
        toast(err.message);
        e.target.checked = !e.target.checked;
      }
    });
  };
  bindPrivacy('#a-priv-finish', 'notify_finishes');
  bindPrivacy('#a-priv-polls', 'notify_polls');
  bindPrivacy('#a-priv-profile', 'profile_public');
  bindPrivacy('#a-priv-share', 'share_compare');

  // Style — applies the moment you click, then persists on the account so it
  // follows the member to other devices (the dashboard re-applies on load).
  // Custom is different: clicking it opens the pickers and previews live,
  // but nothing is saved until "Save palette" — playing with colours
  // shouldn't half-commit an account setting.
  const segBtns = () => [...$('#a-theme-seg').querySelectorAll('button')];
  const pickSeg = (val) => segBtns().forEach((b) => {
    const sel = b.dataset.val === val;
    b.classList.toggle('sel', sel);
    b.setAttribute('aria-pressed', String(sel));
  });
  const readSlots = () => Object.fromEntries(PALETTE_SLOTS.map(([slot]) => [slot, $(`#a-pal-${slot}`)?.value || '']));
  // Seed the pickers from the stored palette, else from whatever the page is
  // wearing (computed style returns the authored hex), else warm.
  const currentHex = (slot) => {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--' + (slot === 'panel2' ? 'panel-2' : slot)).trim();
    return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
  };
  const seedPickers = (from) => {
    const seed = validPalette(from) || Object.fromEntries(PALETTE_SLOTS.map(([slot]) => [slot, currentHex(slot) || WARM[slot]]));
    for (const [slot] of PALETTE_SLOTS) {
      const hex = seed[slot] || WARM[slot];
      $(`#a-pal-${slot}`).value = hex;
      $(`#a-pal-hex-${slot}`).value = hex;
    }
  };
  segBtns().forEach((btn) => btn.addEventListener('click', async () => {
    const val = btn.dataset.val;
    if (val === 'custom') {
      $('#a-palette').classList.remove('hidden');
      if (!btn.classList.contains('sel')) seedPickers(prefs.theme_custom);
      pickSeg('custom');
      applyTheme('custom', readSlots()); // live preview only — Save persists
      return;
    }
    $('#a-palette').classList.add('hidden');
    if (btn.classList.contains('sel')) return;
    try {
      await api('/account/prefs', { method: 'PUT', body: { theme: val } });
      pickSeg(val);
      applyTheme(val);
      toast(val === 'warm' ? 'Warm style on — the hearth is lit' : 'Classic style on — cool slate restored');
    } catch (err) { toast(err.message); }
  }));
  // Picking a colour writes the code; typing a code moves the swatch — the
  // picker input is the single source of truth, and only a well-shaped code
  // ever reaches it. A bare 6-digit paste gains its #; anything else marks
  // the field red and simply doesn't apply (the server gate stays the real
  // bouncer regardless).
  $('#a-palette')?.querySelectorAll('input[type=color]').forEach((inp) =>
    inp.addEventListener('input', () => {
      $(`#a-pal-hex-${inp.dataset.slot}`).value = inp.value;
      applyTheme('custom', readSlots());
    }));
  $('#a-palette')?.querySelectorAll('.palette-hex').forEach((field) =>
    field.addEventListener('input', () => {
      const slot = field.id.replace('a-pal-hex-', '');
      const v = field.value.trim();
      const hex = /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith('#') ? v : '#' + v).toLowerCase() : null;
      field.classList.toggle('bad', !!v && !hex);
      if (hex) $(`#a-pal-${slot}`).value = hex;
      applyTheme('custom', readSlots());
    }));
  $('#a-pal-save')?.addEventListener('click', async () => {
    try {
      await api('/account/prefs', { method: 'PUT', body: { theme: 'custom', theme_custom: readSlots() } });
      toast('Palette saved — it follows you everywhere now');
    } catch (err) { toast(err.message); }
  });
  $('#a-pal-warm')?.addEventListener('click', () => {
    seedPickers(WARM);
    applyTheme('custom', readSlots());
  });
  // Already custom: the panel renders open — seed the pickers from the
  // stored palette (an unseeded colour input reads as black, not empty).
  if (theme === 'custom') seedPickers(prefs.theme_custom);

  // LLM key status + save/clear. The key never round-trips to the client.
  const llmStatus = () => llm.has_key
    ? `Your key is saved${llm.effective_model ? ` — model ${llm.effective_model}` : ''}.`
    : llm.source === 'env'
      ? 'No personal key yet — For you currently runs on the household’s shared key, so its free-tier quota is shared with everyone.'
      : 'No key yet — the For-you page stays disabled until you add one.';
  $('#a-llm-status').textContent = llmStatus();

  $('#a-llm-save').addEventListener('click', async () => {
    const msg = $('#a-llm-msg');
    try {
      Object.assign(llm, await api('/account/llm', {
        method: 'PUT',
        body: {
          api_key: $('#a-llm-key').value.trim(),
          base_url: $('#a-llm-base').value.trim(),
          model: $('#a-llm-model').value.trim(),
        },
      }));
      msg.textContent = 'Key saved.';
      $('#a-llm-key').value = '';
      $('#a-llm-status').textContent = llmStatus();
      toast('LLM key saved — recommendations now use your own key');
      if (!$('#a-llm-clear')) location.reload();
    } catch (err) { msg.textContent = err.message; }
  });

  $('#a-llm-clear')?.addEventListener('click', async () => {
    try {
      Object.assign(llm, await api('/account/llm', { method: 'PUT', body: { clear: true } }));
      toast('Personal key removed');
      accountView();
    } catch (err) { $('#a-llm-msg').textContent = err.message; }
  });

  // ABS link: validate → pick library → link; Sync now runs the pollable job.
  const absMsg = $('#a-abs-msg');
  // Tombstones: books deleted here that the sync would otherwise resurrect.
  // Empty list → nothing shown. "Let it sync again" removes the row, and the
  // next sync re-adds the book (Account's Sync now, or the hourly pass).
  const renderAbsIgnores = async () => {
    const box = $('#a-abs-ignores');
    if (!box) return; // not linked — no list
    let list = [];
    try { list = (await api('/abs/ignored')).ignored; } catch { return; }
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <details class="muted small">
        <summary style="cursor:pointer">🚫 Kept out of sync (${list.length}) — deleted books ABS would bring back</summary>
        <div style="display:grid;gap:4px;margin-top:6px">
          ${list.map((it) => `
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span>${esc(it.title || it.item_id)} <span title="${esc(it.created_at)}">· deleted ${esc((it.created_at || '').slice(0, 10))}</span></span>
            <button class="btn ghost abs-unignore" data-id="${esc(it.item_id)}" style="padding:2px 8px;font-size:12px">Let it sync again</button>
          </div>`).join('')}
        </div>
      </details>`;
    box.querySelectorAll('.abs-unignore').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await api('/abs/ignored/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
        toast('Back in — the next sync brings it back');
        renderAbsIgnores();
      }));
  };
  renderAbsIgnores();
  $('#a-abs-validate').addEventListener('click', async () => {
    absMsg.textContent = 'Checking…';
    try {
      const v = await api('/abs/validate', {
        method: 'POST',
        body: { server_url: $('#a-abs-url').value.trim(), api_token: $('#a-abs-token').value.trim() },
      });
      const sel = $('#a-abs-lib');
      sel.innerHTML = v.libraries.map((l) => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');
      absMsg.textContent = `Connected as ${v.username} — pick your library and hit Link.`;
      $('#a-abs-link').disabled = false;
    } catch (err) { absMsg.textContent = err.message; }
  });
  $('#a-abs-link').addEventListener('click', async () => {
    absMsg.textContent = 'Linking…';
    try {
      await api('/abs/link', {
        method: 'POST',
        body: {
          server_url: $('#a-abs-url').value.trim(),
          api_token: $('#a-abs-token').value.trim(),
          library_id: $('#a-abs-lib').value,
        },
      });
      toast('Audiobookshelf linked — your listening progress syncs itself now');
      accountView();
    } catch (err) { absMsg.textContent = err.message; }
  });
  $('#a-abs-unlink')?.addEventListener('click', async () => {
    if (!confirm('Unlink your Audiobookshelf account? Your books and entries stay — only the automatic syncing stops.')) return;
    await api('/abs/link', { method: 'DELETE' });
    toast('Audiobookshelf unlinked');
    accountView();
  });
  $('#a-abs-sync')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const { id } = await api('/abs/sync', { method: 'POST' });
      let job = null;
      for (let i = 0; i < 200; i++) {
        job = await api('/jobs/' + id);
        if (job.status === 'done' || job.status === 'error') break;
        await new Promise((r) => setTimeout(r, 600));
      }
      if (!job || job.status === 'error') throw new Error(job?.error || 'sync timed out');
      const r = job.result || {};
      toast(`Sync done — ${r.books_added || 0} added, ${(r.finished_dated || 0) + (r.finished_closed || 0) + (r.finished_undated || 0)} finished, ${(r.reading_opened || 0) + (r.reading_updated || 0)} in progress${r.ignored ? `, ${r.ignored} kept out` : ''}`, 6000);
      accountView();
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false;
      btn.textContent = '🔄 Sync now';
    }
  });

  // KOReader sync: mint the one-time key, map unrecognized documents, forget
  // or disconnect. The raw key appears exactly once (invite-link rules) —
  // losing it means Regenerate, which kills the old key instantly.
  const kosCredsPanel = (c) => {
    const full = location.origin + c.url;
    $('#a-kos-new').innerHTML = `
      <div class="muted small" style="margin-bottom:4px">Copy these into KOReader now (the key is shown only once):</div>
      <div style="display:grid;gap:6px">
        <div><span class="muted small">Server&nbsp;</span><code>${esc(full)}</code>
          <button class="btn ghost kos-copy" data-v="${esc(full)}" style="padding:2px 10px;font-size:12px">Copy</button></div>
        <div><span class="muted small">User&nbsp;</span><code>${esc(c.username)}</code>
          <button class="btn ghost kos-copy" data-v="${esc(c.username)}" style="padding:2px 10px;font-size:12px">Copy</button></div>
        <div><span class="muted small">Key&nbsp;</span><code>${esc(c.token)}</code>
          <button class="btn ghost kos-copy" data-v="${esc(c.token)}" style="padding:2px 10px;font-size:12px">Copy</button></div>
      </div>
      <div class="muted small" style="margin-top:6px">KOReader → Tools → Progress sync → Custom sync server = the address above;
      sign in with the username and this key as the password. Turn <b>Send metadata</b> on while you're there.</div>`;
    $('#a-kos-new').querySelectorAll('.kos-copy').forEach((b) =>
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.v); toast('Copied'); }
        catch { toast('Select the text and copy manually', 5000); }
      }));
  };

  const renderKosPending = async () => {
    const box = $('#a-kos-pending');
    if (!box || !kos.connected) return;
    const pending = kos.docs.filter((d) => !d.book_id);
    if (!pending.length) { box.innerHTML = ''; return; }
    let books = [];
    try { books = (await api('/books')).books; } catch { /* picker just stays empty */ }
    box.innerHTML = `
      <details class="muted small" ${pending.length && !kos.docs.some((d) => d.book_id) ? 'open' : ''}>
        <summary style="cursor:pointer">❓ Unrecognized books (${pending.length}) — sync seen these but couldn't match them</summary>
        <div style="display:grid;gap:6px;margin-top:6px">
          ${pending.map((d) => `
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span>${esc(d.title_hint || d.document.slice(0, 12) + '…')} · ${Math.round((d.last_percentage || 0) * 100)}% · ${esc((d.updated_at || '').slice(0, 10))}</span>
            <select class="kos-book" data-doc="${esc(d.document)}">
              <option value="">— pick a book on your shelf —</option>
              ${books.map((b) => `<option value="${b.id}">${esc(b.title)}${b.author ? ` — ${esc(b.author)}` : ''}</option>`).join('')}
            </select>
            <button class="btn ghost kos-map" data-doc="${esc(d.document)}" style="padding:2px 10px;font-size:12px">Map</button>
            <button class="btn ghost kos-forget" data-doc="${esc(d.document)}" style="padding:2px 10px;font-size:12px">Forget</button>
          </div>`).join('')}
        </div>
        <div class="muted small" style="margin-top:6px">Not on your shelf yet? Log it first (<b>＋ Log a book</b>), then map it here.</div>
      </details>`;
    box.querySelectorAll('.kos-map').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const sel = box.querySelector(`.kos-book[data-doc="${CSS.escape(btn.dataset.doc)}"]`);
        if (!sel?.value) { toast('Pick a book first'); return; }
        await api('/kosync/docs/' + encodeURIComponent(btn.dataset.doc) + '/map', { method: 'POST', body: { book_id: +sel.value } });
        toast('Mapped — it syncs from now on');
        accountView();
      }));
    box.querySelectorAll('.kos-forget').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await api('/kosync/docs/' + encodeURIComponent(btn.dataset.doc), { method: 'DELETE' });
        accountView();
      }));
  };
  renderKosPending();

  $('#a-kos-connect')?.addEventListener('click', async () => {
    try {
      const c = await api('/kosync/creds', { method: 'POST' });
      kos.connected = true;
      kos.docs = [];
      kos.last_push_at = null;
      $('#a-kos-status').textContent = 'Connected — waiting for the first push from your e-reader.';
      $('#a-kos-row').innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button class="btn ghost" id="a-kos-regen">Regenerate key</button>
          <button class="btn danger" id="a-kos-unlink">Disconnect</button>
        </div>`;
      kosCredsPanel(c);
      bindKosyncConnected();
    } catch (err) { toast(err.message, 5000); }
  });

  function bindKosyncConnected() {
    $('#a-kos-regen')?.addEventListener('click', async () => {
      if (!confirm('Regenerate the key? Your e-reader stops syncing until you paste the new one.')) return;
      const c = await api('/kosync/creds', { method: 'POST' });
      kosCredsPanel(c);
      toast('New key — old one is dead');
    });
    $('#a-kos-unlink')?.addEventListener('click', async () => {
      if (!confirm('Disconnect KOReader sync? Your books and entries stay — only the automatic syncing stops.')) return;
      await api('/kosync/creds', { method: 'DELETE' });
      toast('KOReader disconnected');
      accountView();
    });
  }
  bindKosyncConnected();
}

// ---------- password reset (#reset/<token>) ----------

function resetView() {
  const token = location.hash.split('/').slice(1).join('/');
  view.innerHTML = `
    <h1>Set a new password</h1>
    <p class="muted">Pick a new password for your account. Your other signed-in devices
    will be logged out.</p>
    <div class="card auth-card">
      <div class="form-grid">
        <div class="field"><label>New password (8+)</label><input id="r-pass" type="password" autocomplete="new-password"></div>
        <div class="field"><label>Confirm password</label><input id="r-pass2" type="password" autocomplete="new-password"></div>
      </div>
      <button class="btn" id="r-go">Save password</button>
      <div class="muted small" id="r-err" style="margin-top:10px;min-height:18px"></div>
    </div>`;
  $('#r-go').addEventListener('click', async () => {
    const err = $('#r-err');
    if ($('#r-pass').value !== $('#r-pass2').value) {
      err.textContent = 'Passwords do not match.';
      return;
    }
    try {
      await api('/auth/reset/accept', { method: 'POST', body: { token, password: $('#r-pass').value } });
      toast('Password updated — sign in with it now');
      location.hash = '#login';
    } catch (e) {
      err.textContent = e.message;
    }
  });
  bindPasswordPeek('#r-pass, #r-pass2');
  $('#r-pass').focus();
}

registerRoute('#login', loginView);
registerRoute('#pair', pairView);
registerRoute('#invite/', inviteView);
registerRoute('#reset/', resetView);
registerRoute('#account', accountView);
