import { api } from '../api.js';
import { $, esc, toast } from '../ui.js';
import { view, registerRoute } from '../router.js';

// Admin-only: mint single-use invite links (labelled with who they're for),
// issue password reset links, revoke what's unused. Links are shown exactly
// once. Onboarding instructions are built into the app — the invitee gets a
// guided welcome page right after signup — so the admin only shares a link.

async function invitesView() {
  view.innerHTML = `
    <h1>Invites & resets</h1>
    <p class="muted">Each link works for exactly one use and is shown only once — send it to the
    person directly. Instructions are built into the app: after they claim the link they get a
    guided walkthrough, no email needed.</p>
    <div class="toolbar">
      <input id="inv-recipient" placeholder="Who's this invite for? (e.g. Mom)" style="max-width:260px">
      <button class="btn" id="inv-create">Create invite</button>
      <span id="inv-new" class="muted small"></span>
    </div>
    <div class="card" id="inv-list"><div class="loading">Loading…</div></div>

    <h3 style="margin-top:26px">Password reset</h3>
    <p class="muted small">Generate a one-time reset link for an existing account (valid 24 hours).
    It logs that account out everywhere and lets them set a new password.</p>
    <div class="toolbar">
      <select id="reset-user"></select>
      <button class="btn ghost" id="reset-create">Create reset link</button>
      <span id="reset-new" class="muted small"></span>
    </div>`;

  const refresh = async () => {
    const { invites } = await api('/auth/invites');
    $('#inv-list').innerHTML = invites.length ? `
      <table class="lib-table">
        <thead><tr><th>For</th><th>Created</th><th>Type</th><th>Status</th></tr></thead>
        <tbody>${invites.map((i) => `
          <tr>
            <td>${i.recipient ? esc(i.recipient) : '<span class="muted">—</span>'}</td>
            <td class="muted small">${esc((i.created_at || '').slice(0, 10))}</td>
            <td>${i.resets_user
              ? `<span class="pill">password reset</span> <span class="muted small">${esc(i.resets_user_name || `#${i.resets_user}`)}</span>`
              : '<span class="pill">signup</span>'}</td>
            <td>${i.used_by
              ? `<span class="pill">used by ${esc(i.used_by_name || `#${i.used_by}`)}</span>`
              : `<span class="pill">unused</span> <button class="btn ghost inv-revoke" data-id="${i.id}" style="padding:3px 10px;font-size:12px">Revoke</button>`}</td>
          </tr>`).join('')}</tbody>
      </table>`
      : '<div class="muted small">No invites yet — create the first one.</div>';
    $('#inv-list').querySelectorAll('.inv-revoke').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await api('/auth/invites/' + btn.dataset.id, { method: 'DELETE' });
        toast('Invite revoked');
        await refresh();
      }));
  };

  $('#inv-create').addEventListener('click', async () => {
    const recipient = $('#inv-recipient').value.trim();
    const { url } = await api('/auth/invites', { method: 'POST', body: { recipient } });
    showInvite(url, $('#inv-new'), recipient);
    await refresh();
  });

  // Reset section: fill the user dropdown, then mint links on demand.
  const { users } = await api('/auth/users');
  $('#reset-user').innerHTML = users.map((u) => `<option value="${u.id}">${esc(u.name)}${u.is_admin ? ' (admin)' : ''}</option>`).join('');
  $('#reset-create').addEventListener('click', async () => {
    const { url } = await api('/auth/resets', { method: 'POST', body: { user_id: +$('#reset-user').value } });
    showOnce(url, $('#reset-new'));
    await refresh();
  });

  await refresh();
}

function showInvite(url, slot, recipient) {
  const full = location.origin + '/' + url.replace(/^\//, '');
  const blurb = `${recipient ? `Hi ${recipient} — ` : ''}I've invited you to my book tracker. Claim your
account with this one-time link (pick your own name and password — a guided
walkthrough follows right after):

${full}`;
  slot.innerHTML = `
    <div style="margin:8px 0">
      <div class="muted small" style="margin-bottom:4px">Link (shown once):</div>
      <code>${esc(full)}</code>
      <button class="btn ghost" id="link-copy" style="padding:4px 12px;font-size:13px">Copy link</button>
    </div>
    <div style="margin-top:10px">
      <div class="muted small" style="margin-bottom:4px">Optional short message to paste along with the link:</div>
      <pre class="invite-email" style="white-space:pre-wrap">${esc(blurb)}</pre>
      <button class="btn ghost" id="blurb-copy" style="padding:4px 12px;font-size:13px">Copy message</button>
    </div>`;
  const copy = async (text, note) => {
    try { await navigator.clipboard.writeText(text); toast(note); }
    catch { toast('Select the text and copy manually', 5000); }
  };
  slot.querySelector('#link-copy').addEventListener('click', () => copy(full, 'Link copied'));
  slot.querySelector('#blurb-copy').addEventListener('click', () => copy(blurb, 'Message copied'));
}

function showOnce(url, slot) {
  const full = location.origin + '/' + url.replace(/^\//, '');
  slot.innerHTML = `Copy it now (shown once): <code>${esc(full)}</code>
    <button class="btn ghost" id="link-copy" style="padding:4px 12px;font-size:13px">Copy</button>`;
  slot.querySelector('#link-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(full); toast('Link copied'); }
    catch { toast('Select and copy the link manually', 5000); }
  });
}

registerRoute('#invites', invitesView);
