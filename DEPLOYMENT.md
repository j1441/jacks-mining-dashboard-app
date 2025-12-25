# Deployment Guide for Jack's Mining Dashboard

## Building and Pushing Docker Image

### Option 1: Simple Build (Recommended)
```bash
./build-simple.sh
```

This will:
1. Build the Docker image for your current architecture
2. Tag it as both `v1.0.11` and `latest`
3. Push both tags to Docker Hub (j73642/mining-dashboard-app)
4. Display the image digest for use in docker-compose.yml

### Option 2: Multi-Architecture Build
```bash
./build-and-push.sh
```

This builds for both amd64 and arm64 (requires Docker buildx to be set up).

### Prerequisites
- Docker installed and running
- Logged into Docker Hub: `docker login`
- Credentials for j73642 account

## Updating Community Store

After building and pushing the Docker image, update these files in your community store repository:

**Repository:** https://github.com/j1441/Jack-s-Community-Store

### 1. Update `jacks-mining-dashboard/umbrel-app.yml`

Change the version line:
```yaml
version: "1.0.11"
```

Update the release notes to mention the fixes:
```yaml
releaseNotes: >-
  v1.0.11:
  - Fixed miner connection issue (minerIP/minerIp field mismatch)
  - Fixed config saving with proper Docker permissions
  - Fixed dashboard data display issues
  - Improved WebSocket communication
```

### 2. Update `jacks-mining-dashboard/docker-compose.yml`

Change the image line under the `web:` service:
```yaml
web:
  image: j73642/mining-dashboard-app:v1.0.11@sha256:XXXXX
```

Replace `XXXXX` with the actual digest from the build output.

Or without digest:
```yaml
web:
  image: j73642/mining-dashboard-app:v1.0.11
```

### 3. Commit and Push to Community Store

```bash
cd /path/to/Jacks-Community-Store
git add jacks-mining-dashboard/
git commit -m "Update mining dashboard to v1.0.11 - Fix connection and config issues"
git push
```

## Testing on Umbrel

1. On your Umbrel server, uninstall the old version (if installed)
2. Wait for the community store to update (or manually refresh)
3. Install the new version
4. Test miner connection by entering your miner's IP address
5. Verify config is saved by refreshing the page

## Changes in v1.0.11

### Fixed Issues:
1. **Miner Connection Not Working**
   - Fixed frontend/backend field name mismatch (minerIP vs minerIp)

2. **Config Saving Permissions**
   - Added entrypoint script to set proper /data directory permissions
   - Now runs as root to fix permissions, then switches to node user

3. **Dashboard Display Issues**
   - Fixed WebSocket data structure to match frontend expectations
   - Added missing fields: temperature (avg), powerDraw, boards array, pool stats

### Technical Changes:
- Added `su-exec` package to Dockerfile
- Created `entrypoint.sh` for permission management
- Updated backend data structure in `server.js`
- Fixed frontend WebSocket message parsing in `index.html`

## Rollback

If you need to rollback to v1.0.10, update the community store files back to:
```yaml
version: "1.0.10"
image: j73642/mining-dashboard-app:v1.0.10@sha256:9a3bccf0c178d1774ff92b40232c1f255c2b0dfc7a9e7bd2aa0e0d501724de61
```
