FROM node:22-alpine

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
