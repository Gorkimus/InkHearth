FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Run unprivileged: the container shares a Docker network with ABS (and
# whatever else joins it), so a compromise shouldn't land as root. The app
# only writes to /app/data and /app/backups — chown those volumes to UID 1000
# on the host (node's uid) when adopting this.
USER node

# SQLite lives here — mount a volume for it.
VOLUME ["/app/data"]
EXPOSE 3222

CMD ["node", "server/index.js"]
