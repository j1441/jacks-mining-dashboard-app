# Mining Dashboard App - Complete Technical Documentation

## Overview

A comprehensive web-based dashboard for monitoring and controlling Bitcoin Antminer miners running Braiins OS, specifically designed for home heating applications in Norway. The app tracks mining performance, electricity costs with Norwegian pricing (including state subsidies), and efficiency metrics comparing mining heat output vs traditional heat pumps.

**Version:** 1.7.1
**Author:** j1441
**License:** MIT
**Repository:** https://github.com/j1441/jacks-mining-dashboard-app
**Platform:** Node.js/Express backend with React frontend (no build step - uses Babel standalone)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Technology Stack](#technology-stack)
3. [File Structure](#file-structure)
4. [Backend Implementation](#backend-implementation)
5. [Frontend Implementation](#frontend-implementation)
6. [External API Integrations](#external-api-integrations)
7. [Miner Communication Protocols](#miner-communication-protocols)
8. [Data Flow & Caching](#data-flow--caching)
9. [Feature Documentation](#feature-documentation)
10. [Configuration Schema](#configuration-schema)
11. [API Reference](#api-reference)
12. [Deployment](#deployment)
13. [Security Considerations](#security-considerations)
14. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              MINING DASHBOARD                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    WebSocket (5s)    ┌──────────────────────────────┐ │
│  │                  │◄────────────────────►│                              │ │
│  │  React Frontend  │                      │    Express.js Backend        │ │
│  │  (Browser/CDN)   │    REST API          │    (Node.js 18+)             │ │
│  │                  │◄────────────────────►│                              │ │
│  └──────────────────┘                      └──────────────┬───────────────┘ │
│                                                           │                  │
│                           ┌───────────────────────────────┼──────────────┐  │
│                           │                               │              │  │
│                           ▼                               ▼              ▼  │
│              ┌────────────────────┐    ┌─────────────────────┐  ┌───────┐  │
│              │   Braiins Miners   │    │   External APIs      │  │ JSON  │  │
│              │   ┌─────────────┐  │    │   ┌───────────────┐  │  │ Files │  │
│              │   │ CGMiner API │  │    │   │ hvakoster     │  │  │       │  │
│              │   │ (port 4028) │  │    │   │ strommen.no   │  │  │config │  │
│              │   ├─────────────┤  │    │   ├───────────────┤  │  │.json  │  │
│              │   │ GraphQL API │  │    │   │ CoinGecko     │  │  │       │  │
│              │   │ (port 80)   │  │    │   ├───────────────┤  │  │history│  │
│              │   ├─────────────┤  │    │   │ blockchain    │  │  │.json  │  │
│              │   │ REST API    │  │    │   │ .info         │  │  │       │  │
│              │   │ (port 80)   │  │    │   └───────────────┘  │  └───────┘  │
│              │   └─────────────┘  │    └─────────────────────┘              │
│              └────────────────────┘                                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

1. **No Build Step**: Frontend uses React via CDN with Babel transpilation in-browser
2. **Single-File Backend**: All server logic in `server.js` (~3200 lines)
3. **JSON File Storage**: Lightweight persistence without database dependencies
4. **Background Polling**: Server polls miners every 5 seconds, pushes via WebSocket
5. **Multi-Protocol Miner Support**: CGMiner API + GraphQL + REST API fallbacks
6. **Miner Control**: Pause/resume mining via Braiins OS REST API with SCOP-based auto-control

---

## Technology Stack

### Backend
| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | 18+ | Runtime environment |
| Express.js | 4.18.2 | HTTP server framework |
| ws | 8.14.2 | WebSocket server for real-time updates |
| @grpc/grpc-js | 1.9.0 | gRPC client for Braiins OS control API |
| @grpc/proto-loader | 0.7.0 | Protocol buffer loader for gRPC |
| net (built-in) | - | TCP connections to CGMiner API |
| https/http (built-in) | - | External API requests |
| fs (built-in) | - | JSON file storage |

### Frontend
| Technology | Version | Purpose |
|------------|---------|---------|
| React | 18.2.0 | UI component framework (CDN) |
| ReactDOM | 18.2.0 | React DOM rendering (CDN) |
| Babel Standalone | 7.23.5 | JSX transpilation in browser |

### Infrastructure
| Technology | Purpose |
|------------|---------|
| Docker | Containerization (Node 18 Alpine) |
| Umbrel | Target deployment platform |
| Tailscale | Recommended VPN for remote access |

---

## File Structure

```
mining-dashboard-app/
├── server.js                    # Backend Express server (3200+ lines)
│                                # - All API endpoints
│                                # - Miner communication logic
│                                # - External API integrations
│                                # - WebSocket server
│                                # - Background polling
│                                # - Miner control (pause/resume)
│                                # - SCOP-based auto-control
│
├── public/
│   └── index.html               # Complete React frontend (2800+ lines)
│                                # - All React components
│                                # - Styling (inline CSS)
│                                # - WebSocket client
│
├── package.json                 # NPM configuration
│                                # - Dependencies: express, ws, @grpc/grpc-js, @grpc/proto-loader
│                                # - Scripts: start, dev
│
├── proto/                       # Braiins OS gRPC protocol buffers
│   └── bos/v1/
│       ├── authentication.proto # Login/auth service definitions
│       └── actions.proto        # PauseMining/ResumeMining service definitions
│
├── Dockerfile                   # Docker build configuration
│                                # - Base: node:18-alpine
│                                # - Non-root user
│                                # - Health checks
│
├── docker-compose.yaml          # Docker Compose for Umbrel
├── umbrel-app.yaml              # Umbrel app manifest
│
├── data/                        # Runtime data (Docker volume)
│   ├── config.json              # User configuration (auto-created)
│   └── history.json             # Historical data (auto-created)
│
├── README.md                    # User documentation
├── PROJECT_CONTEXT.md           # This technical documentation
├── LICENSE                      # MIT License
├── icon.svg                     # App icon
│
└── .github/
    └── workflows/               # GitHub Actions (CI/CD)
```

---

## Backend Implementation

### Core Server Setup (server.js:1-17)

```javascript
const express = require('express');
const WebSocket = require('ws');
const net = require('net');
const PORT = process.env.PORT || 3456;
const DATA_DIR = process.env.DATA_DIR || '/data';
```

### Cache Objects (server.js:39-78)

The server maintains several in-memory caches to reduce API calls and improve response times:

| Cache | Purpose | Refresh Interval |
|-------|---------|------------------|
| `electricityPriceCache` | Norwegian electricity spot prices | 30 minutes |
| `btcPriceCache` | Bitcoin price in multiple currencies | 5 minutes |
| `networkStatsCache` | Bitcoin difficulty, hashrate, block height | 10 minutes |
| `minerStatsCache` | Current stats for all configured miners | 5 seconds |
| `alertHistory` | Log of triggered alerts | Persistent |
| `minerControlState` | Miner pause/resume state, auth tokens, SCOP check times, efficiency tracking, auto mining control state | Runtime |
| `autoControlLogs` | Per-miner control event logs (100 entries per miner) | Runtime |

### Key Backend Functions

#### Miner Communication

| Function | Location | Purpose |
|----------|----------|---------|
| `sendCGMinerCommand(ip, command)` | Line ~1500 | TCP connection to CGMiner API (port 4028) |
| `fetchBraiinsGraphQL(ip)` | Line ~400 | GraphQL queries with schema introspection |
| `fetchBraiinsRestApiStats(ip)` | Line ~1200 | REST API data fetch with authentication |
| `graphqlRequest(ip, query, sessionCookie)` | Line ~1000 | Execute GraphQL query |
| `luciLogin(ip, username, password)` | Line ~760 | LuCI session authentication |
| `getSessionViaWebUI(ip, username, password)` | Line ~930 | Web UI session handling |
| `braiinsRestAuth(ip, username, password)` | Line ~1100 | REST API authentication |

#### Miner Control (Braiins OS REST API)

| Function | Location | Purpose |
|----------|----------|---------|
| `braiinsLogin(ip, username, password)` | Line ~94 | Authenticate with Braiins OS REST API |
| `getMinerAuthToken(ip, minerConfig)` | Line ~144 | Get/refresh auth token with caching |
| `pauseMining(ip, minerConfig)` | Line ~175 | Pause mining via PUT /api/v1/actions/pause |
| `resumeMining(ip, minerConfig)` | Line ~226 | Resume mining via PUT /api/v1/actions/resume |
| `getMiningStatus(ip)` | Line ~310 | Check if miner is paused (via hashrate) |
| `calculateProjectedSCOP(power, hashrate, price, btcPrice)` | Line ~355 | Calculate override SCOP from manual settings |
| `determineIntendedState(projectedSCOP, boardTemp, threshold, minTemp)` | Line ~437 | Determine intended state using override SCOP only |
| `checkSCOPThresholds(minerIp, stats, minerConfig)` | Line ~489 | Active auto-control with state sync and efficiency tracking |
| `checkAutoMiningControl(minerIp, stats, minerConfig)` | Line ~978 | Comprehensive hardware-based auto-control loop |
| `gatherMinerReadings(stats)` | Line ~760 | Extract temps, fans, power, hashrate from stats |
| `checkMiningViolations(readings, thresholds)` | Line ~800 | Check readings against thresholds |
| `determineMiningAction(readings, violations, thresholds, behavior, state)` | Line ~830 | Decide control action with priority logic |
| `executeMiningControlAction(minerIp, action, minerConfig, readings)` | Line ~900 | Execute pause/resume/power adjustments |
| `logAutoControlEvent(minerIp, event)` | Line ~740 | Log control events to buffer |

#### Data Extraction

| Function | Location | Purpose |
|----------|----------|---------|
| `extractTemperatures(statsData, devsData, allStatsData)` | Line 1225 | Parse temperatures from 7+ field patterns |
| `extractFanSpeeds(statsData, devsData, allStatsData)` | Line 1346 | Parse fan RPM from various formats |
| `getMinerStats(ip, config)` | Line 1553 | Aggregate all miner stats from all APIs |

#### External Data

| Function | Location | Purpose |
|----------|----------|---------|
| `fetchElectricityPrices(country, zone)` | Line 983 | Fetch hourly prices with VAT calculation |
| `fetchBTCPrice()` | Line 1050 | Bitcoin price in NOK, USD, EUR, SEK |
| `fetchNetworkStats()` | Line 1074 | Bitcoin difficulty and network hashrate |

#### Efficiency & Pricing

| Function | Location | Purpose |
|----------|----------|---------|
| `calculateEfficiency(hashrate, power, price, btcPrice, currency)` | Line 1128 | Full profitability metrics |
| `getGridFeeForTime(config, date)` | Line 1109 | Time-based grid fee calculation |
| `checkAlerts(stats, config, minerName)` | Line 1426 | Alert threshold detection with cooldown |

#### Configuration & Storage

| Function | Location | Purpose |
|----------|----------|---------|
| `loadConfig()` | Line ~3420 | Load config with backward compatibility |
| `saveConfig(config)` | Line ~3474 | Persist configuration to JSON |
| `loadHistory()` | Line ~3487 | Load history with v1→v2 migration |
| `migrateV1Entries(entries)` | Line ~3515 | Convert old v1 entries to v2 format |
| `saveHistorySnapshot(allMinerStats)` | Line ~3562 | Save complete hourly snapshot |
| `aggregateToDailyAverages(history, snapshots)` | Line ~3666 | Compress hourly data to daily |

#### Background Tasks

| Function | Location | Purpose |
|----------|----------|---------|
| `pollMiners()` | Line ~4550 | Fetch stats for all miners |
| `startBackgroundMinerPolling()` | Line ~4617 | Initialize 5-second polling loop |
| `startHistoryScheduler()` | Line ~4631 | Start hourly history snapshot scheduler |
| `start()` | Line ~4656 | Main startup sequence |

---

## Frontend Implementation

### Component Hierarchy

```
Dashboard (Main App)
├── Header
│   ├── Settings Button → SettingsModal
│   ├── Alerts Button → AlertSettingsModal
│   └── Add Miner Button → AddMinerModal
│
├── Global Stats Row
│   ├── BTCPriceCard
│   ├── NetworkCard
│   └── ElectricityCard
│
├── PriceGraphCard (24-hour electricity visualization)
│
├── HistoricalChartsCard (hashrate/temp/power over time)
│
├── EfficiencyCard (aggregate profitability)
│
├── Miners Grid
│   └── MinerCard (one per miner)
│       ├── Stats Display (hashrate, temp, power, uptime)
│       ├── Efficiency Info (daily profit, SCOP)
│       ├── Fan Speeds
│       ├── Miner Control Section
│       │   ├── Status Badges (AUTO indicator, MINING/PAUSED state)
│       │   ├── ON/OFF Buttons (manual pause/resume)
│       │   └── SCOP Auto-Control Panel
│       │       ├── Enable/Disable Toggle
│       │       ├── SCOP Threshold Setting
│       │       ├── Min Board Temp Setting
│       │       ├── Efficiency Override Section
│       │       │   ├── Last Measured Display
│       │       │   ├── Power Override Input (W)
│       │       │   └── Hashrate Override Input (TH/s)
│       │       ├── Save Settings Button
│       │       └── Auto Control Status Display
│       │           ├── Current vs Intended State
│       │           ├── Measured vs Projected SCOP
│       │           ├── Decision Basis Indicator
│       │           ├── State Reason
│       │           └── Error Display (if any)
│       ├── Pool Stats
│       ├── AutoControlTerminal (Hardware-based Auto-Control)
│       │   ├── Enable/Disable Toggle
│       │   ├── Current Readings Grid
│       │   │   ├── Chip Temp (with threshold)
│       │   │   ├── Board Temp (with threshold)
│       │   │   ├── Fan Speed (with threshold)
│       │   │   ├── Power (with threshold)
│       │   │   ├── Hashrate (with threshold)
│       │   │   └── Active Hashboards (with threshold)
│       │   ├── Control Log Terminal
│       │   │   ├── Real-time event log
│       │   │   ├── Severity-colored entries
│       │   │   └── Clear Logs button
│       │   └── AutoControlSettingsPanel
│       │       ├── Temperature Thresholds (max chip, max/min board)
│       │       ├── Power & Fan Limits (max/min power, max fan)
│       │       ├── Control Behavior (step sizes, cooldown, recovery)
│       │       ├── Save Settings button
│       │       └── (Form state protected from poll updates while editing)
│       └── Remove Button
│
├── API Terminal (debugging/troubleshooting)
│   ├── Miner Selector
│   ├── API Type Selector (CGMiner, gRPC, REST, GraphQL, Status, State)
│   ├── Command Input (for CGMiner commands)
│   ├── Quick Action Buttons
│   │   ├── Test Login (gRPC authentication)
│   │   ├── Check Status (mining/paused state)
│   │   ├── View State (control state details)
│   │   ├── Pause (test pause command)
│   │   └── Resume (test resume command)
│   ├── Command History (recent commands with success/failure)
│   └── Output Display (JSON response with copy button)
│
└── Debug Stats Section
    └── DebugStatsCard (per miner)
        ├── API Availability Summary
        ├── Miner Control State (DPS)
        ├── BOSminer Commands Data
        ├── REST API Data
        └── GraphQL Data
```

### Modal Components

#### SettingsModal
- Pricing mode toggle (Norgespris vs Strømstøtteavtale)
- Electricity zone selection (NO1-NO5)
- Dual grid fee configuration (weekday day / weekend-night)
- Alert threshold configuration

#### AddMinerModal
- IP address input with validation
- Miner name input
- Connection test before adding
- Error display

### Data Visualization Components

#### PriceGraphCard
- 24-hour stacked bar chart
- Base price (blue) + Grid fees (orange)
- Current hour highlighting
- Interactive tooltips
- Min/Avg/Max statistics

#### HistoricalChartsCard
- Line charts for hashrate, temperature, power
- Multi-miner support with separate/aggregated views
- Time range selection: 24h, 7d, 14d, 30d
- Hover tooltips with exact values
- Auto-refresh every 60 seconds

### State Management

```javascript
// Main App state hooks
const [miners, setMiners] = useState([]);
const [electricity, setElectricity] = useState(null);
const [btcPrice, setBtcPrice] = useState(null);
const [network, setNetwork] = useState(null);
const [alerts, setAlerts] = useState([]);
const [config, setConfig] = useState(null);
const [wsConnected, setWsConnected] = useState(false);
```

### WebSocket Connection

```javascript
// Reconnection logic with 5-second retry
const connectWebSocket = useCallback(() => {
  const ws = new WebSocket(`ws://${window.location.host}`);
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    setMiners(data.miners);
    setElectricity(data.electricity);
    setBtcPrice(data.btcPrice);
    setNetwork(data.network);
    setAlerts(data.alerts);
  };
  ws.onclose = () => setTimeout(connectWebSocket, 5000);
}, []);
```

---

## External API Integrations

### 1. hvakosterstrommen.no (Norwegian Electricity Prices)

**Purpose:** Hourly spot electricity prices for Norwegian zones

**Endpoint Pattern:**
```
https://www.hvakosterstrommen.no/api/v1/prices/{YYYY}/{MM-DD}_{ZONE}.json
```

**Response Format:**
```json
[
  {
    "NOK_per_kWh": 0.85,
    "EUR_per_kWh": 0.075,
    "time_start": "2025-12-30T00:00:00+01:00",
    "time_end": "2025-12-30T01:00:00+01:00"
  }
]
```

**VAT Handling:**
- Standard zones (NO1, NO2, NO3, NO5): 25% MVA added
- Tromsø (NO4): 0% VAT

**Refresh:** Every 30 minutes

### 2. CoinGecko API (Bitcoin Price)

**Endpoint:**
```
https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,nok,eur,sek
```

**Response Format:**
```json
{
  "bitcoin": {
    "usd": 95000,
    "nok": 1050000,
    "eur": 88000,
    "sek": 1020000
  }
}
```

**Refresh:** Every 5 minutes

### 3. blockchain.info (Network Stats)

**Endpoint:**
```
https://api.blockchain.info/stats
```

**Response Format:**
```json
{
  "difficulty": 72000000000000,
  "hash_rate": 600000000000000000,
  "n_blocks_total": 820000,
  "market_price_usd": 95000
}
```

**Refresh:** Every 10 minutes

---

## Miner Communication Protocols

### 1. CGMiner JSON-RPC API (Port 4028)

**Protocol:** TCP socket with JSON commands

**Implementation:** `sendCGMinerCommand()` at line 1184

**Commands Used:**

| Command | Purpose | Response Fields |
|---------|---------|-----------------|
| `summary` | Overall mining stats | `SUMMARY.MHS 5s`, `SUMMARY.Elapsed` |
| `stats` | Detailed statistics | Temperature, fan, hashboard data |
| `devs` | Device information | Per-device hashrate and temp |
| `pools` | Pool connections | Status, accepted/rejected shares |
| `fans` | Fan speeds | RPM values |
| `temps` | Temperature data | Board and chip temps |
| `tunerstatus` | Tuner state | Power target, efficiency |

**Power Control:**
```javascript
{ command: 'ascset', parameter: '0,power,WATTS' }
```

### 2. Braiins OS GraphQL API (Port 80)

**Implementation:** `fetchBraiinsGraphQL()` at line 120

**Authentication:** LuCI session token via web login

**Schema Discovery:** Full introspection to find available fields

**Example Query:**
```graphql
{
  bosminer {
    info {
      tempCtrl { targetC, hotC, dangerousC }
      fans { name, speed, rpm }
      workSolver {
        temperatures { name, degreesC }
      }
    }
  }
}
```

### 3. Braiins REST API (Port 80) - Stats Only

**Implementation:** `fetchBraiinsRestApiStats()` at line ~1548

**Authentication:** Token-based via `/api/v1/auth/login` endpoint
- Uses `braiinsRestAuth(ip, username, password)` to obtain token
- Token passed as `Authorization: Bearer <token>` header
- Credentials from miner config (default: root/root)

**Stats Endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `/api/v1/auth/login` | Obtain auth token |
| `/api/v1/miner/stats` | Mining statistics |
| `/api/v1/miner/hw/hashboards` | Hashboard details |
| `/api/v1/cooling/state` | Cooling status |
| `/api/v1/miner/errors` | Error log |
| `/api/v1/pools/` | Pool configuration |
| `/api/v1/performance/target-profiles` | Power profiles |
| `/api/v1/performance/tuner-state` | Tuner state (power data) |
| `/api/v1/miner/details` | Miner details |

**Power Data Extraction Priority:**
1. CGMiner tunerstatus `ApproximateMinerPowerConsumption`
2. GraphQL tuner data
3. CGMiner stats API
4. CGMiner summary API
5. REST API tuner-state `powerConsumptionW`
6. REST API miner-stats `powerConsumptionW`

### 4. Braiins gRPC API (Port 50051) - Miner Control

**Implementation:** Lines ~90-350 in server.js

**Protocol:** gRPC with Protocol Buffers (proto files in `proto/bos/v1/`)

**Port:** 50051 (enabled by default on Braiins OS 23.03.1+)

**Services Used:**
| Service | Method | Purpose |
|---------|--------|---------|
| `AuthenticationService` | `Login` | Get auth token |
| `ActionsService` | `PauseMining` | Pause mining |
| `ActionsService` | `ResumeMining` | Resume mining |

**Authentication Flow:**
```javascript
// 1. Login via gRPC to get token
const client = new AuthenticationService('192.168.1.89:50051', grpc.credentials.createInsecure());
client.Login({ username: 'root', password: 'root' }, (err, response) => {
  // response.token = "abc123..."
  // response.timeout_s = 3600
});

// 2. Use token in metadata for control actions
const metadata = new grpc.Metadata();
metadata.add('authorization', token);
actionsClient.PauseMining({}, metadata, { deadline }, callback);
```

**Token Management:**
- Tokens cached in `minerControlState[ip]`
- Auto-refresh 60 seconds before expiry
- Default timeout: 3600 seconds
- Auto-invalidation on UNAUTHENTICATED errors with retry

**Key Functions:**
| Function | Purpose |
|----------|---------|
| `loadProtos()` | Load .proto files on startup |
| `getGrpcClient(ip, service)` | Get/create cached gRPC client |
| `braiinsLogin(ip, user, pass)` | Authenticate via gRPC |
| `getMinerAuthToken(ip, config)` | Get/refresh cached auth token |
| `invalidateAuthToken(ip)` | Clear cached token and gRPC clients |
| `isAuthError(err)` | Detect authentication errors |
| `pauseMining(ip, config)` | Pause mining via gRPC (with auto-retry) |
| `resumeMining(ip, config)` | Resume mining via gRPC (with auto-retry) |

### Temperature Detection Patterns

The system tries 7+ patterns to extract temperatures (line 1225):

1. `temp_chip_X` / `temp_pcb_X` (Braiins S19 format)
2. `temp1`, `temp2`, `temp3` (older format)
3. `temp2_1`, `temp2_2`, `temp2_3` (some Antminers)
4. `Temperature` field from devs
5. `chain_tempX` patterns
6. Search for any field containing 'temp'
7. Value range detection (20-100°C)

### Fan Speed Detection Patterns

Similar multi-pattern detection (line 1346):

1. `fan1`, `fan2`, `fan3`, `fan4`
2. `fan_speed_in`, `fan_speed_out`
3. Capitalized variants (`Fan1`, `Fan2`)
4. `Fan Speed In`, `Fan Speed Out`
5. Search for 'fan' or 'rpm' in field names

---

## Data Flow & Caching

### Startup Sequence

```
1. ensureDataDir()         → Create /data directory
2. loadConfig()            → Load user configuration
3. fetchElectricityPrices()→ Initial price data
4. fetchBTCPrice()         → Initial BTC price
5. fetchNetworkStats()     → Initial network stats
6. startBackgroundPolling()→ Begin 5-second miner polling
7. app.listen(3456)        → Start HTTP server
8. WebSocket server init   → Ready for clients
```

### Background Polling Loop

```
Every 5 seconds:
┌─────────────────────────────────────────────────────┐
│ pollMiners()                                         │
├─────────────────────────────────────────────────────┤
│ 1. Load current config                              │
│ 2. For each miner in parallel:                      │
│    ├─ sendCGMinerCommand('summary')                 │
│    ├─ sendCGMinerCommand('stats')                   │
│    ├─ sendCGMinerCommand('pools')                   │
│    ├─ fetchBraiinsGraphQL() (for temps/fans)        │
│    └─ calculateEfficiency()                         │
│ 3. Check alerts for each miner                      │
│ 4. Update minerStatsCache                           │
│ 5. Broadcast to all WebSocket clients               │
│ 6. Every hour: saveHistoryEntry()                   │
└─────────────────────────────────────────────────────┘
```

### WebSocket Data Broadcast

```javascript
{
  miners: [{
    minerIp, minerName, hashrate, temperature, power,
    uptime, boards, fans, poolStatus, acceptedShares,
    rejectedShares, rejectRate, powerProfile, efficiency, error,
    // Miner control fields
    isPaused,           // boolean - is miner currently paused
    autoControl: {      // Auto-control configuration
      enabled,          // boolean - is auto-control active
      scopThreshold,    // number - SCOP threshold for pausing
      minTemperature,   // number - min board temp override (optional)
      efficiencyOverride: {  // Custom efficiency for projections (optional)
        power,          // number - expected power in watts
        hashrate        // number - expected hashrate in TH/s
      }
    },
    autoControlState: { // Real-time auto-control status
      intendedState,    // 'mining' | 'paused' | null
      stateReason,      // string - why this state was chosen
      stateMatches,     // boolean - does actual match intended
      lastControlAction,// Date - when last control command sent
      controlAttempts,  // number - consecutive sync failures
      lastSyncError,    // string - last error message
      // Efficiency tracking (control)
      scopUsed,         // number - SCOP value used for decision (from override)
      scopType,         // 'override' | 'none'
      projectedSCOP,    // number - calculated override SCOP (used for control)
      projectedSource,  // 'override' | 'none'
      projectedPower,   // number - power from override (W)
      projectedHashrate,// number - hashrate from override (TH/s)
      // Efficiency tracking (measurement - reference only)
      measuredPower,    // number - instant measured power (W)
      measuredHashrate, // number - instant measured hashrate (TH/s)
      measuredEfficiency, // number - instant efficiency (W/TH)
      measuredAvgPower,    // number - rolling avg power (W)
      measuredAvgHashrate, // number - rolling avg hashrate (TH/s)
      measuredAvgEfficiency, // number - rolling avg efficiency (W/TH)
      best1hPower,      // number - best 1h avg power (W)
      best1hHashrate,   // number - best 1h avg hashrate (TH/s)
      best1hEfficiency, // number - best 1h avg efficiency (W/TH)
      best1hTimestamp,  // Date - when best 1h was recorded
      lastEfficiencyUpdate // Date - when efficiency was last measured
    },
    // Hardware auto-mining control
    autoMiningControl: {   // Hardware auto-control configuration
      enabled,             // boolean - is hardware auto-control active
      thresholds: {        // Threshold settings
        maxChipTemp,       // number - pause if exceeded (°C)
        maxBoardTemp,      // number - power down if exceeded (°C)
        minBoardTemp,      // number - power up for heating (°C)
        maxFanSpeed,       // number - power down if exceeded (RPM)
        maxPower,          // number - max power limit (W)
        minPower           // number - min power floor (W)
      },
      behavior: {          // Control behavior settings
        powerStepDown,     // number - watts to reduce
        powerStepUp,       // number - watts to increase
        cooldownSeconds,   // number - between adjustments
        recoveryDelaySeconds // number - before power increase
      }
    },
    autoMiningControlState: { // Real-time control state
      lastCheck,           // Date - when last checked
      lastAdjustment,      // Date - when last adjustment made
      lastAdjustmentType,  // 'PAUSE' | 'RESUME' | 'POWER_UP' | 'POWER_DOWN'
      adjustmentReason,    // string - why adjustment was made
      readings: {          // Current readings snapshot
        chipTemp,          // number - max chip temp (°C)
        avgBoardTemp,      // number - avg board temp (°C)
        avgFanSpeed,       // number - avg fan speed (RPM)
        power,             // number - current power (W)
        hashrate,          // number - current hashrate (TH/s)
        activeBoards       // number - active hashboard count
      },
      violations: {        // Current threshold violations
        chipTempCritical,  // boolean
        boardTempHigh,     // boolean
        boardTempLow,      // boolean
        fanSpeedHigh,      // boolean
        powerHigh          // boolean
      }
    },
    autoControlLogs: [     // Last 20 control events
      {
        timestamp,         // ISO date string
        type,              // 'CHECK' | 'ADJUSTMENT' | 'VIOLATION' | 'ERROR'
        severity,          // 'info' | 'warning' | 'critical'
        message,           // string - event description
        details            // object - additional data
      }
    ]
  }],
  electricity: {
    rawSpotPrice, basePrice, gridFee, effectivePrice,
    subsidyApplied, subsidyAmount, priceMode, zone, zoneName,
    currency, prices[]
  },
  btcPrice: { nok, eur, sek, usd },
  network: { difficulty, hashrate, hashrateFormatted, blockHeight, blockReward },
  alerts: [{ type, severity, message, minerName, timestamp }],
  alertHistory: [last 20 alerts]
}
```

---

## Feature Documentation

### 1. Multi-Miner Management

- Add/remove miners via UI
- Each miner tracked independently
- Parallel polling for performance
- Per-miner power profile control
- Automatic config migration from single-miner format

### 2. Norwegian Electricity Pricing

#### Norgespris Mode
- Fixed base price: **0.50 NOK/kWh**
- Plus time-of-day grid fees
- Formula: `Total = 0.50 + GridFee`

#### Strømstøtteavtale Mode (with State Subsidy)
- Spot price with 90% subsidy above threshold
- Threshold: **93.75 øre/kWh (0.9375 NOK/kWh)**
- Formula: `Effective = Spot - ((Spot - 0.9375) × 0.90) + GridFee`

#### Time-of-Day Grid Fees
- **Weekday Day** (Mon-Fri 06:00-22:00): Default 0.50 kr/kWh
- **Weekend/Night** (all other times): Default 0.30 kr/kWh
- Configurable in settings

### 3. Power Profile Control

| Profile | Power Target | Daily kWh | Use Case |
|---------|--------------|-----------|----------|
| Low | ~2000W | ~48 kWh | Minimal heating |
| Medium | ~3250W | ~78 kWh | Balanced (default) |
| High | ~3500W | ~84 kWh | Maximum heating |

Implementation uses CGMiner `ascset` command.

### 4. Miner Control (Pause/Resume)

**Manual Control:**
- ON button: Resume mining immediately
- OFF button: Pause mining immediately
- Visual indicator shows current state (PAUSED badge)

**Implementation:**
- Uses Braiins OS REST API (`/api/v1/actions/pause` and `/api/v1/actions/resume`)
- Requires authentication (default: root/root)
- State tracked in `minerControlState` cache

### 5. SCOP-Based Auto-Control

Automatically pause/resume mining based on efficiency thresholds and heating needs. The system actively monitors and controls the miner to ensure it matches the intended state.

**Configuration (per miner):**
| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Enable auto-control | false |
| `scopThreshold` | Pause if SCOP drops below this | 2.0 |
| `minTemperature` | Keep ON if board temp below this | (not set) |
| `efficiencyOverride.power` | **Required**: Expected power consumption (W) | none |
| `efficiencyOverride.hashrate` | **Required**: Expected hashrate (TH/s) | none |

**⚠️ IMPORTANT**: The efficiency override is **required** for auto-control to function. It is **always used** for control decisions, never the measured efficiency.

**Override-Only Control System:**
- **Override SCOP**: Calculated from manual efficiency override (**ALWAYS used for control decisions**)
- **Measured SCOP**: Calculated from actual live mining data (**for comparison/reference only**)

This ensures predictable, deterministic behavior that works even when power stats are unavailable (e.g., at startup when power shows "N/A").

**Efficiency Tracking (For Reference Only):**
When miner is actively mining, the system tracks:
- **Current measurements**: Instant power, hashrate, and efficiency (W/TH)
- **Rolling average**: Average over last 720 samples (1 hour at 5s intervals)
- **Best 1h efficiency**: Best rolling average ever achieved (can be reset)

These measurements are displayed in the UI to help you:
1. Verify your override matches reality
2. Calibrate your override settings
3. Monitor performance over time

**Control Logic:**
```
Every poll cycle (when auto-control enabled):
├── Track actual miner state from hashrate (>0.1 TH/s = mining)
│
├── If miner is actively mining:
│   ├── Record instant measurements (power, hashrate, efficiency)
│   ├── Update rolling average (last 720 samples)
│   └── Update best 1h efficiency if new record
│
├── Calculate override SCOP using manual efficiency settings
│   └── If no override configured → cannot control (defaults to mining)
│
├── Determine intended state:
│   ├── Priority 1: If boardTemp < minTemp → MINING (heating needed)
│   ├── Priority 2: If override SCOP >= threshold → MINING
│   └── Otherwise → PAUSED
│
└── Sync actual state to intended state:
    ├── If states don't match AND cooldown expired (30s):
    │   └── Issue pause/resume command via gRPC
    └── Track sync errors and retry attempts
```

**State Display:**
- Shows current state vs intended state
- Displays measured SCOP (for reference) vs override SCOP (controls miner)
- Shows current average efficiency and best 1h efficiency
- Indicates control decision basis and state reason
- Shows any sync errors

**Board Temperature:**
- Uses average of all available board temps (not chip temp)
- Board temp better reflects room temperature
- Falls back to chip temp if no board temps available

**Rate Limiting:**
- Control actions rate-limited to 30 seconds between commands
- Prevents rapid toggling when near threshold

**Best Efficiency Tracking:**
- Automatically tracks best 1h rolling average efficiency
- Displayed in UI with reset button
- Useful for understanding peak performance capabilities
- API: `POST /api/miner/reset-best-efficiency` with `{ip: "X.X.X.X"}`

### 6. Auto Mining Control (Hardware-Based)

Comprehensive hardware monitoring system that automatically adjusts miner power based on temperature and fan speed thresholds. Includes a real-time terminal display showing state checks and live adjustments.

**Key Features:**
- **Real-time monitoring**: Chip temp, board temp, fan speed, power, hashrate, active hashboards
- **Automatic power adjustment**: Reduces/increases power based on thermal conditions
- **Emergency protection**: Immediately pauses mining if critical chip temp exceeded
- **Heating mode**: Maintains mining and increases power when board temps are low
- **In-app terminal**: Live log showing control events with severity levels
- **Configurable thresholds**: All limits adjustable per-miner

**Configuration (per miner):**
| Setting | Description | Default |
|---------|-------------|---------|
| `autoMiningControl.enabled` | Enable hardware-based auto-control | false |
| `thresholds.maxChipTemp` | Pause immediately if exceeded (°C) | 95 |
| `thresholds.maxBoardTemp` | Reduce power if exceeded (°C) | 75 |
| `thresholds.minBoardTemp` | Increase power/resume for heating (°C) | 20 |
| `thresholds.maxFanSpeed` | Reduce power if exceeded (RPM) | 6000 |
| `thresholds.maxPower` | Maximum allowed power (W) | 3500 |
| `thresholds.minPower` | Minimum power floor (W) | 1500 |
| `thresholds.minHashrate` | Alert if below (TH/s) | 100 |
| `thresholds.minActiveBoards` | Alert if below | 3 |
| `behavior.powerStepDown` | Watts to reduce per adjustment | 250 |
| `behavior.powerStepUp` | Watts to increase per adjustment | 100 |
| `behavior.cooldownSeconds` | Minimum time between adjustments | 60 |
| `behavior.recoveryDelaySeconds` | Delay before increasing power after reduction | 300 |

**Control Logic (Priority Order):**
```
Every poll cycle (5 seconds) when auto-mining-control enabled:
│
├── Priority 1: CRITICAL CHIP TEMP (>maxChipTemp)
│   └── PAUSE IMMEDIATELY - Emergency thermal protection
│
├── Priority 2: LOW BOARD TEMP (<minBoardTemp)
│   ├── If paused → RESUME (heating needed)
│   └── If mining & power < max → INCREASE POWER
│
├── Priority 3: HIGH TEMP OR HIGH FANS
│   ├── If boardTemp > maxBoardTemp → REDUCE POWER
│   └── If fanSpeed > maxFanSpeed → REDUCE POWER
│
└── Priority 4: RECOVERY (after recoveryDelaySeconds)
    └── If stable & power < max → INCREASE POWER (gradual)
```

**Terminal Display:**
- Shows current readings vs thresholds with violation highlighting
- Real-time log with timestamps and severity-colored entries
- Log types: CHECK (🔍), ADJUSTMENT (⚡), VIOLATION (⚠️), RECOVERY (✅), ERROR (❌)
- Clear logs button
- Collapsible settings panel

**Control Actions:**
| Action | Trigger | Command |
|--------|---------|---------|
| PAUSE | Chip temp critical | gRPC `PauseMining()` |
| RESUME | Board temp low (heating) | gRPC `ResumeMining()` |
| POWER_DOWN | High temps or fans | CGMiner `ascset 0,power,X` |
| POWER_UP | Recovery or heating | CGMiner `ascset 0,power,X` |

**API Endpoints:**
- `POST /api/miner/auto-mining-control` - Update settings
- `GET /api/miner/auto-control/logs/:ip` - Get control logs
- `POST /api/miner/auto-control/clear-logs` - Clear logs

**Difference from SCOP Auto-Control:**
| Aspect | SCOP Auto-Control | Auto Mining Control |
|--------|-------------------|---------------------|
| **Purpose** | Profitability optimization | Hardware protection & thermal management |
| **Trigger** | SCOP threshold | Temperature, fan speed, power thresholds |
| **Actions** | Pause/Resume only | Pause/Resume + Power adjustment |
| **Use Case** | Pause when unprofitable | Adjust power to maintain safe temps |

Both systems can be enabled simultaneously - Auto Mining Control takes precedence for safety.

### 7. Efficiency Metrics

```javascript
// Daily BTC estimate
dailyBTC = (minerHashrate / networkHashrate) × blockReward × blocksPerDay

// Daily electricity cost
dailyCost = (power / 1000) × 24 × electricityPrice

// Effective SCOP (vs heat pump)
effectiveSCOP = 1 / (1 - (btcEarnings / electricityCost))

// Heating savings
savings = heatPumpCost - electricityCost + btcEarnings
```

### 7. Alert System

| Alert Type | Default Threshold | Cooldown |
|------------|-------------------|----------|
| High Temperature | 80°C | 15 minutes |
| Low Hashrate | 80% of expected | 15 minutes |
| Miner Offline | N/A | 15 minutes |
| High Reject Rate | 5% | 15 minutes |

Alerts are persisted in `alertHistory` array (last 100).

### 8. Historical Data (v2)

A reliable, independent background scheduler saves comprehensive hourly snapshots with two-tier retention.

**Data Storage Format (v2):**
```json
{
  "version": 2,
  "hourlySnapshots": [
    {
      "timestamp": "2026-01-18T10:00:00.000Z",
      "aggregate": {
        "totalHashrate": 240.5,
        "totalPower": 6400,
        "avgTemperature": 62,
        "totalDailyProfit": 45.50,
        "totalDailyBTC": 0.00012,
        "totalDailyCost": 32.00,
        "avgSCOP": 2.8,
        "minerCount": 2,
        "activeMinerCount": 2
      },
      "miners": [
        {
          "ip": "192.168.1.100",
          "name": "Living Room",
          "hashrate": 120.5,
          "power": 3200,
          "temperature": 62,
          "isPaused": false,
          "scop": 2.8,
          "dailyProfit": 22.75,
          "dailyBTC": 0.00006,
          "dailyCost": 16.00,
          "autoControlEnabled": true,
          "autoControlState": "mining"
        }
      ],
      "market": {
        "btcPriceNOK": 1050000,
        "btcPriceUSD": 95000,
        "btcPriceEUR": 88000,
        "btcPriceSEK": 1020000,
        "electricityPrice": 1.25,
        "electricitySpotPrice": 0.85,
        "gridFee": 0.40,
        "networkDifficulty": 72000000000000,
        "networkHashrate": 600000000000000000
      }
    }
  ],
  "dailyAverages": [
    {
      "date": "2026-01-17",
      "sampleCount": 24,
      "aggregate": {
        "avgHashrate": 238.2,
        "avgPower": 6350,
        "avgTemperature": 61,
        "totalDailyProfit": 44.80,
        "avgSCOP": 2.75,
        "avgMinerCount": 2
      },
      "market": {
        "avgBtcPrice": 1045000,
        "avgElectricityPrice": 1.22,
        "avgDifficulty": 72000000000000
      }
    }
  ]
}
```

**Key Features:**
- **Independent Background Scheduler**: Runs hourly on the hour, independent of WebSocket connections
- **Data Validation**: Only saves entries with valid hashrate and power data
- **Rich Metrics**: Includes SCOP, daily profit/BTC/cost, auto-control state, and full market data
- **Two-Tier Retention**:
  - Hourly snapshots: 168 entries (7 days)
  - Daily averages: 30 entries (30 days)
- **Auto-Compression**: Old hourly data automatically compressed to daily averages before deletion
- **Backward Compatible**: Automatically migrates v1 format to v2 on load
- **Pre-Aggregated Data**: Aggregate stats computed at save time for faster chart rendering

**Backend Functions:**

| Function | Location | Purpose |
|----------|----------|---------|
| `loadHistory()` | Line ~3487 | Load history with v1→v2 migration |
| `migrateV1Entries()` | Line ~3515 | Convert old entries to v2 format |
| `saveHistorySnapshot()` | Line ~3562 | Save complete hourly snapshot |
| `aggregateToDailyAverages()` | Line ~3666 | Compress hourly data to daily |
| `startHistoryScheduler()` | Line ~4631 | Start background save scheduler |

**API:** `GET /api/history?days=7&minerIp=X.X.X.X`

**Response:**
```json
{
  "entries": [...],
  "version": 2,
  "hasHourlyData": true,
  "hasDailyData": true
}
```

**Note:** The API returns v1-style flat entries for backward compatibility with the frontend chart component.

### 9. API Terminal (Debugging & Troubleshooting)

A built-in terminal interface for testing and debugging miner API commands without redeploying the app.

**Features:**
- Execute commands against any configured miner
- Support for multiple API types (CGMiner, gRPC, REST, GraphQL)
- Quick action buttons for common operations
- Command history with success/failure tracking
- JSON output with copy-to-clipboard functionality

**Supported Command Types:**

| Type | Description | Example Use Case |
|------|-------------|------------------|
| **cgminer** | CGMiner API commands (port 4028) | Test summary, stats, pools, devs, temps, fans, tunerstatus |
| **grpc-login** | Test gRPC authentication | Verify port 50051 connectivity and credentials |
| **grpc-pause** | Pause mining via gRPC | Test pause functionality directly |
| **grpc-resume** | Resume mining via gRPC | Test resume functionality directly |
| **rest** | Fetch REST API stats | Verify REST API authentication and data |
| **graphql** | Fetch GraphQL API data | Test GraphQL endpoint connectivity |
| **status** | Get mining status | Check if miner is paused or running |
| **state** | Get control state | View current control state and miner config |

**Quick Actions:**
- 🔐 Test Login - Verify gRPC authentication
- 📊 Check Status - View current mining/paused state
- ⚙️ View State - Inspect control state details
- ⏸️ Pause - Execute pause command
- ▶️ Resume - Execute resume command

**Use Cases:**
1. **Troubleshooting controls** - Test pause/resume commands to see exact error messages
2. **Verifying connectivity** - Check if gRPC port 50051 is accessible
3. **Testing credentials** - Confirm username/password work for authentication
4. **Exploring API responses** - See raw data from different API endpoints
5. **Quick debugging** - Rapidly test API changes without app redeploy

---

## Configuration Schema

### config.json Structure

```json
{
  "miners": [
    {
      "ip": "192.168.1.100",
      "name": "Living Room Miner",
      "username": "root",
      "password": "root",
      "powerProfile": "medium",
      "autoControl": {
        "enabled": false,
        "scopThreshold": 2.0,
        "minTemperature": 35,
        "efficiencyOverride": {
          "power": 3200,
          "hashrate": 120
        }
      }
    }
  ],
  "country": "norway",
  "electricityZone": "NO5",
  "gridFeeWeekdayDay": 0.50,
  "gridFeeWeekendNight": 0.30,
  "priceMode": "stromstotteavtale",
  "alerts": {
    "enabled": true,
    "highTemp": { "enabled": true, "threshold": 80 },
    "lowHashrate": { "enabled": true, "threshold": 80 },
    "minerOffline": { "enabled": true },
    "highRejectRate": { "enabled": true, "threshold": 5 },
    "cooldownMinutes": 15
  },
  "updatedAt": "2025-12-30T..."
}
```

### Per-Miner SCOP Auto-Control Settings

| Field | Type | Description |
|-------|------|-------------|
| `autoControl.enabled` | boolean | Enable SCOP-based auto-control |
| `autoControl.scopThreshold` | number | Pause mining if SCOP drops below this value |
| `autoControl.minTemperature` | number | Keep mining if board temp drops below this (°C) |
| `autoControl.efficiencyOverride.power` | number | Expected power consumption in watts (for projected SCOP) |
| `autoControl.efficiencyOverride.hashrate` | number | Expected hashrate in TH/s (for projected SCOP) |

### Per-Miner Hardware Auto-Mining-Control Settings

| Field | Type | Description |
|-------|------|-------------|
| `autoMiningControl.enabled` | boolean | Enable hardware-based auto-control |
| `autoMiningControl.thresholds.maxChipTemp` | number | Pause immediately if exceeded (°C) |
| `autoMiningControl.thresholds.maxBoardTemp` | number | Reduce power if exceeded (°C) |
| `autoMiningControl.thresholds.minBoardTemp` | number | Increase power for heating (°C) |
| `autoMiningControl.thresholds.maxFanSpeed` | number | Reduce power if exceeded (RPM) |
| `autoMiningControl.thresholds.maxPower` | number | Maximum power limit (W) |
| `autoMiningControl.thresholds.minPower` | number | Minimum power floor (W) |
| `autoMiningControl.thresholds.minHashrate` | number | Alert threshold (TH/s) |
| `autoMiningControl.thresholds.minActiveBoards` | number | Alert threshold |
| `autoMiningControl.behavior.powerStepDown` | number | Watts to reduce per adjustment |
| `autoMiningControl.behavior.powerStepUp` | number | Watts to increase per adjustment |
| `autoMiningControl.behavior.cooldownSeconds` | number | Minimum seconds between adjustments |
| `autoMiningControl.behavior.recoveryDelaySeconds` | number | Delay before power recovery |

### Available Electricity Zones

| Zone | Name | VAT Rate |
|------|------|----------|
| NO1 | Oslo / Øst-Norge | 25% |
| NO2 | Kristiansand / Sør-Norge | 25% |
| NO3 | Trondheim / Midt-Norge | 25% |
| NO4 | Tromsø / Nord-Norge | 0% |
| NO5 | Bergen / Vest-Norge | 25% |

### Migration Behavior

**Single-miner to multi-miner:**
```javascript
// Old format with minerIP
{ minerIP: "192.168.1.100", ... }
// Migrated to
{ miners: [{ ip: "192.168.1.100", name: "Miner 1" }], ... }
```

**Single grid fee to dual:**
```javascript
// Old format
{ gridFeePerKwh: 0.50 }
// Migrated to
{ gridFeeWeekdayDay: 0.50, gridFeeWeekendNight: 0.30 }
```

---

## API Reference

### Health & Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check (returns 200) |
| GET | `/api/config` | Load user configuration |
| POST | `/api/config` | Save configuration |

### Miner Management

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| GET | `/api/miner/stats?ip=X.X.X.X` | - | Get single miner stats |
| POST | `/api/miner/power` | `{ip, profile}` | Set power profile |
| POST | `/api/miner/test` | `{minerIP}` | Test miner connection |
| POST | `/api/miners/add` | `{ip, name, username?, password?}` | Add new miner |
| POST | `/api/miners/remove` | `{ip}` | Remove miner |
| POST | `/api/miners/update` | `{ip, name?, powerProfile?, username?, password?}` | Update miner |

### Miner Control

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/miner/pause` | `{ip}` | Pause mining on miner |
| POST | `/api/miner/resume` | `{ip}` | Resume mining on miner |
| GET | `/api/miner/status?ip=X.X.X.X` | - | Get mining status (paused/running) |
| POST | `/api/miner/auto-control` | `{ip, enabled, scopThreshold, minTemperature, efficiencyOverride}` | Update SCOP auto-control settings |
| POST | `/api/miner/auto-mining-control` | `{ip, enabled, thresholds, behavior}` | Update hardware auto-control settings |
| GET | `/api/miner/auto-control/logs/:ip` | - | Get auto-control logs for miner |
| POST | `/api/miner/auto-control/clear-logs` | `{ip}` | Clear auto-control logs |
| POST | `/api/miner/reset-best-efficiency` | `{ip}` | Reset best 1h efficiency tracking |

**SCOP auto-control body example:**
```json
{
  "ip": "192.168.1.100",
  "enabled": true,
  "scopThreshold": 2.5,
  "minTemperature": 30,
  "efficiencyOverride": {
    "power": 3200,
    "hashrate": 120
  }
}
```

**Hardware auto-mining-control body example:**
```json
{
  "ip": "192.168.1.100",
  "enabled": true,
  "thresholds": {
    "maxChipTemp": 95,
    "maxBoardTemp": 75,
    "minBoardTemp": 20,
    "maxFanSpeed": 6000,
    "maxPower": 3500,
    "minPower": 1500
  },
  "behavior": {
    "powerStepDown": 250,
    "powerStepUp": 100,
    "cooldownSeconds": 60,
    "recoveryDelaySeconds": 300
  }
}
```

### Market Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/electricity/zones` | Get available zones |
| GET | `/api/electricity/prices` | Get current hourly prices |
| GET | `/api/btc/price` | Get Bitcoin price |
| GET | `/api/network/stats` | Get network stats |

### API Terminal (Debugging/Troubleshooting)

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/terminal/execute` | `{ip, type, command}` | Execute API command for debugging |
| GET | `/api/terminal/commands` | - | Get list of available terminal commands |

**Terminal execute body example:**
```json
{
  "ip": "192.168.1.100",
  "type": "cgminer",
  "command": "summary"
}
```

**Available command types:**
- `cgminer` - CGMiner API commands (summary, stats, pools, devs, temps, fans, tunerstatus, devdetails, version)
- `grpc-login` - Test gRPC authentication
- `grpc-pause` - Pause mining via gRPC
- `grpc-resume` - Resume mining via gRPC
- `rest` - Fetch REST API stats
- `graphql` - Fetch GraphQL API data
- `status` - Get current mining status (paused/running)
- `state` - Get current control state and miner config

**Response format:**
```json
{
  "success": true,
  "command": "summary",
  "type": "cgminer",
  "ip": "192.168.1.100",
  "duration": "45ms",
  "result": { /* API response data */ }
}
```

### History & Alerts

| Method | Endpoint | Query Params | Description |
|--------|----------|--------------|-------------|
| GET | `/api/history` | `days`, `minerIp` | Get historical data |
| GET | `/api/alerts/history` | `limit` | Get alert history |
| POST | `/api/alerts/config` | Alert settings | Update alert config |
| POST | `/api/alerts/clear` | - | Clear alert history |

### WebSocket

**Endpoint:** `ws://host:3456/`

**Data Format:** See [WebSocket Data Broadcast](#websocket-data-broadcast)

**Reconnection:** Client auto-reconnects every 5 seconds

---

## Deployment

### Docker Configuration

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
USER 1000
EXPOSE 3456
HEALTHCHECK --interval=30s CMD wget -q --spider http://localhost:3456/health
CMD ["node", "server.js"]
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3456 | Server port |
| `DATA_DIR` | /data | Data storage directory |
| `NODE_ENV` | production | Environment mode |

### Umbrel Deployment

The app includes `umbrel-app.yaml` manifest for easy installation on Umbrel home servers.

### Docker Compose

```yaml
services:
  mining-dashboard:
    image: jacks-mining-dashboard:latest
    ports:
      - "3456:3456"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

---

## Security Considerations

### Implemented

- Non-root Docker user (UID 1000)
- HTTPS for external API calls
- LuCI session authentication for miner APIs
- No sensitive data stored in code
- Local network assumption

### Not Implemented

- User authentication for dashboard
- API key validation
- Rate limiting
- Input sanitization
- HTTPS for dashboard itself

### Recommendations

- Run on private network only
- Use Tailscale VPN for remote access
- Consider adding authentication if exposing to internet
- Configure per-miner credentials if not using default (root:root)
- Miner credentials stored in plaintext in config.json

---

## Troubleshooting

### Using the API Terminal (Recommended First Step)

The built-in **API Terminal** is the fastest way to diagnose miner control and connectivity issues:

1. Navigate to the "API Terminal" section on the dashboard
2. Select your miner from the dropdown
3. Use the **Quick Actions** to test:
   - **🔐 Test Login** - Verify gRPC authentication works
   - **📊 Check Status** - See current mining/paused state
   - **⚙️ View State** - Inspect control state and config
   - **⏸️ Pause / ▶️ Resume** - Test control commands

The terminal will show exact error messages and response times, making it easy to identify:
- Authentication failures
- Network connectivity issues
- API compatibility problems
- Control command errors

### Miner Connection Issues

```bash
# Test CGMiner API connectivity
nc -zv [miner-ip] 4028

# Test gRPC API connectivity
nc -zv [miner-ip] 50051

# Test with curl
curl -X POST http://localhost:3456/api/miner/test \
  -H "Content-Type: application/json" \
  -d '{"minerIP": "192.168.1.100"}'
```

**Using API Terminal:**
- Select miner and click **"🔐 Test Login"**
- If successful: gRPC port 50051 is accessible and credentials are correct
- If error: Check error message for details (connection refused, timeout, auth error)

**Common causes:**
- Miner not running Braiins OS
- Firewall blocking port 4028 or 50051
- Incorrect IP address
- CGMiner API disabled
- Wrong authentication credentials

### Authentication Issues

**Symptom:** `UNAUTHENTICATED: Missing or invalid authentication token`

**Quick Test:** Use API Terminal → **"🔐 Test Login"** to verify credentials immediately

**Solutions:**
1. Update miner credentials via API:
   ```bash
   curl -X POST http://localhost:3456/api/miners/update \
     -H "Content-Type: application/json" \
     -d '{"ip": "192.168.1.100", "username": "root", "password": "YOUR_PASSWORD"}'
   ```
2. Check if you can log into miner web UI with same credentials
3. Restart dashboard to clear cached tokens
4. Newer Braiins OS versions require authentication for all APIs

### Miner Control Not Working

**Symptom:** ON/OFF buttons don't pause/resume mining

**Diagnostic Steps:**
1. Open **API Terminal**
2. Click **"⚙️ View State"** to see current control state
3. Click **"📊 Check Status"** to verify actual miner state
4. Click **"⏸️ Pause"** or **"▶️ Resume"** to test directly
5. Review error message in terminal output

**Common issues:**
- gRPC port 50051 not accessible (connection refused)
- Authentication failure (check username/password in miner config)
- Miner not running Braiins OS with gRPC support (requires 23.03.1+)
- Token expired (terminal will show auth error)

### WebSocket Disconnects

Auto-reconnects every 5 seconds. If persistent:
- Check port 3456 accessibility
- Verify no proxy interference
- Clear browser cache

### Incorrect Pricing

- Verify `priceMode` setting
- Check `electricityZone` matches your location
- Confirm grid fee values
- Subsidy only applies when spot > 0.9375 NOK/kWh

### Docker Issues

```bash
# View logs
docker logs jacks-mining-dashboard

# Restart container
docker restart jacks-mining-dashboard

# Check health
curl http://localhost:3456/health
```

---

## Development Workflow

### Local Development

```bash
npm install
npm run dev  # NODE_ENV=development
```

### Automated Deployment

Changes pushed to GitHub trigger automatic deployment to Umbrel server. Testing is performed directly on the Umbrel instance.

### Code Style

- **Backend:** Async/await, try-catch error handling, extensive logging
- **Frontend:** React functional components, hooks, inline CSS
- **No TypeScript:** Plain JavaScript throughout

---

## Performance Characteristics

| Metric | Value |
|--------|-------|
| Memory footprint | ~50-100MB |
| Miner poll interval | 5 seconds |
| WebSocket broadcast | 5 seconds |
| Electricity price refresh | 30 minutes |
| BTC price refresh | 5 minutes |
| Network stats refresh | 10 minutes |
| History retention | 168 hourly (7 days) + 30 daily (30 days) |
| History save interval | Hourly (on the hour) |

---

## Version History

### v1.7.1 (Current)
- **🛡️ Settings Form State Protection**: Fixed issue where editing settings values would reset on poll updates
  - Settings panel now tracks "dirty" state when user modifies values
  - Polling updates no longer overwrite unsaved user edits
  - Dirty state automatically resets when panel is closed or settings are saved
  - Users can now take their time editing thresholds without racing the 5-second poll interval

### v1.7.0
- **🤖 Auto Mining Control**: Comprehensive hardware-based automatic control system
  - **Real-time Monitoring**: Continuously monitors chip temp, board temp, fan speed, power, hashrate, and active hashboards
  - **Automatic Power Adjustment**: Dynamically adjusts miner power based on thermal conditions
  - **Emergency Protection**: Immediately pauses mining if critical chip temperature is exceeded
  - **Heating Mode**: Maintains or increases power when board temps are low (for home heating use)
  - **In-App Terminal**: Live terminal display showing control events with timestamps and severity levels
  - **Configurable Thresholds**: All temperature, fan speed, and power limits adjustable per-miner
  - **Control Behavior Settings**: Adjustable power step sizes, cooldown periods, and recovery delays
  - **Priority-Based Logic**: Critical safety > Heating needs > Thermal protection > Power recovery
- **🎛️ New UI Components**:
  - `AutoControlTerminal` - Embedded terminal with readings grid, event log, and settings panel
  - `ReadingDisplay` - Individual readings with threshold comparison and violation highlighting
  - `AutoControlSettingsPanel` - Collapsible panel for configuring thresholds and behavior
  - `SettingInput` - Reusable number input for configuration values
- **📡 New API Endpoints**:
  - `POST /api/miner/auto-mining-control` - Update hardware auto-control settings
  - `GET /api/miner/auto-control/logs/:ip` - Get control event logs
  - `POST /api/miner/auto-control/clear-logs` - Clear control logs
- **🔧 Backend Enhancements**:
  - `autoControlLogs` buffer - In-memory circular log (100 entries per miner)
  - `checkAutoMiningControl()` - Main control loop integrated with polling
  - Power adjustment via CGMiner `ascset` command
  - Compatible with existing SCOP auto-control (hardware safety takes precedence)

### v1.6.0
- **📊 Historical Data v2**: Complete redesign of historical data storage and collection
  - **Independent Background Scheduler**: Hourly snapshots saved on the hour, independent of WebSocket connections
  - **Two-Tier Retention**: 168 hourly snapshots (7 days) + 30 daily averages (30 days)
  - **Auto-Compression**: Old hourly data automatically compressed to daily averages before deletion
  - **Rich Metrics**: Now stores SCOP, daily profit/BTC/cost, auto-control state, and full market data (4 currencies)
  - **Pre-Aggregated Data**: Aggregate stats (total hashrate, avg temp, etc.) computed at save time
  - **Data Validation**: Only saves entries with valid hashrate and power data
  - **Backward Compatible**: Automatically migrates v1 format to v2 on load
- **🎨 Improved Historical Charts UI**:
  - Data info badge showing entry count and data version
  - Better error handling with retry button
  - Helpful empty state with info about when first snapshot will be saved
  - Validation of fetched data before display

### v1.5.0
- **🔧 SCOP Auto-Control Fix**: Fixed critical startup issue where auto-control defaulted to "always on"
  - System now **requires** manual efficiency override for auto-control to function
  - Override SCOP is **always used** for control decisions (never measured SCOP)
  - Measured efficiency tracked separately for reference/comparison only
  - Fixes N/A power stats at startup causing incorrect control decisions
- **📊 Enhanced Efficiency Tracking**: Comprehensive efficiency monitoring for reference
  - **Rolling average**: Tracks average efficiency over last 1 hour (720 samples at 5s intervals)
  - **Best 1h efficiency**: Automatically tracks best rolling average ever achieved
  - **Reset capability**: API endpoint to reset best efficiency tracking (`POST /api/miner/reset-best-efficiency`)
  - All measurements displayed in UI to help calibrate override settings
- **🎨 Improved UI Clarity**: Better visualization of control vs measurement
  - Clear labels: "Measured SCOP (for reference)" vs "Override SCOP (controls miner)"
  - Current average efficiency display with W/TH units
  - Best 1h efficiency display with reset button
  - Warning: Override required for auto-control to function
- **📈 Efficiency Comparison**: Compare manual override against measured reality
  - See instant, average, and best efficiency measurements
  - Use measured data to calibrate your override settings
  - Understand how your miner performs under different conditions

### v1.4.2
- **API Terminal**: Built-in debugging interface for testing miner API commands
  - Support for CGMiner, gRPC, REST, GraphQL, Status, and State commands
  - Quick action buttons for common operations (Login, Status, Pause, Resume)
  - Command history with success/failure tracking
  - JSON output display with copy-to-clipboard
  - Eliminates need for app redeploy when testing API changes
- **Reduced Debug Logging**: Removed verbose console logging from CGMiner commands and temperature/fan extraction
  - Only logs errors during normal polling operations
  - Cleaner server logs with less noise
  - Enable DEBUG_CGMINER env var for detailed CGMiner command logging when needed

### v1.4.1
- **Per-Miner Authentication**: Added username/password fields per miner for Braiins OS auth
- **gRPC Auth Retry**: Automatic token invalidation and retry on UNAUTHENTICATED errors
- **REST API Auth Fix**: Fixed REST API authentication (changed default password from empty to 'root')
- **REST API Power Fallback**: Added REST API tuner-state as fallback power data source
- **REST API Error Handling**: Fixed error responses being passed through instead of null
- **Credential Passthrough**: All API calls (gRPC, REST, GraphQL, HTTP) now use per-miner credentials

### v1.4.0
- **Enhanced Auto-Control**: Active monitoring ensures miner state matches intended state
- **Projected SCOP**: Calculates expected SCOP when miner is paused (fixes resume issue)
- **Efficiency Override**: Custom power/hashrate settings for projected SCOP calculations
- **Efficiency Tracking**: Records measured efficiency when mining for future projections
- **Dual SCOP Display**: Shows both measured and projected SCOP in UI
- **State Sync Indicator**: Visual feedback showing current vs intended state
- **Decision Transparency**: Shows which SCOP (measured/projected) is used for decisions

### v1.3.1
- **gRPC API Migration**: Switched miner control from REST API to gRPC API (port 50051)
- Added `@grpc/grpc-js` and `@grpc/proto-loader` dependencies
- Added Braiins OS proto files (`proto/bos/v1/authentication.proto`, `proto/bos/v1/actions.proto`)
- Improved reliability of pause/resume commands
- Requires Braiins OS 23.03.1+ with gRPC port 50051 enabled (default)

### v1.3.0
- **Miner Control**: Manual ON/OFF buttons to pause/resume mining
- **SCOP-Based Auto-Control**: Automatically pause mining when SCOP drops below threshold
- **Minimum Temperature Override**: Keep miner running for heating when board temp drops below set value
- Board temperature used for room temp estimation (not chip temp)

### v1.2.11
- Background miner polling system
- Alert system with configurable thresholds
- Multi-miner parallel polling
- Historical data charts (hashrate, temperature, power)
- Multi-miner aggregated views
- Time range selection
- 24-hour electricity price graph
- Time-of-day grid fees (weekday/weekend)
- Stacked bar visualization

---

*This documentation provides complete technical context for LLM-assisted development. When requesting changes, reference specific sections, functions, or line numbers.*
