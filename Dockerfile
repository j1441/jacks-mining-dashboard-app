FROM node:18-alpine

# Set working directory

WORKDIR /app

# Copy package files

COPY package*.json ./

# Install production dependencies only

RUN npm ci –only=production

# Copy application files

COPY server.js .
COPY public ./public

# Create data directory with proper permissions

RUN mkdir -p /app/data && chmod 777 /app/data

# Expose port

EXPOSE 3456

# Add health check

HEALTHCHECK –interval=30s –timeout=10s –start-period=5s –retries=3   
CMD node -e “require(‘http’).get(‘http://localhost:3456/health’, (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})”

# Run as non-root user for security

USER node

# Start the application

CMD [“node”, “server.js”]
