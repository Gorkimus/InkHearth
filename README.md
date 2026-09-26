# 📚 InkHearth

A self-hosted home for your reading life. Log everything you read **and** listen to,
rate it with S–D tier lists, watch years of reading turn into statistics that actually
mean something — and share the journey with the people you live with (or just swap
book recommendations with). Your server, your data, no subscription.

**The idea in one sentence:** audiobooks are reading — InkHearth counts them
equally, in one "words read" number, and then makes that history useful: statistics,
tier lists, a to-read queue, taste-matched recommendations, and a private social
layer for your own circle of readers.

See [PLAN.md](PLAN.md) for the product plan and decision log.

## What it does

**Track — logging a book takes ~15 seconds**

- Search a title (Google Books, Open Library and Hardcover, merged and ranked) —
  cover, series, page count, genres and moods fill themselves in. Or 📷 scan the
  barcode on a paper book.
- Reads and listens are equals: every entry carries a format, a medium
  (physical / ebook / audiobook / library — or your own, like "graphic
  audio"), a tier rating (S–D), an optional separate narration rating, and
  optional dates, notes and tags. DNFs count too, proportionally.
- Import stamped everything with the import day? Tick rows in the Library
  (or the header ☑ for everything shown) and **set read date unknown** — or
  type a year and **set year** to land them roughly — in one go. Entries and
  ratings stay; they just stop claiming a precise finish date.
- Books Hardcover doesn't list at all (novellas, niche editions) can be marked
  **No HC profile** in their detail panel — they stop flagging "needs
  re-pull", and a re-pull then fills any missing cover/pages from Google
  Books instead.
- **Audiobookshelf, linked to you** — link your own ABS account (Account →
  Audiobookshelf) and your listening progress tracks itself: part-listened
  books appear on your dashboard with live percentages and finishes date
  themselves on sync (hourly, or 🔄 Sync now). Sharing one ABS server with the
  household? Everyone can enter the same details — progress stays per person.
- A now-reading hero sits on the dashboard: progress bar, estimated hours/pages
  left, one-tap **+10% / Finish / DNF / Pause**.
- A TBR queue with a ⭐ next-up, "in the mood for…" chips, and a 🎲 surprise-me.

**Remember — your history becomes answers**

- Dashboard: books, words, pages and hours; monthly pace; a GitHub-style
  activity heatmap; reading streaks; yearly goals with progress rings; momentum
  vs your 3-month pace; breakdowns by format, genre, author, narrator, tier,
  tag and mood. Every section is toggleable per user.
- Year in review: a full stats page per year plus a slide-deck **story mode**
  you can export as an image.
- Series journey: "4 of 6 · next: *Dark Age*" — the next installment is one tap
  from your TBR.
- Your **average rating** across all rated books (weighted D=1 … S=5, shown as
  "B (3.4)") — and, on the Members page, everyone's, so the household can see
  who rates generously and who's a harsh grader.

**Discover — recommendations that know your tiers**

- The **For you** page builds a taste digest from your tiers, series, DNFs and
  narrators, asks an LLM for candidates, then **verifies every pick against
  Hardcover** so no ghost titles slip in. Dials for adventure level, length,
  series vs standalones and count; "Not for me" steers future runs.
- Works with the host's shared key, or your own free
  [Google AI Studio](https://aistudio.google.com/apikey) key (Account →
  Recommendations — free, no card, quota is yours alone; the in-app guide walks
  you through it).

**Together — social, but only with your people**

- Every account gets an invite link, its own private library, and an avatar.
- **Members**: browse everyone's shelf, recent activity, and per-member profiles
  with series rollups.
- **Reading together**: star your people (a private friends circle) and their
  in-progress books appear with live progress bars — see the household moving
  through the same series, and queue anything that looks good with one tap.
- **Compare**: consent-gated taste comparisons — a **Reading Chemistry** score
  with per-genre chemistry bars (shared ratings calibrated to how generously
  each of you rates overall; small overlaps stay near the middle), per-book
  rating deltas, series agreement, and this year's race (books / words / hours /
  streak) — plus read-only views of each other's tier boards and a PNG export.
- The activity feed knows your shelf: "finished *X*" rows flag when the book is
  already in your TBR and offer a one-tap **TBR it too**.

**Yours — private by default, boring to operate**

- One container, one SQLite file. No telemetry, no accounts on anyone else's
  platform — catalog metadata is looked up from public sources when you save,
  and that's all that leaves the box.
- Two privacy switches, honestly scoped: *public profile* (appear on the
  Members page) and *share my tiers* (allow comparisons). Nothing else — dates,
  notes, formats, TBR — ever crosses accounts.
- Silent nightly backups, per-account point-in-time restore (admin), and a
  one-click **download my data** export.
- Installable PWA: add to home screen, browse offline.

## Bring your history

| Source | How |
|---|---|
| **Goodreads** | Export your library CSV (My Books → Import/Export) and upload it. Star ratings map onto S–D tiers, shelves become tags, books are verified against Hardcover, re-uploads can't double-count. |
| **Kobo** | Upload the device's `KoboReader.sqlite` (reading progress suggests finished/reading), then optionally keep the device linked so new progress syncs itself. |
| **Audible** | Audible has no export button, so use any helper app (Libation, OpenAudible, the Audible Library Extractor extension, Amazon's data archive) and upload the file. The app never sees your Amazon login. |
| **Audiobookshelf** | Admin pull from a configured ABS server: real runtimes, narrators, locally-stored covers. |
| **Paper books** | Barcode scan or a 15-second search; or backfill past reads in Memory lane with just title + year + tier. |

## Run it

On whichever machine hosts the app:

```bash
docker compose up -d --build     # → http://localhost:3222, data in ./data
```

or bare-metal:

```bash
npm install
npm start                        # → http://localhost:3222
```

**First boot**: the server prints a one-time *claim link* in its console — open
it to set the admin account's name and password. Then invite people: admin →
name menu (top right) → **Invites** → create link (shown once, works for exactly
one signup, revocable). Forgot-password links come from the same page; there is
no email flow by design.

Stack: Node 24 (built-in `node:sqlite`), Express, vanilla JS SPA, no build step.
The only npm dependency is Express.

## Configuration

Copy `.env.example` to `.env`. All keys are optional unless noted:

| Key | Purpose |
|---|---|
| `PORT` | HTTP port (default 3222) |
| `COOKIE_SECURE` | `1` when serving over https (tunnel/deployment) so the session cookie carries the Secure flag. Leave empty on plain-http localhost. |
| `TRUST_PROXY` | `1` when the app runs behind a reverse proxy (nginx/caddy/tunnel), so the login rate limit keys on the real client IP instead of the proxy's. Leave empty on direct access. |
| `HARDCOVER_TOKEN` | [hardcover.app](https://hardcover.app) API token (free). Fills missing page counts and real audiobook runtimes, series, genres and moods. |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Server-wide key for **For you** recommendations (OpenAI-compatible; free Google AI Studio works — guide in PLAN.md). Members can add personal keys in Account, which take priority. |
| `ABS_URL` / `ABS_API_TOKEN` / `ABS_LIBRARY_ID` | Audiobookshelf — powers the admin library pull (runtimes, narrators, covers). |
| `ABS_LINK_ALLOWLIST` | Admin-sanctioned Audiobookshelf origins (comma-separated, e.g. `http://192.0.2.9:13378` — a documentation address) that skip the member-server rules — the http/LAN escape hatch. Members can otherwise link any **https://** ABS server that resolves publicly; their server must be reachable from *this app's* server. |
| `INSTANCE_LABEL` | Shown in the tab title and header ("STAGING") when running two instances side by side. |
| `KOBO_SYNC_HOURS` | Hours between automatic Kobo device polls (default 6; `0` disables). |
| `BACKUP_HOURS` / `BACKUP_KEEP` | Silent nightly snapshot cadence and how many auto-snapshots to keep (defaults 24 / 60). |
| `CLEANUP_HOURS` | Nightly janitor — expired sessions, day-old uploads (Kobo device databases carry live sync credentials), stale `data/tmp` (default 12; `0` disables). |

## Word math, honestly

No public book API exposes real word counts (verified against Hardcover's
schema), so words are estimates: pages × 275, audio runtime × ~9,300 words/hour,
flagged `≈` in the UI. Audio counts at 1× playback speed — listening faster
doesn't inflate your total. DNFs count proportionally — abandoned at 40% counts
40%. Books with no length data still count as read, with a nudge to add pages or
runtime for word credit.

## Deploying for real

- All state lives in `./data` (SQLite + covers) — back that directory up, or
  rely on the built-in snapshots in `./backups`.
- The container runs unprivileged (UID 1000). If your `./data` / `./backups`
  were written by an older root-running container, chown them once on the
  host before the first `USER node` deploy: `docker run --rm -v "$PWD/data:/d" -v "$PWD/backups:/b" alpine chown -R 1000:1000 /d /b`.
- **Behind an https tunnel**, set `COOKIE_SECURE=1` before starting. Any
  reverse proxy works; for Cloudflare tunnels point an ingress hostname at the
  container's port — e.g. `http://booktracker:3222` when cloudflared shares
  the app's Docker network. Prod publishes on loopback only for exactly that
  reason: the tunnel never needs the host port, and nothing else on the LAN
  should get a plain-HTTP copy of the app.
- **Updates**: `git pull && docker compose up -d --build` (run on the server).
  The PWA picks the new version up on the next refresh (network-first service
  worker; an "app was updated" toast confirms).
- Want a second, isolated instance for testing updates before they go live?
  `docker-compose.staging.yml` runs the same image against a separate
  `./data-staging` volume on port 3223 — published on loopback plus your
  `LAN_IP` from `.env`, so tunnel-free validation at `http://<LAN-IP>:3223`
  keeps working while every other interface stays closed.

## Development

```bash
node scripts/smoke-test.js   # delta-based API test, safe against live data
```

PRs and forks welcome — the codebase is deliberately small and readable: one
Express server (`server/index.js`), a migration runner (`server/db.js`), an
in-process jobs system, and a no-build vanilla-JS SPA under `public/`.

Licensed under the [GPL-3.0-or-later](LICENSE).
