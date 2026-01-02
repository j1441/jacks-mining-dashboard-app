# Umbrel App Examples

Real-world examples of Umbrel apps, from simple to complex.

## Example 1: Simple Single-Container App (Mining Dashboard)

A basic web app with no dependencies, persistent data storage, and WebSocket support.

### Directory Structure
```
mining-dashboard/
├── umbrel-app.yml
├── docker-compose.yml
└── Dockerfile
```

### umbrel-app.yml
```yaml
manifestVersion: 1
id: mining-dashboard
name: Mining Dashboard
category: automation
version: "1.0.0"
port: 3456
tagline: Monitor and control your home heating miner
icon: https://raw.githubusercontent.com/j1441/jacks-mining-dashboard-app/main/icon.svg
description: >-
  Monitor your Antminer running Braiins OS with a clean, modern web interface.
  Perfect for home heating applications with real-time statistics and power control.


  Features:

  • Real-time hashrate, temperature, and performance monitoring

  • Power profile control (Low/Medium/High)

  • Pool statistics and connection status

  • WebSocket-based live updates every 5 seconds

  • Clean, responsive dark theme interface


  Requirements:

  • Antminer running Braiins OS

  • Network access to miner's CGMiner API (port 4028)
developer: j1441
website: https://github.com/j1441/jacks-mining-dashboard-app
dependencies: []
repo: https://github.com/j1441/jacks-mining-dashboard-app
support: https://github.com/j1441/jacks-mining-dashboard-app/issues
gallery: []
path: ""
defaultUsername: ""
defaultPassword: ""
releaseNotes: ""
submitter: j1441
submission: https://github.com/j1441/jacks-mining-dashboard-app
```

### docker-compose.yml
```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: mining-dashboard_web_1
      APP_PORT: 3456

  web:
    image: j73642/mining-dashboard-app:v1.2.00@sha256:9a3bccf0c178d1774ff92b40232c1f255c2b0dfc7a9e7bd2aa0e0d501724de61
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/data:/data
    environment:
      NODE_ENV: production
      PORT: 3456
      DATA_DIR: /data
```

### Dockerfile
```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application files
COPY server.js .
COPY public ./public

# Expose port
EXPOSE 3456

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3456/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Run as non-root user
USER 1000

# Start the application
CMD ["node", "server.js"]
```

### Key Takeaways
- Simple, single-container setup
- Persistent data with `${APP_DATA_DIR}`
- Health check for monitoring
- Runs as non-root user (1000)
- Clean separation of config and code

---

## Example 2: Bitcoin Explorer (With Dependencies)

An app that depends on Bitcoin Core and Electrum server.

### umbrel-app.yml
```yaml
manifestVersion: 1
id: btc-rpc-explorer
name: BTC RPC Explorer
category: finance
version: "3.3.0"
port: 3002
tagline: Simple, database-free blockchain explorer
description: >-
  BTC RPC Explorer is a full-featured, self-hosted explorer for the
  Bitcoin blockchain. With this explorer, you can explore not just the
  blockchain database, but also explore the functional capabilities of your
  Umbrel.


  It comes with a network summary dashboard, detailed view of blocks,
  transactions, addresses, along with analysis tools for viewing stats on
  miner activity, mempool summary, with fee, size, and age breakdowns.


  You can also search by transaction ID, block hash/height, and addresses.
developer: Dan Janosik
website: https://explorer.btc21.org
dependencies:
  - bitcoin
  - electrs
repo: https://github.com/janoside/btc-rpc-explorer
support: https://github.com/janoside/btc-rpc-explorer/discussions
gallery:
  - 1.jpg
  - 2.jpg
  - 3.jpg
path: ""
defaultUsername: ""
defaultPassword: ""
releaseNotes: >-
  Dark mode is finally here! Easily switch between your preferred mode
  in one click.


  This version also includes lots of minor styling improvements, better
  error handling, and several bugfixes.
submitter: Umbrel
submission: https://github.com/getumbrel/umbrel/pull/334
```

### docker-compose.yml
```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: btc-rpc-explorer_web_1
      APP_PORT: 8080

  web:
    image: getumbrel/btc-rpc-explorer:v2.0.2@sha256:f8ba8b97e550f65e5bc935d7516cce7172910e9009f3154a434c7baf55e82a2b
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    environment:
      PORT: 8080

      # Bitcoin Core connection details
      BTCEXP_BITCOIND_HOST: ${APP_BITCOIN_NODE_IP}
      BTCEXP_BITCOIND_PORT: ${APP_BITCOIN_RPC_PORT}
      BTCEXP_BITCOIND_USER: ${APP_BITCOIN_RPC_USER}
      BTCEXP_BITCOIND_PASS: ${APP_BITCOIN_RPC_PASS}

      # Electrum connection details
      BTCEXP_ELECTRUMX_SERVERS: "tcp://${APP_ELECTRS_NODE_IP}:${APP_ELECTRS_NODE_PORT}"

      # App Config
      BTCEXP_HOST: 0.0.0.0
      DEBUG: "btcexp:*,electrumClient"
      BTCEXP_ADDRESS_API: electrumx
      BTCEXP_SLOW_DEVICE_MODE: "true"
      BTCEXP_NO_INMEMORY_RPC_CACHE: "true"
      BTCEXP_PRIVACY_MODE: "true"
      BTCEXP_NO_RATES: "true"
      BTCEXP_RPC_ALLOWALL: "false"
      BTCEXP_BASIC_AUTH_PASSWORD: ""
```

### Key Takeaways
- Uses `dependencies` to require Bitcoin and Electrum
- Accesses Bitcoin via Umbrel-provided environment variables
- No persistent data needed (reads from Bitcoin Core)
- Configuration through environment variables

---

## Example 3: Full-Stack App with Database

A more complex app with separate frontend, backend, and database.

### Directory Structure
```
my-app/
├── umbrel-app.yml
├── docker-compose.yml
└── exports.sh (optional)
```

### umbrel-app.yml
```yaml
manifestVersion: 1
id: my-fullstack-app
name: My Full Stack App
category: automation
version: "1.0.0"
port: 3000
tagline: A full-stack application example
description: >-
  This is a complete full-stack application running on Umbrel with:

  • React frontend

  • Node.js/Express backend API

  • PostgreSQL database

  • Redis for caching
developer: Your Name
website: https://example.com
dependencies: []
repo: https://github.com/user/repo
support: https://github.com/user/repo/issues
gallery: []
path: ""
defaultUsername: ""
defaultPassword: ""
releaseNotes: ""
submitter: your-github-username
submission: https://github.com/user/repo
```

### docker-compose.yml
```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: my-fullstack-app_web_1
      APP_PORT: 3000

  web:
    image: user/my-app-frontend:v1.0.0@sha256:frontend-digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    depends_on:
      - api
    environment:
      REACT_APP_API_URL: http://my-fullstack-app_api_1:4000

  api:
    image: user/my-app-backend:v1.0.0@sha256:backend-digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    depends_on:
      - db
      - redis
    volumes:
      - ${APP_DATA_DIR}/uploads:/app/uploads
    environment:
      NODE_ENV: production
      PORT: 4000
      DATABASE_URL: postgresql://postgres:${APP_PASSWORD}@my-fullstack-app_db_1:5432/myapp
      REDIS_URL: redis://my-fullstack-app_redis_1:6379
      JWT_SECRET: ${APP_SEED}
      UPLOAD_DIR: /app/uploads
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  db:
    image: postgres:14-alpine@sha256:postgres-digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/postgres:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${APP_PASSWORD}
      PGDATA: /var/lib/postgresql/data/pgdata

  redis:
    image: redis:7-alpine@sha256:redis-digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 30s
    volumes:
      - ${APP_DATA_DIR}/redis:/data
    command: redis-server --appendonly yes
```

### Key Takeaways
- Multi-service architecture with depends_on
- Database and cache with persistent storage
- Uses `${APP_PASSWORD}` for database credentials
- Uses `${APP_SEED}` for JWT secret (deterministic)
- Health check on API service
- Separate volumes for different data types

---

## Example 4: Worker Queue App

App with web frontend and background workers.

### docker-compose.yml
```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: queue-app_web_1
      APP_PORT: 3000

  web:
    image: user/queue-app:v1.0.0@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    depends_on:
      - redis
    command: ["npm", "run", "start:web"]
    environment:
      NODE_ENV: production
      PORT: 3000
      REDIS_URL: redis://queue-app_redis_1:6379

  worker:
    image: user/queue-app:v1.0.0@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 2m  # Longer for graceful job completion
    depends_on:
      - redis
    command: ["npm", "run", "start:worker"]
    volumes:
      - ${APP_DATA_DIR}/processed:/app/processed
    environment:
      NODE_ENV: production
      REDIS_URL: redis://queue-app_redis_1:6379
      WORKER_CONCURRENCY: "2"

  redis:
    image: redis:7-alpine@sha256:redis-digest
    user: "1000:1000"
    restart: on-failure
    volumes:
      - ${APP_DATA_DIR}/redis:/data
    command: redis-server --appendonly yes
```

### Key Takeaways
- Same image, different commands for web and worker
- Longer stop grace period for workers
- Shared Redis for job queue
- Worker can process jobs in background

---

## Example 5: Bitcoin/Lightning App

App that integrates with both Bitcoin Core and Lightning Network.

### umbrel-app.yml
```yaml
manifestVersion: 1
id: lightning-app
name: Lightning App
category: finance
version: "1.0.0"
port: 3000
tagline: Manage your Lightning channels
description: >-
  A comprehensive Lightning Network management interface.


  Features:

  • Channel management

  • Payment history

  • Invoice generation

  • Balance monitoring


  Requirements:

  • Bitcoin Core

  • Lightning Network (LND)
developer: Your Name
website: https://example.com
dependencies:
  - bitcoin
  - lightning
repo: https://github.com/user/repo
support: https://github.com/user/repo/issues
gallery: []
releaseNotes: ""
submitter: your-username
submission: https://github.com/user/repo
```

### docker-compose.yml
```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: lightning-app_web_1
      APP_PORT: 3000

  web:
    image: user/lightning-app:v1.0.0@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/data:/data
      - ${APP_LIGHTNING_NODE_DATA_DIR}:/lnd:ro  # Read-only access to LND
    environment:
      NODE_ENV: production
      PORT: 3000

      # Bitcoin Core
      BITCOIN_HOST: ${APP_BITCOIN_NODE_IP}
      BITCOIN_RPC_PORT: ${APP_BITCOIN_RPC_PORT}
      BITCOIN_RPC_USER: ${APP_BITCOIN_RPC_USER}
      BITCOIN_RPC_PASS: ${APP_BITCOIN_RPC_PASS}

      # Lightning (LND)
      LND_HOST: ${APP_LIGHTNING_NODE_IP}
      LND_GRPC_PORT: ${APP_LIGHTNING_NODE_GRPC_PORT}
      LND_REST_PORT: ${APP_LIGHTNING_NODE_REST_PORT}

      # LND Certificate and Macaroon paths
      LND_CERT_FILE: /lnd/tls.cert
      LND_MACAROON_FILE: /lnd/data/chain/bitcoin/mainnet/admin.macaroon

      # Data directory
      DATA_DIR: /data
```

### Key Takeaways
- Requires both `bitcoin` and `lightning` dependencies
- Read-only mount of LND data directory
- Access to LND certificates and macaroons
- Uses all Bitcoin and Lightning environment variables

---

## Example 6: App with Custom Networking Needs

App that needs to expose additional ports.

### docker-compose.yml
```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: custom-network-app_web_1
      APP_PORT: 3000

  web:
    image: user/custom-app:v1.0.0@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    ports:
      # Expose P2P port for direct connections
      - 8333:8333
      # Expose metrics port (Prometheus)
      - 9090:9090
    environment:
      HTTP_PORT: 3000
      P2P_PORT: 8333
      METRICS_PORT: 9090
```

### Key Takeaways
- Exposes additional ports beyond web UI
- Useful for P2P protocols, metrics, APIs
- Still uses app_proxy for web UI

---

## Example 7: App with Environment Export (exports.sh)

Share environment variables with other apps.

### Directory Structure
```
my-service/
├── umbrel-app.yml
├── docker-compose.yml
└── exports.sh
```

### exports.sh
```bash
#!/bin/bash

# Export this app's API endpoint for other apps to use
export APP_MY_SERVICE_API_URL="http://my-service_web_1:3000/api"

# Export API key (using APP_PASSWORD as the key)
export APP_MY_SERVICE_API_KEY="${APP_PASSWORD}"

# Export version
export APP_MY_SERVICE_VERSION="1.0.0"
```

### How Other Apps Can Use It

In another app's `docker-compose.yml`:
```yaml
services:
  web:
    environment:
      # These variables are available from exports.sh
      MY_SERVICE_URL: ${APP_MY_SERVICE_API_URL}
      MY_SERVICE_KEY: ${APP_MY_SERVICE_API_KEY}
```

### Key Takeaways
- `exports.sh` makes variables available to other apps
- Useful for creating service ecosystems
- Must be executable (`chmod +x exports.sh`)

---

## Example 8: Development vs Production Configuration

Using different images or configs for dev/prod.

### docker-compose.yml
```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: dev-app_web_1
      APP_PORT: 3000

  web:
    # Production image with digest
    image: user/app:v1.0.0@sha256:production-digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/data:/data
    environment:
      NODE_ENV: production
      PORT: 3000
      LOG_LEVEL: warn
      ENABLE_DEBUG: "false"

  # Development service (commented out for production)
  # dev:
  #   image: user/app:dev
  #   user: "1000:1000"
  #   volumes:
  #     - ${APP_DATA_DIR}/data:/data
  #     - ./src:/app/src  # Mount source for hot reload
  #   environment:
  #     NODE_ENV: development
  #     PORT: 3000
  #     LOG_LEVEL: debug
  #     ENABLE_DEBUG: "true"
```

### Key Takeaways
- Separate configs for dev and prod
- Dev can mount source code for live reload
- Production uses pinned digest
- Environment variables control behavior

---

## Common Patterns Summary

### Single Container (Simple)
```yaml
app_proxy -> web (+ data volume)
```

### With Database
```yaml
app_proxy -> web -> db (+ data volumes)
```

### With Cache
```yaml
app_proxy -> web -> redis (+ data volumes)
```

### Full Stack
```yaml
app_proxy -> web -> api -> db + redis (+ data volumes)
```

### With Workers
```yaml
app_proxy -> web -> worker -> redis (+ data volumes)
```

### Bitcoin/Lightning Integration
```yaml
app_proxy -> web (+ read-only bitcoin/lightning mounts)
```

---

## Building Multi-Architecture Images

Example commands for all the above apps:

```bash
# Navigate to your app directory
cd my-app

# Create and use buildx builder
docker buildx create --use

# Build and push multi-arch image
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --tag your-dockerhub-user/app:v1.0.0 \
  --output "type=registry" \
  .

# Get multi-arch digest
docker buildx imagetools inspect your-dockerhub-user/app:v1.0.0 --raw | \
  sha256sum | awk '{print $1}'

# Use in docker-compose.yml
# image: your-dockerhub-user/app:v1.0.0@sha256:<digest-from-above>
```

---

## Testing Checklist

For all examples above, test:

1. **Installation**
   - [ ] App installs successfully
   - [ ] All dependencies are met
   - [ ] No error messages in logs

2. **Functionality**
   - [ ] Web UI is accessible
   - [ ] All features work as expected
   - [ ] API endpoints respond correctly

3. **Data Persistence**
   - [ ] Stop/start app - data persists
   - [ ] Restart device - data persists
   - [ ] Uninstall/reinstall - data is cleared

4. **Permissions**
   - [ ] No permission errors in logs
   - [ ] Files are created with correct ownership
   - [ ] Read/write operations work

5. **Dependencies** (if applicable)
   - [ ] Bitcoin connection works
   - [ ] Lightning connection works
   - [ ] Database connection works

6. **Resource Usage**
   - [ ] CPU usage is reasonable
   - [ ] Memory usage is stable
   - [ ] Disk space is managed properly

---

## See Also

- [SKILL.md](SKILL.md) - Main Umbrel app development guide
- [MANIFEST_REFERENCE.md](MANIFEST_REFERENCE.md) - umbrel-app.yml field reference
- [DOCKER_COMPOSE_GUIDE.md](DOCKER_COMPOSE_GUIDE.md) - Docker Compose patterns
