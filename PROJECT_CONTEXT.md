# Mining Dashboard App - Project Context

## Overview
A comprehensive web-based dashboard for monitoring and controlling Bitcoin Antminer miners running Braiins OS, specifically designed for home heating applications in Norway. The app tracks mining performance, electricity costs with Norwegian pricing (including state subsidies), and efficiency metrics comparing mining heat output vs traditional heat pumps.

**Version:** 1.2.17
**Author:** j1441
**License:** MIT
**Platform:** Node.js/Express backend with React frontend (no build step - uses Babel standalone)

---

## Architecture

### Backend (server.js)
- **Framework:** Express.js
- **WebSocket:** ws library for real-time updates (every 5 seconds)
- **Port:** 3456 (default)
- **Data Storage:** JSON files in `/data` directory
  - `config.json` - User configuration (miners, pricing mode, grid fees)
  - `history.json` - Historical mining data

### Frontend (public/index.html)
- **Framework:** React 18 (CDN-loaded, no build process)
- **Transpiler:** Babel Standalone
- **Styling:** Inline CSS with custom classes, dark gradient theme
- **Components:** Modular React components (Settings, AddMiner, MinerCard, ElectricityCard, etc.)

### External APIs
1. **hvakosterstrommen.no** - Norwegian electricity spot prices (by zone)
2. **CoinGecko** - Bitcoin price in multiple currencies (NOK, EUR, SEK, USD)
3. **blockchain.info** - Bitcoin network stats (difficulty, hashrate, block height)

### Miner Communication
- **Protocol:** CGMiner JSON-RPC API (port 4028)
- **GraphQL:** Braiins OS GraphQL API support for enhanced temperature/fan data
- **Commands:** Summary, Stats, Pools data + power profile control

---

## Key Features

### 1. Multi-Miner Support
- Monitor multiple miners simultaneously
- Each miner has independent:
  - Power profile (Low/Medium/High)
  - Status tracking
  - Statistics display
- Add/remove miners via UI
- Automatic config migration from single-miner to multi-miner format

### 2. Norwegian Electricity Pricing
Two pricing modes with accurate calculations and time-of-day grid fees:

#### **Norgespris Mode**
- Fixed base price: **0.50 NOK/kWh**
- Plus time-of-day grid fees
- Formula: `Total = 0.50 + Grid Fee (Time-dependent)`
- Use case: Simplified fixed-rate contract

#### **Strømstøtteavtale Mode** (with State Subsidy)
- Spot price with 90% state subsidy above threshold
- Threshold: **93.75 øre/kWh (0.9375 NOK/kWh)**
- Plus time-of-day grid fees
- Formula when spot > threshold:
  ```
  Subsidy = (Spot - 0.9375) × 0.90
  Effective Spot = Spot - Subsidy
  Total = Effective Spot + Grid Fee (Time-dependent)
  ```
- Example: Spot 2.00 kr → Subsidy 0.956 kr → Effective 1.044 kr → Total 1.544 kr (with 0.50 grid fee)

#### **Time-of-Day Grid Fees**
- **Weekday Day Rate** (Mon–Fri 06:00–22:00): Default 0.50 kr/kWh
- **Weekend/Night Rate** (Sat, Sun, Mon–Fri 22:00–06:00): Default 0.30 kr/kWh
- Configurable separately in settings
- Automatically applied based on current time
- Grid fee calculation function: `getGridFeeForTime()` in server.js (lines 933-952)

### 3. Real-time Monitoring
- **Hashrate** - Mining speed in TH/s
- **Temperature** - Chip and board temperatures (°C)
- **Power Draw** - Current power consumption (Watts)
- **Uptime** - Miner operational time
- **Pool Stats** - Accepted/rejected shares, reject rate
- **Efficiency Metrics** - Daily profit, effective SCOP, cost comparisons

### 4. Heating Efficiency Analysis
- **Effective SCOP** calculation comparing miner heat vs heat pump (SCOP 3.5)
- Daily cost comparisons:
  - Daily electricity cost (with chosen pricing mode)
  - Daily BTC earnings
  - Daily profit/loss
  - Equivalent heat pump cost
  - Savings/extra cost vs heat pump
- Breakeven BTC price calculation

### 5. Power Profile Management
Each miner can be controlled independently:
- **Low:** ~2000W (~48 kWh/day) - Minimal heating
- **Medium:** ~3250W (~78 kWh/day) - Balanced (default)
- **High:** ~3500W (~84 kWh/day) - Maximum heating

### 6. 24-Hour Electricity Price Visualization
- **Stacked bar chart** showing next 24 hours of electricity prices
- **Two-layer visualization**:
  - Blue bars (bottom): Base price (0.50 kr/kWh for Norgespris OR subsidized spot for Strømstøtteavtale)
  - Orange bars (top): Grid fees (varies by time-of-day)
- **Features**:
  - Current hour highlighted in yellow
  - Interactive tooltips with detailed breakdown per hour
  - Price statistics (lowest, average, highest)
  - Color-coded legend
  - Mode-specific information panels
- Component: `PriceGraphCard` in index.html (lines 620-771)

### 7. Historical Data Charts
- **Interactive line charts** displaying historical trends over time
- **Three chart types**:
  - Hashrate (TH/s) - Mining performance over time
  - Temperature (°C) - Thermal patterns and trends
  - Power Draw (W) - Energy consumption history
- **Multi-miner support**:
  - View individual miner data
  - View all miners separately (multi-colored lines)
  - View aggregated sum/total (combined hashrate/power, averaged temperature)
- **Time range selection**: 24 hours, 7 days, 14 days, or 30 days
- **Features**:
  - Unified Y-axis scaling for accurate comparison
  - X-axis time graduations (hourly for 24h, daily for longer periods)
  - Interactive hover tooltips showing exact values and timestamps
  - Real-time statistics (current, average, max, min, data points)
  - Color-coded legend for multi-miner view
  - Auto-refresh every 60 seconds
- **Data storage**:
  - Hourly snapshots saved to `history.json`
  - Retains 720 entries (30 days)
  - Per-miner tracking with IP and name
- Component: `HistoricalChartsCard` in index.html (lines 1097-1536)
- API Endpoint: `GET /api/history?days=7&minerIp=192.168.1.100`

---

## File Structure

```
mining-dashboard-app/
├── server.js                 # Backend Express server (2200+ lines)
├── public/
│   └── index.html           # Frontend React app (1200+ lines)
├── package.json             # Dependencies and metadata
├── Dockerfile               # Container build instructions
├── docker-compose.yaml      # Docker compose config
├── umbrel-app.yaml         # Umbrel app manifest
├── data/                    # Runtime data directory
│   ├── config.json         # User configuration (auto-created)
│   └── history.json        # Historical data (auto-created)
├── README.md               # User documentation
├── LICENSE                 # MIT License
└── PROJECT_CONTEXT.md      # This file
```

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
  "updatedAt": "2025-12-29T..."
}
```

**Note:** Old configs with `gridFeePerKwh` are automatically migrated to the dual grid fee format on load.

### Available Electricity Zones
- **NO1:** Oslo / Øst-Norge
- **NO2:** Kristiansand / Sør-Norge
- **NO3:** Trondheim / Midt-Norge
- **NO4:** Tromsø / Nord-Norge (0% VAT)
- **NO5:** Bergen / Vest-Norge

---

## API Endpoints

### Configuration
- `GET /api/config` - Load configuration
- `POST /api/config` - Save configuration

### Miner Management
- `POST /api/miners/add` - Add new miner (`{ip, name}`)
- `POST /api/miners/remove` - Remove miner (`{ip}`)
- `POST /api/miners/update` - Update miner details (`{ip, name?, powerProfile?}`)
- `POST /api/miner/test` - Test miner connection (`{minerIP}`)

### Miner Control
- `POST /api/miner/power` - Set power profile (`{ip, profile}`)
  - Profiles: "low", "medium", "high"

### Data Endpoints
- `GET /api/electricity/prices` - Get electricity prices for zone
- `GET /api/electricity/zones` - Get available zones/countries

### WebSocket
- `ws://localhost:3456` - Real-time data stream
- Sends every 5 seconds:
```json
{
  "miners": [
    {
      "minerIp": "192.168.1.100",
      "minerName": "Miner 1",
      "hashrate": 100.5,
      "temperature": 65,
      "powerDraw": 3250,
      "uptime": 86400,
      "boards": [...],
      "fans": {...},
      "poolStatus": "Connected",
      "acceptedShares": 1000,
      "rejectedShares": 5,
      "rejectRate": 0.5,
      "powerProfile": "medium",
      "efficiency": {...},
      "error": null
    }
  ],
  "electricity": {
    "rawSpotPrice": 1.50,
    "basePrice": 0.994,
    "gridFee": 0.50,
    "effectivePrice": 1.494,
    "subsidyApplied": true,
    "subsidyAmount": 0.506,
    "priceMode": "stromstotteavtale",
    "zone": "NO5",
    "zoneName": "Bergen / Vest-Norge",
    "currency": "NOK",
    "prices": [...]
  },
  "btcPrice": {
    "nok": 1000000,
    "eur": 90000,
    "sek": 1000000,
    "usd": 95000
  },
  "network": {
    "difficulty": 72000000000000,
    "hashrate": 600000000,
    "hashrateFormatted": "600 EH/s",
    "blockHeight": 820000,
    "blockReward": 3.125
  }
}
```

---

## Key Functions & Logic

### Backend (server.js)

#### Miner Statistics (`getMinerStats`)
- Lines 1520-1690
- Fetches data from CGMiner API + GraphQL
- Calculates efficiency metrics
- Returns complete stats object with pricing

#### Grid Fee Calculation (`getGridFeeForTime`)
- Lines 933-952
- Determines applicable grid fee based on day of week and hour
- Returns weekday day rate (Mon–Fri 06:00–22:00) or weekend/night rate
- Used by `getMinerStats()` for current pricing

#### Electricity Pricing (`calculateEfficiency`)
- Lines 954-1000+
- Implements Norgespris vs Strømstøtteavtale logic
- Applies state subsidy calculation
- Returns effective price and efficiency metrics

#### CGMiner Communication (`sendCGMinerCommand`)
- Lines 1378-1420
- JSON-RPC protocol over TCP
- Timeout handling (10s default)
- Returns parsed response

#### Configuration Management
- `loadConfig()` - Lines 1748-1787
  - Auto-migrates old single-miner format to multi-miner
  - Auto-migrates old `gridFeePerKwh` to dual grid fee format
  - Returns default config if not exists
- `saveConfig()` - Lines 1789-1792

#### Historical Data Management
- `loadHistory()` - Lines 1815-1825
  - Loads historical data from `history.json`
  - Returns empty structure if file doesn't exist
- `saveHistoryEntry(stats)` - Lines 1827-1854
  - Saves hourly snapshot of miner stats
  - Includes: timestamp, minerIp, minerName, hashrate, temperature, power, prices
  - Maintains rolling 720-entry limit (30 days)
  - Called hourly via WebSocket loop
- API: `GET /api/history?days=7&minerIp=<ip>` - Lines 2128-2147
  - Returns filtered historical entries
  - Supports `days` parameter (default: 7)
  - Optional `minerIp` filter for single-miner data

### Frontend (index.html)

#### Components
1. **SettingsModal** (lines 174-335)
   - Pricing mode toggle (Norgespris/Strømstøtteavtale)
   - Dual grid fee inputs (weekday day & weekend/night)
   - Country/zone selection

2. **PriceGraphCard** (lines 620-771)
   - 24-hour electricity price visualization
   - Stacked bar chart with base price + grid fees
   - Time-of-day grid fee calculation per hour
   - Interactive tooltips and price statistics
   - Current hour highlighting

3. **HistoricalChartsCard** (lines 1097-1536)
   - Interactive line charts for hashrate, temperature, power
   - Multi-miner support with separate or aggregated views
   - Time range selection (24h, 7d, 14d, 30d)
   - Unified Y-axis scaling across all miners
   - X-axis time graduations (hourly/daily)
   - Hover tooltips with exact values and timestamps
   - Real-time statistics display
   - Auto-refresh every 60 seconds
   - Color-coded legend for multi-miner view

4. **AddMinerModal** (lines ~773-943)
   - IP and name input
   - Connection test before adding
   - Error handling

5. **MinerCard** (lines ~945-1100)
   - Individual miner display
   - Stats, efficiency, power profiles
   - Remove button

6. **ElectricityCard** (lines 489-596)
   - Shows spot prices, grid fees, total
   - Subsidy information display
   - Hourly price chart (simplified)

7. **EfficiencyCard** (lines 393-485)
   - Daily costs and earnings
   - SCOP comparison
   - Heat pump cost comparison

8. **Dashboard** (lines ~1540+)
   - Main container
   - WebSocket connection
   - Miner management functions
   - Layout: Global data → PriceGraphCard → HistoricalChartsCard → Miners grid

---

## Common Customization Points

### Modifying Grid Fee Time Periods
1. Update `getGridFeeForTime()` in server.js (lines 933-952) - Backend calculation
2. Update `getGridFeeForHour()` in PriceGraphCard (lines 629-644) - Frontend visualization
3. Adjust hour ranges and day-of-week logic as needed

### Adding New Pricing Modes
1. Update `server.js` lines 1604-1627 (pricing calculation in getMinerStats)
2. Update `public/index.html` lines 218-238 (settings modal toggle)
3. Update PriceGraphCard display logic (lines 631-663)
4. Update ElectricityCard display logic (lines 489-596)

### Adding New Miner Metrics
1. Extract data in `getMinerStats()` function
2. Add to returned stats object (lines 1615-1680)
3. Display in MinerCard component (lines 808-838)

### Changing Power Profiles
1. Backend: `setPowerProfile()` function (lines 1434-1518)
2. Frontend: Profile buttons in MinerCard (lines 860-892)
3. Update power/kWh estimates in labels

### Adding New Countries/Zones
1. Update `ELECTRICITY_ZONES` object (lines 23-37)
2. Add API integration for that country's pricing
3. Update currency handling throughout

---

## Dependencies

### Backend (package.json)
```json
{
  "express": "^4.18.2",
  "ws": "^8.14.2"
}
```

### Frontend (CDN)
- React 18.2.0
- ReactDOM 18.2.0
- Babel Standalone 7.23.5

---

## Development Commands

```bash
# Install dependencies
npm install

# Start server (production)
npm start

# Start server (development)
npm run dev

# Docker build
docker build -t mining-dashboard:1.2.11 .

# Docker run
docker run -d -p 3456:3456 -v $(pwd)/data:/data mining-dashboard:1.2.11
```

---

## Development Workflow

### Automated Deployment to Umbrel
- Changes pushed to GitHub automatically trigger deployment to Umbrel server
- Testing is performed directly on the Umbrel instance after deployment
- No local testing required - production testing workflow
- Allows for rapid iteration and testing in the actual deployment environment

### Workflow Steps
1. Make code changes locally
2. Commit and push to GitHub repository
3. Automated workflow deploys to Umbrel server
4. Test functionality on Umbrel instance
5. Iterate as needed

---

## Environment Variables

- `PORT` - Server port (default: 3456)
- `DATA_DIR` - Data directory path (default: /data)
- `NODE_ENV` - Environment (development/production)

---

## Important Notes

### Migration Behavior
- Old single-miner configs automatically migrate to multi-miner format
  - Migration happens in `loadConfig()` at lines 1754-1763
  - Original config is preserved with new `miners` array
- Old `gridFeePerKwh` configs automatically migrate to dual grid fee format
  - Migration happens in `loadConfig()` at lines 1765-1771
  - Weekday day rate set to old value
  - Weekend/night rate set to 60% of old value as default

### WebSocket Reconnection
- Auto-reconnects every 5 seconds on disconnect
- Handles connection errors gracefully
- No manual reconnect needed

### Error Handling
- Per-miner errors don't affect other miners
- Global data (electricity/BTC) fetched independently
- Errors displayed in UI with context

### Data Persistence
- Config saved to `/data/config.json` on changes
- History saved hourly to `/data/history.json`
- Both created automatically if missing

---

## Common Issues & Solutions

### "Cannot read properties of undefined (reading 'some')"
- **Cause:** `config.miners` is undefined
- **Fix:** Added null check at line 1944-1946
- Ensure `loadConfig()` always returns `miners: []`

### Miners not connecting
- Check CGMiner API port 4028 is accessible
- Verify Braiins OS is running (not stock firmware)
- Test with `/api/miner/test` endpoint first

### Incorrect electricity pricing
- Verify `priceMode` is set correctly
- Check `gridFeePerKwh` value (in NOK/kWh)
- Ensure spot price API is accessible
- Subsidy only applies when spot > 0.9375 NOK/kWh

### WebSocket disconnects
- Normal behavior - auto-reconnects
- Check firewall/proxy settings
- Verify port 3456 is accessible

---

## Code Style & Patterns

### Backend
- Async/await for all async operations
- Try-catch error handling with logging
- Express middleware for JSON parsing
- WebSocket for real-time updates

### Frontend
- React functional components with hooks
- useState for local state
- useEffect for lifecycle
- useCallback for WebSocket setup
- Inline styles (no CSS files)
- ES6+ syntax via Babel

---

## Testing

### Manual Testing
1. Add miner via UI
2. Verify connection in miner card
3. Change power profile
4. Check settings modal (pricing modes and dual grid fees)
5. Monitor WebSocket updates
6. View 24-hour price graph
7. Test time-of-day grid fee calculations
8. Remove miner

### Test Connection Endpoint
```bash
curl -X POST http://localhost:3456/api/miner/test \
  -H "Content-Type: application/json" \
  -d '{"minerIP": "192.168.1.100"}'
```

---

## Recent Updates (December 2025)

### Historical Data Charts (v1.3.1)
- Added interactive line charts for hashrate, temperature, and power draw
- Multi-miner support with separate or aggregated views
- Time range selection: 24h, 7d, 14d, 30d
- Hover tooltips showing exact values and timestamps
- Unified Y-axis scaling for accurate multi-miner comparison
- X-axis time graduations (hourly/daily based on range)
- Auto-refresh every 60 seconds
- Data persisted in `history.json` (720 entries, 30 days retention)
- Per-miner tracking with IP and name identification
- Component: `HistoricalChartsCard` (index.html lines 1097-1536)
- API: `GET /api/history?days=7&minerIp=<ip>` (server.js lines 2128-2147)

### 24-Hour Electricity Price Graph (v1.3.0)
- Added comprehensive price visualization showing next 24 hours
- Stacked bar chart displays base price + time-varying grid fees
- Current hour highlighted for easy reference
- Interactive tooltips with detailed price breakdown per hour
- Price statistics (min/avg/max) displayed below graph

### Time-of-Day Grid Fees (v1.3.0)
- Replaced single grid fee with dual rate system:
  - Weekday day rate (Mon–Fri 06:00–22:00)
  - Weekend/night rate (Sat, Sun, Mon–Fri 22:00–06:00)
- Automatic calculation based on current time
- Backend function: `getGridFeeForTime()` (server.js)
- Frontend visualization updates per hour in graph
- Settings UI updated with separate inputs for each rate
- Automatic migration from old single-rate configs

---

## Future Enhancement Ideas

- [ ] Multi-currency support beyond NOK/EUR/SEK/USD
- [x] ~~Historical data charts (hashrate, temperature over time)~~ - **Completed v1.3.1**
- [ ] Alert system (high temp, low hashrate, disconnected miner)
- [ ] Auto power profile switching based on electricity price
- [ ] Mobile app or responsive improvements
- [ ] Multiple mining pools support
- [ ] Profitability calculator with custom scenarios
- [ ] Energy usage tracking and reports
- [ ] Integration with home automation systems
- [ ] Support for more complex grid fee structures (seasonal, multiple time periods)
- [ ] Export historical data to CSV/JSON
- [ ] Customizable chart colors and themes

---

## Security Considerations

- No authentication (relies on network security)
- Designed for private networks + Tailscale VPN
- No external data transmission
- Config stored locally in Docker volume
- CGMiner API is local network only
- Consider adding auth if exposing to internet

---

## Performance Notes

- WebSocket updates: 5 seconds interval
- Electricity prices: Cached 30 minutes
- BTC price: Cached 5 minutes
- Network stats: Cached 10 minutes
- Multiple miners fetched in parallel (Promise.all)
- Historical data saved hourly

---

This context document should provide a complete picture of the project for LLM-assisted development. When requesting changes, reference this document and specify which components/functions need modification.
