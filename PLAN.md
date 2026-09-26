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
**B** = liked it; **C** = fine / forgettable; **D** = disliked or DNF. DNF books still
get a tier.

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

- Charts/UI library choice — deferred until something outgrows hand-rolled SVG.
- Whether Hardcover needs a fallback for niche titles — judge after real usage.
- Library listing scale (five correlated per-book subqueries, JS-side filtering)
  — fine at small-instance scale (hundreds of books); revisit with query plans
  if the library grows ~10×.
