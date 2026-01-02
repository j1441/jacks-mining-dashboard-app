---
name: umbrel-app
description: Helps build, configure, debug, and troubleshoot Umbrel OS applications. Use when creating new Umbrel apps, working with umbrel-app.yml manifests, docker-compose.yml files, Docker configuration, debugging app issues, testing apps, or any Umbrel app development questions.
---

# Umbrel App Development Skill

This skill provides expert guidance for developing applications for Umbrel OS, based on real-world experience and the official Umbrel app framework.

## 🚨 IMPORTANT: Jack's Community Store Context

**We are building apps for Jack's Community Store (non-official community apps), NOT the official Umbrel App Store.**

Key differences:
- **Repository**: Apps live in `/Users/james/Jack-s-Community-Store/`
- **App naming**: Prefix all apps with `jacks-` (e.g., `jacks-mining-dashboard`)
- **Architecture**: Build for **AMD64 ONLY** (linux/amd64), NOT ARM64
- **Deployment**: Commit directly to our repository, no PR to official Umbrel store
- **Docker platform**: Always use `--platform linux/amd64`

## When to Use This Skill

Use this skill when you need help with:
- Creating new Umbrel apps from scratch
- Configuring app manifests (umbrel-app.yml)
- Setting up Docker Compose files for Umbrel
- Building multi-architecture Docker images
- Debugging common Umbrel app issues
- Testing apps locally on umbrelOS
- Understanding Umbrel's app framework requirements
- Submitting apps to the Umbrel App Store

## Quick Reference

### Essential Umbrel App Files

Every Umbrel app requires these files in the app directory:
```
my-app/
├── umbrel-app.yml          # App manifest (metadata, version, dependencies)
├── docker-compose.yml      # Docker services configuration
├── exports.sh              # Optional: Environment variables to share with other apps
└── data/                   # Optional: Persistent data directory
```

### App Manifest Structure (umbrel-app.yml)

```yaml
manifestVersion: 1
id: my-app-id                    # lowercase letters and dashes only
name: My App Name
category: automation             # finance, automation, networking, etc.
version: "1.0.0"
port: 3000                       # Main web UI port
tagline: Short one-line description
icon: https://url-to-icon.svg
description: >-
  Detailed multi-line description.
  Supports markdown formatting.
releaseNotes: >-
  What's new in this version.
developer: Your Name
website: https://example.com
dependencies: []                 # List of app IDs this app requires
repo: https://github.com/user/repo
support: https://github.com/user/repo/issues
gallery: []                      # Screenshots (added by Umbrel team)
path: ""                         # URL path (usually empty)
defaultUsername: ""
defaultPassword: ""
submitter: Your GitHub Username
submission: https://github.com/user/repo
```

### Docker Compose Template

```yaml
version: "3.7"

services:
  app_proxy:
    environment:
      # Format: <app-id>_<service-name>_1
      APP_HOST: my-app_web_1
      APP_PORT: 3000

  web:
    image: your-dockerhub-user/image:tag@sha256:digest
    user: "1000:1000"              # Run as non-root for security
    restart: on-failure
    stop_grace_period: 1m
    volumes:
      - ${APP_DATA_DIR}/data:/data  # Persistent storage
    environment:
      NODE_ENV: production
      PORT: 3000
```

## Common Tasks & Solutions

### 1. Creating a New Umbrel App for Jack's Community Store

**IMPORTANT**: We are building apps for Jack's Community Store (non-official apps), NOT the official Umbrel App Store.

**Step 1: Navigate to Jack's Community Store repository**
```bash
cd /Users/james/Jack-s-Community-Store
```

**Step 2: Choose an app ID**
- Use lowercase letters and dashes only
- Prefix with "jacks-" for Jack's Community Store apps
- Make it human-readable and recognizable
- Example: `jacks-mining-dashboard`, `jacks-aiostreams`

**Step 3: Create app directory**
```bash
mkdir jacks-your-app-name
cd jacks-your-app-name
```

**Step 4: Create required files**
- umbrel-app.yml (see template above)
- docker-compose.yml (see template above)
- exports.sh (if needed for sharing env vars)

For complete examples, see [EXAMPLES.md](EXAMPLES.md).

### 2. Building Docker Images (AMD64 Only)

**IMPORTANT**: We only build for AMD64 architecture (linux/amd64), NOT ARM64.

```bash
# Enable Docker buildx
docker buildx create --use

# Build and push AMD64-only image
docker buildx build \
  --platform linux/amd64 \
  --tag your-dockerhub-user/app:v1.0.0 \
  --output "type=registry" \
  .

# Get the AMD64 digest for docker-compose.yml
docker buildx imagetools inspect your-dockerhub-user/app:v1.0.0 --raw | \
  sha256sum | awk '{print $1}'
```

**CRITICAL**: Use the AMD64 digest in docker-compose.yml!

### 3. Debugging Common Issues

#### App Won't Start

**Symptom**: App shows "Starting..." but never becomes available

**Common Causes & Fixes**:

1. **Port conflicts**
   - Check if port is already in use
   - Verify APP_PORT matches the port your app listens on
   - Ensure port is exposed in Dockerfile

2. **Permission issues**
   - Use `user: "1000:1000"` in docker-compose.yml
   - Ensure data directories are writable by UID 1000
   - Check file permissions in mounted volumes

3. **Missing dependencies**
   - Verify all required apps are listed in `dependencies` array
   - Check that dependency apps are installed and running

4. **Environment variables**
   - Verify all required env vars are set
   - Check Umbrel-provided variables are used correctly
   - Use proper format: `${APP_DATA_DIR}`, `${APP_BITCOIN_NODE_IP}`, etc.

#### App Proxy Issues

**Symptom**: Can't access app through Umbrel's web UI

**Fix**: Verify app_proxy configuration
```yaml
app_proxy:
  environment:
    # Must match format: <app-id>_<service-name>_1
    APP_HOST: your-app-id_web_1  # Note the _1 suffix!
    APP_PORT: 3000                # Port your service listens on
```

#### Data Not Persisting

**Symptom**: Settings or data lost after restart

**Fix**: Mount persistent volumes correctly
```yaml
volumes:
  - ${APP_DATA_DIR}/data:/data
  - ${APP_DATA_DIR}/config:/config
```

**Test**: Restart the app and verify data survives. Uninstalling will delete all data.

### 4. Testing Apps Locally

#### Option A: Local Development Environment (Recommended)

Requirements: Docker Desktop with OrbStack (macOS) or WSL2 (Windows)

```bash
# Clone umbrel repo
git clone https://github.com/getumbrel/umbrel
cd umbrel

# Start development environment
npm run dev

# Access at http://umbrel-dev.local
```

Copy app to dev environment:
```bash
rsync -av --exclude=".gitkeep" \
  ./your-app-id \
  umbrel@umbrel-dev.local:/home/umbrel/umbrel/app-stores/getumbrel-umbrel-apps-github-53f74447/
```

Install app:
```bash
# Via CLI
npm run dev client -- apps.install.mutate -- --appId your-app-id

# Or through web UI at http://umbrel-dev.local
```

#### Option B: Physical Device

1. Install umbrelOS on hardware or VM
2. Copy app directory via rsync
3. Install through web UI or CLI

For detailed testing instructions, see the [UMBREL_APP_GUIDE.md](../../../UMBREL_APP_GUIDE.md).

### 5. Using Umbrel Environment Variables

Umbrel provides these variables to your app:

**System Variables**:
- `${DEVICE_HOSTNAME}` - Device hostname (e.g., "umbrel")
- `${DEVICE_DOMAIN_NAME}` - Local domain (e.g., "umbrel.local")

**Tor Proxy**:
- `${TOR_PROXY_IP}` - Tor proxy IP
- `${TOR_PROXY_PORT}` - Tor proxy port

**App-Specific**:
- `${APP_DATA_DIR}` - Persistent data directory for your app
- `${APP_HIDDEN_SERVICE}` - Tor hidden service address
- `${APP_PASSWORD}` - Unique password for authentication
- `${APP_SEED}` - 256-bit deterministic seed derived from user's Umbrel seed

**Bitcoin Core** (if bitcoin dependency):
- `${APP_BITCOIN_NODE_IP}` - Bitcoin Core IP
- `${APP_BITCOIN_RPC_PORT}` - RPC port
- `${APP_BITCOIN_RPC_USER}` - RPC username
- `${APP_BITCOIN_RPC_PASS}` - RPC password
- `${APP_BITCOIN_DATA_DIR}` - Bitcoin data directory (read-only)

**Lightning (LND)** (if lightning dependency):
- `${APP_LIGHTNING_NODE_IP}` - LND IP
- `${APP_LIGHTNING_NODE_GRPC_PORT}` - gRPC port
- `${APP_LIGHTNING_NODE_REST_PORT}` - REST port
- `${APP_LIGHTNING_NODE_DATA_DIR}` - LND data directory (read-only)

**Electrum Server** (if electrs dependency):
- `${APP_ELECTRS_NODE_IP}` - Electrum server IP
- `${APP_ELECTRS_NODE_PORT}` - Electrum server port

### 6. Best Practices

#### Docker Best Practices

✅ **DO:**
- Use lightweight base images (alpine, slim variants)
- Implement multi-stage builds
- Run as non-root user (1000:1000)
- Use deterministic builds
- Pin images with sha256 digests
- Add health checks
- Use proper stop grace periods
- Build for linux/amd64 platform (Jack's Community Store apps)

❌ **DON'T:**
- Run as root user
- Expose unnecessary ports
- Build for ARM64 (we only support AMD64 for Jack's Community Store)
- Use `latest` tag without digest
- Include development dependencies in final image

#### Security Best Practices

✅ **DO:**
- Validate all user inputs
- Use environment variables for secrets
- Implement proper authentication
- Use HTTPS where possible
- Follow OWASP security guidelines
- Request minimal permissions needed

❌ **DON'T:**
- Hardcode credentials
- Expose sensitive data in logs
- Skip input validation
- Disable security features

#### App Manifest Best Practices

✅ **DO:**
- Write clear, concise descriptions
- Include meaningful release notes
- List all dependencies
- Use semantic versioning
- Provide support links
- Choose appropriate category

❌ **DON'T:**
- Leave gallery or releaseNotes empty when submitting (use `gallery: []` and `releaseNotes: ""`)
- Use special characters in app ID
- Skip version updates
- Forget to update release notes

## Common Debugging Commands

```bash
# View app logs
umbreld client apps.logs.query --appId your-app-id

# Check app status
umbreld client apps.list.query | grep your-app-id

# Restart app
umbreld client apps.restart.mutate --appId your-app-id

# Uninstall app
umbreld client apps.uninstall.mutate --appId your-app-id

# Check Docker containers
docker ps | grep your-app-id

# View container logs
docker logs <container-id>

# Inspect container
docker inspect <container-id>
```

## Publishing Your App to Jack's Community Store

**IMPORTANT**: We are publishing to Jack's Community Store, NOT the official Umbrel App Store.

When ready to publish:

1. **Prepare your app**:
   ```bash
   cd /Users/james/Jack-s-Community-Store
   git add jacks-your-app-name/
   git commit -m "Add jacks-your-app-name"
   git push
   ```

2. **App location**: Apps are stored in `/Users/james/Jack-s-Community-Store/`

3. **No PR required**: Since this is our own community store, we commit directly to the repository

4. **Testing requirements**:
   - [ ] Tested on umbrelOS with AMD64 architecture
   - [ ] Docker image built for linux/amd64 only
   - [ ] App starts and runs correctly
   - [ ] Data persists after restart

For more detailed information, see:
- [MANIFEST_REFERENCE.md](MANIFEST_REFERENCE.md) - Complete umbrel-app.yml field reference
- [DOCKER_COMPOSE_GUIDE.md](DOCKER_COMPOSE_GUIDE.md) - Docker Compose patterns and examples
- [EXAMPLES.md](EXAMPLES.md) - Real-world app examples

## Troubleshooting Checklist

When debugging Umbrel app issues, check:

- [ ] App ID uses only lowercase letters and dashes
- [ ] docker-compose.yml version is "3.7"
- [ ] APP_HOST follows format: `<app-id>_<service>_1`
- [ ] APP_PORT matches the port your app listens on
- [ ] Docker image uses multi-architecture digest
- [ ] Service runs as user "1000:1000"
- [ ] Data directories are mounted correctly
- [ ] All environment variables are set
- [ ] Dependencies are listed in manifest
- [ ] Port in manifest matches exposed port
- [ ] Health check is working (if implemented)
- [ ] Logs show no errors
- [ ] App works after restart (data persists)

## Getting Help

If you're stuck:
1. Check the official [Umbrel App Framework Guide](https://github.com/getumbrel/umbrel-apps)
2. Review the [UMBREL_APP_GUIDE.md](../../../UMBREL_APP_GUIDE.md) in this project
3. Look at existing apps in the umbrel-apps repository
4. Open an issue on [getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps/issues)
5. Ask in the Umbrel community forums

## Quick Commands Reference

```bash
# Development environment
npm run dev                                          # Start umbrel-dev
npm run dev client -- apps.install.mutate -- --appId <id>   # Install app
npm run dev client -- apps.uninstall.mutate -- --appId <id> # Uninstall app

# Docker (AMD64 only for Jack's Community Store)
docker buildx build --platform linux/amd64 --tag user/image:tag --output "type=registry" .
docker buildx imagetools inspect user/image:tag --raw | sha256sum

# Testing
rsync -av --exclude=".gitkeep" ./app-dir umbrel@umbrel.local:/home/umbrel/umbrel/app-stores/.../
ssh umbrel@umbrel.local
umbreld client apps.install.mutate --appId <app-id>

# Jack's Community Store workflow
cd /Users/james/Jack-s-Community-Store
mkdir jacks-new-app
# Create umbrel-app.yml and docker-compose.yml
docker buildx build --platform linux/amd64 --tag user/image:tag --output "type=registry" .
git add jacks-new-app/
git commit -m "Add jacks-new-app"
git push
```

---

This skill is based on real-world experience developing Umbrel apps, including the Mining Dashboard app in this repository. When you ask questions about Umbrel app development, Claude will use this knowledge to provide accurate, tested guidance.
