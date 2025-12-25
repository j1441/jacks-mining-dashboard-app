FROM node:18-alpine

# Install su-exec for proper user switching
RUN apk add --no-cache su-exec

# Set working directory

WORKDIR /app

# Copy package files

COPY package*.json ./

# Install production dependencies only

RUN npm ci --only=production

# Copy application files

COPY server.js .
COPY public ./public

# Copy and setup entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose port

EXPOSE 3456

# Add health check

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 CMD node -e "require('http').get('http://localhost:3456/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Use entrypoint to set up permissions before running as node user

ENTRYPOINT ["/entrypoint.sh"]

# Start the application

CMD ["node", "server.js"]
