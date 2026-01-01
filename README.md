# Mining Dashboard for Umbrel

A comprehensive web-based dashboard for monitoring and controlling Bitcoin Antminer miners running Braiins OS, designed specifically for home heating applications in Norway.

![Dashboard Preview](https://img.shields.io/badge/Status-Production-green)
![Version](https://img.shields.io/badge/Version-1.2.11-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)
![Node](https://img.shields.io/badge/Node-18+-brightgreen)

## Features

### Real-Time Monitoring
- **Live Mining Stats** - Hashrate, temperature, power consumption updated every 5 seconds
- **Multi-Miner Support** - Monitor and control multiple miners from a single dashboard
- **WebSocket Updates** - Real-time data streaming without page refresh
- **Pool Statistics** - Connection status, accepted/rejected shares, reject rate

### Norwegian Electricity Pricing
- **Two Pricing Modes:**
  - **Norgespris** - Fixed 0.50 NOK/kWh base price
  - **Stromstotteavtale** - Spot price with 90% state subsidy above 93.75 ore/kWh threshold
- **Time-of-Day Grid Fees** - Separate weekday/weekend rates (configurable)
- **All 5 Norwegian Zones** - NO1 (Oslo), NO2 (Kristiansand), NO3 (Trondheim), NO4 (Tromso), NO5 (Bergen)
- **Automatic VAT** - 25% MVA (0% in Nord-Norge)

### Efficiency Analytics
- **Daily BTC Earnings** - Estimated based on current network difficulty
- **Daily Electricity Cost** - Real-time cost calculation with your pricing mode
- **Heat Pump Comparison** - Effective SCOP vs traditional heat pump (SCOP 3.5)
- **Breakeven BTC Price** - Know when mining becomes profitable

### Power Management
- **Three Power Profiles** - Low (~2000W), Medium (~3250W), High (~3500W)
- **Per-Miner Control** - Set different profiles for each miner
- **Instant Switching** - Changes apply within seconds via CGMiner API

### Data Visualization
- **24-Hour Price Graph** - Stacked bar chart showing spot price + grid fees
- **Historical Charts** - Hashrate, temperature, and power over 24h/7d/14d/30d
- **Multi-Miner Views** - Separate or aggregated data views
- **Interactive Tooltips** - Detailed breakdown on hover

### Alert System
- **Temperature Alerts** - Notification when chip temp exceeds threshold (default 80°C)
- **Low Hashrate Alerts** - Warning when performance drops below expected
- **Offline Detection** - Know immediately when a miner disconnects
- **High Reject Rate** - Alert when pool rejects exceed threshold

## Requirements

- **Umbrel Server** or any Docker host
- **Antminer** running Braiins OS (any version with CGMiner API)
- **Network Access** - Miner accessible on port 4028
- **Optional** - Tailscale for secure remote access

## Quick Start

### Option 1: Umbrel Installation

```bash
# SSH into your Umbrel
ssh umbrel@umbrel.local

# Navigate to apps directory
cd ~/umbrel/app-data

# Clone repository
git clone https://github.com/j1441/jacks-mining-dashboard-app.git
cd jacks-mining-dashboard-app

# Install
cd ~/umbrel
./scripts/app install jacks-mining-dashboard-app
```

Access at: `http://umbrel.local:3456`

### Option 2: Docker Installation

```bash
# Clone repository
git clone https://github.com/j1441/jacks-mining-dashboard-app.git
cd jacks-mining-dashboard-app

# Build and run
docker build -t mining-dashboard .
docker run -d \
  --name mining-dashboard \
  --restart unless-stopped \
  -p 3456:3456 \
  -v $(pwd)/data:/data \
  mining-dashboard
```

### Option 3: Local Development

```bash
# Install dependencies
npm install

# Start server
npm start

# Development mode with logging
npm run dev
```

Access at: `http://localhost:3456`

## Configuration

### First-Time Setup

1. Open dashboard in browser
2. Click **"Add Miner"** button
3. Enter miner's IP address and name
4. Click **"Test Connection"** to verify
5. Save and miner will appear on dashboard

### Settings

Click the **gear icon** to configure:

- **Electricity Zone** - Select your Norwegian price zone (NO1-NO5)
- **Pricing Mode** - Choose Norgespris or Stromstotteavtale
- **Grid Fees** - Set weekday day and weekend/night rates
- **Alerts** - Configure temperature, hashrate, and reject rate thresholds

### Configuration File

Settings are stored in `/data/config.json`:

```json
{
  "miners": [
    { "ip": "192.168.1.100", "name": "Living Room", "powerProfile": "medium" }
  ],
  "electricityZone": "NO5",
  "priceMode": "stromstotteavtale",
  "gridFeeWeekdayDay": 0.50,
  "gridFeeWeekendNight": 0.30,
  "alerts": {
    "enabled": true,
    "highTemp": { "enabled": true, "threshold": 80 },
    "lowHashrate": { "enabled": true, "threshold": 80 },
    "cooldownMinutes": 15
  }
}
```

## Dashboard Overview

### Main Statistics

| Metric | Description |
|--------|-------------|
| Hashrate | Current mining speed in TH/s |
| Temperature | Chip temperature in Celsius |
| Power Draw | Current consumption in Watts |
| Uptime | Time since miner started |
| Efficiency | Watts per TH/s |

### Power Profiles

| Profile | Power | Daily kWh | Best For |
|---------|-------|-----------|----------|
| Low | ~2000W | ~48 | Minimal heating, summer |
| Medium | ~3250W | ~78 | Balanced (default) |
| High | ~3500W | ~84 | Maximum heating, winter |

### Efficiency Metrics

- **Daily BTC** - Estimated earnings at current difficulty
- **Daily Cost** - Electricity cost with your pricing mode
- **Daily Profit** - BTC earnings minus electricity cost
- **Effective SCOP** - Mining efficiency vs heat pump
- **Savings** - Amount saved vs traditional heating

## API Reference

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/config` | Get configuration |
| POST | `/api/config` | Save configuration |
| POST | `/api/miners/add` | Add new miner |
| POST | `/api/miners/remove` | Remove miner |
| POST | `/api/miner/power` | Set power profile |
| POST | `/api/miner/test` | Test connection |
| GET | `/api/electricity/prices` | Current prices |
| GET | `/api/btc/price` | Bitcoin price |
| GET | `/api/network/stats` | Network stats |
| GET | `/api/history` | Historical data |

### WebSocket

Connect to `ws://host:3456/` for real-time updates every 5 seconds.

## Troubleshooting

### Miner Won't Connect

```bash
# Test network connectivity
ping 192.168.1.100

# Test CGMiner API port
nc -zv 192.168.1.100 4028
```

**Common causes:**
- Miner not running Braiins OS (stock firmware doesn't have CGMiner API)
- Firewall blocking port 4028
- Incorrect IP address
- Miner powered off or rebooting

### No Data Showing

```bash
# Check Docker logs
docker logs mining-dashboard

# Test API directly
curl http://localhost:3456/api/miner/stats?ip=192.168.1.100
```

### WebSocket Disconnecting

The dashboard auto-reconnects every 5 seconds. If persistent issues:
- Check port 3456 is accessible
- Verify no reverse proxy interfering
- Clear browser cache

### Incorrect Electricity Price

- Verify correct zone selected (NO1-NO5)
- Check pricing mode matches your contract
- Confirm grid fee values are correct
- Note: Subsidy only applies when spot > 0.9375 NOK/kWh

## Technology Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js 18+, Express.js |
| Real-time | WebSocket (ws library) |
| Frontend | React 18 (CDN, no build step) |
| Container | Docker (Node Alpine) |
| Storage | JSON files |

## External Data Sources

| Source | Data | Refresh |
|--------|------|---------|
| hvakosterstrommen.no | Norwegian electricity prices | 30 min |
| CoinGecko | Bitcoin price (USD, NOK, EUR, SEK) | 5 min |
| blockchain.info | Network difficulty, hashrate | 10 min |

## Security Notes

- **No authentication** - Designed for private networks
- **Local network only** - Do not expose to internet without VPN
- **Use Tailscale** - Recommended for secure remote access
- **Default credentials** - Change miner's root:root password

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Support

- Open an issue on GitHub
- Check troubleshooting section above
- Review logs: `docker logs mining-dashboard`

## License

MIT License - see LICENSE file

## Acknowledgments

- Built for [Umbrel](https://umbrel.com) home servers
- Compatible with [Braiins OS](https://braiins.com) firmware
- Uses CGMiner JSON-RPC API
- Norwegian electricity data from hvakosterstrommen.no

---

**Built for Norwegian home miners who want to heat their homes while stacking sats**
