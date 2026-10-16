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
