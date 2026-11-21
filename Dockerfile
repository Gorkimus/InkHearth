FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# su-exec: the tiny alpine setuid tool the entrypoint uses to drop to node.
RUN apk add --no-cache su-exec && chmod +x /usr/local/bin/entrypoint.sh

# The container starts as root ONLY so the entrypoint can fix bind-mount
# ownership (Docker creates missing ./data and ./backups as root on a fresh
# clone; the app would fail to open its database). The server itself always
# runs as node (UID 1000) via su-exec — a compromise never lands as root,
# which matters on shared networks like the ABS one.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# SQLite lives here — mount a volume for it.
VOLUME ["/app/data"]
EXPOSE 3222

CMD ["node", "server/index.js"]
