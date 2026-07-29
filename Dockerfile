FROM node:22-alpine

# The version CI is publishing this image as. It is the store/umbrel-app.yml
# version, which package.json does not track, so it has to come in from the
# build rather than out of the source tree. server.js falls back to
# package.json when this is unset (local `docker build`, `node server.js`).
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Application files
COPY server.js .
COPY lib ./lib
COPY public ./public
COPY proto ./proto

EXPOSE 3456

# /health returns 503 if any controller loop has stalled (see DESIGN.md §3.5);
# real recovery is the in-process watchdog + restart:on-failure, this is visibility.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3456/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

USER 1000

CMD ["node", "server.js"]
