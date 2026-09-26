import { api } from '../api.js';
import { $, esc, toast, bindPasswordPeek, applyTheme } from '../ui.js';
import { view, registerRoute } from '../router.js';


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
    : `<button id="user-name-toggle" type="button" class="user-name">${user.has_avatar ? `<img class="avatar avatar-s" src="/api/avatar/${user.id}" alt="">` : ''}<span>${esc(user.name)}${user.is_admin ? ' · admin' : ''}</span> ▾</button>
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
    </div>`;
  $('#l-go').addEventListener('click', signIn);
  $('#l-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
  bindPasswordPeek('#l-pass');
  $('#l-name').focus();
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
      $('#invite-banner').innerHTML = `<span style="color:var(--t-d)">This invite link has been used or revoked —
        ask for a fresh one.</span>`;
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
  const theme = prefs.theme === 'classic' ? 'classic' : 'warm';
  const abs = await api('/abs/link').catch(() => ({ link: null }));
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
          <button class="btn ghost" id="a-avatar-upload">${me.has_avatar ? 'Change picture' : 'Add a picture'}</button>
          ${me.has_avatar ? '<button class="btn ghost" id="a-avatar-remove">Remove</button>' : ''}
          <span class="muted small">square-cropped, shrunk to 256px — shown next to your name across the app</span>
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
        <button type="button" data-val="warm" class="sel" aria-pressed="true">🔥 Warm</button>
        <button type="button" data-val="classic" aria-pressed="false">❄️ Classic</button>
      </div>
      <div class="muted small" style="margin-top:8px">Warm is the hearth-and-ember palette; Classic is the
      original cool slate. Saved to your account, so it follows you across devices — and it
      applies instantly, no reload.</div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Privacy</h3>
      <label style="display:block;margin:6px 0">
        <input type="checkbox" id="a-priv-profile" ${priv.profile_public ? 'checked' : ''}>
        Public profile — list me on the Members page with my recent activity
      </label>
      <label style="display:block;margin:6px 0">
        <input type="checkbox" id="a-priv-share" ${priv.share_compare ? 'checked' : ''}>
        Share my tiers — let members who opt in compare their ratings with mine
      </label>
      <div class="muted small">Turning either off hides the data immediately; nothing is deleted.
      The Compare page has a shortcut to the same setting.</div>
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
      </div>` : `
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
    toast('Avatar removed');
    renderUserMenu();
    accountView();
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
  bindPrivacy('#a-priv-profile', 'profile_public');
  bindPrivacy('#a-priv-share', 'share_compare');

  // Style — applies the moment you click, then persists on the account so it
  // follows the member to other devices (the dashboard re-applies on load).
  $('#a-theme-seg')?.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (btn.classList.contains('sel')) return;
      try {
        await api('/account/prefs', { method: 'PUT', body: { theme: btn.dataset.val } });
        $('#a-theme-seg').querySelectorAll('button').forEach((b) => {
          const sel = b === btn;
          b.classList.toggle('sel', sel);
          b.setAttribute('aria-pressed', String(sel));
        });
        applyTheme(btn.dataset.val);
        toast(btn.dataset.val === 'warm' ? 'Warm style on — the hearth is lit' : 'Classic style on — cool slate restored');
      } catch (err) {
        toast(err.message);
      }
    }));

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
      toast(`Sync done — ${r.books_added || 0} added, ${(r.finished_dated || 0) + (r.finished_closed || 0) + (r.finished_undated || 0)} finished, ${(r.reading_opened || 0) + (r.reading_updated || 0)} in progress`, 6000);
      accountView();
    } catch (err) {
      toast(err.message, 5000);
      btn.disabled = false;
      btn.textContent = '🔄 Sync now';
    }
  });
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
registerRoute('#invite/', inviteView);
registerRoute('#reset/', resetView);
registerRoute('#account', accountView);
