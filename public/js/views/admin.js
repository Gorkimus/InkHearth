import { api } from '../api.js';
import { $, esc, toast } from '../ui.js';
import { openModal, closeModal } from '../book-modal.js';
import { view, registerRoute } from '../router.js';

// Admin panel (#admin): instance vitals, who's logged in and from where,
// job history, kobo sync state, library health. Server-side the payload is
// requireAdmin; here we also gate the view so non-admins get a quiet card.

// Timestamps arrive in three shapes: SQLite's naive UTC strings
// ("2026-09-13 18:45:30", no zone marker), ISO strings (instance.started_at)
// and epoch millis (Hardcover health). The naive ones must be tagged UTC
// explicitly — new Date() would parse them as browser-local — then everything
// renders in the viewer's own timezone, DST-aware.
const stampFmt = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const when = (v) => {
  if (!v) return '—';
  const d = typeof v === 'number' ? new Date(v)
    : new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.slice(0, 19).replace(' ', 'T')}Z` : v);
  return Number.isNaN(d.getTime()) ? esc(String(v).slice(0, 16).replace('T', ' ')) : esc(stampFmt.format(d).replace(',', ''));
};
const bytes = (n) => (n == null ? '—' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// "Mozilla/5.0 (Linux; Android 13; Pixel 7) … Chrome/120…" → "Linux; Android 13; Pixel 7 · Chrome"
function device(ua) {
  if (!ua) return 'unknown device';
  const platform = (ua.match(/\(([^)]+)\)/) || [])[1] || ua.slice(0, 30);
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${platform}${browser ? ` · ${browser}` : ''}`;
}

const statusPill = (s) => {
  const tone = { done: 'var(--read)', error: 'var(--t-d)', running: 'var(--accent)', queued: 'var(--muted)' }[s] || 'var(--muted)';
  return `<span class="pill" style="color:${tone};border-color:${tone}">${esc(s)}</span>`;
};

async function adminView() {
  const meta = await api('/meta');
  if (!meta.user?.is_admin) {
    view.innerHTML = `<h1>Admin</h1><div class="card"><p class="muted" style="margin:0">Admin only.</p></div>`;
    return;
  }

  let d;
  try {
    d = await api('/admin/overview');
  } catch (err) {
    view.innerHTML = `<h1>Admin</h1><div class="card"><p class="muted" style="margin:0">${esc(err.message)}</p></div>`;
    return;
  }

  const upMs = Date.now() - new Date(d.instance.started_at).getTime();
  const uptime = upMs > 86400000 ? `${Math.floor(upMs / 86400000)}d ${Math.floor((upMs % 86400000) / 3600000)}h`
    : `${Math.floor(upMs / 3600000)}h ${Math.floor((upMs % 3600000) / 60000)}m`;
  const pill = (label, on) => on
    ? `<span class="pill" style="color:var(--read);border-color:var(--read)">✓ ${label}</span>`
    : `<span class="pill">○ ${label} not set</span>`;

  // Hardcover's pill is a HEALTH signal, not a config flag — a bad GraphQL
  // field once failed every HC call for hours with nothing to show for it.
  const hardcoverPill = (hc) => {
    if (!hc?.configured) return '<span class="pill">○ Hardcover not set</span>';
    const tip = `${hc.lastOkAt ? `last OK ${when(hc.lastOkAt)}` : 'no successful call yet'}`
      + (hc.lastErrorAt ? ` · last error: ${esc(hc.lastError || '')} (${when(hc.lastErrorAt)})` : '');
    return hc.ok
      ? `<span class="pill" style="color:var(--read);border-color:var(--read)" title="${tip}">✓ Hardcover</span>`
      : `<span class="pill" style="color:var(--t-s);border-color:var(--t-s)" title="${tip}">⚠ Hardcover failing</span>`;
  };

  view.innerHTML = `
    <h1>Admin</h1>
    <div class="toolbar">
      <button class="btn ghost" id="admin-refresh">↻ Refresh</button>
      <span class="muted small">server started ${when(d.instance.started_at)} · up ${uptime} · all times local</span>
    </div>

    <div class="headline-cards">
      <div class="card"><div class="k">Schema</div><div class="v">v${d.instance.schema_version}</div></div>
      <div class="card"><div class="k">Database</div><div class="v">${bytes(d.instance.db_bytes)}</div></div>
      <div class="card"><div class="k">Books</div><div class="v">${d.health.books}</div></div>
      <div class="card"><div class="k">Users</div><div class="v">${d.instance.users}</div></div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="k">Users &amp; access</div>
      <table class="lib-table static">
        <thead><tr><th>User</th><th>Joined</th><th>Last login</th><th>Sessions</th><th>Last activity</th><th>Library</th><th></th></tr></thead>
        <tbody>${d.users.map((u) => `
          <tr>
            <td><div class="t">${esc(u.name)}${u.is_admin ? ' <span class="pill">admin</span>' : ''}</div></td>
            <td class="muted small">${when(u.joined)}</td>
            <td class="muted small">${when(u.last_login)}</td>
            <td class="muted small">${u.sessions}</td>
            <td class="muted small">${when(u.last_activity)}</td>
            <td class="muted small">${u.books} books · ${u.finished} finished</td>
            <td style="white-space:nowrap">
              <button class="btn ghost restore" data-id="${u.id}" data-name="${esc(u.name)}"
                style="padding:3px 10px;font-size:12px" title="Roll this account back to a snapshot">♻ Restore</button>
              <button class="btn ghost danger revoke" data-id="${u.id}" data-name="${esc(u.name)}"
              style="padding:3px 10px;font-size:12px">Log out everywhere</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <div class="k">Recent logins</div>
        ${d.logins.length ? `<table class="lib-table static">
          <thead><tr><th>When</th><th>Who</th><th>Result</th><th>Device</th></tr></thead>
          <tbody>${d.logins.map((a) => `
            <tr>
              <td class="muted small">${when(a.created_at)}</td>
              <td>${esc(a.resolved_name || a.name || '?')}${a.ok ? '' : ' <span class="muted small">(attempted)</span>'}</td>
              <td>${a.ok
                ? '<span class="muted small">✓ signed in</span>'
                : '<span class="pill" style="color:var(--t-d);border-color:var(--t-d)">FAILED</span>'}</td>
              <td class="muted small">${esc(a.ip || '—')}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<div class="muted small">No logins recorded yet.</div>'}
      </div>
      <div class="card">
        <div class="k">Active sessions</div>
        <table class="lib-table static">
          <thead><tr><th>User</th><th>Started</th><th>Expires</th><th>Device</th></tr></thead>
          <tbody>${d.sessions.map((s) => `
            <tr>
              <td>${esc(s.name)}</td>
              <td class="muted small">${when(s.created_at)}</td>
              <td class="muted small">${when(s.expires_at)}</td>
              <td class="muted small">${esc(device(s.user_agent))}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="muted small">none</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <div class="k">Recent jobs</div>
        ${d.jobs.length ? `<table class="lib-table static">
          <thead><tr><th>When</th><th>Kind</th><th>User</th><th>Status</th></tr></thead>
          <tbody>${d.jobs.map((j) => `
            <tr>
              <td class="muted small">${when(j.created_at)}</td>
              <td>${esc(j.kind)}</td>
              <td class="muted small">${esc(j.user_name || '—')}</td>
              <td>${statusPill(j.status)}${j.error ? `<div class="muted small" title="${esc(j.error)}">${esc(j.error.slice(0, 60))}${j.error.length > 60 ? '…' : ''}</div>` : ''}${j.result ? `<div class="muted small" title="${esc(j.result)}" style="opacity:.75">↳ ${esc(String(j.result).slice(0, 60))}${String(j.result).length > 60 ? '…' : ''}</div>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<div class="muted small">No jobs yet.</div>'}
      </div>
      <div class="card">
        <div class="k">Integrations &amp; devices</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
          ${hardcoverPill(d.integrations.hardcover)}
          ${pill('Audiobookshelf', d.integrations.abs)}
          ${pill('LLM key', d.integrations.llm)}
        </div>
        ${d.kobo.length ? `<table class="lib-table static">
          <thead><tr><th>Kobo link</th><th>Last sync</th><th>Status</th></tr></thead>
          <tbody>${d.kobo.map((k) => `
            <tr>
              <td>${esc(k.name)}</td>
              <td class="muted small">${when(k.last_synced_at)}</td>
              <td class="muted small">${k.last_error
                ? `<span style="color:var(--t-d)">${esc(k.last_error.slice(0, 50))}</span>`
                : '✓ ok'}</td>
            </tr>`).join('')}</tbody>
        </table>` : '<div class="muted small" style="margin-top:6px">No linked Kobo devices.</div>'}
        ${(d.abs || []).length ? `<table class="lib-table static" style="margin-top:10px">
          <thead><tr><th>Audiobookshelf link</th><th>Last sync</th><th>Status</th></tr></thead>
          <tbody>${d.abs.map((a) => `
            <tr>
              <td>${esc(a.name)}</td>
              <td class="muted small">${when(a.last_synced_at)}</td>
              <td class="muted small">${a.last_error
                ? `<span style="color:var(--t-d)">${esc(a.last_error.slice(0, 50))}</span>`
                : '✓ ok'}</td>
            </tr>`).join('')}</tbody>
        </table>` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:14px" id="fr-admin">
      <div class="k">Feature requests</div>
      <div id="fr-admin-list" style="margin-top:6px"><div class="loading">Loading…</div></div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="k">Library health</div>
      <div class="muted small" style="margin:6px 0">
        ${d.health.missing_covers} books without a cover · ${d.health.missing_series} without a series ·
        ${d.health.missing_moods} without moods — a bulk <a href="#memory">re-pull on Memory lane</a> backfills what Hardcover can match.
      </div>
      <div class="muted small">${d.backups.count} snapshot${d.backups.count === 1 ? '' : 's'} on disk (${bytes(d.backups.bytes)}),
      newest ${esc(d.backups.newest || '—')} — nightly snapshots are automatic; ♻ Restore rolls one account back to any of them.</div>
    </div>`;

  $('#admin-refresh').addEventListener('click', adminView);

  // Feature requests: newest first, open ones above done ones. Mark done or
  // delete; both refresh the whole panel (cheap and keeps the count honest).
  api('/feedback/all').then(({ requests }) => {
    const el = $('#fr-admin-list');
    if (!el) return;
    el.innerHTML = requests.length ? `<table class="lib-table">
      <thead><tr><th>Who</th><th>Request</th><th>Sent</th><th></th></tr></thead>
      <tbody>${requests.map((r) => `
        <tr>
          <td>${esc(r.user_name)}</td>
          <td style="white-space:normal">${esc(r.body)}</td>
          <td class="muted small">${esc((r.created_at || '').slice(0, 10))}</td>
          <td style="white-space:nowrap">
            ${r.status === 'done' ? '<span class="pill">✓ done</span>' : '<span class="pill">open</span>'}
            <button class="btn ghost fr-toggle" data-id="${r.id}" data-status="${r.status}" style="padding:3px 10px;font-size:12px">${r.status === 'done' ? 'Reopen' : '✓ Done'}</button>
            <button class="btn ghost danger fr-del" data-id="${r.id}" style="padding:3px 10px;font-size:12px">✕</button>
          </td>
        </tr>`).join('')}</tbody></table>`
      : '<div class="muted small">No feature requests yet.</div>';
    el.querySelectorAll('.fr-toggle').forEach((btn) => btn.addEventListener('click', async () => {
      await api('/feedback/' + btn.dataset.id + '/status', {
        method: 'PUT', body: { status: btn.dataset.status === 'done' ? 'open' : 'done' },
      });
      adminView();
    }));
    el.querySelectorAll('.fr-del').forEach((btn) => btn.addEventListener('click', async () => {
      await api('/feedback/' + btn.dataset.id, { method: 'DELETE' });
      adminView();
    }));
  }).catch(() => { /* stays in loading state — non-fatal for the rest of the panel */ });

  view.querySelectorAll('.revoke').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm(`Log "${btn.dataset.name}" out of all devices?`)) return;
      try {
        await api('/admin/sessions/revoke', { method: 'POST', body: { user_id: +btn.dataset.id } });
        toast(`"${btn.dataset.name}" logged out everywhere`);
        adminView();
      } catch (err) {
        toast(err.message, 5000);
      }
    }));

  // Per-account rollback: pick a snapshot, swap the account's data back to
  // that moment. The server takes a restore-point snapshot first, keeps the
  // account's current password/admin flag, and clears their sessions.
  view.querySelectorAll('.restore').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = +btn.dataset.id;
      const name = btn.dataset.name;
      let backups;
      try {
        backups = (await api('/backup')).backups;
      } catch (err) {
        return toast(err.message, 5000);
      }
      openModal(`
        <h2 style="margin-top:0">Restore ${esc(name)}'s data</h2>
        <p class="muted small">Replaces this account's books, entries, queue, tags and settings with their state
        in the chosen snapshot. A fresh restore-point snapshot is taken first, the account's password stays
        as it is now, and they are logged out everywhere.</p>
        <select id="restore-snap" style="width:100%">${backups.map((b) =>
          `<option value="${esc(b.name)}">${esc(b.name)} · ${bytes(b.bytes)}</option>`).join('')}</select>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn danger" id="restore-go">Restore account</button>
          <button class="btn ghost" id="restore-cancel">Cancel</button>
        </div>`);
      $('#restore-cancel').addEventListener('click', closeModal);
      $('#restore-go').addEventListener('click', async () => {
        const go = $('#restore-go');
        const file = $('#restore-snap').value;
        go.disabled = true;
        go.textContent = 'Restoring…';
        try {
          const r = await api('/admin/restore-account', { method: 'POST', body: { user_id: id, file } });
          toast(`Restored "${name}" from ${file} — restore point saved as ${r.restore_point}`, 6000);
          closeModal();
          adminView();
        } catch (err) {
          go.disabled = false;
          go.textContent = 'Restore account';
          toast(err.message, 6000);
        }
      });
    }));
}

registerRoute('#admin', adminView);
