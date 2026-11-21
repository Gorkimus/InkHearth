#!/bin/sh
# First-boot ownership fix, then drop to the unprivileged user.
#
# Docker creates missing bind-mount directories (./data, ./backups on a fresh
# clone) as ROOT, while the app runs as node (UID 1000) — without this, a
# stock `docker compose up` dies with "unable to open database file". Also
# heals older setups whose volumes were written by root-running containers.
# The app process itself never runs as root: su-exec swaps to node:node
# before exec'ing the server.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data /app/backups 2>/dev/null || true
  exec su-exec node:node "$@"
fi
# Started unprivileged already (bare docker run -u, k8s, etc.) — go direct.
exec "$@"
