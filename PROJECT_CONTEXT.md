# Mining Dashboard App - Project Context

## Overview
A comprehensive web-based dashboard for monitoring and controlling Bitcoin Antminer miners running Braiins OS, specifically designed for home heating applications in Norway. The app tracks mining performance, electricity costs with Norwegian pricing (including state subsidies), and efficiency metrics comparing mining heat output vs traditional heat pumps.

**Version:** 1.2.11
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
Two pricing modes with accurate calculations:

#### **Norgespris Mode**
- Fixed base price: **0.50 NOK/kWh**
- Plus custom grid fees (time/season dependent)
- Formula: `Total = 0.50 + Grid Fee`
- Use case: Simplified fixed-rate contract

#### **Strømstøtteavtale Mode** (with State Subsidy)
- Spot price with 90% state subsidy above threshold
- Threshold: **93.75 øre/kWh (0.9375 NOK/kWh)**
- Plus custom grid fees
- Formula when spot > threshold:
  ```
  Subsidy = (Spot - 0.9375) × 0.90
  Effective Spot = Spot - Subsidy
  Total = Effective Spot + Grid Fee
  ```
- Example: Spot 2.00 kr → Subsidy 0.956 kr → Effective 1.044 kr → Total 1.544 kr (with 0.50 grid fee)

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

---

## File Structure

```
mining-dashboard-app/
├── server.js                 # Backend Express server (2200+ lines)
├── public/
│   └── index.html           # Frontend React app (900+ lines)
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
  "gridFeePerKwh": 0.50,
  "priceMode": "stromstotteavtale",
  "updatedAt": "2025-12-29T..."
}
```

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

#### Electricity Pricing (`calculateEfficiency`)
- Lines 1583-1610
- Implements Norgespris vs Strømstøtteavtale logic
- Applies state subsidy calculation
- Returns effective price

#### CGMiner Communication (`sendCGMinerCommand`)
- Lines 1378-1420
- JSON-RPC protocol over TCP
- Timeout handling (10s default)
- Returns parsed response

#### Configuration Management
- `loadConfig()` - Lines 1724-1778
  - Auto-migrates old single-miner format
  - Returns default config if not exists
- `saveConfig()` - Lines 1780-1783

### Frontend (index.html)

#### Components
1. **SettingsModal** (lines 174-323)
   - Pricing mode toggle (Norgespris/Strømstøtteavtale)
   - Grid fee input (both modes)
   - Country/zone selection

2. **AddMinerModal** (lines 605-749)
   - IP and name input
   - Connection test before adding
   - Error handling

3. **MinerCard** (lines 751-907)
   - Individual miner display
   - Stats, efficiency, power profiles
   - Remove button

4. **ElectricityCard** (lines 460-596)
   - Shows spot prices, grid fees, total
   - Subsidy information display
   - Hourly price chart

5. **EfficiencyCard** (lines 385-458)
   - Daily costs and earnings
   - SCOP comparison
   - Heat pump cost comparison

6. **Dashboard** (lines 909-884)
   - Main container
   - WebSocket connection
   - Miner management functions

---

## Common Customization Points

### Adding New Pricing Modes
1. Update `server.js` lines 1583-1610 (pricing calculation)
2. Update `public/index.html` lines 219-266 (settings modal)
3. Update ElectricityCard display logic (lines 460-596)

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
- Migration happens in `loadConfig()` at lines 1729-1739
- Original config is preserved with new `miners` array

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
4. Check settings modal (pricing modes)
5. Monitor WebSocket updates
6. Remove miner

### Test Connection Endpoint
```bash
curl -X POST http://localhost:3456/api/miner/test \
  -H "Content-Type: application/json" \
  -d '{"minerIP": "192.168.1.100"}'
```

---

## Future Enhancement Ideas

- [ ] Multi-currency support beyond NOK/EUR/SEK/USD
- [ ] Historical data charts (hashrate, temperature over time)
- [ ] Alert system (high temp, low hashrate, disconnected miner)
- [ ] Auto power profile switching based on electricity price
- [ ] Mobile app or responsive improvements
- [ ] Multiple mining pools support
- [ ] Profitability calculator with custom scenarios
- [ ] Energy usage tracking and reports
- [ ] Integration with home automation systems

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
