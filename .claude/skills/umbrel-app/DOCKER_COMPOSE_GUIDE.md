# Docker Compose Guide for Umbrel Apps

Complete reference for creating `docker-compose.yml` files for Umbrel apps.

## Basic Structure

Every Umbrel app's `docker-compose.yml` must follow this structure:

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: <app-id>_<service-name>_1
      APP_PORT: <port-number>

  # Your main service
  web:
    image: user/image:tag@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/data:/data
    environment:
      # Your app's environment variables
```

## Required Services

### app_proxy Service

**Purpose**: Routes traffic from Umbrel's web UI to your app

**Required Configuration**:
```yaml
services:
  app_proxy:
    environment:
      # Format: <app-id>_<service-name>_1
      APP_HOST: mining-dashboard_web_1
      APP_PORT: 3456
```

**Critical Rules**:
1. `APP_HOST` must follow exact format: `<app-id>_<service-name>_1`
2. The `_1` suffix is required (Docker Compose naming convention)
3. Must match your actual service name (usually `web`)
4. `APP_PORT` must match the port your app listens on internally

**Common Mistakes**:
```yaml
# Wrong - missing _1
APP_HOST: my-app_web

# Wrong - wrong service name
APP_HOST: my-app_server_1  # but service is named "web"

# Correct
APP_HOST: my-app_web_1
```

### Main Application Service

Usually named `web`, but can be anything (api, server, app, etc.):

```yaml
web:
  image: dockerhub-user/image:tag@sha256:digest
  user: "1000:1000"
  restart: on-failure
  stop_grace_period: 1m
  volumes:
    - ${APP_DATA_DIR}/data:/data
  environment:
    PORT: 3456
    NODE_ENV: production
```

## Image Configuration

### Image with Digest (Required)

**Format**: `user/image:tag@sha256:digest`

```yaml
image: j73642/mining-dashboard-app:v1.2.00@sha256:9a3bccf0c178d1774ff92b40232c1f255c2b0dfc7a9e7bd2aa0e0d501724de61
```

**How to get the multi-arch digest**:
```bash
# Build and push multi-architecture image
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --tag your-user/app:v1.0.0 \
  --output "type=registry" \
  .

# Get the multi-architecture digest
docker buildx imagetools inspect your-user/app:v1.0.0 --raw | sha256sum | awk '{print $1}'
```

**Important**: The digest must be for the multi-architecture manifest, not a single platform!

### User Configuration (Security)

**Always run as non-root**:
```yaml
user: "1000:1000"
```

**Why**:
- Security best practice
- Matches Umbrel's user permissions
- Prevents permission issues with volumes

**Alternative formats**:
```yaml
# Both work
user: "1000:1000"  # Recommended
user: 1000         # Also valid
```

### Restart Policy

**Recommended**:
```yaml
restart: on-failure
```

**Options**:
- `no` - Never restart (not recommended)
- `on-failure` - Restart only if container exits with error (recommended)
- `always` - Always restart (use with caution)
- `unless-stopped` - Restart unless manually stopped

### Stop Grace Period

**Purpose**: Allows app to shut down gracefully

```yaml
stop_grace_period: 1m
```

**Common values**:
- `30s` - For simple apps
- `1m` - For most apps (recommended)
- `2m` - For apps with longer shutdown processes

## Volumes

### Persistent Data

**Format**: Use `${APP_DATA_DIR}` provided by Umbrel

```yaml
volumes:
  # Single data directory
  - ${APP_DATA_DIR}/data:/data

  # Multiple directories
  - ${APP_DATA_DIR}/data:/app/data
  - ${APP_DATA_DIR}/config:/app/config
  - ${APP_DATA_DIR}/logs:/var/log
```

**Important**:
- Data in volumes persists across app restarts
- Data is deleted when app is uninstalled
- Directories are automatically created by Umbrel
- Permissions are set to match `user: 1000:1000`

### Read-Only Volumes

**Use case**: Accessing Bitcoin/Lightning data

```yaml
volumes:
  # Bitcoin Core data (read-only)
  - ${APP_BITCOIN_DATA_DIR}:/bitcoin:ro

  # Lightning (LND) data (read-only)
  - ${APP_LIGHTNING_NODE_DATA_DIR}:/lnd:ro
```

**Why read-only (`:ro`)**:
- Prevents accidental data corruption
- Security best practice
- Apps shouldn't modify Bitcoin/Lightning data

### Volume Permissions

**Creating directories in Dockerfile**:
```dockerfile
# Make sure directories are owned by UID 1000
RUN mkdir -p /app/data && chown -R 1000:1000 /app/data
```

**In docker-compose.yml**:
```yaml
user: "1000:1000"
volumes:
  - ${APP_DATA_DIR}/data:/app/data
```

## Environment Variables

### Umbrel-Provided Variables

**System Variables**:
```yaml
environment:
  DEVICE_HOSTNAME: ${DEVICE_HOSTNAME}           # e.g., "umbrel"
  DEVICE_DOMAIN: ${DEVICE_DOMAIN_NAME}          # e.g., "umbrel.local"
```

**App-Specific Variables**:
```yaml
environment:
  APP_DATA_DIR: ${APP_DATA_DIR}                 # Your app's data directory
  APP_PASSWORD: ${APP_PASSWORD}                 # Unique password for auth
  APP_SEED: ${APP_SEED}                         # 256-bit deterministic seed
  HIDDEN_SERVICE: ${APP_HIDDEN_SERVICE}         # Tor hidden service URL
```

**Bitcoin Core Variables** (when `bitcoin` dependency):
```yaml
environment:
  BITCOIN_HOST: ${APP_BITCOIN_NODE_IP}
  BITCOIN_RPC_PORT: ${APP_BITCOIN_RPC_PORT}
  BITCOIN_RPC_USER: ${APP_BITCOIN_RPC_USER}
  BITCOIN_RPC_PASS: ${APP_BITCOIN_RPC_PASS}
```

**Lightning (LND) Variables** (when `lightning` dependency):
```yaml
environment:
  LND_HOST: ${APP_LIGHTNING_NODE_IP}
  LND_GRPC_PORT: ${APP_LIGHTNING_NODE_GRPC_PORT}
  LND_REST_PORT: ${APP_LIGHTNING_NODE_REST_PORT}
```

**Electrum Server Variables** (when `electrs` dependency):
```yaml
environment:
  ELECTRUM_HOST: ${APP_ELECTRS_NODE_IP}
  ELECTRUM_PORT: ${APP_ELECTRS_NODE_PORT}
```

**Tor Proxy Variables**:
```yaml
environment:
  TOR_PROXY_IP: ${TOR_PROXY_IP}
  TOR_PROXY_PORT: ${TOR_PROXY_PORT}
```

### Custom Environment Variables

**Your app's configuration**:
```yaml
environment:
  NODE_ENV: production
  PORT: 3456
  LOG_LEVEL: info
  ENABLE_FEATURE_X: "true"
```

**Important**:
- Use consistent naming
- Document required variables
- Provide sensible defaults in your app code
- Use strings for boolean values in YAML

## Ports

### Port Exposure

**Usually not needed** if using app_proxy:
```yaml
# Don't need to expose port if using app_proxy
services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 3000

  web:
    # No ports section needed - app_proxy handles routing
    environment:
      PORT: 3000
```

**When to expose ports**:
```yaml
ports:
  # Expose additional ports (non-HTTP services)
  - 8333:8333  # Bitcoin P2P
  - 9735:9735  # Lightning P2P
```

**Common patterns**:
```yaml
# Bitcoin node
ports:
  - 8333:8333  # Bitcoin P2P
  - 8332:8332  # Bitcoin RPC

# Lightning node
ports:
  - 9735:9735  # Lightning P2P
  - 10009:10009  # gRPC

# Custom service
ports:
  - 4028:4028  # CGMiner API
```

## Multi-Service Apps

### App with Database

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 3000

  web:
    image: user/app:v1@sha256:digest
    user: "1000:1000"
    restart: on-failure
    depends_on:
      - db
    environment:
      DATABASE_URL: postgresql://postgres:password@my-app_db_1:5432/myapp
    volumes:
      - ${APP_DATA_DIR}/data:/data

  db:
    image: postgres:14-alpine@sha256:digest
    user: "1000:1000"
    restart: on-failure
    volumes:
      - ${APP_DATA_DIR}/postgres:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${APP_PASSWORD}
```

### App with Redis Cache

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 3000

  web:
    image: user/app:v1@sha256:digest
    user: "1000:1000"
    restart: on-failure
    depends_on:
      - redis
    environment:
      REDIS_URL: redis://my-app_redis_1:6379

  redis:
    image: redis:7-alpine@sha256:digest
    user: "1000:1000"
    restart: on-failure
    volumes:
      - ${APP_DATA_DIR}/redis:/data
```

### Service Dependencies

**Use `depends_on` to control startup order**:
```yaml
web:
  depends_on:
    - db
    - redis
    - worker
```

**Note**: This only controls start order, not readiness. Your app should handle waiting for services to be ready.

## Health Checks

**Optional but recommended**:

```yaml
web:
  image: user/app:v1@sha256:digest
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 40s
```

**Alternative health checks**:
```yaml
# Using wget
healthcheck:
  test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3000/health"]

# Using Node.js
healthcheck:
  test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"]

# Using netcat for non-HTTP services
healthcheck:
  test: ["CMD", "nc", "-z", "localhost", "5432"]
```

## Advanced Patterns

### App with Worker Process

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 3000

  web:
    image: user/app:v1@sha256:digest
    user: "1000:1000"
    restart: on-failure
    command: ["npm", "run", "start:web"]
    volumes:
      - ${APP_DATA_DIR}/data:/data

  worker:
    image: user/app:v1@sha256:digest
    user: "1000:1000"
    restart: on-failure
    command: ["npm", "run", "start:worker"]
    volumes:
      - ${APP_DATA_DIR}/data:/data
```

### Custom Networking

**Usually not needed** - Umbrel handles networking automatically.

If required:
```yaml
version: "3.7"

services:
  web:
    networks:
      - app_network

networks:
  app_network:
    driver: bridge
```

### Resource Limits

**Optional - use if needed**:
```yaml
web:
  image: user/app:v1@sha256:digest
  deploy:
    resources:
      limits:
        cpus: '2'
        memory: 2G
      reservations:
        cpus: '0.5'
        memory: 512M
```

## Complete Examples

### Simple Single-Container App

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

### Bitcoin Explorer App

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: btc-rpc-explorer_web_1
      APP_PORT: 8080

  web:
    image: getumbrel/btc-rpc-explorer:v2.0.2@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    environment:
      PORT: 8080
      BTCEXP_BITCOIND_HOST: ${APP_BITCOIN_NODE_IP}
      BTCEXP_BITCOIND_PORT: ${APP_BITCOIN_RPC_PORT}
      BTCEXP_BITCOIND_USER: ${APP_BITCOIN_RPC_USER}
      BTCEXP_BITCOIND_PASS: ${APP_BITCOIN_RPC_PASS}
      BTCEXP_ELECTRUMX_SERVERS: "tcp://${APP_ELECTRS_NODE_IP}:${APP_ELECTRS_NODE_PORT}"
      BTCEXP_HOST: 0.0.0.0
      BTCEXP_ADDRESS_API: electrumx
      BTCEXP_PRIVACY_MODE: "true"
      BTCEXP_NO_RATES: "true"
```

### Full-Stack App with Database

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 3000

  web:
    image: user/app-frontend:v1@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    depends_on:
      - api
    environment:
      API_URL: http://my-app_api_1:4000

  api:
    image: user/app-backend:v1@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    depends_on:
      - db
    volumes:
      - ${APP_DATA_DIR}/uploads:/app/uploads
    environment:
      DATABASE_URL: postgresql://postgres:${APP_PASSWORD}@my-app_db_1:5432/myapp
      JWT_SECRET: ${APP_SEED}
      PORT: 4000

  db:
    image: postgres:14-alpine@sha256:digest
    user: "1000:1000"
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/postgres:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${APP_PASSWORD}
```

## Validation Checklist

Before testing your docker-compose.yml:

- [ ] Version is "3.7"
- [ ] app_proxy service is configured correctly
- [ ] APP_HOST follows format: `<app-id>_<service>_1`
- [ ] APP_PORT matches your app's listening port
- [ ] All images use multi-arch digests
- [ ] All services run as user "1000:1000"
- [ ] restart: on-failure is set
- [ ] Persistent data uses ${APP_DATA_DIR}
- [ ] All environment variables are set
- [ ] No syntax errors (validate YAML)
- [ ] Service names match references (e.g., depends_on)

## Common Issues & Solutions

### Issue: App not accessible through Umbrel UI

**Check**:
```yaml
# Verify APP_HOST format
app_proxy:
  environment:
    APP_HOST: my-app_web_1  # Must have _1 suffix!
    APP_PORT: 3000          # Must match app's listening port
```

### Issue: Permission denied errors

**Fix**: Ensure user is set correctly
```yaml
web:
  user: "1000:1000"  # Must be 1000:1000
  volumes:
    - ${APP_DATA_DIR}/data:/data  # Will be owned by 1000:1000
```

### Issue: Data not persisting

**Fix**: Use proper volume mounts
```yaml
volumes:
  # Wrong - data will be lost
  - /data

  # Correct - data persists
  - ${APP_DATA_DIR}/data:/data
```

### Issue: Can't connect to Bitcoin/Lightning

**Check dependencies and environment**:
```yaml
# In umbrel-app.yml
dependencies:
  - bitcoin
  - lightning

# In docker-compose.yml
environment:
  BITCOIN_HOST: ${APP_BITCOIN_NODE_IP}  # Provided by Umbrel
  LND_HOST: ${APP_LIGHTNING_NODE_IP}    # Only if lightning dependency
```

## See Also

- [SKILL.md](SKILL.md) - Main Umbrel app development guide
- [MANIFEST_REFERENCE.md](MANIFEST_REFERENCE.md) - umbrel-app.yml reference
- [EXAMPLES.md](EXAMPLES.md) - Real-world examples
