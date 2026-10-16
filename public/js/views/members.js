import { api } from '../api.js';
import { $, esc, tierBadge, fmtWords, today, toast, guard, bindSeg, segVal, togetherRows, bindTogetherTbr, bindTableSort } from '../ui.js';
import { renderInfoBody } from '../book-info.js';
import { openModal, bookModal } from '../book-modal.js';
import { bindCheers, loadChatter } from '../chatter.js';
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

const feedRows = (rows, myId) => (rows.length ? rows.map((a) => `
  <div class="rowline" style="display:flex;gap:10px;align-items:center">
    <span style="flex:1">
      <strong>${esc(a.user_name)}</strong>
      <span class="muted small">${a.status === 'dnf' ? 'DNF’d' : 'finished'}</span>
      ${esc(a.title)} <span class="muted small">${esc(a.author || '')}</span>
      ${a.rating ? tierBadge(a.rating) : ''}
      <span class="muted small">${a.format === 'listened' ? '🎧' : '📖'}${a.status === 'dnf' ? ` · DNF @ ${esc(a.dnf_percent || '?')}%` : ''}${a.finished ? ` · ${esc(a.finished)}` : ' · date unknown'}</span>
      ${a.in_my_tbr ? '<span class="pill">📌 in your TBR</span>' : a.in_my_library ? '<span class="pill">on your shelf</span>' : ''}
    </span>
    <span style="display:flex;gap:6px;align-items:center">
      ${a.user_id === myId ? '' : `<button class="react-btn cheer-btn${a.cheered_by_me ? ' sel' : ''}" data-event="${a.event_id}" title="Cheer this">👏${a.cheers ? ' ' + a.cheers : ''}</button>`}
      ${a.in_my_library ? '' : `<button class="btn ghost together-tbr" data-title="${esc(a.title)}" data-author="${esc(a.author || '')}" data-hc="${a.hardcover_id || ''}" style="padding:2px 10px;font-size:12px">📌 TBR it too</button>`}
    </span>
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
    <p class="muted">Everyone reading by this hearth — browse their shelves, cheer a finish, see
    who's mid-chapter. Next to each name sits a star: <strong>☆</strong> means they're not in your
    circle yet, <strong>⭐</strong> means they're in. Star your people and their current reads show up
    under "Reading together" here and on your dashboard; tap ⭐ again to quietly take them back out.
    Profiles are browsable; private by default means nobody outside this instance sees anything.</p>
    <div class="card" style="margin-bottom:14px">
      <div class="k">Search the shelves <span class="muted small">— who has it, and how they rated it</span></div>
      ${shelfSearchHTML()}
    </div>
    ${leaders.length ? `
    <div class="card" style="margin-bottom:14px">
      <div class="k">Who rates how <span class="muted small">— average across all rated books, D=1 … S=5</span></div>
      <div style="display:flex;gap:6px 18px;flex-wrap:wrap;padding-top:4px">
        ${leaders.map((m) => `<span style="display:inline-flex;align-items:center;gap:2px"><a href="#members/${m.id}" style="color:inherit;text-decoration:none"><strong>${esc(m.name)}</strong></a>${m.id === myId ? '' : `<button class="circle-star${inCircle.has(m.id) ? ' sel' : ''}" data-id="${m.id}"
          title="${inCircle.has(m.id) ? 'In your circle — click to remove' : 'Add to your circle'}">${inCircle.has(m.id) ? '⭐' : '☆'}</button>`} <strong>${m.avg.tier}</strong> <span class="muted small">(${m.avg.score})</span></span>`).join('')}
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
      <div id="feed-list">${feedRows(activity, myId)}</div>
    </div>`;

  bindShelfSearch(view, {
    // An owner chip opens THAT member's copy of THAT book — the preview
    // modal with notes and chatter — instead of hopping to their profile.
    onOpenBook: (d) => {
      // dataset values are strings — '0' is truthy, so compare explicitly.
      if (d.self === '1') { bookModal(+d.book); return; }
      openMemberBookModal(
        { id: +d.member, name: d.name },
        {
          book_id: +d.book, title: d.title, author: d.author || null,
          series_name: d.series || null, cover_url: d.cover || null,
          rating: d.rating || null, format: d.format || null, last_finished: d.finished || null,
        });
    },
  });

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
      box.innerHTML = feedRows(data.activity, myId);
      bindTogetherTbr(box);
      bindCheers(box);
    } catch (err) {
      box.innerHTML = `<div class="muted small">${esc(err.message)}</div>`;
    }
  };
  $('#feed-scope').addEventListener('change', () => loadFeed(segVal('#feed-scope') || 'all'));
  bindTogetherTbr($('#together-panel'));
  bindCheers($('#together-panel'));
  bindTogetherTbr($('#feed-list'));
  bindCheers($('#feed-list'));
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
      ${is_self ? '' : `<a href="#members/${member.id}/tbr">Their TBR 👍</a>`}
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
      ${series.map((s) => `<a class="pill" href="#search/series/${encodeURIComponent(s.series)}" style="margin:0 6px 6px 0">${esc(s.series)} · ${s.books} · ${tierBadge(s.avg_tier)}</a>`).join('')}
    </div>` : ''}
    <div class="card" style="margin-top:14px">
      <div class="k">Books <span class="muted small">(${books.length} — newest first; click a header to sort)${is_self ? '' : ' — add any of them to your own pile'}</span></div>
      ${books.length ? `
      <table class="lib-table static profile-shelf">
        <thead><tr><th><span data-sort-label="title">Book</span> <span class="sort-alt" data-sort-alt="author" title="Sort by author">Author</span></th><th>Series</th><th>Tier</th><th>Format</th><th>Finished</th>${is_self ? '' : '<th></th>'}</tr></thead>
        <tbody>${books.map((b, i) => `
          <tr data-book="${i}" title="View book details">
            <td data-v="${esc((b.title || '').toLowerCase())}"><div class="t">${esc(b.title)}</div><div class="muted small">${b.author ? `<a class="text-link" href="#search/author/${encodeURIComponent(b.author)}">${esc(b.author)}</a>` : ''}</div></td>
            <td class="muted" data-v="${esc((b.series_name || '').toLowerCase())}">${b.series_name ? `<a class="text-link" href="#search/series/${encodeURIComponent(b.series_name)}">${esc(b.series_name)}</a>` : ''}</td>
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
      openMemberBookModal(member, b);
    });
  }
}

// A member's copy of a book, as a modal: shelf line, catalog details, their
// shared notes, and the work's chatter thread — the same conversation you'd
// get from your own copy, gated on YOUR progress, not theirs. Shared by the
// profile shelf rows and the shelf-search owner chips.
export function openMemberBookModal(member, b) {
  openModal(`
    <div class="modal-head">
      ${b.cover_url ? `<img class="cover-m" src="${esc(b.cover_url)}">` : '<div class="cover-m blank"></div>'}
      <div>
        <h2>${esc(b.title)}</h2>
        <div class="muted">${b.author ? `<a class="text-link" href="#search/author/${encodeURIComponent(b.author)}">${esc(b.author)}</a>` : 'Unknown author'}</div>
        ${b.series_name ? `<div class="muted small"><a class="text-link" href="#search/series/${encodeURIComponent(b.series_name)}">${esc(b.series_name)}</a></div>` : ''}
        ${b.queued
          ? `<div class="muted small">Queued in <a class="text-link" href="#members/${member.id}">${esc(member.name)}</a>'s TBR${b.is_next_up ? ' — ⭐ next up' : ''}</div>`
          : `<div class="muted small">On <a class="text-link" href="#members/${member.id}">${esc(member.name)}</a>'s shelf:
          ${b.rating ? `tier ${b.rating}` : 'unrated'} · ${b.format === 'listened' ? '🎧 listened' : '📖 read'}${b.last_finished ? ` · ${esc(b.last_finished)}` : ''}</div>`}
      </div>
    </div>
    <div id="prof-actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center"></div>
    <div id="prof-info"><div class="muted small">Loading details…</div></div>
    <div class="card chat-card" id="prof-chatter" style="margin-top:10px"><div class="k">Chatter</div><div class="muted small">Loading…</div></div>`);
  api(`/members/${member.id}/books/${b.book_id}/info`)
    .then((info) => {
      renderInfoBody($('#prof-info'), info);
      // Add-to-library actions, only when this work isn't on the viewer's
      // own shelf — the profile shelf's copy-fields convention, same draft
      // (their copy's data, Hardcover anchor when one exists).
      const actRow = $('#prof-actions');
      if (info.in_my_library) {
        actRow.innerHTML = '<span class="pill">on your shelf</span>';
      } else {
        actRow.innerHTML = `
          <button class="btn ghost" id="pm-add-lib" style="padding:4px 12px;font-size:13px">＋ Add to library</button>
          <button class="btn ghost" id="pm-add-tbr" style="padding:4px 12px;font-size:13px">📌 Add to TBR</button>`;
        const draft = () => ({
          title: b.title, author: b.author || null, series_name: b.series_name || null,
          cover_url: b.cover_url || null, page_count: info.page_count || null,
          audio_runtime_minutes: info.audio_runtime_minutes || null,
          ...(info.hardcover_id ? { source_provider: 'hardcover', source_id: String(info.hardcover_id) } : {}),
        });
        const add = async (btn, mode) => {
          btn.disabled = true;
          btn.textContent = 'Adding…';
          try {
            const { book, existed } = await api('/books', { method: 'POST', body: draft() });
            if (mode === 'tbr') {
              const r = await api('/tbr', { method: 'POST', body: { book_id: book.id } });
              toast(existed && r.existed ? `"${b.title}" is already queued on your TBR`
                : r.existed ? `"${b.title}" is on your shelf — queued on your TBR`
                : `"${b.title}" added to your TBR`);
            } else {
              toast(existed ? `"${b.title}" is already in your library` : `"${b.title}" added to your library`);
            }
            actRow.innerHTML = '<span class="pill">on your shelf</span>';
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
            btn.textContent = mode === 'tbr' ? '📌 Add to TBR' : '＋ Add to library';
          }
        };
        $('#pm-add-lib').addEventListener('click', (e) => add(e.currentTarget, 'lib'));
        $('#pm-add-tbr').addEventListener('click', (e) => add(e.currentTarget, 'tbr'));
      }
      // Shared notes (public by default, 🔒 per note): the review text
      // rides the same consent gate as the rest of the preview.
      if (Array.isArray(info.notes) && info.notes.length) {
        const notesEl = document.createElement('div');
        notesEl.style.marginTop = '10px';
        notesEl.innerHTML = `<div class="muted small" style="margin-bottom:4px">${esc(member.name)}'s notes</div>`
          + info.notes.map((n) => `<div style="margin-bottom:8px">
              ${n.rating ? tierBadge(n.rating) + ' ' : ''}<span class="muted small">${esc(n.finished_at || (n.finished_year ? String(n.finished_year) : ''))}</span>
              <div class="small">${esc(n.notes)}</div>
            </div>`).join('');
        $('#prof-info').after(notesEl);
      }
    })
    .catch((err) => { $('#prof-info').innerHTML = `<div class="muted small">Could not load: ${esc(err.message)}</div>`; });
  // The work's thread, anchored on THEIR copy — workFromParams resolves the
  // work cross-member and the gating uses the viewer's own progress.
  loadChatter($('#prof-chatter'), { bookId: b.book_id });
}

// A member's TBR, seen from outside: every queued book with a 👍 beside it —
// bump one to root for it. One bump per book (click again to take it back);
// the owner sees the counts on their own queue and hears the bell once.
async function memberTbrView(id) {
  let p;
  try {
    p = await api('/members/' + id + '/tbr');
  } catch (err) {
    view.innerHTML = `
      <h1>TBR</h1>
      <div class="card"><p class="muted" style="margin:0 0 12px">${esc(err.message)}</p>
      <a href="#members">← All members</a></div>`;
    return;
  }
  const { member, is_self, entries } = p;
  // The household's votes lead: most bumped first, then the owner's ⭐ pick,
  // then newest queued — the same order their own queue keeps past that.
  const shown = [...entries].sort((a, b) =>
    (b.bumps - a.bumps) || (b.is_next_up - a.is_next_up)
    || String(b.added_at || '').localeCompare(String(a.added_at || '')));
  const bumpersText = (e) =>
    [e.bumped_by_me ? 'you' : null, ...(e.bumpers || [])].filter(Boolean).join(', ');
  view.innerHTML = `
    <h1 style="display:flex;align-items:center;gap:12px">${member.has_avatar ? `<img class="avatar avatar-m" src="/api/avatar/${member.id}" alt="">` : ''}<span>${esc(member.name)}'s TBR</span></h1>
    <div class="toolbar"><a href="#members/${member.id}">← ${esc(member.name)}'s shelf</a></div>
    <p class="muted">Books ${esc(member.name)} means to get to. A 👍 bumps one up the pile —
    they'll see the count on their queue and get a nudge in their bell. One bump per book;
    click again to quietly take it back.</p>
    <div id="member-tbr">
    ${shown.length ? `
    <table class="lib-table"><thead><tr><th></th><th>Book</th><th>Queued</th><th>👍</th></tr></thead><tbody>
      ${shown.map((e) => `
      <tr data-book="${e.book_id}">
        <td>${e.cover_url ? `<img class="cover-s" src="${esc(e.cover_url)}" loading="lazy">` : '<div class="cover-s blank"></div>'}</td>
        <td><div class="t">${esc(e.title)}</div><div class="muted small">${e.author ? `<a class="text-link" href="#search/author/${encodeURIComponent(e.author)}">${esc(e.author)}</a>` : ''}${e.series_name ? ` · <a class="text-link" href="#search/series/${encodeURIComponent(e.series_name)}">${esc(e.series_name)}</a>${e.series_order != null ? ' #' + e.series_order : ''}` : ''}${e.is_next_up ? ' · <strong>⭐ next up</strong>' : ''}</div></td>
        <td class="muted small">${esc((e.added_at || '').slice(0, 10))}</td>
        <td>${is_self
          ? (e.bumps ? `<span class="pill" title="Bumped by ${esc(bumpersText(e))}">👍 ${e.bumps}</span>` : '')
          : `<button class="react-btn bump-btn${e.bumped_by_me ? ' sel' : ''}" data-id="${e.book_id}"
              title="${e.bumps ? `Bumped by ${esc(bumpersText(e))} — click to take it back` : 'Bump this up their pile'}">👍${e.bumps ? ' ' + e.bumps : ''}</button>`}</td>
      </tr>`).join('')}
    </tbody></table>` : `<div class="empty">Nothing in the queue — books land here when ${esc(member.name)} marks one TBR.</div>`}
    </div>`;

  // Toggle in place: the count and state flip without a re-render, so the
  // list never jumps under the click. Order stays as loaded — reshuffling
  // mid-click would pull the rug.
  if (!is_self) {
    for (const btn of view.querySelectorAll('.bump-btn')) {
      btn.addEventListener('click', guard(async () => {
        btn.disabled = true;
        try {
          const r = await api(`/members/${member.id}/tbr/bump`, { method: 'POST', body: { book_id: +btn.dataset.id } });
          btn.classList.toggle('sel', r.bumped);
          btn.textContent = '👍' + (r.bumps ? ' ' + r.bumps : '');
        } catch (err) { toast(err.message); }
        btn.disabled = false;
      }));
    }
  }

  // Row click opens their copy as a preview (description lazy-loads, chatter
  // gated on your own progress) — same as the shelf rows on their profile.
  for (const tr of view.querySelectorAll('tr[data-book]')) {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      const b = entries.find((x) => x.book_id === +tr.dataset.book);
      if (b) openMemberBookModal(member, { ...b, queued: true });
    });
  }
}

function membersRoute() {
  const parts = location.hash.split('/');
  if (parts[1] && parts[2] === 'tbr') return memberTbrView(+parts[1]);
  return parts[1] ? memberProfile(+parts[1]) : membersView();
}

registerRoute('#members/', membersRoute);
registerRoute('#members', membersRoute);
