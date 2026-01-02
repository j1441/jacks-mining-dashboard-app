# Umbrel App Manifest Reference

Complete reference for all fields in `umbrel-app.yml`

## Required Fields

### manifestVersion
- **Type**: Integer
- **Values**: `1` or `1.1`
- **Description**: Manifest schema version
- **When to use each**:
  - `1`: Standard apps without lifecycle hooks
  - `1.1`: Apps requiring hooks (pre-start, post-install, etc.)

```yaml
manifestVersion: 1
```

### id
- **Type**: String
- **Format**: Lowercase letters and dashes only
- **Max length**: 64 characters
- **Description**: Unique identifier for your app
- **Rules**:
  - Must be unique across all Umbrel apps
  - Should be human-readable and recognizable
  - Cannot be changed after submission

```yaml
id: btc-rpc-explorer
id: mining-dashboard
id: my-app-name
```

### name
- **Type**: String
- **Description**: Display name shown in Umbrel UI
- **Best practices**:
  - Use proper capitalization
  - Keep it concise but descriptive
  - Avoid redundant words like "App" or "Umbrel"

```yaml
name: BTC RPC Explorer
name: Mining Dashboard
name: Jellyfin
```

### category
- **Type**: String
- **Values**: One of the predefined categories
- **Available Categories**:
  - `finance` - Bitcoin, Lightning, wallets, exchanges
  - `automation` - Home automation, smart home
  - `networking` - VPNs, proxies, DNS
  - `media` - Media servers, streaming
  - `files` - File storage, sync, sharing
  - `development` - Developer tools, databases
  - `social` - Social media, communication
  - `security` - Security tools, password managers
  - `analytics` - Monitoring, analytics, dashboards

```yaml
category: finance
category: automation
```

### version
- **Type**: String (quoted)
- **Format**: Semantic versioning (MAJOR.MINOR.PATCH)
- **Description**: Current version of your app
- **Important**:
  - Must be quoted to prevent YAML parsing as number
  - Should follow semver specification
  - Update with each release

```yaml
version: "1.0.0"
version: "2.3.1"
version: "0.1.0-beta"
```

### port
- **Type**: Integer
- **Description**: Primary port where your app's web UI is accessible
- **Must match**: The port configured in docker-compose.yml
- **Range**: Typically 3000-9999 to avoid conflicts

```yaml
port: 3000
port: 8080
port: 3456
```

### tagline
- **Type**: String
- **Description**: Short one-line description (shown on app card)
- **Best practices**:
  - Keep under 60 characters
  - Describe what the app does, not how
  - Don't end with period
  - Be concise and catchy

```yaml
tagline: Simple, database-free blockchain explorer
tagline: Monitor and control your home heating miner
tagline: The Free Software Media System
```

### description
- **Type**: Multi-line string
- **Format**: Supports markdown
- **Description**: Detailed description of your app
- **Best practices**:
  - Use `>-` for multi-line text (removes newlines)
  - First paragraph should be an overview
  - List key features with bullet points
  - Include requirements if any
  - Be specific about functionality

```yaml
description: >-
  BTC RPC Explorer is a full-featured, self-hosted explorer for the
  Bitcoin blockchain. With this explorer, you can explore not just the
  blockchain database, but also explore the functional capabilities of your
  Umbrel.

  Features:

  • Real-time hashrate and temperature monitoring

  • Power profile control for optimal performance

  • Pool statistics and connection status

  Requirements:

  • Bitcoin node running on Umbrel

  • Network access to mining hardware
```

### developer
- **Type**: String
- **Description**: Name of the app's original developer/creator
- **Note**: Your GitHub username goes in `submitter`, not here

```yaml
developer: Dan Janosik
developer: Jellyfin Team
developer: j1441
```

### website
- **Type**: URL
- **Description**: Official website for the app project
- **Best practices**:
  - Use HTTPS if available
  - Link to project homepage, not GitHub

```yaml
website: https://explorer.btc21.org
website: https://jellyfin.org
```

### dependencies
- **Type**: Array of strings
- **Description**: List of app IDs that must be installed first
- **Common dependencies**:
  - `bitcoin` - Bitcoin Core
  - `lightning` - LND (Lightning Network Daemon)
  - `electrs` - Electrum server
- **Behavior**:
  - Umbrel won't allow installation until dependencies are installed
  - Dependencies will be started before your app
  - Empty array if no dependencies

```yaml
# No dependencies
dependencies: []

# Single dependency
dependencies:
  - bitcoin

# Multiple dependencies
dependencies:
  - bitcoin
  - electrs
  - lightning
```

### repo
- **Type**: URL
- **Description**: Link to source code repository
- **Best practices**:
  - Use GitHub/GitLab repository URL
  - Don't include `/tree/branch` or specific paths

```yaml
repo: https://github.com/janoside/btc-rpc-explorer
repo: https://github.com/j1441/jacks-mining-dashboard-app
```

### support
- **Type**: URL
- **Description**: Where users can get help
- **Common choices**:
  - GitHub Issues
  - GitHub Discussions
  - Discord server
  - Forum

```yaml
support: https://github.com/janoside/btc-rpc-explorer/discussions
support: https://github.com/j1441/jacks-mining-dashboard-app/issues
```

### gallery
- **Type**: Array of URLs or filenames
- **Description**: Screenshots/images shown in app store
- **Format**:
  - 3-5 high-quality images
  - 1440x900px resolution
  - PNG format
- **Initial submission**: Use empty array
- **After review**: Umbrel team will help finalize

```yaml
# Initial submission
gallery: []

# After Umbrel team adds images
gallery:
  - 1.jpg
  - 2.jpg
  - 3.jpg
```

### releaseNotes
- **Type**: Multi-line string
- **Description**: What's new in this version
- **Initial submission**: Use empty string
- **Updates**: Describe changes, fixes, new features

```yaml
# Initial submission
releaseNotes: ""

# Version update
releaseNotes: >-
  v2.0.0 - Major Update

  • Added dark mode support

  • Improved performance by 50%

  • Fixed connection timeout issues

  • Updated dependencies for security
```

### submitter
- **Type**: String
- **Description**: Your GitHub username (person submitting to Umbrel)
- **Note**: Different from `developer` if you're packaging someone else's app

```yaml
submitter: j1441
submitter: Umbrel
```

### submission
- **Type**: URL
- **Description**: Link to your GitHub pull request or repository
- **Format**: Link to your fork or PR

```yaml
submission: https://github.com/j1441/jacks-mining-dashboard-app
submission: https://github.com/getumbrel/umbrel/pull/334
```

## Optional Fields

### path
- **Type**: String
- **Default**: `""`
- **Description**: URL path suffix for accessing app
- **Usually**: Leave empty (most apps don't need this)

```yaml
path: ""
path: "/admin"
```

### defaultUsername
- **Type**: String
- **Default**: `""`
- **Description**: Default username if app has pre-configured auth
- **Usually**: Empty unless app has hardcoded default credentials

```yaml
defaultUsername: ""
defaultUsername: "admin"
```

### defaultPassword
- **Type**: String
- **Default**: `""`
- **Description**: Default password if app has pre-configured auth
- **Security**: Only use if app forces a default password
- **Best practice**: Apps should use `${APP_PASSWORD}` instead

```yaml
defaultPassword: ""
defaultPassword: "changeme"
```

### icon
- **Type**: URL
- **Description**: App icon (256x256 SVG preferred)
- **Requirements**:
  - 256x256px
  - SVG format preferred
  - No rounded corners (CSS handles this)
  - Publicly accessible URL
- **Note**: Can point to your GitHub raw content

```yaml
icon: https://raw.githubusercontent.com/j1441/jacks-mining-dashboard-app/main/icon.svg
```

## Manifest Version 1.1 Features

If you set `manifestVersion: 1.1`, you can use hooks:

### Available Hooks

- `pre-start` - Runs before app starts
- `post-start` - Runs after app starts
- `pre-stop` - Runs before app stops
- `post-stop` - Runs after app stops
- `pre-install` - Runs before app installation
- `post-install` - Runs after app installation
- `pre-uninstall` - Runs before app uninstallation
- `post-uninstall` - Runs after app uninstallation

Example with hooks:
```yaml
manifestVersion: 1.1
id: my-app
# ... other fields ...
hooks:
  pre-start: hooks/pre-start.sh
  post-install: hooks/post-install.sh
```

## Complete Example

```yaml
manifestVersion: 1
id: mining-dashboard
category: automation
name: Mining Dashboard
version: "1.0.0"
tagline: Monitor and control your home heating miner
icon: https://raw.githubusercontent.com/j1441/jacks-mining-dashboard-app/main/icon.svg
description: >-
  Monitor your Antminer running Braiins OS with a clean, modern web interface.
  Perfect for home heating applications with real-time statistics and power control.


  Features:

  • Real-time hashrate, temperature, and performance monitoring

  • Power profile control (Low/Medium/High)

  • Pool statistics and connection status

  • Temperature tracking for all boards and chips

  • Fan speed monitoring

  • WebSocket-based live updates

  • Clean, responsive dark theme interface


  Requirements:

  • Antminer running Braiins OS

  • Network access to miner's CGMiner API (port 4028)
releaseNotes: ""
developer: j1441
website: https://github.com/j1441/jacks-mining-dashboard-app
dependencies: []
repo: https://github.com/j1441/jacks-mining-dashboard-app
support: https://github.com/j1441/jacks-mining-dashboard-app/issues
port: 3456
gallery: []
path: ""
defaultUsername: ""
defaultPassword: ""
submitter: j1441
submission: https://github.com/j1441/jacks-mining-dashboard-app
```

## Validation Checklist

Before submitting, verify:

- [ ] manifestVersion is 1 or 1.1
- [ ] id uses only lowercase letters and dashes
- [ ] version is quoted string
- [ ] port matches docker-compose.yml
- [ ] description includes features and requirements
- [ ] dependencies lists all required apps
- [ ] gallery is empty array for initial submission
- [ ] releaseNotes is empty string for initial submission
- [ ] All URLs are valid and accessible
- [ ] No syntax errors (validate YAML)

## Common Mistakes to Avoid

1. **Unquoted version number**
   ```yaml
   # Wrong
   version: 1.0.0

   # Correct
   version: "1.0.0"
   ```

2. **Invalid app ID**
   ```yaml
   # Wrong
   id: My_App
   id: my-app!

   # Correct
   id: my-app
   ```

3. **Wrong port**
   ```yaml
   # Port must match docker-compose.yml APP_PORT
   port: 3000  # Make sure this is right!
   ```

4. **Missing dependencies**
   ```yaml
   # If your app needs Bitcoin Core
   dependencies:
     - bitcoin  # Don't forget this!
   ```

5. **Forgetting to update version**
   ```yaml
   # Update this with each release!
   version: "1.0.1"
   ```

## See Also

- [SKILL.md](SKILL.md) - Main Umbrel app development guide
- [DOCKER_COMPOSE_GUIDE.md](DOCKER_COMPOSE_GUIDE.md) - Docker Compose reference
- [EXAMPLES.md](EXAMPLES.md) - Real-world examples
