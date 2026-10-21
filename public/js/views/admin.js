import { api, pollJob } from '../api.js';
import { $, esc, toast } from '../ui.js';
import { openModal, closeModal } from '../book-modal.js';
import { view, registerRoute } from '../router.js';

// Admin panel (#admin): instance vitals, who's logged in and from where,
// job history, kobo sync state, library health. Server-side the payload is
// requireAdmin; here we also gate the view so non-admins get a quiet card.
// Layout is hearth-style panes — cards paired side by side, event feeds
// folded past the newest few — so the whole panel fits roughly one screen
// instead of a long vertical scroll.

// Timestamps arrive in three shapes: SQLite's naive UTC strings
// ("2026-09-13 18:45:30", no zone marker), ISO strings (instance.started_at)
// and epoch millis (Hardcover health). The naive ones must be tagged UTC
// explicitly — new Date() would parse them as browser-local — then everything
// renders in the viewer's own timezone, DST-aware.
const parseStamp = (v) => typeof v === 'number' ? new Date(v)
  : new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v) ? `${v.slice(0, 19).replace(' ', 'T')}Z` : v);
const stampFull = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
// Panes run half-width, so table stamps compress: time only for today,
// "Oct 16 17:05" otherwise. The full "2026-10-16 17:05" rides in tooltips.
const stampC = new Intl.DateTimeFormat('en-CA', {
  month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const whenFull = (v) => {
  if (!v) return '—';
  const d = parseStamp(v);
  return Number.isNaN(d.getTime()) ? esc(String(v).slice(0, 16).replace('T', ' ')) : esc(stampFull.format(d).replace(',', ''));
};
const when = (v) => {
  if (!v) return '—';
  const d = parseStamp(v);
  if (Number.isNaN(d.getTime())) return esc(String(v).slice(0, 16).replace('T', ' '));
  const s = stampC.format(d).replace(',', '');
  return d.toDateString() === new Date().toDateString() ? s.slice(s.lastIndexOf(' ') + 1) : s;
};
const bytes = (n) => (n == null ? '—' : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// IPv6 addresses run 40+ chars and would wrap a half-width pane into three
// lines — they truncate here, full address in the cell's tooltip.
const ipShort = (raw) => {
  if (!raw) return '—';
  const ip = raw.replace(/^::ffff:/, ''); // IPv4-mapped IPv6 → bare IPv4
  return ip.length > 16 ? `${ip.slice(0, 14)}…` : ip;
};

// "Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Edg/…" → "Windows · Edge".
// Full UA stays in the cell's tooltip.
function device(ua) {
  if (!ua) return 'unknown device';
  const plat = (ua.match(/\(([^)]+)\)/) || [])[1] || ua.slice(0, 30);
  const android = plat.match(/Android [\d.]+(?:; ([^;)]+))?/);
  const os = android
    ? (android[1] ? `${android[0].split(';')[0].trim()} · ${android[1].trim()}` : android[0])
    : /Windows/.test(plat) ? 'Windows'
    : /iPad/.test(plat) ? 'iPad'
    : /iPhone/.test(plat) ? 'iPhone'
    : /Macintosh/.test(plat) ? 'Mac'
    : /CrOS/.test(plat) ? 'ChromeOS'
    : /Linux/.test(plat) ? 'Linux'
    : plat.split(';')[0].slice(0, 24) || 'unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os}${browser ? ` · ${browser}` : ''}`;
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

  // Event feeds fold past the newest few — the admin scans the top, older
  // rows wait behind a toggle, and counts surface in the card headers so a
  // folded failure never hides. Running/queued jobs never fold.
  const failedLogins = d.logins.filter((a) => !a.ok).length;
  const erroredJobs = d.jobs.filter((j) => j.status === 'error').length;
  const olderJobs = d.jobs.filter((j, i) => i >= 5 && j.status !== 'running' && j.status !== 'queued').length;
  // The roster folds too — a 16-strong member list (seed accounts and all)
  // shouldn't push the event feeds below the fold. Admins never fold.
  const olderUsers = d.users.filter((u, i) => i >= 6 && !u.is_admin).length;
  const countPill = (n, label) => (n ? `<span class="pill" style="color:var(--t-d);border-color:var(--t-d)">${n} ${label}</span>` : '');
  const foldBtn = (n) => `<button class="btn ghost fold-btn" data-n="${n}" style="padding:2px 10px;font-size:12px;margin-top:8px">▸ Show ${n} older</button>`;

  view.innerHTML = `
    <div class="admin-page">
    <h1>Admin</h1>
    <div class="toolbar">
      <button class="btn ghost" id="admin-refresh">↻ Refresh</button>
      ${hardcoverPill(d.integrations.hardcover)}
      ${pill('Audiobookshelf', d.integrations.abs)}
      ${pill('LLM key', d.integrations.llm)}
      <span class="muted small" style="margin-left:auto">started ${when(d.instance.started_at)} · up ${uptime} · all times local</span>
    </div>

    <div class="headline-cards">
      <div class="card"><div class="k">Schema</div><div class="v">v${d.instance.schema_version}</div></div>
      <div class="card"><div class="k">Database</div><div class="v">${bytes(d.instance.db_bytes)}</div></div>
      <div class="card"><div class="k">Books</div><div class="v">${d.health.books}</div></div>
      <div class="card"><div class="k">Users</div><div class="v">${d.instance.users}</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="k">Users &amp; access</div>
        <table class="lib-table static">
          <thead><tr><th>User</th><th>Last login</th><th>Last activity</th><th>Sess.</th><th></th></tr></thead>
          <tbody>${d.users.map((u, i) => `
            <tr class="${i >= 6 && !u.is_admin ? 'older' : ''}">
              <td class="ellip" title="joined ${whenFull(u.joined)} · ${u.books} books · ${u.finished} finished"><span class="t">${esc(u.name)}</span>${u.is_admin ? ' <span class="pill">admin</span>' : ''}</td>
              <td class="muted small" title="${whenFull(u.last_login)}">${when(u.last_login)}</td>
              <td class="muted small" title="${whenFull(u.last_activity)}">${when(u.last_activity)}</td>
              <td class="muted small">${u.sessions}</td>
              <td style="white-space:nowrap">
                <button class="btn ghost restore" data-id="${u.id}" data-name="${esc(u.name)}"
                  style="padding:3px 8px;font-size:12px" title="Roll this account back to a snapshot">♻</button>
                <button class="btn ghost danger revoke" data-id="${u.id}" data-name="${esc(u.name)}"
                  style="padding:3px 8px;font-size:12px" title="Log out of every device">⏏</button></td>
            </tr>`).join('')}</tbody>
        </table>
        ${olderUsers ? foldBtn(olderUsers) : ''}
      </div>
      <div class="card">
        <div class="k">Active sessions</div>
        <table class="lib-table static">
          <thead><tr><th>User</th><th>Device</th><th>Started</th><th>Expires</th></tr></thead>
          <tbody>${d.sessions.map((s, i) => `
            <tr class="${i >= 6 ? 'older' : ''}">
              <td>${esc(s.name)}</td>
              <td class="muted small ellip" title="${esc(s.user_agent || '')}">${esc(device(s.user_agent))}</td>
              <td class="muted small" title="${whenFull(s.created_at)}">${when(s.created_at)}</td>
              <td class="muted small" title="${whenFull(s.expires_at)}">${when(s.expires_at)}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="muted small">none</td></tr>'}</tbody>
        </table>
        ${d.sessions.length > 6 ? foldBtn(d.sessions.length - 6) : ''}
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="k">Recent logins ${countPill(failedLogins, 'failed')}</div>
        ${d.logins.length ? `<table class="lib-table static">
          <thead><tr><th>When</th><th>Who</th><th>Result</th><th>IP</th></tr></thead>
          <tbody>${d.logins.map((a, i) => `
            <tr class="${i >= 5 ? 'older' : ''}">
              <td class="muted small" title="${whenFull(a.created_at)}">${when(a.created_at)}</td>
              <td class="ellip">${esc(a.resolved_name || a.name || '?')}${a.ok ? '' : ' <span class="muted small">(attempted)</span>'}</td>
              <td>${a.ok
                ? '<span class="muted small">✓ signed in</span>'
                : '<span class="pill" style="color:var(--t-d);border-color:var(--t-d)">FAILED</span>'}</td>
              <td class="muted small ellip" title="${esc(a.ip || '')}">${esc(ipShort(a.ip))}</td>
            </tr>`).join('')}</tbody>
        </table>
        ${d.logins.length > 5 ? foldBtn(d.logins.length - 5) : ''}`
        : '<div class="muted small">No logins recorded yet.</div>'}
      </div>
      <div class="card">
        <div class="k" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <span>Recent jobs ${countPill(erroredJobs, 'errored')}</span>
          ${d.jobs.some((j) => j.status === 'done' || j.status === 'error')
            ? '<button class="btn ghost" id="admin-jobs-clear" style="padding:2px 10px;font-size:12px" title="Drop every finished job from the feed (running ones stay)">Clear finished</button>'
            : ''}
        </div>
        ${d.jobs.length ? `<table class="lib-table static">
          <thead><tr><th>When</th><th>Kind</th><th>User</th><th>Status</th></tr></thead>
          <tbody>${d.jobs.map((j, i) => `
            <tr class="${i >= 5 && j.status !== 'running' && j.status !== 'queued' ? 'older' : ''}">
              <td class="muted small" title="${whenFull(j.created_at)}">${when(j.created_at)}</td>
              <td>${esc(j.kind)}</td>
              <td class="muted small">${esc(j.user_name || '—')}</td>
              <td title="${esc(j.result || j.error || j.status)}">${statusPill(j.status)}${j.error ? `<div class="muted small" title="${esc(j.error)}">${esc(j.error.slice(0, 60))}${j.error.length > 60 ? '…' : ''}</div>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table>
        ${olderJobs ? foldBtn(olderJobs) : ''}`
        : '<div class="muted small">No jobs yet.</div>'}
      </div>
    </div>

    <div class="grid-2">
      <div class="card" id="fr-admin">
        <div class="k">Feature requests</div>
        <div id="fr-admin-list" style="margin-top:6px"><div class="loading">Loading…</div></div>
      </div>
      <div class="card">
        <div class="k">Announcement</div>
        <div class="muted small" style="margin:6px 0">Rings every member's bell with one message — e.g. “Hardcover's daily limit resets at 8pm; re-run your import after that and missing page counts will fill in.”</div>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <textarea id="admin-broadcast" rows="2" style="flex:1" maxlength="500" placeholder="Message to the household…"></textarea>
          <button class="btn ghost" id="admin-broadcast-send" style="padding:3px 10px;font-size:12px">🔔 Send</button>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="k">Devices</div>
        ${d.kobo.length || (d.abs || []).length ? `
        ${d.kobo.length ? `<table class="lib-table static">
          <thead><tr><th>Kobo link</th><th>Last sync</th><th>Status</th></tr></thead>
          <tbody>${d.kobo.map((k) => `
            <tr>
              <td>${esc(k.name)}</td>
              <td class="muted small" title="${whenFull(k.last_synced_at)}">${when(k.last_synced_at)}</td>
              <td class="muted small">${k.last_error
                ? `<span style="color:var(--t-d)">${esc(k.last_error.slice(0, 50))}</span> <button class="btn ghost link-err-x" data-kind="kobo" data-uid="${k.user_id}" style="padding:1px 7px;font-size:11px" title="Clear this error (it also self-clears on the next good sync)">✕</button>`
                : '✓ ok'}</td>
            </tr>`).join('')}</tbody>
        </table>` : ''}
        ${(d.abs || []).length ? `<table class="lib-table static" style="margin-top:10px">
          <thead><tr><th>Audiobookshelf link</th><th>Last sync</th><th>Status</th></tr></thead>
          <tbody>${d.abs.map((a) => `
            <tr>
              <td>${esc(a.name)}</td>
              <td class="muted small" title="${whenFull(a.last_synced_at)}">${when(a.last_synced_at)}</td>
              <td class="muted small">${a.last_error
                ? `<span style="color:var(--t-d)">${esc(a.last_error.slice(0, 50))}</span> <button class="btn ghost link-err-x" data-kind="abs" data-uid="${a.user_id}" style="padding:1px 7px;font-size:11px" title="Clear this error (it also self-clears on the next good sync)">✕</button>`
                : '✓ ok'}</td>
            </tr>`).join('')}</tbody>
        </table>` : ''}`
        : '<div class="muted small">No linked Kobo or Audiobookshelf devices.</div>'}
      </div>
      <div class="card">
        <div class="k">Library health &amp; backups</div>
        <div class="muted small" style="margin:6px 0">
          ${d.health.missing_covers} books without a cover · ${d.health.missing_series} without a series ·
          ${d.health.missing_moods} without moods — a bulk <a href="#memory">re-pull on Memory lane</a> backfills what Hardcover can match.
        </div>
        <div class="muted small">${d.backups.count} snapshot${d.backups.count === 1 ? '' : 's'} on disk (${bytes(d.backups.bytes)}),
        newest ${esc(d.backups.newest || '—')} — nightly snapshots are automatic; ♻ Restore rolls one account back to any of them.</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">
          <button class="btn ghost" id="admin-refresh-missing" style="padding:3px 10px;font-size:12px"
            title="Re-pull pages/series/genres for every member's books that are missing them. Skips cleanly if Hardcover's daily limit is exhausted — run again after it resets.">↻ Fill gaps from Hardcover</button>
          <span class="muted small" id="admin-refresh-missing-hint"></span>
        </div>
      </div>
    </div>
    </div>`;

  // Folded event rows: newest few visible, the rest behind the toggle.
  view.querySelectorAll('.fold-btn').forEach((btn) => btn.addEventListener('click', () => {
    const table = btn.closest('.card').querySelector('table');
    const open = table.classList.toggle('open');
    btn.textContent = open ? '▾ Show fewer' : `▸ Show ${btn.dataset.n} older`;
  }));

  $('#admin-refresh').addEventListener('click', adminView);

  // The metadata sweep: one job, every member's missing books, Harding-paced.
  // A capped run stops before stamping anything it couldn't check — the hint
  // says when to try again.
  $('#admin-refresh-missing')?.addEventListener('click', async (e) => {
    const btn = e.target;
    const hint = $('#admin-refresh-missing-hint');
    btn.disabled = true;
    btn.textContent = 'Running…';
    hint.textContent = '';
    try {
      const { id } = await api('/jobs', { method: 'POST', body: { kind: 'book_refresh', payload: { only_missing: true, all_users: true } } });
      const r = await pollJob(id, {
        isStale: () => !btn.isConnected,
        onProgress: (j) => { btn.textContent = `Running… ${j.progress_label || j.progress + '%'}`; },
      });
      if (!r) return;
      if (r.capped) {
        const at = r.cap_resets_at ? new Date(r.cap_resets_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        hint.textContent = `Stopped — Hardcover's daily limit (resets ${at}). Re-run it after that.`;
      } else {
        hint.textContent = `${r.candidates} candidate${r.candidates === 1 ? '' : 's'} across ${r.users} member${r.users === 1 ? '' : 's'}: ${r.matched} matched, ${r.updated} updated.`;
      }
      toast(`Metadata sweep: ${r.matched} of ${r.candidates} matched`);
    } catch (err) {
      hint.textContent = '';
      toast('Sweep failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Fill gaps from Hardcover';
    }
  });

  $('#admin-broadcast-send')?.addEventListener('click', async () => {
    const ta = $('#admin-broadcast');
    const message = ta.value.trim();
    if (!message) return toast('Write the message first');
    try {
      await api('/notifications/broadcast', { method: 'POST', body: { message } });
      ta.value = '';
      toast("Sent — it's in every member's bell");
    } catch (err) { toast('Broadcast failed: ' + err.message); }
  });

  // Feed upkeep: drop finished jobs from the panel, or wipe a link error
  // the admin has already looked into. Both just re-render the panel.
  $('#admin-jobs-clear')?.addEventListener('click', async () => {
    try {
      const r = await api('/admin/jobs/clear', { method: 'POST' });
      toast(`Cleared ${r.cleared} finished job${r.cleared === 1 ? '' : 's'}`);
      adminView();
    } catch (err) { toast(err.message); }
  });
  document.querySelectorAll('.link-err-x').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api('/admin/links/clear-error', { method: 'POST', body: { kind: btn.dataset.kind, user_id: +btn.dataset.uid } });
        adminView();
      } catch (err) { toast(err.message); }
    }));

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
