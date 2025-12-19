# Jack’s Antminer Dashboard for Umbrel

A web-based dashboard for monitoring and controlling Antminer miners running Braiins OS, designed specifically for home heating applications.

![Dashboard Preview](https://img.shields.io/badge/Status-Production-green)
![Version](https://img.shields.io/badge/Version-1.0.0-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- 🔥 **Real-time Monitoring** - Live hashrate, temperature, and performance metrics
- ⚡ **Power Management** - Three power profiles (Low/Medium/High) for optimal home heating
- 🌡️ **Temperature Tracking** - Monitor board and chip temperatures with fan speeds
- 📊 **Pool Statistics** - View connection status, accepted/rejected shares
- 🔄 **Live Updates** - WebSocket-based real-time data every 5 seconds
- 🎨 **Modern UI** - Clean, responsive dark theme interface
- 🔐 **Remote Access** - Works seamlessly with Tailscale VPN

## Requirements

- **Umbrel Server** - Running on your home network
- **Antminer** - Running Braiins OS (any version with CGMiner API)
- **Network Access** - Miner must be accessible on port 4028 from Umbrel
- **Optional** - Tailscale installed on Umbrel for remote access

## Installation

### Quick Install

1. SSH into your Umbrel server:

```bash
ssh umbrel@umbrel.local
```

1. Navigate to the Umbrel apps directory:

```bash
cd ~/umbrel/app-data
```

1. Clone this repository:

```bash
git clone https://github.com/yourusername/jack-antminer-dashboard.git
cd jack-antminer-dashboard
```

1. Install the app:

```bash
cd ~/umbrel
./scripts/app install jack-antminer-dashboard
```

1. Access the dashboard:

- **Local**: `http://umbrel.local:3456`
- **Via Tailscale**: `http://[umbrel-tailscale-ip]:3456`

### Manual Docker Installation

If you prefer to run it directly with Docker:

```bash
# Build the image
docker build -t jack-antminer-dashboard:v1.0.0 .

# Run the container
docker run -d \
  --name jack-antminer-dashboard \
  --restart unless-stopped \
  -p 3456:3456 \
  -v $(pwd)/data:/app/data \
  jack-antminer-dashboard:v1.0.0
```

## Configuration

### First Time Setup

1. Open the dashboard in your browser
1. Enter your Antminer’s local IP address (e.g., `192.168.1.100`)
1. Click “Connect to Miner”
1. Dashboard will start displaying live statistics

### Verifying Miner Connection

Ensure your miner’s CGMiner API is accessible:

```bash
# Test from Umbrel server
nc -zv [miner-ip] 4028
```

If the connection fails:

- Check that your miner is powered on and connected to the network
- Verify the IP address is correct
- Ensure no firewall is blocking port 4028
- Confirm Braiins OS is running (not stock firmware)

## Usage

### Dashboard Overview

**Main Statistics:**

- **Hashrate** - Current mining speed in TH/s
- **Temperature** - Chip temperature in Celsius
- **Power Draw** - Current power consumption in Watts
- **Uptime** - How long the miner has been running

**Power Profiles:**

- **Low** (~2000W) - Minimal heating, lower performance
- **Medium** (~3250W) - Balanced heating and performance (default)
- **High** (~3500W) - Maximum heating and performance

**Detailed Information:**

- Board temperatures (1, 2, 3)
- Fan speeds (RPM)
- Pool connection status
- Accepted and rejected shares
- Reject rate percentage

### Remote Access via Tailscale

1. Install Tailscale on your Umbrel if not already installed
1. Get your Umbrel’s Tailscale IP: `tailscale ip`
1. Access from anywhere: `http://[tailscale-ip]:3456`

### Power Profile Selection

Click on the desired power profile button to adjust heating output:

- Changes take effect immediately
- Miner will adjust power consumption within ~30 seconds
- Monitor temperature to ensure safe operating range

## Troubleshooting

### Dashboard won’t connect to miner

**Check network connectivity:**

```bash
ping [miner-ip]
telnet [miner-ip] 4028
```

**Verify Braiins OS API is enabled:**

- SSH into your miner
- Check that CGMiner API is running on port 4028

### No data showing

**Check Docker logs:**

```bash
docker logs jack-antminer-dashboard
```

Common issues:

- Incorrect miner IP address
- Firewall blocking port 4028
- Miner not running Braiins OS
- CGMiner API disabled

### Container won’t start

**View detailed logs:**

```bash
docker logs --tail 50 jack-antminer-dashboard
```

**Restart the container:**

```bash
docker restart jack-antminer-dashboard
```

### WebSocket connection issues

- Check that port 3456 is not blocked
- Verify no other service is using port 3456
- Try clearing browser cache and reloading

## Architecture

### Technology Stack

- **Backend**: Node.js with Express
- **Real-time Updates**: WebSocket (ws library)
- **Frontend**: React 18 with Tailwind CSS
- **Container**: Docker (Node 18 Alpine)
- **API Protocol**: CGMiner JSON-RPC

### File Structure

```
jack-antminer-dashboard/
├── README.md                 # This file
├── LICENSE                   # MIT License
├── umbrel-app.yml           # Umbrel app manifest
├── docker-compose.yml       # Docker Compose configuration
├── Dockerfile               # Container build instructions
├── package.json             # Node.js dependencies
├── server.js                # Backend server
└── public/
    └── index.html           # Frontend React app
```

### API Endpoints

- `GET /health` - Health check endpoint
- `GET /api/miner/stats` - Get current miner statistics
- `POST /api/miner/power` - Set power profile
- `GET /api/config` - Load saved configuration
- `POST /api/config` - Save miner IP configuration
- `WebSocket /` - Real-time updates stream

## Development

### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm start

# Access at http://localhost:3456
```

### Building Docker Image

```bash
docker build -t jack-antminer-dashboard:v1.0.0 .
```

### Testing

```bash
# Test miner connection
curl http://localhost:3456/api/miner/stats?ip=192.168.1.100

# Test power profile change
curl -X POST http://localhost:3456/api/miner/power \
  -H "Content-Type: application/json" \
  -d '{"profile":"medium"}'
```

## Future Enhancements

- [ ] Support for multiple miners
- [ ] Historical data and charts
- [ ] Temperature alerts and notifications
- [ ] Auto-discovery of miners on network
- [ ] Custom power profiles
- [ ] Mining pool switching
- [ ] Profitability calculator
- [ ] Email/SMS notifications
- [ ] Mobile app

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:

- Open an issue on GitHub
- Check existing issues for solutions
- Review troubleshooting section above

## License

MIT License - see LICENSE file for details

## Acknowledgments

- Built for Umbrel home server platform
- Compatible with Braiins OS mining firmware
- Uses CGMiner API for miner communication

## Security Notes

- This dashboard does not include authentication
- Relies on network security (private network + Tailscale)
- Does not expose sensitive mining credentials
- Configuration stored locally in container volume
- No external API calls or data transmission

## Disclaimer

This software is provided as-is for personal use. Mining cryptocurrency consumes significant electrical power. Ensure proper ventilation and cooling. Monitor temperatures regularly. Not responsible for any damage to equipment.

-----

**Built with ❤️ for home mining and heating**
