#!/usr/bin/env bash
# Build a sanitized snapshot for the PUBLIC repo (fresh history, no private
# data). The private repo stays the ops home; this script never pushes —
# creating the public repo is a deliberate manual step (instructions at the
# end). Run from anywhere; operates on this checkout's HEAD.
#
#   scripts/make-public-export.sh
#
# What it does:
#   1. exports the tracked tree of HEAD (gitignored/private files can't ride
#      along) to dist/booktracker-public/
#   2. PATTERN GATE — greps the export for every identifier the privacy audit
#      flagged (names, paths, domains, key shapes). Any hit aborts.
#   3. inits a fresh git history: ONE commit, authored with the GitHub
#      noreply identity (never a personal email).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist/booktracker-public"
NOREPLY="286784774+Gorkimus@users.noreply.github.com"

# Every pattern the Sept 21, 2026 privacy audit established as a leak.
# Case-insensitive. Extend this list, never shorten it without re-auditing.
GATE_RE='pabs-media|pabslab|psanders|\bpabs\b|/home/|C:[/\\]+users|192\.168\.|gracie|lorenzo|polese|jfreak93|turd|coldin|marcio|serene|pablo|discord|@gmail|AIzaSy[a-z0-9_-]|hc_pat_|eyJhbGci|ssh-ed25519 AAAA|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]'

echo "==> Exporting tracked tree of $(git -C "$ROOT" rev-parse --short HEAD)"
rm -rf "$DIST"
mkdir -p "$DIST"
git -C "$ROOT" archive --format=tar HEAD | tar -x -C "$DIST"

echo "==> Pattern gate"
# The script itself is excluded: its pattern list IS the audit vocabulary —
# those identifiers have to appear here to be gated, and the script ships
# publicly so the gate is self-documenting.
if grep -rIinE "$GATE_RE" --exclude=make-public-export.sh "$DIST" > /tmp/public-export-gate.txt 2>&1; then
  echo "!!! GATE FAILED — private identifiers found in the export:"
  cat /tmp/public-export-gate.txt
  echo "!!! Fix the source files (or extend exclusions deliberately), then re-run."
  exit 1
fi
echo "    clean — none of the audited identifiers present"

echo "==> Fresh single-commit history (noreply author)"
git -C "$DIST" init -q -b main
git -C "$DIST" add -A
GIT_AUTHOR_NAME="Gorkimus" GIT_AUTHOR_EMAIL="$NOREPLY" \
GIT_COMMITTER_NAME="Gorkimus" GIT_COMMITTER_EMAIL="$NOREPLY" \
  git -C "$DIST" commit -q -m "Update public mirror"

# The public twin is a mirror of gated snapshots: each export replaces its
# whole history, so the remote is re-added here and pushes are --force by
# design. Still never pushed automatically.
git -C "$DIST" remote add origin https://github.com/Gorkimus/InkHearth.git

FILES=$(git -C "$DIST" ls-files | wc -l | tr -d ' ')
echo "==> Done: $DIST ($FILES files, commit $(git -C "$DIST" rev-parse --short HEAD))"

cat <<'NEXT'

Update the public repo (manual, deliberate — this script never pushes):
  cd dist/booktracker-public
  git push --force origin main

Pre-publish eyes (2 minutes): skim the export tree once — README, CHANGELOG,
docs/, .github/ — and confirm no new personal references slipped in since the
audit. The private repo must NEVER be flipped public: its history carries the
audited identifiers.
NEXT
