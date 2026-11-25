# Book Tracker — Product Plan

A self-hosted, local-first web app that logs every book read or listened to, and turns that
log into statistics, tier lists, a TBR queue, and taste-based recommendations.
Multi-user since Sept 2026: invite-only accounts, per-user libraries, and
consent-based cross-account comparison — with a private social layer (friends
circles, reading-together, taste matches) scoped to each instance.

## Why build this

1. **Combined read + listen analytics** — one "words read" number across formats.
2. **Tier lists** per book *and* per series, to make taste visible.
3. Ingestion from **actual infrastructure** (Audiobookshelf, Kobo device) instead of manual journaling.
4. Full data ownership: local SQLite, Docker + own tunnel, no platform lock-in.

## Data model

Two layers, kept separate:

- **Objective metadata** — never typed by hand; autofilled from public sources:
  title, author, narrator, series + series order, page count, genres, audio
  runtime (Hardcover `audio_seconds` when a token is set), publication year.
- **Personal layer** — per-user entries:
  - **Consumption events** (a book is a thing; finishing it is an event):
    format (read / listened), start & finish dates (optional for past books),
    status (finished / DNF at ~% / reading), medium.
  - **Rating**: S / A / B / C / D, plus optional separate **narration rating** for audiobooks.
  - **Notes** (on events — imported reviews, thoughts): public to the household
    by default (migration 52 made every existing note retroactively shared);
    a 🌐/🔒 toggle opts individual notes private.
  - **TBR entries**: staging area feeding the log (queued → started → done).
- Every table carries `user_id`; `currentUserId()` in `server/db.js` is the single
  swap point for auth.

### Word counts & the headline number

- **Listened books count as read.** The dashboard amalgamates both formats into one
  set of totals; the read/listened split is a secondary view.
- Word counts are always estimates (no public book API exposes them — verified):
  pages × 275, audio runtime × 155 wpm (~9,300 words/hour), flagged `≈` in the UI.
- **Listening time derives from runtime, not ABS play-time** (play history
  isn't portable between listening platforms).
- DNF counts proportionally: abandoned at 40% → 40% of the words.

## Data sources

| Source | Provides | When |
|---|---|---|
| Hardcover API (GraphQL, free) | canonical titles, authors, series + position, genres, years, pages; verifies AI recs exist | save-time enrichment, imports, V4 recs |
| Google Books + Open Library (keyless) | discovery autofill | MVP (done) |
| Audiobookshelf REST API | inventory, real runtimes, narrators, covers | import (done, script) |
| Kobo device DB (KoboReader.sqlite upload) | books on device, read %, last-read dates, ISBNs | import (done) |
| Audible library export (file upload — produced by helper apps: Libation, OpenAudible, Audible Library Extractor, audible-cli, Amazon "Request My Data") | owned books, listen progress %, last-listened dates, runtimes | import (done, untested against real files) |
| StoryGraph library export (My Books → Manage → Export Your Library, CSV) | whole library: read statuses incl. DNF/paused, per-edition rows, quarter-star ratings, HTML reviews → event notes, tags, narrators | import (done) |
| LLM (OpenAI-compatible) | recommendation candidates + taste reasoning | done (Phase 4) |

## Features — shipped

- Quick add (search → autofill → format → tier), Memory lane (title + year + tier).
- **Kobo import**: upload KoboReader.sqlite; ISBN-based Hardcover matching; review list
  with suggested finished / reading / book-only from device progress.
- **Audible import**: upload a helper-app library export (CSV/JSON); same review list
  and jobs-based import as Kobo, ASIN + progress suggestions, runtimes captured for the
  word math. No Amazon credentials, ever.
- ABS library import script (idempotent; locally-stored covers; `REMATCH=1` re-match).
- Dashboard: books read + words read (amalgamated), pages, hours, words/month,
  format split, genres, author leaderboard; length-missing flagging.
- Library: persistent filters (search, To be rated / 📌 TBR / tier / format), book modal
  (edit, log re-reads, narration rating, TBR toggle), 📌 badges.
- TBR queue page with ⭐ next-up; logging an event auto-advances entries.
- Medium implies format (audiobook → Listened; physical/ebook → Read); live list updates on TBR changes.
- Docker + compose; delta-based smoke test safe against live data.

## Roadmap (decided Sept 2026)

### Phase 6 — Immersion (DONE Sept 2026)
The habit + delight layer on top of the logged history:
- **Mobile nav fix** — the nav strip is its own touch scroller (two-row
  header, hidden scrollbar, active link auto-centered); the page body never
  slides sideways to reach a link. Wide tables keep native behavior by choice.
- **Now-reading hero** — the in-progress book front and center on the
  dashboard: cover, progress bar, estimated hours/pages left, one-tap
  +10% / Finish / DNF / Pause. `events.percent` (migration 16) +
  `POST /events/:id/progress`; finishing goes through quick-status.
- **Goals & momentum** — yearly targets (books/words/hours in `prefs.goals`)
  as SVG progress rings, plus "this month vs your 3-month pace".
- **Series journey** — "4 of 6 · next: Dark Age" cards from owned books +
  Hardcover rosters (exact-name series query; translations deduped per
  position preferring the primary edition). Global 7-day roster cache
  (`series_cache`, migration 17), 8s fetch budget, stale-on-error — the
  dashboard never blocks on HC. One-tap TBR for the next installment,
  deduped on the hardcover anchor.
- **Activity heatmap + Wrapped story mode** — GitHub-style day calendar
  (trailing 365 in /stats, per-year in /stats/year) and `#review/<year>/story`:
  full-screen slide deck (headline → pace → rhythm → top-5 → tiers → narrator
  → closing) with swipe/keys/dots and a text-only canvas PNG export.
- **Metadata re-pull** — per-book "↻ Re-pull data" in the book modal plus an
  admin bulk `book_refresh` job: series/genres/year overwritten from
  Hardcover, lengths/cover filled if empty, title/author/tags never touched;
  quick-add search now carries series so future books don't ship without it.

### Moods + taste match (DONE Sept 8, 2026)
From a Hardcover/StoryGraph survey (moods, owned flag, match %, content
warnings, buddy reads, challenges, journal were the candidates; **owned flag
and content warnings deliberately declined**):
- **Moods** — StoryGraph's core "what am I in the mood for" idea, fed by
  Hardcover: `cached_tags.Mood` arrives in every HC response already; new
  `moodsFrom()` (top 3 by crowd count, twins `genresFrom`) + `books.moods`
  (migration 18, same JSON-array convention as genres). Wired through all
  write paths (search passthrough, re-pull overwrite, ABS/library imports,
  POST/PUT, TBR join). Surfaces: library mood filter, TBR mood pills,
  "In the mood for…" chips + 🎲 Surprise-me over the queue, book-modal edit
  field. Bulk re-pull counts empty moods as "missing" → one run backfills.
- **Taste match %** — Hardcover's supporter feature, household-scoped:
  `sharedBooks()`/`matchSummary()` extracted from the compare route (pure
  refactor, response unchanged); Members directory + profiles show
  `🎯 N% match · M rated in common` only for members opted into comparisons
  (`share_compare`, the exact Compare gate — no bypass) and only at ≥3
  commonly rated books, below that the % is noise.

### Cross-profile adds, interactive labels, rec upgrades (DONE Sept 9, 2026)
- **Add from a member's profile** — profile books now carry the copy-fields
  (hardcover_id, lengths, cover) + an `is_self` flag; per-row 📌 TBR / ✅ Read
  buttons create your own book (deduped on the HC anchor, else title+author)
  and reuse the TBR route / quick-status. Catalog-level data only — profiles
  stay gated by `profile_public`.
- **Interactive library labels** — genres join moods + personal tags as a
  filter dropdown, and all three render as clickable pills on library rows;
  clicking a pill applies its filter.
- **Rec cards** — ✅ Read ("I've already read this": creates + logs finished
  via quick-status, guarded against double-logging; `status` CHECK widened
  with `'read'` via migration 19 table rebuild) and a "More info" expander:
  Hardcover description (new `description` field in `HC_BOOKS`, verified
  live), genres/moods/lengths/series, 24h in-memory cache, and links to
  Hardcover (slug-based `/books/{slug}` — numeric ids 404 on the site) +
  Google Books/Goodreads/Open Library search fallbacks.

### Barcode scan to add (DONE Sept 9, 2026)
📷 Scan on Log a book: camera modal (native `BarcodeDetector` on Android/
Chromium, vendored ZXing UMD for Safari/Firefox — the app's first vendor
file, loaded only when the scanner opens) + a type-the-ISBN fallback in the
same modal. `GET /books/isbn/:isbn` resolves the code: Google Books first,
Open Library's exact bibkey API as fallback (search.json fuzzy-matches
unknown ISBNs — a real trap, verified against it), then Hardcover enrichment
for series/genres/moods. Pre-2007 US UPC-A barcodes expand to ISBN-13.
Scanned books flow into the standard confirm panel — same save, dedupe and
format logging as any search result. Live-test on a phone after deploy.

### Account polish + social + stats expansion (DONE Sept 13–14, 2026)

Two staging batches, driven by "make the app nicer to live with, and make the
social side something people actually use":

- **Account polish (Sept 13)** — password **peek** toggles (eye button) on every
  password field, with momentary reveal (auto re-hide on blur/Escape, no focus
  steal so phone keyboards stay open); **avatars** (browser square-crops to a
  256px JPEG, stored as a BLOB on the user row so backups carry them; served
  consent-gated with sniffing + CSP hardening — `server/routes/avatar.js`,
  migration 25); and a gentle **LLM-key nudge** on the For-you page (dismissible,
  never nagging) pointing at the new step-by-step key guide on the Account page.
  Member-facing copy de-jargoned in the same pass ("household's shared key", no
  `.env` talk).
- **Tags & moods stats** — the two fields members already curate finally count:
  words-weighted top lists on the dashboard and in year-in-review.
- **Friends circle** — a viewer-private starred subset of members (`prefs.circle`,
  no migration). Deliberately *not* household-wide: you pick who you follow.
- **Reading together** — the circle's in-progress books with live percent bars,
  on the Members page and the dashboard; each row knows whether the book is
  already on your shelf or queued, and offers one-tap **TBR it too**.
- **Activity feed upgrades** — relationship chips on every row plus a
  Everyone/My-circle filter (`?circle=1`).
- **Compare: this year's race** — books/words/hours/DNFs/current-streak
  head-to-head, still hard-gated by `share_compare`.
- **Average rating** — every member's ratings weighted D=1 … S=5 across all
  rated books (latest rating per book), shown as "B (3.4)": on member cards, in
  a "Who rates how" leaderboard on Members, on profiles, and in Compare totals —
  making rating generosity visible across the instance.
- **Regression caught in the wild**: the tags/moods edit had clobbered the
  author/tier aggregation lines in `/stats` (empty Tier spread + Author
  leaderboard); restored, and the smoke suite now asserts them.

Decisions: **frontend stays vanilla** (per-view modules, no build step; Preact-no-build
is the reversible escape hatch if a screen demands it) · **auth lands after the tier
board** · **LLM = OpenAI-compatible endpoint** (Google AI Studio free tier guide below) ·
**Audible import is upload-only** (a helper app of the user's choice exports the library
file; the app never sees Amazon credentials — direct Amazon login is explicitly deferred).

### Club life + repairs + portraits (DONE Sept 23 – Oct 3, 2026)
A stretch of mostly-concurrent work (several sessions shipped here — read the
commit log for the deep detail; HANDOFF.md carries the operational history):
- **Works + chatter** — cross-copy work identity (`server/works.js`, alias
  graph keyed on hardcover id / normalized title+author) backs one comment
  thread per work; comments stamp the poster's server-computed progress,
  percent-gating hides what's ahead of the viewer, spoilers wait for a
  finish; emoji reactions on comments and cheers (same machinery) on reading
  events; nudges deep-link into the thread.
- **Club polls + crowned picks** — any member raises a poll seeded from the
  club's TBR next-ups (options deduped on the work key), live one-vote tally
  with revote-moves-it, creator closes (admin backstop) and crowns a pick;
  "I'm in" copies the winner onto the joiner's shelf, deduped.
- **Readalongs** — a crowned pick becomes a paced buddy read: `target_finish`
  (+ `readalong_started_at` anchor) drives a server-computed pace wall
  (percent per participant, expected-percent line, finished/ahead/on/behind
  chips at ±10), the work's chatter thread embedded; exactly-one nudge on
  start and on new joins; only the poll's creator (admin backstop) sets or
  ends the window.
- **Storyteller Selection** — blind writing-style tasting flights
  (`server/storytellers/`): one LLM job rewrites a scene in each cast
  author's voice (authors drawn from the member's own shelves), the member
  ranks anonymized passages, the reveal maps voices to authors plus their
  standing in the member's ratings; admin-only authentic corpus from epub
  scans (fflate unzip). Audible import also accepts .xlsx exports now.
- **Kobo cloud-sync repair** — the sync feed's typed top-level events
  (NewEntitlement/ChangedEntitlement triples, ChangedReadingState deltas)
  are all unwrapped now (the old mapper dropped title-less events — weeks of
  member finishes); `kobo_ent_map` (schema 44) translates entitlement↔revision
  ids; finishes date from `StatusInfo.LastTimeFinished` and are never
  re-dated; auto-add is conservative (finished / reading / ≥5%); tiered
  title matching (normalized → null-author → subtitle-prefix, never across
  disagreeing authors) so replays can't mint dupes.
- **ABS member-link hardening** — custom server URLs must be https on
  public-DNS hostnames, redirects re-validated, sanitized errors;
  `ABS_LINK_ALLOWLIST` keeps admin-sanctioned http/LAN origins working.
- **5.8/5.9 audit bundles live** (entry-undo, hero no-flash, schema-level
  dedupe, job timeouts, nightly janitor, unprivileged container).
- **Hearth polish (Oct 3)** — chatter-card rows carry the commenter's id and
  borrow display titles for copy-less comments (broken avatars + "a book"
  fixed at the API); Members "who rates how" carries the circle-star toggle;
  header copy explains ☆/⭐ and opens "Everyone reading by this hearth".
- **Stock avatars (Oct 3, schema 45)** — five hand-authored hearth/book SVGs
  in `public/avatars/`; `/api/avatar/:id` serves custom > explicit
  `users.avatar_stock` pick > auto by user id; all `has_avatar` query sites
  are constant-true (nobody is faceless); Account picker + Auto; removing a
  photo falls back to the pick. **Three lists must stay in sync when the set
  changes: `STOCK_KEYS` (routes/avatar.js), `STOCK_AVATARS`/`STOCK_NAMES`
  (views/auth.js), and the files themselves.**


### Phase 1 — Foundations (no user-visible change)
Migration runner (`schema_version` + ordered migrations); split `app.js` into per-view
modules; `jobs` table + start/poll endpoints with an in-process worker; ops hardening
(container healthcheck, SQLite backup endpoint).

### Phase 2 — Tier board (rest of V2) — DONE Sept 2026
Drag-and-drop S–D board per book; series rollups (avg of S=5…D=1, min 2 ratings,
manual override column, `series_overrides` migration); shareable tier-list image
(client-side canvas); in-app ABS import running through the jobs system.

### Phase 3 — Auth + multi-user + Compare — DONE Sept 2026
Login (username + scrypt-hashed password, sessions table, httpOnly cookie).
**Access via single-use invite links**: the admin generates an invite (random
token, stored hashed, works for exactly one account creation, revocable while
unused) and shares the URL; the recipient creates their own account (name +
password) through it. **DONE**: auth gate on /api (401s), session-scoped
`currentUserId()` via AsyncLocalStorage (CLI falls back to seed user; jobs
carry `user_id` explicitly), admin claim link printed on first boot, login/
account views, admin Invites view, ABS import admin-only. **Compare** (step 6):
consent-based (`users.share_compare`, migration 7 — the invited account was
promised its data stays "yours alone", so nothing crosses accounts without an
explicit opt-in; no admin bypass). Opted-in members appear in each other's
picker; the comparison matches books across accounts by Hardcover id, falling
back to normalized title+author, and shows shared books, per-book rating
deltas (latest-entry tiers, S=5…D=1) and series rollup agreement (overrides
apply). Only tier letters + book/series names are exposed.

### Phase 4 — Recommendations (V3) — DONE Sept 2026
Taste profile digest (tiers, series rollups, DNFs, narrators, owned catalog,
already-suggested, avoid signals) → LLM proposes candidates with reasoning →
Hardcover verification (drops hallucinated titles, captures pages/runtime for
word-commitment totals) → recommendation cards → one-click to TBR → "Not for
me" avoid signals fed into future digests. `recommendations` + `avoid_signals`
tables (migration 8); generation runs as the `recommendations` job (digest →
LLM → verify); `payload.candidates` + `hardcover:false` give an offline path
the smoke uses. Built against an OpenAI-compatible endpoint; unconfigured keys
leave the Generate button disabled with a hint.

### Phase 5 — Polish (V4) — DONE Sept 2026
Year-in-review page (DONE Sept 2026 — includes the monthly pace view); personal
tags (DONE — book modal, library filter/search, Goodreads shelves import as
tags); Goodreads CSV import (DONE — same review wizard as Kobo, ISBN Hardcover
matching, star→tier mapping); all-time pace charts (DONE Sept 2026 — dashboard
section with words-per-year bars plus a scrollable all-history monthly strip;
`/api/stats` exposes `months_all`); also shipped late in the phase: search
reliability (timeouts, ranked merge), multi-select batch add, on-pause shelf,
tags-while-ranking, quick status buttons, TBR-clears-reading, privacy toggles,
Hardcover as a discovery source, Kobo device-link polling (see Kobo section).

### LLM config (Google AI Studio free tier)

1. aistudio.google.com → sign in → "Get API key" → create (free, no card).
2. Add to `.env`:
   - `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`
   - `LLM_API_KEY=<key>`
   - `LLM_MODEL=gemini-3.6-flash` (the current Flash model listed in AI Studio —
     `gemini-2.5-flash` is retired for new accounts; older keys may keep it)
3. Free tier is ample (a rec run is a handful of calls). Privacy note: free-tier
   content may be used by Google for product improvement — alternatives: Groq
   (free, fast) or local Ollama (nothing leaves the machine), same three keys.

## Rating scale

S–D letter tiers. **S** = loved it!; **A** = excellent;
**B** = liked it; **C** = fine / forgettable; **D** = disliked. DNF books still
get a tier, and wear a small DNF badge on the board and in its exports (a
book DNF'd and later finished loses the badge again — latest entry wins).

### Kobo dynamic sync (evaluated Sept 2026 — post-Phase-3 candidate)

The ideal: import KoboReader.sqlite once (library + history, already built), then
never plug in again — new reading flows in automatically. Doable via **device-link
polling**: the imported file contains the device's own cloud credentials
(`UserID`/`UserKey`, `api_endpoint` in `Kobo eReader.conf`); with opt-in storage of
those tokens, the app polls Kobo's sync endpoints as the device and suggests
finished/reading updates. Decided ladder:

1. **File import** (built) — snapshot; re-uploads are safe (event dedupe) but manual.
2. **Device-link polling** — BUILT Sept 2026 (`server/kobo/sync.js`, migration
   `kobo_links`): opt-in storage of the device's UserID/UserKey from the
   uploaded KoboReader.sqlite; a `kobo_sync` job (manual "Sync now" + 6-hourly
   auto-poll, `KOBO_SYNC_HOURS=0` off) authenticates as the device and pulls
   changed reading state into the standard event-deduped, Hardcover-matched
   importer. Protocol per calibre-web/KoSync prior art — **awaiting its
   real-account spike** (the undecided part is exact HMAC input + paging).
3. **Official Kobo Integrations program** — Kobo launched partner account-linking
   (StoryGraph, June 2026); partnership-only today, watch for self-serve access.

Rejected: email/password Kobo login in our UI — no proven implementation
(Auth0/OIDC-protected), password handling for data strictly worse than the device file.

## Non-goals

Public social/community features (this is a private instance, not a platform) —
though *instance-scoped* social shipped deliberately in Sept 2026: friends
circles, reading-together, consent-based comparison, taste-match badges. Also
out: a mobile app, catalog-of-the-world maintenance (rented from
Hardcover/Google/Open Library by design), shelf management beyond the TBR queue,
ABS play-time tracking.
**Split frontend/backend packaging** — the SPA already talks to the API over HTTP, so
the "slim user app" is just the browser; one container until a concrete trigger
(native client, public-scale traffic) makes a split worth its CORS/auth costs.
Multi-user = accounts logging into the same webpage.

## Still open

- ~~**STAGED Nov 25: KOReader progress sync (Update 5.39 "Page turner")**~~ **SHIPPED Nov 25** (user's word: "I don't have anyone to test it yet so go ahead and ship"; snapshot `manual-pre-5-39-page-turner-ship-20261125.db`; schema 59→60 at the prod rebuild) — user asks: can Calibre/BookBridge integrate like ABS/Kobo live sync, and can a KOReader user's progress/completion be tracked? Assessment first (Nov 25): Calibre never learns device progress and has no documented positions read API; BookBridge has no aggregate read API (admin = provisioning only, device = word maps) — both parked. The clean fit is the kosync protocol KOReader already speaks: the app BECOMES the sync server, so the device pushes (no poller, no outbound fetches, no SSRF surface). Protocol pinned from KOReader's own plugin source (plugins/kosync.koplugin: PUT /syncs/progress, GET /syncs/progress/:document, GET /users/auth, POST /users/create; x-auth-user + x-auth-key where the key is md5(password); percentage is 0–1; document is ALWAYS a digest — md5 even in Filename mode) and cross-checked against BookBridge's kosync server (404-with-message for unknown docs — strict clients treat 5xx as fatal; register-that-matches). The one breakable link — matching — is solved by the plugin's opt-in "Send metadata" ({filename, title, authors}, explicitly for custom servers). Migration 60: kosync_links (user_id PK, key_hash = md5 of a generated token — the raw token only ever appears in the Account card's shown-once panel; regenerate kills the old key instantly) + kosync_docs (user_id, document PK — the position row that serves the protocol's GET to the member's other devices, doubling as the book mapping; book_id NULL = pending, ON DELETE SET NULL re-pends on book delete — the kobo_ent_map pattern). Server: routes/kosync.js (protocol half public via two new AUTH_EXEMPT patterns — only the four wire paths, management stays behind the session gate; own tight limiter 5 fails/60 s per name+IP with 429; percentage validated to [0,1]; placeholder docs rejected; /users/create succeeds iff creds already match, accepting raw or md5 password forms) and koreader/sync.js (the fold, mirroring the ABS decision core: ≥97% finishes close-or-minted with finished_at=COALESCE and NEVER re-dated; part-way updates/opens the reading event; noteReadingDay on pushes; fresh finishes ring the circle + crier, stale ones land undated and quiet; sync-opened starts stay silent per the standing 5.29 rule; matching ladder = doc map → findBookByTitle (now exported from kobo/sync.js) → hardcoverLookup-enriched auto-create; metadata-less pushes park pending with hints COALESCEd in when metadata arrives later; mapKosyncDoc folds a pending doc's stored position with its updated_at as the observation under the 14-day window — stale stalls never open, stale finishes land undated). Account card: Connect mints creds (shown-once URL/username/token panel with copy buttons, invite-link rules), status line (books syncing, last push), "Unrecognized books" picker (shelf dropdown + Map + Forget), Regenerate, Disconnect; setup steps name the plugin's Send metadata switch. Smoke: new "koreader kosync OK" section — creds/auth (wrong 401, md5 form 200, register raw-password 201), a metadata push auto-creating the book + reading event at 42% + the GET shape (percentage/progress/device/timestamp), 98% minting a finish, a 1.0 push never re-dating it, a metadata-less push parking pending (no book/event), map-folding 50% onto a fixture book, percentage 1.5 → 400, placeholder GET → 429… 404, unauth push → 401, regenerate killing the old key, and credential guessing throttled to 429 (guesses ride a PHANTOM username — the in-memory limiter would otherwise poison a re-run inside its window; suite proven re-runnable back-to-back). Pin bites: reverting the finish threshold → red at exactly "98% push did not mint a finish" (restored sha256-verified). Verified: full local suite green twice on a fresh schema-60 DB, a true 59→60 upgrade boot on an old-tree eb63ff5 DB (checkpointed WAL first), then a curl-as-KOReader pass with the exact wire shapes (0.10→0.42 with metadata→0.98: book created, reading opened at 42, finish dated today; GET serving the last position; a no-metadata push parked pending) and a real browser pass (claim → connected card state, the pending mapper round trip with the fold landing in the DB, Regenerate's shown-once panel whose key authenticates over curl under the renamed username, no overflow at 390). Schema 59→60; staged only — ships on the user's word.
- ~~**STAGED Nov 24: community invites + username uniqueness (Update 5.38 "Open house")**~~ **SHIPPED Nov 24** (user's word: "Looks good - let's ship it"; snapshot `manual-pre-5-38-open-house-ship-20261124.db`; schema 56→59 — migrations 58+59 ran on prod at the rebuild, riding with 5.37) — user ask: every invite is individual, so having one ready for a friend is hard; make a generic invite with ~10 uses that can be posted to a community and shared until its uses run out, then mint another. Two migrations. m58: `CREATE UNIQUE INDEX idx_users_name_ci ON users(lower(name))` — makes the DB enforce exactly what login already assumes (the lookup is lower(name)=lower(?) taking the first match, so a second same-name or case-variant account signed up fine but was locked out at its next sign-in; the "that name is taken" branches in accept + rename were dead code — users.name never had any UNIQUE anything). Guarded: the migration throws naming any existing case-insensitive duplicates rather than silently renaming someone (prod checked read-only before staging: 20 users, 0 dup groups); a case-only self-rename stays legal (the indexed lower() value is unchanged). m59: invites.max_uses (NULL = single-use, every existing row and all resets/claim links unchanged) + use_count. Server (auth.js): createInvite takes maxUses — signup invites only, resets and the boot claim link stay one-shot, ≥2 honored, the route clamps 2–100; findUsableInvite stays live while use_count < max_uses for community rows; consumeInvite bumps the count with a conditional UPDATE (the pairing-approve pattern) and reports whether it bit — redeemInvite deletes the just-inserted user if it ever didn't (unreachable on this synchronous server; keeps the invariant airtight). The user INSERT stays before the consume, so a refused duplicate name never burns a community use. Routes: POST /auth/invites takes/echoes maxUses (below 2 = plain single); GET /auth/invites carries max_uses/use_count; DELETE revokes while a link still works (unused singles, community with claims left — used/full rows stay as history). UI: invites.js grows a "uses" number input (1–100, default 1) with reworded page copy; the paste-along blurb words itself by uses (community: "it's open to the first N people to claim it, so don't sit on it") with a "good for the first N claims" note under the link; list rows read "community ×N" / "used N of M" / "full" with Revoke only while claims remain. auth.js's dead-token banner now covers every death: "used, filled up, or revoked". Smoke: new "community invites + name uniqueness" section — duplicate exact + case-variant refused with no use burned, two claims land (use_count 1→2, used_by NULL), a third refused ("not valid anymore"), a full link not revocable, a live one revocable, rename-to-taken refused / case-only self-rename allowed / exact case restored, maxUses:1 clamps to a plain single row; the boot pre-clean gains the fixtures (matched case-insensitively — an interrupted run may stop mid-rename). Pins BITE: reverting the WHERE + consume conditions turned the suite red at exactly the exhaustion assertion (restored sha256-verified); dropping the index turned it red at exactly "duplicate username accepted". Verified: full local suite green on a fresh schema-59 DB and again on a re-freshened DB after the bite runs; a true 57→59 upgrade boot (old-tree 5b81f20 DB → new tree: version 59, index present, data intact) plus the loud-fail path (a seeded dup pair → boot refuses, naming "Upgrade Test / upgrade test (upgrade test)", version stays 57); and a real browser on the scratch instance — admin claimed through the real claim form, a 3-use "Browser Crew" link minted with the community blurb, three signups through the path-form link (banner "reserved for Browser Crew"), a case-variant duplicate refused inline while the third claim still succeeded (no burn), the 4th visit hitting the new dead banner with the button disabled, the list counting "used 0 of 3" → "full" with Revoke disappearing, a live community link revoked from the UI with the toast, and no horizontal overflow at 390 with the new toolbar input. Schema 57→59 (snapshot ritual + migrations run on prod at the next ship's deploy; staging DB migrates at rebuild); rides with 5.37 per the user's word. CHANGELOG 5.38 + README invite wording along.
- ~~**STAGED Nov 24: ABS sync tombstones (Update 5.37 "Gone for good")**~~ **SHIPPED Nov 24** (rode the 5.38 "Open house" ship on the user's word; snapshot `manual-pre-5-38-open-house-ship-20261124.db`; schema 56→57 ran at the prod rebuild alongside 58+59) — the Nov 1 diagnosis, built at last: abs_sync (every 90 min) re-created deleted books and their events because ABS still reports the items' progress and the sync re-adds whatever it can't find (the mutation proof showed it live: books_added 1 + a re-logged finish on the very next sync). Migration 57 adds `abs_ignored (user_id, item_id, title, created_at, PK(user_id,item_id))`. DELETE /books/:id now writes a tombstone first when the book is ABS-sourced (source_provider='abs' + source_id) and answers `abs_ignored: true`; the sync preloads the member's ignore set once and skips those items entirely (no book, no events, no crier — result.ignored counts them, and the Account Sync-now toast says "N kept out"); non-ABS deletes write nothing. The undo: GET/DELETE /abs/ignored[/:itemId] + a "🚫 Kept out of sync" list on the Account page's Audiobookshelf card — "Let it sync again" removes the row and the next sync re-adds the book (re-logging its finish/progress from ABS, same as a first sighting). Books re-added manually (unlinked from ABS) are unaffected; the delete toast tells the member what happened ("Deleted — ABS sync will leave it out (Account → Audiobookshelf to undo)"). Smoke pins in the ABS section: delete→tombstone→re-sync skips (books_added 0, ignored 1, book gone)→un-ignore→re-sync restores (books_added 1)→non-ABS delete writes nothing; the section self-clean clears the tombstones it created — and the pins BITE (reverting the one-line sync skip turned the suite red at exactly the resurrection assertion). Verified: full local suite green on a fresh schema-57 DB, then a real browser on a scratch instance with a mock ABS server — the delete toast, the ignore list rendering, a live Sync now reporting "0 added, …, 1 kept out" with the book staying gone, the undo round trip (book back, reading event re-opened from ABS progress), and the manual book's plain "Deleted". Rides the next ship per the user's word (schema change → snapshot ritual + migration on prod at deploy; staging DB migrates at rebuild).
- ~~**STAGED Nov 24: tier board genre filter (Update 5.36 "By genre")**~~ **SHIPPED Nov 24** (user's word: "go ahead ship it"; snapshot `manual-pre-5-36-by-genre-ship-20261124.db`; no schema change) — user ask: "add to the tierlist sort options to sort by genre" = a genre dropdown in the board's ▽ Filter row, beside the author one (the board has no sort modes by design — hand-arrangement is the point; the filter row is its "sort options" in the user's phrasing). The dropdown's options are the union of every board book's genres (a book wears several), drawn from the FULL board so narrowing one facet never collapses another; picking one narrows the board to books whose genres include it (multi-genre books match each), AND-combined with the author and year filters; a remembered genre absent from the board being viewed resets instead of hiding everything (the author rule); and the exports follow as always — exportRows() consumes the same visibleBooks() pool, so the header counts the filtered list (browser-verified: Fantasy on the scratch board exported "11 books · ≈1.33M words"). Server: GET /board/:userId now selects b.genres too and parses it with parseJsonArr (server/jsonarr.js) so a member's board arrives in the same shape GET /books serves your own in — genres are catalog facts that board's info panel already shares; tags, notes and dates still never travel. Smoke pin: the invited member's board carries parsed genres on every book, with a genre-carrying fixture at ['Fantasy'] and genre-less ones at [] — proven to bite by reverting the SELECT line (suite red at exactly that pin, file restored sha256-verified). Verified: full local suite green, then a real browser on a genre-seeded scratch instance — dropdown options = the exact sorted union; Fantasy/Science Fiction/Romance/Horror narrowing; a multi-genre book matching its second genre; genre AND author (1 book, and 0 for a non-co-occurring pair); back to All genres restoring the full board; the member board filtering the same way with no year select; a stale Romance pick resetting on arrival at a member board that lacks it; the text export's header following the filter; and the three-dropdown row wrapping cleanly at 390 wide with no horizontal overflow. Client + one server SELECT; no schema change.
- ~~**STAGED Nov 24: export header — the books on the list and the words they stand for (Update 5.35 "Weighing in")**~~ **SHIPPED Nov 24** (user's word: "go ahead ship the update"; snapshot `manual-pre-5-35-weighing-in-ship-20261124.db`; no schema change) — user ask: with a filter on, the tier board's exported header read "N of M books · date"; drop the "of M books" part, keep the count of the books on the list, and add how many words those books stand for. One function heads all three board exports (boardCountLabel in public/js/views/tierboard.js → the image, the list-only image and the Markdown text), so all three now read `N books · ≈X words · date` on your own board and on a read-only member board alike. New pure helper booksWordsLabel(books) in public/js/ui.js, built on the estimator and formatter the rest of the app already uses (estWordsClient in its 'read' order — a stored word count, else pages × 275, else audio runtime at 9,300 words an hour — and fmtWords, the year-in-review card's style); no new word math. The user's calls: the `≈8.42M words` wording; a DNF counts in full (the line sizes the books on the list, not the reading); tier board only — the TBR exports are unchanged (that list sends no page counts and collapsed series hide their other volumes, so it would want server-side per-series totals). Defaults taken: a book with no length data adds nothing and gets no note (the card's convention), and with none on the list the words part is left out; "1 books" now reads "1 book". SERVER: GET /board/:userId (the read-only member board) selects page_count, audio_runtime_minutes and word_count as well — edition facts that board's info panel already shares; tags, notes and dates still don't travel. The on-screen "N of M books with entries" counter is untouched. Smoke pin: the invited member's board carries the length fields (a sized fixture at its stored page count, an unsized one null) and still leaks nothing personal — and the pin bites: with the SELECT reverted the suite goes red at exactly that line. Verified: a 34-assertion Node scratch on the real modules (label outputs, pages/runtime/word-count precedence, DNF in full, unsized books, singular, the Markdown heading, client/server estimator parity), the full local isolated suite green, then a real browser on a local scratch instance seeded through the API — all three exports on the unfiltered board, under an author filter, a year filter, "not finished yet" and a filter matching nothing; a single-book list; a DNF; a runtime-only book; a book with no length data; a member's board with a long name, whole and author-filtered; the on-screen counter reading "N of M" throughout; the ≈ glyph painted; toolbars unchanged at 1280 and 390. No schema change.
- ~~**STAGED Nov 23: Markdown companions to the image exports (Update 5.34 "In so many words")**~~ **SHIPPED Nov 23** (user's word: "go ahead and ship it"; snapshot manual-pre-5-34-in-so-many-words-ship-20261123.db; no schema change) — user ask: when exporting a tier list or TBR of any kind, also output a text-only copy of the list (Markdown), for posting alongside the image(s) on Reddit. A ⬇ Export as text button sits beside the image buttons on the tier board (your own and the read-only member board) and on the TBR queue — a separate button rather than a checkbox, because browsers can refuse a second file from one click. public/js/text-export.js: pure builders (mdText escapes the characters Markdown would read as formatting and folds whitespace; mdEntry = `- Title (Series #N) — *Author* (notes…)`; listMarkdown = one italic header line, then per non-empty section a bold label, a blank line, the items — Reddit glues a list onto the paragraph above it without that blank line) plus the browser part (downloadText; copyText with a select-and-execCommand fallback for plain-http LAN origins, where the async clipboard API does not exist; saveTextList = the file is saved, then an action toast whose Copy button puts the same text on the clipboard, saying so honestly when copying is blocked). SAME ROWS AS THE PICTURE: the board text mirrors the list-only image (exportRows — S→D then unrated, hand-arranged order, an active author/year filter, a DNF note, the "N of M books" header); the TBR text mirrors the TBR image (tbrTiles — one line per series, its next unread volume, "+N queued"), byte-identical with Collapse series on or off. Titles carry the series position on the TBR (that is what a series rolls up to) and not on the board (its list image shows title + author alone). Verified: a 36-assertion Node scratch on the real module (exact outputs, escaping, series order 0 and 0.5, empty tiers, blank-line structure), then a real browser on a local scratch instance seeded with every tier, an unrated entry, a DNF, a Markdown-hostile title, a hand-arranged tier order and a multi-volume TBR series whose first volume is read — file name/type/content on both views, Copy through the real clipboard API and through the fallback, the copy-blocked message, filter parity, a member board, a narrowed queue, an empty board and an empty queue, all three board image exports and the TBR image still fine after the shared title/label refactor, and both toolbars at 1280 and 390 wide. Two pre-existing bugs found by that pass ride along as their own commits: the tier board's author filter carried from your board into a member's and hid everything (4373c9d), and the TBR image lost its series badge and rolled-up count with Collapse series on (f5944dc — tbrTiles now feeds both exports). Client-only; no schema change; no smoke pin (nothing server-side).
- ~~**STAGED Nov 21: Goodreads CSV export (Update 5.33 "Return to sender")**~~ **SHIPPED Nov 23** (user's word: "we can ship the goodreads export feature from staging"; snapshot manual-pre-5-33-return-to-sender-ship-20261123.db; no schema change. The ship waited two days because CI was red on the staged commits: the export smoke pin expected the author field quoted while csvRow leaves comma-free fields bare — a wrong pin on a correct row. Re-pinned field by field in ed13806 (test-only); the local isolated suite and CI then both ran green end to end) — user ask: put the finished library back into Goodreads (its importer lives at My Books → Import and export — goodreads.com/review/import directly; the redesign buried the sidebar entry, which started this). GET /api/export/goodreads streams the signed-in reader's finished books as a CSV with Goodreads' canonical export header verbatim (UTF-8 BOM, CRLF, RFC4180 via a new csvRow writer in server/csv.js — the parseCsv reader's mirror). One row per book: re-reads fold to the latest finish date with Read Count carrying the total; the latest event's tier becomes My Rating on the import ladder (S→5, A→4, B→3, C→2, D→1; unrated→0); year-only finishes keep no Date Read (a bare year can't pick a day — inventing one would claim a date nobody logged); DNF/reading/other members' books stay out. No ISBNs are stored (import-time only, for the Hardcover match), so Goodreads matches title+author and its import preview is the fix-editions window — the card copy says so. Titles ship bare (no "(Series, #N)" suffix — the same tag the importer itself strips to protect matching). Memory lane gains the card after the import cards; the button is a plain `<a download>` riding the session cookie, no JS. Verified by a scratch round-trip (synthetic DB → route SQL + mapping verbatim → parseGoodreads back: 21 assertions, ladder/quoting/dates/order all invert). Smoke pin: canonical header + the imported smoke book's whole row (quoted comma-title, bare author, A→4, its read date, read shelf, Read Count 1) + the full loop through /goodreads/parse. No schema change.
- ~~**STAGED Nov 21: TBR series collapsing (Update 5.32 "Next in line")**~~ **SHIPPED Nov 21** (user validated on staging and said ship; snapshot manual-pre-5-32-next-in-line-ship-20261121.db; no schema change; browser pass caught one bug pre-ship — the collapse grouped unconditionally, fixed in 2125e6d before deploy) — user ask: multiple queued volumes of one series bury the book that matters next; a 📚 Collapse series toggle (per-device localStorage bt-tbr-collapse, off by default) trims the list to each series' next UNREAD volume. Rule (shared by list + PNG export): group by trimmed series_name; survivor = unread first (queued ≠ unread), then lowest series_order (null never displaces known), then earliest queued; all-read series falls back to its first volume (re-read queues); the series keeps the queue position of its first-seen entry so pinned series still lead. Survivor row carries a “+N queued” pill (tooltip = hidden titles, ⭐ if the next-up star is inside); header notes “N series collapsed”; mood chips still build from ALL entries; Surprise-me draws from the collapsed shown. SERVER: GET /tbr gains EXISTS(...finished...) AS finished per row (books.js:1169 idiom) because queued ≠ unread (re-queues, read-out-of-order). rollupSeries (the PNG export) upgraded from lowest-order-queued to the same next-unread rule so image and list agree. Smoke pin: re-queued finished volume reports finished:1, fresh queue entry finished:0. Client + one server subquery; no schema change.
- ~~**STAGED Nov 20: self-host quickstart (Update 5.31 "Front door")**~~ **SHIPPED Nov 20** (user validated + ran the pre-ship privacy audit, then said ship; snapshot manual-pre-5-31-front-door-ship-20261120.db; no schema change; OWNER DEPLOY COMMAND CHANGED this ship: prod now needs `-f docker-compose.yml -f docker-compose.abs.yml`) — make a stranger's stock experience work and document it. Base docker-compose.yml is STANDALONE now: own bridge network (the external abs-network moved to a new docker-compose.abs.yml overlay — OWNER DEPLOYS GAIN a second -f flag), env_file optional (compose long syntax required:false), LISTEN escape var for the port binding. STRANGER-TEST CATCH: a fresh clone's docker compose up died with "unable to open database file" — Docker creates missing ./data+./backups as root while the app runs as node; new entrypoint.sh starts as root for one chown heartbeat then su-exec drops to node:node (app never runs as root; su-exec added to the image). Verified end-to-end on the box as a real stranger: fresh clone, no .env, no networks, renamed container/port only to dodge prod collisions on the shared host — boot, claim link (now with a swap-localhost hint), admin claimed via API, session verified, full teardown. README: Run-it became a Quickstart (prereqs, claim-from-logs, LAN/https notes) + How-it's-built blurb + 9 missing config rows; .env.example completed to match (dead ABS_LIBRARY_NAME removed); package.json engines node>=24; seed-demo.js respects BT_DB_PATH. Landing page gained four REAL screenshots (fresh scratch instance, seed-demo data only: hearth/library/tier board/search). Pooled-rankings federation assessed in the same pass (hc:/titleKeys work identity is federation-grade, booksWithTiers is the bundle row, share_compare is the consent precedent; recommendation: manual bundles first, central commons later, no p2p) —  Pre-ship privacy audit (user ask: zero identifying content on the public repo): independent scans of the live twin and the pending tree found keys/tokens/passwords/emails/IPs/webhooks clean; two catches fixed — a real-domain comment in the new abs overlay (swapped for a 192.0.2.x documentation address) and the export gate's own shipped vocabulary, which published the household roster by design — now untracked scripts/.gate-vocab with abort-on-missing, roster scrubbed from the script and its dated comments, full-tree name scan of the export empty. Ship trail: twin force-pushed a fresh single-commit history — the roster left the live public repo at this ship (old commits unreachable; GitHub may retain by SHA for a while, disclosed to the user).
- ~~**STAGED Nov 20: author filter (Update 5.30 "By author")**~~ **SHIPPED Nov 20** (user validated on staging and shipped the same session; snapshot manual-pre-5-30-by-author-ship-20261120.db; client-only, no schema change) — an All-authors dropdown beside the tier/format filters in library.js: single pick, exact match on the stored author string, options drawn from the whole current-search fetch (the label-dropdown rule: a dropdown never filters its own list away), a stored pick that no longer matches anything resets instead of hiding the table, and the pick survives re-renders via libState like tier/format.
- ~~**STAGED Nov 12: Discord echo of finishes + starts (Update 5.29 "The town
  crier")**~~ **SHIPPED Nov 12** (household validation: all four post shapes
  watched live in a throwaway test channel — solo sentence, 3-book gather,
  5-book gather with held-back titles, separate start — and the gather tail
  re-worded mid-validation to the user’s phrasing with a masked link to the
  finisher’s shelf; user: "worked great, lets ship it"; snapshot
  manual-pre-5-29-town-crier-ship-20261112.db; no schema change) — a webhook URL (env `DISCORD_WEBHOOK_URL`, empty = fully off)
  makes the server post to the household's Discord: live finishes from the
  app AND finishes first observed by an ABS sync (the same call sites and
  import-silence rules as notifyCircleFinish), plus UI-only starts
  (quick-status open, POST /events 'reading', edit-flip to 'reading' —
  sync-opened reading events deliberately excluded: progress>0 opens them
  with no freshness gate, so the Blacktongue-style zombie re-opens would
  broadcast until a tombstone exists). Burst-gathering in server/discord.js:
  per-member batches anchored at the first event, flushed by one unref'd
  setTimeout after DISCORD_BATCH_SECONDS (default 60) — one finish posts a
  sentence, a mass-mark day posts "finished 37 books — A, B, C, and 34
  more — check them out on InkHearth" as a masked link to the finisher’s own
  shelf (appUrl + #members/<uid>, an existing hash route — the link only
  appears when DISCORD_APP_URL is set) (start/finish batch independently, deduped by book id, two members
  never share a post). Delivery fire-and-forget — call sites never await,
  failures (incl. 429) log one line and drop, restart mid-window loses the
  batch; right trade for a celebratory feed. Stdlib-only (global fetch +
  AbortSignal.timeout, house idiom), no schema change, posts as username
  "Inkhearth". Staging gets a test channel: compose.staging overrides
  DISCORD_WEBHOOK_URL from .env's DISCORD_STAGING_WEBHOOK_URL so the secret
  never enters the repo. Verified Nov 12: live staging probe ALL PASS via the
  staging-smoke compose (HARDCOVER_TOKEN empty, as documented — a first
  off-label probe against the plain container hit the known live-token fixture
  hazard: Hardcover retitled the "Smoke ABS" fixtures to real novels and
  stranded them; cleaned by source_id li-1..4, no real data touched); CI green
  after an audit-fix bump (body-parser 1.20.9 GHSA-27r3-jxmh-p828 + qs patch,
  lockfile-only) that had reddened the gate mid-5.29. Discord e2e then verified
  live against a throwaway test-channel webhook (all four shapes plus the
  batch-2 shelf link, zero flush failures, every test row cleaned); ship note:
  the export gate’s bare "discord" was narrowed to webhook/invite/channel URL
  shapes the same day — 5.29 made the word public feature copy — and the
  member-named example left the CHANGELOG bullet. Prod crier ships dormant:
  the household arms it by pointing prod .env’s DISCORD_WEBHOOK_URL at the
  real channel (DISCORD_APP_URL=tunnel URL is pre-set at deploy).
- ~~**STAGED Oct 19: finish→rate nudge, Start Reading, clickable titles (Update
  5.28 "The last page")**~~ **SHIPPED Oct 19** (after household validation;
  snapshot manual-pre-5-28-the-last-page-ship-20261019.db — taken with 5.27,
  which ships in the same motion; no schema change) — three small household
  asks, one commit: (1) marking
  a book finished — the book panel's ✅ Read, the hearth hero's ✅ Finish, and
  the ✅ Read flows that copy a member's book or accept a recommendation — now
  toasts with a ⭐ Rate it action that opens that exact entry's edit form with
  the tier picker scrolled into view (quick-status returns touched_event — the
  id it closed in place or created; events[0] alone can be an older finish
  when a stale open event lingers behind a newer one — and book-modal exports
  openRating() as the shared landing); (2) the catalog search modal ("Not on
  any shelf here yet") grows ▶ Start Reading beside Add to TBR: the same draft
  POST /books then quick-status reading, which is idempotent, so it can never
  double-log an open event; (3) together-row titles (hearth + members page)
  and the h2 titles of the book panel and member preview are now
  #search/title deep links — the household's answer to "who else has read
  it", riding the normal exact search with owner chips. No schema change.
  Smoke: touched_event pinned in all four quick-status shapes (close-in-place,
  insert-new, reading start, idempotent re-start); local tokenless full suite
  ALL PASS Oct 19. Browser check (local, scratch user, cleaned up after):
  Start Reading creates the shelf copy + an open reading event + the owner
  chip on re-search; Read → ⭐ Rate it opens the editor with the picker
  centered; the title link closes the modal and lands on the exact search
  with chips. Shipped the same evening. Batch 2 (same day, the user's first
  hours with it): the hearth's Finish outgrew the toast — it now opens a
  proper prompt that waits for an answer (⭐ Rate it / Later, ✕ and Escape
  count as Later) in a new narrow .prompt modal-card variant; the panel and
  the copy-from paths keep the toast, which suits surfaces you're already
  inside. Browser-checked like batch 1. SHIPPED Oct 20 (user: "better" —
  validated on staging; snapshot manual-pre-5-28-batch2-ship-20261020.db;
  client-only, no schema change).
- ~~**STAGED Oct 19 (late): series journey truthfulness (Update 5.27 "The full
  ladder")**~~ **SHIPPED Oct 19** (after household validation, together with
  5.28; snapshot manual-pre-5-28-the-last-page-ship-20261019.db; no schema
  change) — the follow-through on the Kellanved's finding: the unified
  search was fixed in 5.26 but the hearth's Series journey card still read
  "Path to Ascendancy 2 of 2 · you're up to date" (the admin's screenshot).
  Root cause chain, all confirmed against live data: the journey builds its
  ladder from ONE exact-name HC series record (9861); HC's copy of that
  record is missing #3 (filed on duplicate row 294795, invisible to the
  exact-name query); the trim-at-first-gap rule (built for foreign
  numbering) cut the ladder to [1]; and total = max(ladder, finished)
  inflated the stub to 2 of 2 — a double falsehood. And the same mis-filed
  row was a loaded gun in the re-pull: pickSeries would have renamed the
  household's copy onto HC's duplicate row. Three fixes: (1) the shelf
  completes the ladder — every owned book in the series group with a sane
  slot position (≥1, whole or .5) and no roster entry at its position
  becomes a rung synthesized from our row (hc id/title/author/year, marked
  mine) BEFORE the slot/trim stages; gaps the member fills are HC's misses,
  not foreign numbering, and the trim now anchors at the last owned rung
  (owned rungs — synthesized or an HC entry that IS one of our books —
  prove continuation); (2) candidates are UNIONED instead of best-one-won —
  any roster containing one of the member's own hc ids joins the ladder
  (same-named duplicate rows), while author/title-only candidates stay out
  (the Witness/Forster disambiguation holds); (3) pickSeries gained a
  stay-put guard: refreshBookMetadata passes the book's current
  series_name+order; an HC attachment agreeing with the current name wins
  (stable position updates), no agreeing attachment + complete local series
  = keep local (null, no adoption) — a re-pull can no longer move a book
  out of the series the household filed it under; bare/partial books adopt
  HC exactly as before. Books HC lists but the member doesn't own still
  recommend normally (the owned-unread #4 case renders the Witness-style
  "you already own the next one"). Smoke: gap-ladder fixture (roster
  missing #3, shelf owns+finished 1–3, unowned #4 → total 4, current 3,
  next = #4; then owning #4 flips to owned-next) + pickSeries pins
  (mis-filed-only → keep-local; agreeing → adopt; bare → unchanged);
  tokenless full suite ALL PASS Oct 19. No schema change. Staging probe
  DONE: the real Path to Ascendancy card reads 4 of 4, next null (the
  ladder includes the shelf-completed #3; the admin has finished all
  four, so "up to date" is now simply true — it was a 1-rung stub
  inflated to 2 of 2). Shipped the same evening as 5.28.
- ~~**STAGED Oct 19: unified search — shelves first, catalogs fill (Update 5.26
  "Home ground")**~~ **SHIPPED Oct 19** (after household validation; snapshot
  manual-pre-5-26-home-ground-ship-20261019.db; no schema change) — the
  admin's ask after the Kellanved's Reach finding
  (HC files the book on a duplicate series row, so the catalog series browse
  skipped a book the household owns): "our search should go through our DB
  first since we have direct control over it; use HC + others to fill other
  data where needed," pattern-checked against Audiobookshelf (their library
  search is purely local SQLite — books/series-with-books/authors/narrators/
  tags, permission-gated; providers live only in the add-content surface).
  Adopted the local mechanics, kept one page (a 20-member household wants
  both answers at once — the deliberate divergence from ABS's hard split).
  New GET /search/unified (books.js): searchShelves (the /members/search
  query+grouping, extracted to an exported fn in members.js and widened with
  series_order/published_year/hardcover_id — MIN non-null across a work's
  copies) and external searchMetadata run in PARALLEL, then mergeUnified
  (server/search-merge.js — pure, offline-fixture-tested): shelf groups lead
  with owner chips; a provider hit matching an owned work (hc-id key or
  normalized title+author — either key matches, so a Google twin of an
  HC-keyed shelf book still dedupes) is ABSORBED as field-level backup
  (cover/year/pages fill the local row's holes); strangers become the
  catalogs section at full provider rank. Series mode sorts shelves by
  position — the Path to Ascendancy browse reads 1–4, owned complete.
  Provider half failing degrades to shelves-only; GET /search untouched
  (Log a book's provider-only contract); /search/hearth stays for API
  stability but the page no longer needs it (one round trip instead of
  two). Client: two labeled sections with a quiet divider ("searched N
  shelves here — more from the catalogs:"), "in the hearth" tick now means
  shelves-only, deep links/quotes/collections tick apply to the catalogs
  half. Smoke: `unified search OK` (route live half + mergeUnified offline
  fixtures: absorb-by-hc-key, borrow, title-key dedupe, pass-through);
  local tokenless full suite ALL PASS Oct 19. Staging browser check DONE —
  the Kellanved's series itself: series search paints 1–4 in order with
  owner chips, Kellanved's Reach at #3, correct shelf-count line (a
  "shelfves" pluralization mangle in the divider caught in the same pass);
  the deep-link exact variant returning no HC roster degrades gracefully to
  shelves-only. STAGED — awaiting household validation.
- ~~**STAGED Oct 18: manual cover picks (Update 5.25 "By its cover")**~~
  **SHIPPED Oct 18** (after household validation + the re-pick cache fix
  below; snapshot manual-pre-5-25-by-its-cover-ship-20261018.db; migration
  56 is one additive column) — a
  member's ask via the admin, scoped by studying Audiobookshelf's cover
  system (their findCovers providers, CoverManager download-and-store
  pattern, magic-byte validation, and re-scan-never-overwrites rule — the
  one thing deliberately NOT copied: their paste-a-URL fetch has no SSRF
  guard, ours does). The book panel grows 🖼 Different cover beside Re-pull
  data: a picker with 🔍 Search (Hardcover editions of the same work via a
  new `editions { cached_image }` GraphQL — probed live, the relationship
  and field confirmed Oct 18 — plus Audible via the keyless
  api.audible.com → audnexus recipe ABS uses, Google Books thumbnails at
  zoom=2, Open Library at -L), 🔗 URL (https-only), 📤 Upload
  (client-resized ≤600×900 JPEG, base64). Picks are DOWNLOADED AND STORED
  locally as data/covers/manual-<bookId>.<ext> (the ABS-sync cover scheme;
  /covers static already serves it) — never hotlinked, so Amazon's signed
  URLs can't rot and the board's PNG export stays same-origin. Magic-byte
  sniffing gates every store (jpg/png/webp/gif, 10 MB cap). Migration 56
  adds books.cover_locked (flag-scoped skip, hardcover_excluded's model):
  the re-pull keeps a locked cover even on the explicit single-book button,
  whose response now says cover_locked so the toast reads "your chosen
  cover was kept"; unlock + re-pull restores HC's pick; DELETE sweeps the
  file. PUT gate accepts cover_url (already did) + cover_locked coercion.
  Re-pick replaces the old file across extensions. Smoke: `cover picks OK`
  (base64 pick stores+locks, cross-type re-pick, junk/http/private-host
  gates 400, lock+unlock round-trip, candidates shape with tokenless
  degrade) plus an ACCEPT-path pin on the extracted url-guard module —
  earned the hard way: the first cut's guard rejected EVERY hostname (the
  address-literal fallback answered true for non-addresses), which only the
  live staging probe caught; the rejection-only smoke couldn't see it.
  Local tokenless full suite ALL PASS Oct 18. Live staging probe PASS: 16
  real candidates across Hardcover (12 editions)/Audible (3, narrator-
  labeled — "read by Chiwetel Ejiofor")/Open Library with Google keyless-
  503 degrading into notes[] as designed; a real pick stored to
  data/covers/manual-<id>.jpg; re-pull KEPT it (response names the lock);
  unlock + re-pull restored HC's pick; probe book restored byte-identically,
  file swept, session removed. UI browser-verified via the localhost ssh
  tunnel (IAB blocks JS cookies even on localhost — server Set-Cookie via a
  temp-flipped staging password was the way in; hash restored from a
  container-side stash, teardown verified each step): tabs, prefilled
  query, worldwide-editions grid all rendered, a pick flipped the modal to
  the local copy in place. STAGED — awaiting household validation.
- **5.25 fix (Oct 18, from the first household test): re-picks kept the OLD
  image on screen.** Every pick stored the same URL (manual-<id>.<ext>);
  the browser serves same-URL images from its memory cache without
  revalidating, so the second upload's "cover updated" toast was true on
  disk and a lie on screen — reproduced in-browser (blue saved over red,
  modal still painted red, disk verified blue, no-store fetch blue). Fix:
  cache-busting epoch in the stored name (manual-<id>-<epoch>.<ext>),
  swept on re-pick/delete; smoke pin moved to the new shape; red→green→
  magenta in-browser after deploy paints every change. Cost of the
  verification, disclosed: the repro's container rebuild wiped the
  container-local state stash and the re-pick swept the tester's uploaded
  image — the test book was returned to its Hardcover cover (unlocked) via
  the real API instead; the staging admin's hash was re-mirrored read-only
  from prod's row (the stash that would have restored it died with the
  old container). Lesson re-learned twice in one day: no state stashes
  inside container /tmp across a redeploy, and no ssh-embedded node -e
  with template literals — scp the .cjs.
- ~~**STAGED Oct 17 (evening): admin panel de-squash + panes (Update 5.24
  "Tidy desk")**~~ **SHIPPED Oct 17** (after the admin's validation on
  staging; snapshot manual-pre-5-24-tidy-desk-ship-20261017.db; no schema
  change — view + scoped CSS only) — the admin's screenshot showed the
  half-width grid-2
  tables squashed (full "2026-10-16 17:05" stamps and 40-char IPv6s wrapping
  to 2–3 lines) and the page ~2.5 viewports tall. Reworked the view only
  (public/js/views/admin.js + scoped CSS in style.css; no server change):
  integration pills moved into the top toolbar beside Refresh/uptime so
  health leads the first screen; the six stacked sections become four
  grid-2 pane rows (users|sessions, logins|jobs, feature
  requests|announcement, devices|library health). Every feed folds past
  the newest few behind a "▸ Show N older" toggle — logins/jobs 5, sessions
  6, roster 6 (admins never fold, so the admin's own row never hides;
  staging's 16-member list mirroring prod is what drove the roster fold);
  running/queued jobs never fold; failed-login and errored-job counts sit
  in the card headings so a folded failure never hides. Users table:
  Joined/Library columns moved into the name's tooltip, restore /
  log-out-everywhere become ♻ / ⏏ glyph buttons (confirm dialogs and
  tooltips spell them out). Squash fixes: compact stamps (time-only today,
  "Oct 16 17:05" otherwise; full value in tooltips), device() shortens UAs
  ("Windows · Edge", "Android 13 · Pixel 7"), IPv6 truncates past 16 chars
  (with ::ffff: IPv4-mapped forms shown as bare IPv4 — the real payload is
  full of them), full address on hover. Job rows are one line: the raw-JSON
  ↳ result subline is gone from display, the full result rides the status
  cell's tooltip. CSS is scoped to .admin-page: td nowrap at a tighter
  5px/8px padding (scan lists, not shelves), .ellip 130px ellipsis, error
  sublines 260px ellipsis, tr.older folds; phones (<800px, panes stacked)
  fall back to wrapping. Net: 2.5 viewports → 1.75 at 1600×900 with the
  roster, sessions, logins and jobs all on screen one (staging's full
  real-data payload). Verified: helpers scratch-tested (naive-UTC/ISO/epoch
  stamps, 8 UAs, IPv4/v6 — caught an Android capture-index bug pre-deploy);
  a local render harness (staging worktree's public/ + the real staging
  /admin/overview payload — the embedded test browser blocks cookie
  storage, hence no direct staging login) confirmed zero cell wrap at
  1600/1280, zero overflow at 780 stacked, folds expand/collapse, admin row
  always visible; the deployed container rebuilt clean. En-route fix: the
  first cut's template shipped with curly quotes in every HTML attribute
  (write-time mangling) — ids never materialized and the view died on
  #admin-refresh; caught in the harness before any household eyes.
- ~~**STAGED Oct 17 (early hours): custom colour palettes (Update 5.23 "Wear
  your colors")**~~ **SHIPPED Oct 17** — a member's ask, with his own constraint: custom CSS
  palettes beyond the two built-ins, but "nothing but a colour value" ever
  accepted. Built exactly that: Account → Style grows 🎨 Custom beside
  Warm/Classic — seven slots (bg, panels, deep panels, lines, text,
  muted text, accent — the warm override set; tier colours stay
  house-wide so S–D means the same thing at every seat), each a colour
  picker PLUS a type-the-code box (user follow-up after the plain-language
  security explainer: pasting hex is exactly as safe as picking — same
  shape, same gate; a bare 6-digit paste gains its #, junk marks the field
  red and never reaches the picker, which stays the single source of
  truth readSlots saves), with live preview while picking or typing.
  Nothing persists until "Save palette"; switching
  to a built-in keeps the stored palette waiting. The contract lives at
  the PUT /account/prefs gate (recommendations.js): theme_custom survives
  the generic prefs merge only as {known 7 slots} × /^#[0-9a-f]{6}$/i —
  non-hex strings, nested objects, unknown keys all die there; theme
  itself is constrained to warm|classic|custom. Client mirrors the gate
  (validPalette) before applying anything as inline CSS variables on
  <html> (beats both :root blocks; cleared on every re-theme), derives
  --bg-rgb/--accent-rgb from the hexes and auto-picks --on-accent by
  luminance (dark text on bright accents, light on dark — matches both
  built-ins) so buttons stay readable; mobile theme-color follows the
  custom bg. Persistence rides the existing prefs JSON — no schema
  change; boot re-applies from the dashboard prefs fetch, with
  bt-theme-custom in localStorage painting it between boot and fetch
  (index.html's pre-paint script still only handles classic — custom
  boots on the warm base for a beat, deliberate: the inline stays tiny).
  En route fix: the account page's seg was hardcoded Warm-selected even
  for Classic-wearing members (the computed `theme` var existed unused) —
  now reflects the stored theme. Smoke: prefs section grows the palette
  gate (valid hex survives + lowercased; javascript:/url(/short-hex/
  object/nested/unknown keys dropped; partial update keeps siblings;
  null clears; junk theme word never reaches the client). Local tokenless
  full suite green Oct 17. **Staged + verified**: deployed to the box,
  live gate probe (junk dropped, hex kept, prefs reset, session removed);
  the household tried it — user: "looks good". **Ship trail (Oct 17):
  snapshot `manual-pre-5-23-palettes-ship-20261017.db` (s55, 2550 books,
  263 notifs — no schema change, ritual only) → this strike → merge →
  prod rebuild → live probe → twin re-export, one motion.**
- ~~**STAGED Oct 16 (late): chatter @-tags (Update 5.22 "Say their name")**~~
  **SHIPPED Oct 16 (night)** —
  typing @ in any chatter composer (book modal or standalone thread) opens
  a member picker above the textarea (arrows/enter/tab/click pick, esc
  closes; list from GET /chatter/mentionable — every hearth account minus
  self, cached per tab; a tag is direct address, not directory browsing,
  so profile_public doesn't gate it). A pick writes "@Name " into the text
  and records the id; the post's mentions[] carries ids pruned at send to
  names still written in the body — deleting the tag text deletes the tag.
  Server (m55: comment_mentions keyed UNIQUE(comment_id, user_id) with
  FK-cascade off comments and users, acked_at, idx on user_id+acked_at;
  notifications CHECK widened with 'mention' via the m41/m51/m54 rebuild —
  schema 55) validates ids against real accounts, drops the author, and
  rings each tagged member ONE 'mention' nudge (payload identical in shape
  to the comment nudge: their own copy's book_id when they have one, else
  work+title for the thread modal) — the generic 'comment' nudge skips
  tagged members so one comment can't double-ring. notify()'s 24h dedupe
  and the bell's per-actor cap carry over unchanged. Acknowledgment is
  defined as *reading the thread*: GET /chatter acks the viewer's mentions
  on comments they can actually see (a spoiler-gated tag waits its turn),
  and that ack is what unpins — /chatter/recent floats un-acked tagged
  rows above the newest-first walk (pinned-first, then id desc; a hidden
  spoiler can't pin what isn't in the visible set), rows gaining
  mentions_you + the page's mention names for snippet chips. notify-ui
  gains the "📌 tagged you on 'X'" bell text; deep link rides the existing
  chain (own copy → book modal loads the thread → acks; else thread
  modal). Client renders tagged names as accent chips in bubbles and
  hearth snippets (matching on escaped text, longest name first, so
  hand-typed lookalikes stay plain — the picker is the contract), a "📌
  you" pill in the thread meta, and a tinted pinned row with "📌 mentioned
  you" on the hearth card. Deliberately out: tappable chip→profile links
  (5.21's modal-link machinery makes that cheap later) and any
  suppress-until-caught-up nudge logic. Smoke: new mentions section
  (mentionable excludes self; dup+bogus ids sanitized to one; exactly one
  'mention' ring and no generic comment ring for the tagged member;
  unread===1; tagged row pinned above a newer untagged comment; spoiler
  tag neither leaks into the hearth card nor steals the pin; thread load
  acks the visible tag and settles it into chronology) + the finish count
  fix 3→6 (the section adds three thread comments) + a boot-time
  orphan-mention sweep joining the defensive sweeps. Local tokenless full
  suite green Oct 16 (CI boot recipe: scratch DB + ABS_LINK_ALLOWLIST +
  cover-proxy extra hosts). **Staged Oct 16 (late)**: CI smoke green on
  both pushes (38a3fb0 feature; b93fac2 — mention bell rows earn the
  inline 👏 like comment rows, same enrich path); schema 55 migrated
  clean on the staging DB (25 notif rows survived the rebuild; snapshot
  `manual-pre-5-22-mention-tags-20261016.db`). Staging env note: the
  in-container full-suite run trips in the ABS section — the container's
  live Hardcover token enriches the mock's imports into real titles
  ("Smoke" by Dan Vyleta ×3), so the title-key assertions miss; the
  canonical full suite stays the local/CI tokenless run (the 5.19
  recipe), and staging's .env now carries ABS_LINK_ALLOWLIST +
  http://127.0.0.1:34877 so the suite can run there when needed
  (loopback inside the container only — no real surface). Browser-
  verified end to end on staging as a throwaway member (invite→signup→
  login): bell badge + the "📌 tagged you on 'Piranesi'" ring with inline
  👏, row deep-link → thread modal (copy-less member path), 📌-you pill +
  accent @chips (visual pass on both), composer @ → picker (self
  excluded, filter, enter-pick writes the picked "@Name "), post
  round-trip rang the tagged member's bell; as Demo Reader (admin
  reset): pinned hearth-card row above newer chatter with the amber tint
  + "📌 mentioned you" pill, click → thread, pin settled after the
  visit. Known edge: a bookless member's dashboard is the onboarding
  hero (no hearth card) — their tag still rings the bell and deep-links
  fine; the pin surface only exists on the full dashboard. All check
  artifacts removed (comments, notifications, throwaway member + its
  invite, minted/logged-in sessions; Demo Reader's password
  re-randomized). **Ship trail (user validated + said ship same night):
  snapshot `manual-pre-5-22-mention-tags-ship-20261016.db` (s54, 2550
  books, 261 notifs) → this strike → merge → prod rebuild → live probe
  → twin re-export, one motion.**
- ~~**STAGED Oct 16 (late): universal search — Update 5.21 "One box"**~~
  **SHIPPED Oct 16 (late)** — a 🔍
  on the nav opens `#search`: Log a book's skeleton (field chips, debounced
  box, result-card grid) minus the logging machinery, recombined with the
  members shelf search. Catalog mode runs the same /search (Hardcover/Google/
  OL) with `owned=1` — owned books are the point here, they surface with your
  chip — and POST /search/hearth annotates each result with the household's
  owners (compare key chain: hardcover_id first, normalized title+author
  otherwise, deduped when both hit; directory privacy profile_public + self;
  owner payload identical to /members/search chips). Card click opens your
  own copy's modal, else the first owner's member preview (notes + chatter),
  else a catalog modal ("Not on any shelf here yet" + description when
  HC-sourced + "Log it yourself →" deep link to #add/title/…); owner chips
  open THAT member's copy. The "in the hearth" tick (persisted per device)
  flips the same page onto /members/search — who-has-what as first-class
  cards instead of the Members sidebar's compact rows. Annotation failures
  degrade quietly to plain catalog cards. Smoke: POST /search/hearth section
  (title-key two owners self-first with own_book_id + invited's S-tier chip,
  hardcover-id key matching across a different title, both-key dedupe, miss
  = null); full suite green on staging. Browser-verified end to end (catalog
  query → chips on the canonical card incl. (you) → own modal → another
  member's preview → hearth tick → catalog modal on an unmatched card); uniform card
  widths, zero overflow. Known quirk carried over from /members/search: a
  work whose copies split between hardcover_id-keyed and title-keyed rows
  shows as two cards in hearth mode (the catalog-mode annotation merges both
  keys and does not split). **Batch 2 (user's follow-up, same update): modal
  links.** All four book modals (own, member preview, thread, catalog) make
  their header text clickable: author → #search/author/…, series →
  #search/series/… (order suffix stays outside the link), the preview's
  shelf-owner name → their profile. One delegated listener on the persistent
  #modal-card closes ANY modal on an in-card hash link before the route
  renders. #search grows the deep-link contract #search/<title|author|
  series>/<q> — prefilled, field chip set, exact like Log a book's links;
  typing stays fuzzy. Every browse-type #add/author|series link (members
  profile shelf + series pills + member TBR, dashboard reading-together +
  series journey, library ×3, compare ×2, TBR) repointed to #search; the
  three log-type "log it yourself" links (#add/title/…) deliberately keep
  going to Log a book. Browser-verified: own-modal author →
  #search/author/Susanna%20Clarke (23 cards, 2 hearth-owned, modal closed,
  Author chip), Piranesi chip → Nadia preview with author→search +
  Nadia→#members/86 both landing right, catalog modal "Log it yourself" →
  #add/title prefilled. Smoke hygiene en route: the boot-time 'Smoke %'
  sweep now also runs in the finally — a green run still left kobo fixtures
  on the (shared, household-visible) staging DB until the next boot swept
  them. **Batch 3 (polish, same update):** catalog modal gains the series
  line in its header (under the author, linking into #search/series, order
  beside it — previously only the body's details line had it); search tiles
  carry the full series info ("author · Series #N", "author · Book N"
  fallback, year otherwise); "collections & samples" tick joins the search
  row — noise hidden stays the DEFAULT (server behavior untouched), the tick
  opts in and persists per device, hides in hearth mode. Browser-verified:
  "Patrick Rothfuss · The Kingkiller Chronicle #2" tile; The Hurricane Wars
  catalog modal head "… | Thea Guanzon | The Hurricane Wars #1 | Not on any
  shelf here yet."; toggle present-unchecked, hidden in hearth mode.
  **Batch 4 (consistency, same update):** the catalog modal and the member
  preview both grow "＋ Add to library" / "📌 Add to TBR" — the profile
  shelf's copy-buttons convention — shown only when the work ISN'T on the
  viewer's shelf. New in_my_library on /members/:id/books/:id/info
  (viewer's same-work copy: hc anchor, then title+author key); preview's
  draft mirrors addTheirBook (their copy's data + hc anchor + lengths);
  catalog modal posts Log a book's batch-add draft (provider-anchored),
  closes into a re-run search so the card carries your chip at once;
  "Log it yourself →" kept for the full-entry path. Smoke: in_my_library
  pinned true where the admin owns a same-work Saga One. Browser-verified:
  Hurricane Wars TBR-add → card instantly shows the "(you)" chip; Piranesi +
  Bedlam previews correctly say "on your shelf" (buttons suppressed);
  Demo Reader's Dune → buttons → add → pill flips. Test books deleted
  after. Shipped Oct 16 (late) after the household's validation: snapshot
  `manual-pre-5-21-one-box-ship-20261016.db` (schema unchanged, 54), merge,
  prod rebuild, twin re-export in the same motion.
- ~~**STAGED Oct 16: chatter spoiler rule + paged hearth feed (Update 5.20
  "Speak freely")**~~ **SHIPPED Oct 16 (late)** — three reported issues, one root system. (1) The spoiler
  gate was over-severe: canSee hid EVERY comment posted ahead of the viewer,
  spoiler or not (a finished reader's plain note was invisible to anyone
  mid-book), and spoilers waited for a 100% finish. Now only a
  spoiler-flagged comment is withheld, and only while its stamped position is
  ahead of the viewer's — spoiler at 75% shows at 75%, plain comments always
  show, and a spoiler from someone who never got into the book (no stamped %)
  shows too. (2) The hearth card had NO gating — /chatter/recent returned raw
  bodies; it now runs every row through the same canSee with the viewer's own
  position per resolved work. (3) "Comments disappeared" — nothing was ever
  deleted (book_comments has no cleanup); the card asked ?limit=6. /recent
  now pages 10 from the visible set within the newest-200 window (the
  thread's own ceiling): page 1 = latest, ‹ page X of Y › walks older (pace
  chevron idiom), over-range clamps, and a muted "🔒 N spoiler comments
  hidden until you catch up" keeps silent gating from reading as vanishing.
  Thread banner/composer copy reworded to the rule. Smoke reworked to the new
  contract (plain-ahead visible + reactable, spoiler-ahead hidden + 403 on
  react, hearth leaks no spoiler / keeps the plain one, no-position spoiler
  visible, finish opens all, paging invariants + clamp, viewer_copy mapping);
  full suite green on staging Oct 16. Also while verifying: the smoke suite
  gained a boot-time 'Smoke %' sweep — kobo-section fixtures (amp, adoptSub,
  the variants, sync-imported rows) never entered the created[] cleanup, so
  any mid-section failure leaked rows that made findBookByTitle match the
  OLDEST same-title row and broke the next run's fold assertions
  (state_updates 0). Staging only, pending household validation.
- ~~**STAGED Oct 16: TBR bumps (Update 5.19 "The gentle nudge")**~~
  **SHIPPED Oct 16 (evening)** — a member's TBR is browsable from their
  profile ("Their TBR 👍" beside "Compare with mine"), every queued book
  carrying a toggleable 👍 (tbr_bumps, m54: keyed owner+book+bumper so bumps
  survive done → re-queued cycles; notifications CHECK widened with 'bump'
  via the m41/m51 rebuild). Owner sees counts + bumper names on their own
  #tbr rows; one bell ring per net bump (notify's 24h dedupe absorbs off/on
  churn). Privacy = profile_public, like the shelf. Verified: CI smoke +
  local tokenless full suite + a throwaway-member live check on the staging
  container; prod snapshot manual-pre-tbr-bumps-ship-20261016.db, schema 54.
- ~~**Update 5.17 batch**~~ **SHIPPED Oct 12, 2026 (evening) as "The common
  room"** — phone card layouts (own Library + member-profile shelves below
  640px), notes public-by-default with the per-note 🔒 (member book previews
  render them), shelf-search owner chips deep-linking into the member's
  book modal + the work's chatter thread (viewer-gated spoilers). Schema 52
  live on prod; twin re-exported with the ship.
- ~~**STAGED: series fix + Who-rates-how links**~~ **SHIPPED Oct 13 (early
  hours) with the streak RECOVERY: schema 53.** Root cause: events.progress_at
  holds only the latest touch, so the day-set rebuilt from current row state
  lost any day a same-book reader touched the day before. Fix = `reading_days`
  table (m53) recorded at every stamp site (noteReadingDay); day-set = table ∪
  created_at ∪ live column. Recovery pass (user-approved, back to the Sept 7
  snapshot boundary, no further): every nightly `booktracker-*.db` ≥ Sept 7
  contributes its per-user visible day-set — INSERT OR IGNORE, additive.
  Who-rates-how names link to profiles (memberCard idiom). Smoke pins the
  two-day same-book regression; staging verified end-to-end (planted
  table-only day → live streak 1→4).
- ~~**STAGED: series 0/0.1 + half-star goodreads**~~ **SHIPPED Oct 13
  (evening) as Update 5.18 "Book zero"** — series positions 0–10000 up to 2
  decimals (three zero-eating saves fixed, decimal validation, toFixed(2)
  sort key), fractional stars in the Goodreads import (StoryGraph rounding
  convention; Fable-via-ShelfBridge files import as-is — column
  compatibility verified against shelfbridge's transformer.py). Public
  update post: docs/update-8.html (5.13→5.18 digest). No migration.
- **Onboarding fallout to nudge:** the Libby member's interrupted import is
  DONE — they re-uploaded themselves Oct 12 evening (227 books, 216 events,
  clean). Remaining: one StoryGraph member's import never landed (4 failed
  attempts, last one Oct 12 ~4pm EDT still tripping the format gate —
  hard-refresh the tab and re-upload; the metadata pool makes it fast).
  A broadcast announcement is drafted for when they should retry.
- **Hardcover capacity (LIVE on prod since Oct 13):** Free tier is
  5,000 requests/day per token, resetting midnight UTC — the exact cap and
  reset ride the 429 headers. Imports consult a cross-member metadata pool
  + 14-day negative cache (hc_misses, m50) before any API call; the first
  daily-shaped 429 trips a circuit breaker (no retry burn — Oct 12 wasted
  ~1,500 requests on 4-retries into the wall); `HARDCOVER_TOKEN_2` adds a
  friend's token as automatic overflow; admin panel has "Fill everyone's
  gaps from Hardcover" (book_refresh all_users, cap-guarded so it stops
  before stamping books it couldn't check) and an Announcement box (bell
  broadcast — the notifications kind CHECK needed the m51 rebuild, shipped
  same night after the first real send failed).
- **Kobo: watch the next syncs** — Update 5.12 shipped Oct 9 (staging→main
  merge + prod deploy in one motion, schema 48 live on prod, snapshot
  `manual-pre-pairing-ship-20261009.db`): device pairing, the Kobo
  round-three repair, the board's include-book-list export, and the DNF
  badge together. The one member's shelf is single-row (the Oct 4 replay's
  duplicate
  Butter/Out were deleted with a snapshot first), and her real "Out" finish
  hasn't been pushed by her device yet: when it arrives it must dedupe
  silently onto the hand-finished row (the ent_map author was normalized so
  even prod's pre-ship matcher folds it). Job counters to eyeball:
  `token_held`, `stale_skipped`, `finished_deduped`.
- ~~**Libby import: first real run through the UI**~~ **DONE Oct 12, 2026** —
  the member's re-upload after the deploy interruption: 227 books, 184
  Hardcover-matched + 25 from the pool, 216 events, all dated. The
  borrow-log-scale validation landed clean.
- **StoryGraph import: first real runs happened Oct 12** (onboarding wave:
  an 831-book import with 603 HC matches, 572 events, 253 TBR; a re-upload
  of the same file deduped perfectly — 831 imported / 831 skipped / 0
  events). Reviews-as-notes validated at whole-library scale.
- A member's two deliberately-kept same-title pairs ("God in the Machine",
  "The Light We Lost") + ~7 null-id Kobo rows remain by her call.
- ~~Public-twin re-export~~ **re-exported and pushed Oct 12 with the 5.17
  ship** (twin current with private main as of Update 5.17).
- Declined "for now" (user call): usability bundle (keyboard a11y, numeric %
  input), efficiency bundle (hcNorm precompute, route splitting, icon diet); parked
  transactional imports; cosmetic timezone normalization of imported dates.
- Charts/UI library choice — deferred until something outgrows hand-rolled SVG.
- Whether Hardcover needs a fallback for niche titles — judge after real usage.
- Library listing scale (five correlated per-book subqueries, JS-side filtering)
  — fine at small-instance scale (hundreds of books); revisit with query plans
  if the library grows ~10×.
