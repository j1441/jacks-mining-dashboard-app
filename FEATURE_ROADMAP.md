# Mining Dashboard - Feature Roadmap

A prioritized list of potential features for future development, organized by impact and complexity.

---

## Top 10 High-Impact Features

### 1. Auto Power Profile Scheduling Based on Electricity Price
**Priority:** High | **Complexity:** Medium | **Estimated Effort:** 8-12 hours

Automatically adjust miner power profiles based on current electricity prices to maximize profitability.

**Implementation:**
- Add price threshold settings per power profile in config
- Create scheduling logic in `pollMiners()` to check price vs thresholds
- Switch profiles via existing `setPowerProfile()` function
- Add UI toggle to enable/disable auto-switching
- Optional: Time-based rules (e.g., always Low during peak hours)

**Config Schema:**
```json
{
  "autoPowerScheduling": {
    "enabled": true,
    "rules": [
      { "maxPrice": 0.50, "profile": "high" },
      { "maxPrice": 1.00, "profile": "medium" },
      { "maxPrice": 999, "profile": "low" }
    ]
  }
}
```

**Files to Modify:**
- `server.js`: Add scheduling logic in polling loop
- `public/index.html`: Add settings UI for thresholds

---

### 2. Push Notifications (Telegram/Discord/Email)
**Priority:** High | **Complexity:** Low | **Estimated Effort:** 4-6 hours

Send alerts to external services when thresholds are triggered.

**Implementation:**
- Add notification service configuration in settings
- Create notification dispatcher in `checkAlerts()` function
- Support multiple channels: Telegram Bot API, Discord Webhooks, SMTP

**Config Schema:**
```json
{
  "notifications": {
    "telegram": {
      "enabled": true,
      "botToken": "123456:ABC-DEF",
      "chatId": "123456789"
    },
    "discord": {
      "enabled": false,
      "webhookUrl": "https://discord.com/api/webhooks/..."
    },
    "email": {
      "enabled": false,
      "smtp": { "host": "", "port": 587, "user": "", "pass": "" },
      "to": "user@example.com"
    }
  }
}
```

**Files to Modify:**
- `server.js`: Add `sendNotification()` function, call from `checkAlerts()`
- `public/index.html`: Add notification settings UI

---

### 3. Progressive Web App (PWA) Support
**Priority:** High | **Complexity:** Low-Medium | **Estimated Effort:** 4-6 hours

Make the dashboard installable on mobile devices with offline support.

**Implementation:**
- Create `manifest.json` with app metadata and icons
- Add service worker for caching and offline support
- Show "last updated" timestamp when offline
- Add install prompt for mobile users

**New Files:**
- `public/manifest.json`
- `public/service-worker.js`
- `public/icons/` (various sizes: 192x192, 512x512)

**Files to Modify:**
- `public/index.html`: Add manifest link and service worker registration

---

### 4. Profitability Forecasting
**Priority:** High | **Complexity:** Medium | **Estimated Effort:** 12-16 hours

Predict earnings based on historical data and price forecasts.

**Implementation:**
- Fetch next-day electricity prices (available after 13:00 from API)
- Calculate expected earnings per hour for next 24 hours
- Show "best mining windows" when prices are lowest
- Weekly/monthly projections based on rolling averages

**Features:**
- Tomorrow's price forecast chart
- "Optimal mining schedule" recommendation
- Monthly earnings projection
- Break-even analysis with current difficulty trend

**Files to Modify:**
- `server.js`: Add forecasting calculations, fetch tomorrow's prices
- `public/index.html`: Add ForecastCard component

---

### 5. Data Export (CSV/JSON)
**Priority:** Medium-High | **Complexity:** Low | **Estimated Effort:** 3-4 hours

Export historical data for tax reporting and external analysis.

**Implementation:**
- Add `/api/export` endpoint with format and date range params
- Generate CSV with columns: date, miner, hashrate, power, cost, earnings
- Support JSON export for programmatic use
- Add "Export" button in Historical Charts section

**API Endpoint:**
```
GET /api/export?format=csv&from=2025-01-01&to=2025-12-31&minerIp=all
```

**Files to Modify:**
- `server.js`: Add export endpoint with CSV generation
- `public/index.html`: Add export button and date picker modal

---

### 6. Multi-Pool Statistics
**Priority:** Medium | **Complexity:** Medium | **Estimated Effort:** 6-8 hours

Display detailed pool information and statistics per miner.

**Implementation:**
- Parse pool data from existing CGMiner `pools` command
- Show active pool, backup pools, and failover status
- Display pool-specific stats: shares, stale rate, last share time
- Track pool uptime and reliability

**Data Already Available:**
```javascript
// From sendCGMinerCommand('pools')
{
  "POOLS": [{
    "URL": "stratum+tcp://pool.example.com:3333",
    "Status": "Alive",
    "Accepted": 1234,
    "Rejected": 5,
    "Stale": 2
  }]
}
```

**Files to Modify:**
- `server.js`: Extract and include pool data in miner stats
- `public/index.html`: Add PoolCard component or expand MinerCard

---

### 7. Authentication System
**Priority:** Medium-High | **Complexity:** Medium | **Estimated Effort:** 8-12 hours

Optional authentication for secure remote access.

**Implementation:**
- Add optional username/password configuration
- Session-based auth with JWT or simple cookies
- Protect all API endpoints when auth enabled
- Login page component

**Config Schema:**
```json
{
  "auth": {
    "enabled": false,
    "username": "admin",
    "passwordHash": "bcrypt_hash_here"
  }
}
```

**Security Considerations:**
- Use bcrypt for password hashing
- Implement rate limiting on login attempts
- Add session timeout
- Consider HTTPS requirement when auth enabled

**Files to Modify:**
- `server.js`: Add auth middleware, login endpoint, session management
- `public/index.html`: Add LoginModal component

---

### 8. Dashboard Customization
**Priority:** Medium | **Complexity:** Medium | **Estimated Effort:** 10-14 hours

Allow users to customize their dashboard layout and appearance.

**Implementation:**
- Drag-and-drop card arrangement (use react-dnd or similar)
- Show/hide individual cards
- Card size options (compact/expanded)
- Theme selection (dark/light/custom colors)
- Save layout to config

**Config Schema:**
```json
{
  "dashboard": {
    "theme": "dark",
    "layout": ["btcPrice", "network", "electricity", "priceGraph", "miners"],
    "hiddenCards": ["efficiency"],
    "compactMode": false
  }
}
```

**Files to Modify:**
- `public/index.html`: Add layout management, theme switching
- `server.js`: Persist layout configuration

---

### 9. Hashboard Health Monitoring
**Priority:** Medium-High | **Complexity:** Medium | **Estimated Effort:** 8-10 hours

Track individual hashboard performance to detect degradation early.

**Implementation:**
- Parse per-hashboard data from CGMiner stats
- Store historical performance per board
- Calculate performance trends (7-day rolling average)
- Alert on significant degradation (>10% drop)
- Show board-level temperature and chip count

**Data Available:**
```javascript
// Per-board stats from CGMiner
{
  "chain_rate1": 35.2,  // TH/s
  "chain_rate2": 34.8,
  "chain_rate3": 35.1,
  "temp_chip_1": 65,
  "temp_chip_2": 67,
  "temp_chip_3": 66
}
```

**Files to Modify:**
- `server.js`: Extract board-level stats, add to history
- `public/index.html`: Add HashboardHealthCard component

---

### 10. Home Assistant / MQTT Integration
**Priority:** Medium | **Complexity:** Medium | **Estimated Effort:** 8-12 hours

Publish data to MQTT for Home Assistant and other automation platforms.

**Implementation:**
- Add optional MQTT client (use `mqtt` npm package)
- Publish miner stats to configurable topics
- Support Home Assistant MQTT discovery
- Enable external automation (e.g., solar-based mining)

**Config Schema:**
```json
{
  "mqtt": {
    "enabled": false,
    "broker": "mqtt://192.168.1.50:1883",
    "username": "",
    "password": "",
    "baseTopic": "mining-dashboard",
    "homeAssistantDiscovery": true
  }
}
```

**MQTT Topics:**
```
mining-dashboard/miner/192.168.1.100/hashrate
mining-dashboard/miner/192.168.1.100/temperature
mining-dashboard/miner/192.168.1.100/power
mining-dashboard/electricity/price
mining-dashboard/btc/price
```

**New Dependencies:**
- `mqtt` npm package

**Files to Modify:**
- `server.js`: Add MQTT client, publish in polling loop
- `public/index.html`: Add MQTT settings UI

---

## Quick Wins (Low Effort, Good Value)

| Feature | Effort | Impact | Description |
|---------|--------|--------|-------------|
| CSV Export | 3-4 hrs | High | Tax reporting and analysis |
| Telegram Alerts | 3-4 hrs | High | Instant mobile notifications |
| PWA Manifest | 2-3 hrs | Medium | Mobile install capability |
| Dark/Light Toggle | 2-3 hrs | Low | User preference |
| Uptime Statistics | 2-3 hrs | Medium | Reliability tracking |
| Miner Nicknames | 1-2 hrs | Low | Better UX for multi-miner |
| Refresh Rate Setting | 1-2 hrs | Low | Reduce bandwidth if needed |

---

## Future Considerations

### Infrastructure Improvements
- [ ] TypeScript migration for better maintainability
- [ ] Split server.js into modular files
- [ ] Add unit tests with Jest
- [ ] Add integration tests for API endpoints
- [ ] Database option (SQLite) for larger history retention

### Additional Integrations
- [ ] Nicehash API support (for Nicehash miners)
- [ ] Whatsminer support (different API protocol)
- [ ] Solar production integration (Enphase, SolarEdge APIs)
- [ ] Tibber API (alternative Norwegian electricity provider)

### Analytics Enhancements
- [ ] Cumulative earnings tracker (all-time stats)
- [ ] Efficiency trends over time
- [ ] Cost per BTC mined calculation
- [ ] ROI calculator based on hardware cost

### UX Improvements
- [ ] Onboarding wizard for first-time setup
- [ ] Miner auto-discovery on local network
- [ ] Keyboard shortcuts
- [ ] Dashboard presets (heating mode, profit mode, monitoring mode)

---

## Implementation Priority Matrix

```
                    HIGH IMPACT
                        |
    [2] Notifications   |   [1] Auto Power Scheduling
    [5] CSV Export      |   [4] Profitability Forecast
                        |   [3] PWA Support
    ────────────────────┼────────────────────
                        |
    [8] Customization   |   [7] Authentication
                        |   [9] Hashboard Health
                        |   [10] Home Assistant
                        |   [6] Multi-Pool
                        |
                    LOW IMPACT
         LOW EFFORT              HIGH EFFORT
```

---

## Version Milestones

### v1.3.0 - Quick Wins Release
- CSV/JSON data export
- Telegram/Discord notifications
- PWA support
- Dark/Light theme toggle

### v1.4.0 - Smart Mining Release
- Auto power scheduling based on price
- Profitability forecasting
- Tomorrow's price preview

### v1.5.0 - Advanced Monitoring Release
- Hashboard health monitoring
- Multi-pool statistics
- Enhanced alert system

### v2.0.0 - Platform Release
- Authentication system
- Home Assistant integration
- Dashboard customization
- API for third-party integrations

---

*Last updated: January 2026*
