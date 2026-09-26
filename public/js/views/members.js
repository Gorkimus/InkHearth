import { api } from '../api.js';
import { $, esc, tierBadge, fmtWords, today, toast, bindSeg, segVal, togetherRows, bindTogetherTbr, bindTableSort } from '../ui.js';
import { renderInfoBody } from '../book-info.js';
import { openModal, bookModal } from '../book-modal.js';
import { shelfSearchHTML, bindShelfSearch } from '../shelf-search.js';
import { view, registerRoute } from '../router.js';
import { chemistryRing } from '../../charts.js';

// Members (friend & family): the household directory, a recent-activity feed,
// and browsable profiles. Profiles are public by default (users.profile_public)
// and read-only — you're looking at someone else's shelf. Social layer: a
// viewer-private friends circle (☆) drives the "Reading together" panel and a
// circle-scoped feed filter; every feed row knows whether the book is already
// on your shelf or queued, and offers a one-tap "TBR it too".

const memberCard = (m, isSelf, starred) => `
  <div class="rec-card">
    <div class="t" style="display:flex;align-items:center;gap:8px">
      ${m.has_avatar ? `<img class="avatar avatar-s" src="/api/avatar/${m.id}" alt="">` : ''}
      <a href="#members/${m.id}" style="color:inherit;text-decoration:none">${esc(m.name)}</a>${m.is_admin ? ' <span class="pill">admin</span>' : ''}
      ${!isSelf ? `<button class="circle-star${starred ? ' sel' : ''}" data-id="${m.id}"
        title="${starred ? 'In your circle — click to remove' : 'Add to your circle'}">${starred ? '⭐' : '☆'}</button>` : ''}
    </div>
    <div class="muted small">${m.books} book${m.books === 1 ? '' : 's'} · ${m.finished} finished</div>
    ${m.avg ? `<div class="muted small">avg rating <strong>${m.avg.tier} (${m.avg.score})</strong> · ${m.avg.rated} rated</div>` : ''}
    <div class="muted small">${m.last_finished ? `last finished ${esc(m.last_finished)}` : 'nothing logged yet'}</div>
    ${m.match ? `<div class="muted small">🎯 <strong>${m.match.pct}% chemistry</strong> · ${m.match.shared_rated} rated in common</div>` : ''}
    <div style="display:flex;gap:8px">
      <a class="btn ghost" href="#members/${m.id}" style="padding:4px 12px;font-size:13px">Profile</a>
      <a class="btn ghost" href="#compare/${m.id}" style="padding:4px 12px;font-size:13px">Compare</a>
    </div>
  </div>`;

const feedRows = (rows) => (rows.length ? rows.map((a) => `
  <div class="rowline" style="display:flex;gap:10px;align-items:center">
    <span style="flex:1">
      <strong>${esc(a.user_name)}</strong>
      <span class="muted small">${a.status === 'dnf' ? 'DNF’d' : 'finished'}</span>
      ${esc(a.title)} <span class="muted small">${esc(a.author || '')}</span>
      ${a.rating ? tierBadge(a.rating) : ''}
      <span class="muted small">${a.format === 'listened' ? '🎧' : '📖'}${a.status === 'dnf' ? ` · DNF @ ${esc(a.dnf_percent || '?')}%` : ''}${a.finished ? ` · ${esc(a.finished)}` : ' · date unknown'}</span>
      ${a.in_my_tbr ? '<span class="pill">📌 in your TBR</span>' : a.in_my_library ? '<span class="pill">on your shelf</span>' : ''}
    </span>
    ${a.in_my_library ? '' : `<button class="btn ghost together-tbr" data-title="${esc(a.title)}" data-author="${esc(a.author || '')}" data-hc="${a.hardcover_id || ''}" style="padding:2px 10px;font-size:12px">📌 TBR it too</button>`}
  </div>`).join('') : '<div class="muted small">Nothing logged yet.</div>');

async function membersView() {
  const [{ members }, { activity }, { ids: circle }, { readers }, me] = await Promise.all([
    api('/members'), api('/members/activity'), api('/circle'), api('/members/reading-now'), api('/auth/me'),
  ]);
  const myId = me.user?.id;
  const inCircle = new Set(circle);
  const sorted = [...members].sort((a, b) =>
    (inCircle.has(b.id) - inCircle.has(a.id)) || a.name.localeCompare(b.name));
  // Who rates high vs low: average tier weighted D=1 … S=5, leaders first.
  const leaders = members.filter((m) => m.avg).sort((a, b) => b.avg.score - a.avg.score);

  view.innerHTML = `
    <h1>Members</h1>
    <p class="muted">Everyone reading under this roof. Star your people — their current reads show up
    under "Reading together" here and on your dashboard. Profiles are browsable; private by default
    means nobody outside this instance sees anything.</p>
    <div class="card" style="margin-bottom:14px">
      <div class="k">Search the shelves <span class="muted small">— who has it, and how they rated it</span></div>
      ${shelfSearchHTML()}
    </div>
    ${leaders.length ? `
    <div class="card" style="margin-bottom:14px">
      <div class="k">Who rates how <span class="muted small">— average across all rated books, D=1 … S=5</span></div>
      <div style="display:flex;gap:6px 18px;flex-wrap:wrap;padding-top:4px">
        ${leaders.map((m) => `<span><strong>${esc(m.name)}</strong> <strong>${m.avg.tier}</strong> <span class="muted small">(${m.avg.score})</span></span>`).join('')}
      </div>
    </div>` : ''}
    <div class="card" style="margin-bottom:14px">
      <div class="k">Reading together</div>
      <div id="together-panel">${togetherRows(readers,
        '<div class="muted small">Star friends with ☆ below and the books they\u2019re mid-way through appear here.</div>')}</div>
    </div>
    <div class="rec-grid" id="member-grid">
      ${sorted.map((m) => memberCard(m, m.id === myId, inCircle.has(m.id))).join('')}
    </div>
    <div class="card" style="margin-top:6px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div class="k">Recent activity</div>
        <div class="seg" id="feed-scope">
          <button type="button" data-val="all" class="sel" aria-pressed="true">Everyone</button>
          <button type="button" data-val="circle" aria-pressed="false">My circle</button>
        </div>
      </div>
      <div id="feed-list">${feedRows(activity)}</div>
    </div>`;

  bindShelfSearch(view);

  // Circle stars: toggle membership and re-render — the panel, the feed
  // filter and the card order all follow the saved circle. The re-render is
  // awaited inside the try so a failed refresh surfaces as a toast instead
  // of silently leaving the page stale.
  view.querySelectorAll('.circle-star').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = +btn.dataset.id;
      const wasIn = inCircle.has(id);
      btn.disabled = true;
      try {
        await api('/circle', { method: 'PUT', body: { ids: wasIn ? circle.filter((x) => x !== id) : [...circle, id] } });
        toast(wasIn ? 'Removed from your circle' : 'Added to your circle');
        await membersView();
      } catch (err) { toast(err.message); }
    }));

  // bindSeg must see the .seg element: pass the view (it binds every .seg
  // inside), not the seg itself — a seg binds nothing when passed itself.
  bindSeg(view);
  const loadFeed = async (scope) => {
    const box = $('#feed-list');
    if (scope === 'circle' && !circle.length) {
      box.innerHTML = '<div class="muted small">Your circle is empty — star friends above to scope the feed to them.</div>';
      return;
    }
    box.innerHTML = '<div class="muted small">Loading…</div>';
    try {
      const data = await api('/members/activity' + (scope === 'circle' ? '?circle=1' : ''));
      box.innerHTML = feedRows(data.activity);
      bindTogetherTbr(box);
    } catch (err) {
      box.innerHTML = `<div class="muted small">${esc(err.message)}</div>`;
    }
  };
  $('#feed-scope').addEventListener('change', () => loadFeed(segVal('#feed-scope') || 'all'));
  bindTogetherTbr($('#together-panel'));
  bindTogetherTbr($('#feed-list'));
}

async function memberProfile(id) {
  let p;
  try {
    p = await api('/members/' + id);
  } catch (err) {
    view.innerHTML = `
      <h1>Profile</h1>
      <div class="card"><p class="muted" style="margin:0 0 12px">${esc(err.message)}</p>
      <a href="#members">← All members</a></div>`;
    return;
  }
  const { member, match, is_self, stats, series, books } = p;
  const t = stats;
  view.innerHTML = `
    <h1 style="display:flex;align-items:center;gap:12px">${member.has_avatar ? `<img class="avatar avatar-m" src="/api/avatar/${member.id}" alt="">` : ''}<span>${esc(member.name)}'s shelf</span></h1>
    <div class="toolbar">
      <a href="#members">← All members</a>
      <a href="#compare/${member.id}">Compare with mine</a>
    </div>
    ${match ? `<div class="card" style="margin-top:6px">
      <div class="k">Reading Chemistry</div>
      <div class="chem-row">
        ${chemistryRing(match.pct, { size: 76, stroke: 8 })}
        <div class="muted small">${match.shared_rated} book${match.shared_rated === 1 ? '' : 's'} rated in common${match.shared_total > match.shared_rated ? ` · ${match.shared_total} shared overall` : ''}</div>
      </div></div>` : ''}
    <div class="headline-cards">
      ${member.avg ? `<div class="card"><div class="k">Avg rating</div><div class="v">${member.avg.tier} <span class="muted small" style="font-size:14px">(${member.avg.score})</span></div><div class="sub">${member.avg.rated} rated</div></div>` : ''}
      <div class="card big"><div class="k">Books finished</div><div class="v">${t.books_read}</div></div>
      <div class="card big"><div class="k">Words read</div><div class="v">${fmtWords(t.words)}</div><div class="sub">≈ estimates</div></div>
      <div class="card"><div class="k">Pages</div><div class="v">${t.pages.toLocaleString()}</div></div>
      <div class="card"><div class="k">Hours listened</div><div class="v">${t.hours.toLocaleString()}</div></div>
    </div>
    ${series.length ? `
    <div class="card" style="margin-top:14px"><div class="k">Series <span class="muted small">(books · avg tier)</span></div>
      ${series.map((s) => `<a class="pill" href="#add/series/${encodeURIComponent(s.series)}" style="margin:0 6px 6px 0">${esc(s.series)} · ${s.books} · ${tierBadge(s.avg_tier)}</a>`).join('')}
    </div>` : ''}
    <div class="card" style="margin-top:14px">
      <div class="k">Books <span class="muted small">(${books.length} — newest first; click a header to sort)${is_self ? '' : ' — add any of them to your own pile'}</span></div>
      ${books.length ? `
      <table class="lib-table static">
        <thead><tr><th><span data-sort-label="title">Book</span> <span class="sort-alt" data-sort-alt="author" title="Sort by author">Author</span></th><th>Series</th><th>Tier</th><th>Format</th><th>Finished</th>${is_self ? '' : '<th></th>'}</tr></thead>
        <tbody>${books.map((b, i) => `
          <tr data-book="${i}" title="View book details">
            <td data-v="${esc((b.title || '').toLowerCase())}"><div class="t">${esc(b.title)}</div><div class="muted small">${b.author ? `<a class="text-link" href="#add/author/${encodeURIComponent(b.author)}">${esc(b.author)}</a>` : ''}</div></td>
            <td class="muted" data-v="${esc((b.series_name || '').toLowerCase())}">${b.series_name ? `<a class="text-link" href="#add/series/${encodeURIComponent(b.series_name)}">${esc(b.series_name)}</a>` : ''}</td>
            <td data-v="${{ S: 5, A: 4, B: 3, C: 2, D: 1 }[b.rating] ?? 0}">${b.rating ? tierBadge(b.rating) : '<span class="muted">—</span>'}</td>
            <td data-v="${b.format === 'listened' ? 'listened' : 'read'}">${b.format === 'listened' ? '🎧' : '📖'}</td>
            <td class="muted small" data-v="${esc(b.last_finished || '')}">${esc(b.last_finished || '')}</td>
            ${is_self ? '' : b.read_by_me
              ? '<td class="muted small">✓ in your library</td>'
              : b.in_my_library
                ? `<td style="white-space:nowrap" class="prof-actions">
                    <button class="btn ghost prof-read" data-i="${i}" style="padding:4px 10px;font-size:12px">✅ Read</button>
                  </td>`
                : `<td style="white-space:nowrap" class="prof-actions">
                    <button class="btn ghost prof-tbr" data-i="${i}" style="padding:4px 10px;font-size:12px">📌 TBR</button>
                    <button class="btn ghost prof-read" data-i="${i}" style="padding:4px 10px;font-size:12px">✅ Read</button>
                  </td>`}
          </tr>`).join('')}</tbody>
      </table>` : '<div class="muted small">Nothing logged yet.</div>'}
    </div>`;

  // Column sorting on the shelf (Book / Series / Tier / Format / Finished) —
  // DOM-side via the shared helper; cells carry data-v for computed values.
  const shelfTable = view.querySelector('table.lib-table');
  if (shelfTable) {
    bindTableSort(shelfTable, [
      // Arrow goes inside the Book label span, so it never lands after the
      // Author toggle sharing this header.
      { th: 0, ind: '[data-sort-label="title"]' },
      // Author lives inside the Book cell (title + author stacked) — the
      // alt trigger sorts by the author line without changing the layout.
      { th: 0, trigger: '[data-sort-alt="author"]', get: (cell) => cell.querySelector('.muted')?.textContent || '' },
      { th: 1 },
      { th: 2, dir: 'desc' },
      { th: 3 },
      { th: 4, dir: 'desc', initial: true },
    ]);
  }

  // Copy one of their books into my library: create my own deduped row
  // (hardcover anchor when the profile row carries one, else title+author),
  // then queue it as TBR or log a finished read — the same quick-status the
  // book modal uses. The actions cell flips to an "added" note either way.
  const addTheirBook = async (b, mode, cell) => {
    const draft = {
      title: b.title, author: b.author, series_name: b.series_name,
      page_count: b.page_count, audio_runtime_minutes: b.audio_runtime_minutes,
      cover_url: b.cover_url || null,
    };
    if (b.hardcover_id) { draft.source_provider = 'hardcover'; draft.source_id = String(b.hardcover_id); }
    const { book } = await api('/books', { method: 'POST', body: draft });
    if (mode === 'tbr') {
      const r = await api('/tbr', { method: 'POST', body: { book_id: book.id } });
      toast(r.existed ? `"${b.title}" is already in your TBR` : `"${b.title}" added to your TBR`);
    } else {
      const det = await api('/books/' + book.id);
      if (det.events.some((e) => e.status === 'finished')) {
        toast(`"${b.title}" is already in your library as read`);
      } else {
        await api(`/books/${book.id}/quick-status`, { method: 'POST', body: { status: 'read', finished_at: today() } });
        toast(`"${b.title}" logged as read — details any time`);
      }
    }
    cell.innerHTML = '<span class="muted small">✓ in your library</span>';
  };
  if (!is_self) {
    for (const btn of view.querySelectorAll('.prof-tbr, .prof-read')) {
      btn.addEventListener('click', async (e) => {
        const cell = e.target.closest('.prof-actions');
        const book = books[+btn.dataset.i];
        btn.disabled = true;
        try {
          await addTheirBook(book, btn.classList.contains('prof-tbr') ? 'tbr' : 'read', cell);
        } catch (err) {
          btn.disabled = false;
          toast(err.message);
        }
      });
    }
  }

  // Book details on click: your own shelf opens the full book modal; someone
  // else's opens a read-only preview whose Hardcover description/genres lazy-
  // load from /members/:id/books/:bookId/info — one paced call per click,
  // never for the shelf as a whole.
  for (const tr of view.querySelectorAll('tr[data-book]')) {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const b = books[+tr.dataset.book];
      if (is_self) {
        bookModal(b.book_id);
        return;
      }
      openModal(`
        <div class="modal-head">
          ${b.cover_url ? `<img class="cover-m" src="${esc(b.cover_url)}">` : '<div class="cover-m blank"></div>'}
          <div>
            <h2>${esc(b.title)}</h2>
            <div class="muted">${esc(b.author || 'Unknown author')}</div>
            ${b.series_name ? `<div class="muted small">${esc(b.series_name)}</div>` : ''}
            <div class="muted small">On ${esc(member.name)}'s shelf:
              ${b.rating ? `tier ${b.rating}` : 'unrated'} · ${b.format === 'listened' ? '🎧 listened' : '📖 read'}${b.last_finished ? ` · ${esc(b.last_finished)}` : ''}</div>
          </div>
        </div>
        <div id="prof-info"><div class="muted small">Loading details…</div></div>`);
      api(`/members/${member.id}/books/${b.book_id}/info`)
        .then((info) => renderInfoBody($('#prof-info'), info))
        .catch((err) => { $('#prof-info').innerHTML = `<div class="muted small">Could not load: ${esc(err.message)}</div>`; });
    });
  }
}

function membersRoute() {
  const id = location.hash.split('/')[1];
  return id ? memberProfile(+id) : membersView();
}

registerRoute('#members/', membersRoute);
registerRoute('#members', membersRoute);
