# Mining Dashboard App - Complete Technical Documentation

## Overview

A comprehensive web-based dashboard for monitoring and controlling Bitcoin Antminer miners running Braiins OS, specifically designed for home heating applications in Norway. The app tracks mining performance, electricity costs with Norwegian pricing (including state subsidies), and efficiency metrics comparing mining heat output vs traditional heat pumps.

**Version:** 1.2.11
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
2. **Single-File Backend**: All server logic in `server.js` (~2800 lines)
3. **JSON File Storage**: Lightweight persistence without database dependencies
4. **Background Polling**: Server polls miners every 5 seconds, pushes via WebSocket
5. **Multi-Protocol Miner Support**: CGMiner API + GraphQL + REST API fallbacks

---

## Technology Stack

### Backend
| Technology | Version | Purpose |
|------------|---------|---------|
| Node.js | 18+ | Runtime environment |
| Express.js | 4.18.2 | HTTP server framework |
| ws | 8.14.2 | WebSocket server for real-time updates |
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
├── server.js                    # Backend Express server (2800+ lines)
│                                # - All API endpoints
│                                # - Miner communication logic
│                                # - External API integrations
│                                # - WebSocket server
│                                # - Background polling
│
├── public/
│   └── index.html               # Complete React frontend (2000+ lines)
│                                # - All React components
│                                # - Styling (inline CSS)
│                                # - WebSocket client
│
├── package.json                 # NPM configuration
│                                # - Dependencies: express, ws
│                                # - Scripts: start, dev
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

### Key Backend Functions

#### Miner Communication

| Function | Location | Purpose |
|----------|----------|---------|
| `sendCGMinerCommand(ip, command)` | Line 1184 | TCP connection to CGMiner API (port 4028) |
| `fetchBraiinsGraphQL(ip)` | Line 120 | GraphQL queries with schema introspection |
| `fetchBraiinsRestApiStats(ip)` | Line 936 | REST API data fetch with authentication |
| `graphqlRequest(ip, query, sessionCookie)` | Line 714 | Execute GraphQL query |
| `luciLogin(ip, username, password)` | Line 493 | LuCI session authentication |
| `getSessionViaWebUI(ip, username, password)` | Line 662 | Web UI session handling |
| `braiinsRestAuth(ip, username, password)` | Line 829 | REST API authentication |

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
| `loadConfig()` | Line 2174 | Load config with backward compatibility |
| `saveConfig(config)` | Line 2236 | Persist configuration to JSON |
| `loadHistory()` | Line 2241 | Load historical data points |
| `saveHistoryEntry(stats)` | Line 2253 | Append new data point (720 max) |

#### Background Tasks

| Function | Location | Purpose |
|----------|----------|---------|
| `pollMiners()` | Line 2616 | Fetch stats for all miners |
| `startBackgroundMinerPolling()` | Line 2682 | Initialize 5-second polling loop |
| `start()` | Line 2696 | Main startup sequence |

---

## Frontend Implementation

### Component Hierarchy

```
Dashboard (Main App)
├── Header
│   ├── Settings Button → SettingsModal
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
└── Miners Grid
    └── MinerCard (one per miner)
        ├── Stats Display
        ├── Power Profile Buttons
        └── Remove Button
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

### 3. Braiins REST API (Port 80)

**Implementation:** `fetchBraiinsRestApiStats()` at line 936

**Endpoints:**
| Endpoint | Purpose |
|----------|---------|
| `/api/v1/auth/login` | Authentication |
| `/api/v1/miner/stats` | Mining statistics |
| `/api/v1/miner/hw/hashboards` | Hashboard details |
| `/api/v1/cooling/state` | Cooling status |
| `/api/v1/performance/target-profiles` | Power profiles |

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
    rejectedShares, rejectRate, powerProfile, efficiency, error
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

### 4. Efficiency Metrics

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

### 5. Alert System

| Alert Type | Default Threshold | Cooldown |
|------------|-------------------|----------|
| High Temperature | 80°C | 15 minutes |
| Low Hashrate | 80% of expected | 15 minutes |
| Miner Offline | N/A | 15 minutes |
| High Reject Rate | 5% | 15 minutes |

Alerts are persisted in `alertHistory` array (last 100).

### 6. Historical Data

- Hourly snapshots saved to `history.json`
- Retains 720 entries (30 days)
- Fields: timestamp, minerIp, minerName, hashrate, power, temperature, electricityPrice, btcPrice, networkDifficulty, dailyProfit, effectiveSCOP
- API: `GET /api/history?days=7&minerIp=X.X.X.X`

---

## Configuration Schema

### config.json Structure

```json
{
  "miners": [
    {
      "ip": "192.168.1.100",
      "name": "Living Room Miner",
      "powerProfile": "medium"
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
| POST | `/api/miners/add` | `{ip, name}` | Add new miner |
| POST | `/api/miners/remove` | `{ip}` | Remove miner |
| POST | `/api/miners/update` | `{ip, name?, powerProfile?}` | Update miner |

### Market Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/electricity/zones` | Get available zones |
| GET | `/api/electricity/prices` | Get current hourly prices |
| GET | `/api/btc/price` | Get Bitcoin price |
| GET | `/api/network/stats` | Get network stats |

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
- Default miner credentials (root:root) should be changed

---

## Troubleshooting

### Miner Connection Issues

```bash
# Test CGMiner API connectivity
nc -zv [miner-ip] 4028

# Test with curl
curl -X POST http://localhost:3456/api/miner/test \
  -H "Content-Type: application/json" \
  -d '{"minerIP": "192.168.1.100"}'
```

**Common causes:**
- Miner not running Braiins OS
- Firewall blocking port 4028
- Incorrect IP address
- CGMiner API disabled

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
| History retention | 720 entries (30 days) |

---

## Version History

### v1.2.11 (Current)
- Background miner polling system
- Alert system with configurable thresholds
- Multi-miner parallel polling

### v1.3.1
- Historical data charts (hashrate, temperature, power)
- Multi-miner aggregated views
- Time range selection

### v1.3.0
- 24-hour electricity price graph
- Time-of-day grid fees (weekday/weekend)
- Stacked bar visualization

---

*This documentation provides complete technical context for LLM-assisted development. When requesting changes, reference specific sections, functions, or line numbers.*
