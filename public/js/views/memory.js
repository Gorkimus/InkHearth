import { api, pollJob } from '../api.js';
import { $, esc, toast, tierBadge, TIERS, segHTML, segVal, bindSeg, bindTierPicker, pickerVal, guard } from '../ui.js';
import { view, registerRoute } from '../router.js';

// ---------- file-import review UI (shared by Kobo + Audible) ----------
// Both flows: upload a file → server parses defensively → review list with
// per-book status → import runs as a pollable job with Hardcover matching.

function makeImporter(boxSelector, { kind, label, tierColumn = false }) {
  const box = () => $(boxSelector);
  let rows = [];

  function render(books) {
    const order = { finished: 0, reading: 1, tbr: 2, book: 3 };
    rows = books
      .sort((a, b) => (order[a.suggested_status] ?? 9) - (order[b.suggested_status] ?? 9))
      .map((b) => ({ ...b, include: b.suggested_status !== 'book', chosen_status: b.suggested_status }));
    box().innerHTML = `
    <div class="muted small" style="margin:10px 0 4px">${books.length} books found —
    uncheck anything you don't want, adjust statuses, then import. Progress and dates come from the file.</div>
    <table class="lib-table" style="margin-top:6px"><thead><tr>
      <th title="Select all / none"><input type="checkbox" id="k-select-all"></th>
      <th>Book</th><th>Progress</th>${tierColumn ? '<th>Tier</th>' : ''}<th>Keep as</th>
    </tr></thead><tbody>
    ${rows.map((b, i) => `
      <tr>
        <td><input type="checkbox" data-kidx="${i}" class="k-include" ${b.include ? 'checked' : ''}></td>
        <td><div class="t" style="font-size:13px">${esc(b.title)}</div><div class="muted small">${esc(b.author || '')}${b.isbn || b.content_id ? ' · ' + esc(b.isbn || b.content_id) : ''}</div></td>
        <td class="muted small">${b.percent ? b.percent + '%' : '—'}${b.last_read ? ' · ' + esc(b.last_read) : ''}</td>
        ${tierColumn ? `<td><select data-kidx="${i}" class="k-tier">
          <option value="" ${!b.rating ? 'selected' : ''}>—</option>
          ${TIERS.map((t) => `<option value="${t}" ${b.rating === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select></td>` : ''}
        <td><select data-kidx="${i}" class="k-status">
          <option value="finished" ${b.chosen_status === 'finished' ? 'selected' : ''}>Finished</option>
          <option value="reading" ${b.chosen_status === 'reading' ? 'selected' : ''}>Reading now</option>
          <option value="tbr" ${b.chosen_status === 'tbr' ? 'selected' : ''}>To read (TBR)</option>
          <option value="book" ${b.chosen_status === 'book' ? 'selected' : ''}>Book only</option>
        </select></td>
      </tr>`).join('')}
    </tbody></table>
    <div style="margin-top:10px;display:flex;gap:10px;align-items:center">
      <button class="btn import-go">Import selected</button>
      <span class="muted small">Matching runs against Hardcover — can take a couple of minutes for big libraries.</span>
    </div>`;
    // Header select-all: checked = every row in, indeterminate = some in.
    // One click flips the whole list; row edits keep the header honest.
    const paintAll = () => {
    const all = $('#k-select-all', box());
      const n = rows.filter((r) => r.include).length;
      all.checked = n === rows.length;
      all.indeterminate = n > 0 && n < rows.length;
    };
    paintAll();
    $('#k-select-all', box()).addEventListener('change', (e) => {
      rows.forEach((r) => { r.include = e.target.checked; });
      box().querySelectorAll('.k-include').forEach((cb) => { cb.checked = e.target.checked; });
      e.target.indeterminate = false;
    });
    box().querySelectorAll('.k-include').forEach((cb) =>
      cb.addEventListener('change', () => {
        rows[+cb.dataset.kidx].include = cb.checked;
        paintAll();
      }));
    box().querySelectorAll('.k-status').forEach((sel) =>
      sel.addEventListener('change', () => { rows[+sel.dataset.kidx].chosen_status = sel.value; }));
    box().querySelectorAll('.k-tier').forEach((sel) =>
      sel.addEventListener('change', () => { rows[+sel.dataset.kidx].rating = sel.value || null; }));
    box().querySelector('.import-go').addEventListener('click', start);
  }

  async function start() {
    const selected = rows.filter((r) => r.include).map((r) => ({ ...r }));
    if (!selected.length) return toast('Nothing selected');
    const btn = box().querySelector('.import-go');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    // A running import can be stopped: the flag lands on the job row, the
    // runner checks it between books, and everything already imported stands.
    const stop = document.createElement('button');
    stop.className = 'btn danger';
    stop.textContent = '■ Stop';
    stop.addEventListener('click', async () => {
      stop.disabled = true;
      stop.textContent = 'Stopping…';
      await api('/jobs/' + jobId, { method: 'DELETE' }).catch(() => {});
      stop.textContent = 'Stopping after this book…';
    });
    btn.after(stop);
    try {
      // Long-running (Hardcover matching paces ~400ms/book): start a job, poll it.
      const { id: jobId } = await api('/jobs', {
        method: 'POST',
        body: { kind, payload: { hardcover: true, rows: selected } },
      });
      const result = await pollJob(id, {
        isStale: () => !btn.isConnected, // view left — stop tracking, job runs on
        onProgress: (j) => { btn.textContent = `Importing… ${j.progress_label || ''}`; },
      });
      if (!result) return;
      if (result.cancelled) {
        box().innerHTML = `<div class="muted small">Import stopped at ${result.imported} of
          ${result.rows_total} books — everything processed is in your library. Upload the same
          file anytime to pick up the rest (already-imported books skip themselves).</div>`;
        toast(`${label} import stopped — ${result.imported} books were in`);
      } else {
        box().innerHTML = `<div class="muted small">Imported ${result.imported} ${label} books —
          ${result.hardcover_matched} matched to Hardcover, ${result.events_created} read events created
          ${result.tbr_queued ? `, ${result.tbr_queued} queued as want-to-read` : ''}
          ${result.skipped ? `(${result.skipped} already in your library)` : ''}.</div>`;
        toast(`${label} import complete: ${result.imported} books`);
      }
    } catch (err) {
      toast('Import failed: ' + err.message, 6000);
      btn.disabled = false;
      btn.textContent = 'Import selected';
    } finally {
      stop.remove();
    }
  }

  return { render, boxSelector };
}

const koboImport = makeImporter('#kobo-review', { kind: 'kobo_import', label: 'Kobo' });
const audibleImport = makeImporter('#audible-review', { kind: 'audible_import', label: 'Audible' });
const goodreadsImport = makeImporter('#goodreads-review', { kind: 'goodreads_import', label: 'Goodreads', tierColumn: true });

async function uploadFile(file, parsePath, importer, onParsed) {
  $(importer.boxSelector).innerHTML = '<div class="muted small">Parsing file…</div>';
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch(parsePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf,
    });
    // A proxy/out-of-date server can answer with an HTML page — fail with
    // something readable instead of a JSON token-parse error.
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !data || data.error) throw new Error(data?.error || `parse failed (HTTP ${res.status})`);
    importer.render(data.books);
    if (onParsed) onParsed(data);
  } catch (err) {
    $(importer.boxSelector).innerHTML = `<div class="muted small">Import failed: ${esc(err.message)}</div>`;
  }
}

// ---------- memory lane ----------

async function memoryView() {
  const session = [];
  // The ABS pull uses the host's .env credentials (the host's library), so the
  // card only exists for the admin.
  let isAdmin = false;
  try { isAdmin = !!((await api('/meta')).user?.is_admin); } catch { /* stays hidden */ }
  view.innerHTML = `
    <h1>Memory lane</h1>
    <p class="muted">Fast backfill for books you've already finished — title, year, tier. No dates needed.
    Rank what you remember; skip what you don't.</p>
    <div class="card" style="max-width:640px">
      <div class="form-grid">
        <div class="field"><label>Title *</label><input id="m-title"></div>
        <div class="field"><label>Author</label><input id="m-author"></div>
        <div class="field"><label>Year finished</label><input id="m-year" type="number" min="1900" max="2100" value="${new Date().getFullYear() - 1}"></div>
        <div class="field"><label>Format</label>${segHTML('m-format', [['read', '📖 Read'], ['listened', '🎧 Listened']], 'read')}</div>
        <div class="field wide"><label>Tier</label>
          <div class="tier-picker" id="m-rating">${TIERS.map((t) => `<button type="button" class="tier-btn tier-${t}" data-val="${t}" aria-pressed="false">${t}</button>`).join('')}</div>
        </div>
      </div>
      <button class="btn" id="m-add">Add book</button>
      <span class="muted small" style="margin-left:10px">Enter rolls straight through to the next book.</span>
    </div>
    <div class="card" style="max-width:640px;margin-top:14px">
      <h3 style="margin:0 0 8px">Import from a Kobo</h3>
      <p class="muted small">Plug the Kobo in over USB and upload its <code>.kobo/KoboReader.sqlite</code>.
      Books are matched against Hardcover automatically; you confirm what counts as read before anything is saved.
      Afterwards you can keep the device linked so new progress pulls in by itself.</p>
      <input type="file" id="kobo-file" accept=".sqlite,.db,.sqlite3">
      <div id="kobo-link" class="small" style="margin-top:8px"></div>
      <div id="kobo-review"></div>
    </div>
    <div class="card" style="max-width:640px;margin-top:14px">
      <h3 style="margin:0 0 8px">Import from Audible</h3>
      <p class="muted small">Audible doesn't offer an export, so use any helper app to produce one —
      Libation, OpenAudible, or the Audible Library Extractor browser extension (Amazon's "Request My Data"
      archive works too). Upload the CSV/JSON/XLSX here; we never ask for your Amazon login.</p>
      <input type="file" id="audible-file" accept=".csv,.json,.txt,.xlsx">
      <div id="audible-review"></div>
    </div>
    <div class="card" style="max-width:640px;margin-top:14px">
      <h3 style="margin:0 0 8px">Import from Goodreads</h3>
      <p class="muted small">Export your library at Goodreads → My Books → Import/Export (CSV), then upload it here.
      Star ratings map onto the S–D tiers (editable in the review list), shelves become tags, and every book is
      verified against Hardcover.</p>
      <input type="file" id="goodreads-file" accept=".csv,.txt">
      <div id="goodreads-review"></div>
    </div>
    ${isAdmin ? `
    <div class="card" style="max-width:640px;margin-top:14px">
      <h3 style="margin:0 0 8px">Pull from Audiobookshelf</h3>
      <p class="muted small">Imports this server's configured ABS library: real runtimes, narrators, locally-stored
      covers, Hardcover metadata. Already-imported books are skipped. Catalog-only — log what you finished
      yourself, or via the imports above.</p>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <label class="muted small"><input type="checkbox" id="abs-rematch"> Re-match books lacking a Hardcover link</label>
        <button class="btn" id="abs-import">Start import</button>
      </div>
      <div id="abs-status" class="muted small" style="margin-top:8px"></div>
    </div>
    <div class="card" style="max-width:640px;margin-top:14px">
      <h3 style="margin:0 0 8px">Re-pull book data</h3>
      <p class="muted small">Re-fetch series, genres, moods, year, lengths and covers from Hardcover for every book in
      your library. Books missing a series, moods or Hardcover link are the usual reason to run this — quick-added
      books predate the series-aware search.</p>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <label class="muted small"><input type="checkbox" id="refresh-only-missing" checked> Only books missing series, moods or Hardcover link</label>
        <button class="btn" id="book-refresh">Start re-pull</button>
      </div>
      <div id="refresh-status" class="muted small" style="margin-top:8px"></div>
    </div>` : ''}
    <div class="chips" id="m-chips"></div>`;

  bindSeg(view);
  bindTierPicker(view);
  const titleInput = $('#m-title');

  async function addOne() {
    const title = titleInput.value.trim();
    if (!title) return toast('Title is required');
    const year = +$('#m-year').value || null;
    const format = segVal('#m-format') || 'read';
    const rating = pickerVal('#m-rating') || null;
    const { book } = await api('/books', {
      method: 'POST',
      body: { title, author: $('#m-author').value.trim() || null, source_provider: 'manual' },
    });
    await api('/events', {
      method: 'POST',
      body: { book_id: book.id, format, status: 'finished', finished_year: year, rating },
    });
    session.push({ title, year, format, rating });
    $('#m-chips').innerHTML = session
      .map((s) => `<span class="chip">${s.format === 'listened' ? '🎧' : '📖'} ${esc(s.title)}${s.year ? ` · ${s.year}` : ''} ${s.rating ? tierBadge(s.rating) : ''}</span>`)
      .join('');
    titleInput.value = '';
    $('#m-author').value = '';
    titleInput.focus(); // tier intentionally stays selected for batch entry
  }

  const card = view.querySelector('.card');
  $('#m-add').addEventListener('click', guard(addOne));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); guard(addOne)(); }
  });

  $('#kobo-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) uploadFile(f, '/api/kobo/parse', koboImport, (data) => {
      koboHasCreds = !!data.device_link_available;
      renderKoboLink();
    });
  });

  $('#audible-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) uploadFile(f, '/api/audible/parse', audibleImport);
  });

  $('#goodreads-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) uploadFile(f, '/api/goodreads/parse', goodreadsImport);
  });

  // ---- linked Kobo device (device-link polling) ----
  // After an upload that carried device credentials, offer to keep the device
  // linked; when linked, show sync state and a manual "Sync now".
  let koboHasCreds = false;

  async function runKoboSyncJob() {
    const btn = $('#kobo-sync');
    const status = $('#kobo-sync-status');
    btn.disabled = true;
    try {
      const { id } = await api('/kobo/sync', { method: 'POST' });
      const r = await pollJob(id, {
        isStale: () => !status?.isConnected,
        onProgress: (j) => { status.textContent = `Syncing… ${j.progress_label || ''}`; },
      });
      if (!r) return;
      status.textContent = r.imported
        ? `Synced — ${r.imported} new or updated book${r.imported === 1 ? '' : 's'} (${r.changed} changed on the device).`
        : 'Up to date — nothing new on the device.';
      toast('Kobo sync complete');
    } catch (err) {
      if (status) status.textContent = '';
      toast('Sync failed: ' + err.message, 6000);
      renderKoboLink(); // re-renders with the stored last_error
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function renderKoboLink() {
    const box = $('#kobo-link');
    if (!box) return;
    let link = null;
    try { ({ link } = await api('/kobo/link')); } catch { /* stay blank */ }
    if (link) {
      box.innerHTML = `
        <div>🔗 Device linked${link.kobo_user_id ? ` · ${esc(link.kobo_user_id)}` : ''} ·
          ${link.last_synced_at ? `last synced ${esc(link.last_synced_at)}` : 'never synced'}</div>
        <div style="margin:6px 0;display:flex;gap:8px;align-items:center">
          <button class="btn ghost" id="kobo-sync" style="padding:2px 10px;font-size:12px">Sync now</button>
          <button class="btn ghost" id="kobo-unlink" style="padding:2px 10px;font-size:12px">Unlink</button>
        </div>
        ${link.last_error ? `<div class="muted small" style="color:#c0392b">Last sync failed: ${esc(link.last_error)}</div>` : ''}
        <div id="kobo-sync-status" class="muted small"></div>`;
      $('#kobo-sync').addEventListener('click', runKoboSyncJob);
      $('#kobo-unlink').addEventListener('click', guard(async () => {
        await api('/kobo/link', { method: 'DELETE' });
        toast('Device unlinked');
        koboHasCreds = false;
        renderKoboLink();
      }));
    } else if (koboHasCreds) {
      box.innerHTML = `
        <label class="muted small"><input type="checkbox" id="kobo-keep-linked">
        🔗 Keep this Kobo linked — reading progress syncs from Kobo's cloud automatically.
        This stores the device's sync key (opt-in; Unlink removes it).</label>`;
      $('#kobo-keep-linked').addEventListener('change', async (e) => {
        if (!e.target.checked) return;
        try {
          await api('/kobo/link', { method: 'POST' });
          toast('Device linked — it will sync automatically from now on');
          renderKoboLink();
        } catch (err) {
          toast(err.message);
          e.target.checked = false;
        }
      });
    } else {
      box.innerHTML = '';
    }
  }
  renderKoboLink();

  $('#abs-import')?.addEventListener('click', async () => {
    const btn = $('#abs-import');
    const status = $('#abs-status');
    btn.disabled = true;
    status.textContent = 'Starting…';
    try {
      const { id } = await api('/jobs', {
        method: 'POST',
        body: { kind: 'abs_import', payload: { rematch: $('#abs-rematch').checked } },
      });
      const r = await pollJob(id, {
        isStale: () => !status?.isConnected,
        onProgress: (j) => { status.textContent = `Working… ${j.progress_label || ''}`; },
      });
      if (!r) return;
      status.textContent = r.rematch
        ? `Re-matched ${r.rematched}/${r.candidates} — ${r.still_unmatched.length} still unmatched.`
        : `Imported ${r.imported} new books (${r.skipped} already present); ${r.hardcover_matched}/${r.imported} matched to Hardcover.`;
      toast('ABS import complete');
    } catch (err) {
      status.textContent = '';
      toast('ABS import failed: ' + err.message, 6000);
    } finally {
      btn.disabled = false;
    }
  });

  $('#book-refresh')?.addEventListener('click', async () => {
    const btn = $('#book-refresh');
    const status = $('#refresh-status');
    btn.disabled = true;
    status.textContent = 'Starting…';
    try {
      const { id } = await api('/jobs', {
        method: 'POST',
        body: { kind: 'book_refresh', payload: { only_missing: $('#refresh-only-missing').checked } },
      });
      const r = await pollJob(id, {
        isStale: () => !status?.isConnected,
        onProgress: (j) => { status.textContent = `Working… ${j.progress_label || ''}`; },
      });
      if (!r) return;
      status.textContent = `Matched ${r.matched}/${r.candidates} — ${r.updated} book${r.updated === 1 ? '' : 's'} updated.` +
        (r.unmatched.length ? ` No match: ${r.unmatched.slice(0, 5).map(esc).join(', ')}${r.unmatched.length > 5 ? '…' : ''}` : '');
      toast('Re-pull complete');
    } catch (err) {
      status.textContent = '';
      toast('Re-pull failed: ' + err.message, 6000);
    } finally {
      btn.disabled = false;
    }
  });
}

registerRoute('#memory', memoryView);
