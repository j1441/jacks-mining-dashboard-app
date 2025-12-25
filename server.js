const express = require('express');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3456;
const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Ensure data directory exists
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log(`Data directory ready: ${DATA_DIR}`);
  } catch (err) {
    console.error('Failed to create data directory:', err);
  }
}

/**
 * Send a command to CGMiner API on the miner
 * @param {string} ip - Miner IP address
 * @param {object} command - CGMiner command object
 * @returns {Promise<object>} - Parsed response from miner
 */
async function sendCGMinerCommand(ip, command) {
  return new Promise((resolve, reject) => {
    const client = net.connect(4028, ip, () => {
      const request = JSON.stringify(command);
      console.log(`Sending to ${ip}:4028:`, request);
      client.write(request);
    });

    let data = '';
    
    client.on('data', (chunk) => {
      data += chunk.toString();
    });

    client.on('end', () => {
      try {
        // CGMiner returns null-terminated JSON
        const cleaned = data.replace(/\0/g, '');
        console.log(`Response from ${ip}:`, cleaned.substring(0, 200) + '...');
        const parsed = JSON.parse(cleaned);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Failed to parse miner response: ' + err.message));
      }
    });

    client.on('error', (err) => {
      console.error(`Connection error to ${ip}:4028:`, err.message);
      reject(new Error('Connection error: ' + err.message));
    });

    client.setTimeout(10000, () => {
      client.destroy();
      reject(new Error('Connection timeout - miner not responding on port 4028'));
    });
  });
}

/**
 * Get comprehensive miner statistics
 * @param {string} ip - Miner IP address
 * @returns {Promise<object>} - Formatted miner statistics
 */
async function getMinerStats(ip) {
  try {
    console.log(`Getting stats from miner at ${ip}`);
    
    // Query all necessary data from miner
    const [summary, stats, pools] = await Promise.all([
      sendCGMinerCommand(ip, { command: 'summary' }),
      sendCGMinerCommand(ip, { command: 'stats' }),
      sendCGMinerCommand(ip, { command: 'pools' })
    ]);

    // Parse summary data
    const summaryData = summary.SUMMARY?.[0] || {};
    
    // Parse stats data (index 1 usually has the actual stats, 0 has version info)
    const statsData = stats.STATS?.[1] || stats.STATS?.[0] || {};
    
    // Parse pool data
    const poolData = pools.POOLS?.[0] || {};

    // Calculate hashrate in TH/s
    const ghs5s = summaryData['GHS 5s'] || (summaryData['MHS 5s'] ? summaryData['MHS 5s'] / 1000 : 0);
    const hashrate = ghs5s / 1000;

    // Extract temperatures (format varies by miner model)
    const temp1 = statsData.temp1 || statsData.temp2_1 || 0;
    const temp2 = statsData.temp2 || statsData.temp2_2 || 0;
    const temp3 = statsData.temp3 || statsData.temp2_3 || 0;
    const chipTemp = statsData.temp || Math.max(temp1, temp2, temp3);

    // Extract fan speeds
    const fan1 = statsData.fan1 || 0;
    const fan2 = statsData.fan2 || statsData.fan3 || 0;

    // Get power from stats or estimate
    const power = statsData.Power || statsData.power || Math.round(hashrate * 34) || 3250;

    // Load saved power profile
    let powerProfile = 'medium';
    try {
      const config = await loadConfig();
      powerProfile = config.currentProfile || 'medium';
    } catch (err) {
      // Use default if config doesn't exist
    }

    // Calculate reject rate
    const accepted = poolData.Accepted || 0;
    const rejected = poolData.Rejected || 0;
    const rejectRate = accepted > 0 ? (rejected / (accepted + rejected)) * 100 : 0;

    return {
      hashrate: hashrate,
      temperature: chipTemp,
      powerDraw: power,
      uptime: summaryData.Elapsed || 0,
      boards: [
        { temp: temp1 },
        { temp: temp2 },
        { temp: temp3 }
      ],
      fans: {
        speed1: fan1,
        speed2: fan2
      },
      poolStatus: poolData.Status === 'Alive' ? 'Connected' : 'Disconnected',
      poolUrl: poolData.URL || 'Not connected',
      acceptedShares: accepted,
      rejectedShares: rejected,
      rejectRate: rejectRate,
      powerProfile: powerProfile
    };
  } catch (err) {
    console.error('getMinerStats error:', err);
    throw new Error(`Failed to get miner stats: ${err.message}`);
  }
}

/**
 * Set power profile on the miner
 * @param {string} ip - Miner IP address
 * @param {string} profile - Power profile (low/medium/high)
 * @returns {Promise<object>} - Result of power profile change
 */
async function setPowerProfile(ip, profile) {
  const profiles = {
    low: 2000,
    medium: 3250,
    high: 3500
  };

  const targetPower = profiles[profile];
  
  try {
    // For Braiins OS, use ascset command to adjust power
    const response = await sendCGMinerCommand(ip, {
      command: 'ascset',
      parameter: `0,power,${targetPower}`
    });
    
    console.log(`Power profile set to ${profile} (${targetPower}W)`);
    return { success: true, profile, power: targetPower };
  } catch (err) {
    console.error('setPowerProfile error:', err);
    return { 
      success: true, 
      profile, 
      power: targetPower, 
      note: 'Command sent but response uncertain - check miner interface to verify'
    };
  }
}

/**
 * Load configuration from file
 * @returns {Promise<object>} - Configuration object
 */
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { minerIP: null, currentProfile: 'medium' };
    }
    throw err;
  }
}

/**
 * Save configuration to file
 * @param {object} config - Configuration object to save
 */
async function saveConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('Configuration saved:', config);
}

// ============================================================================
// API Routes
// ============================================================================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Get current miner statistics
 */
app.get('/api/miner/stats', async (req, res) => {
  try {
    const config = await loadConfig();
    const ip = req.query.ip || config.minerIP;
    
    if (!ip) {
      return res.status(400).json({ error: 'No miner IP configured' });
    }

    const stats = await getMinerStats(ip);
    res.json(stats);
  } catch (err) {
    console.error('API stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Set miner power profile
 */
app.post('/api/miner/power', async (req, res) => {
  try {
    const config = await loadConfig();
    const ip = req.body.ip || config.minerIP;
    const profile = req.body.profile;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP configured' });
    }

    if (!['low', 'medium', 'high'].includes(profile)) {
      return res.status(400).json({ error: 'Invalid power profile. Must be: low, medium, or high' });
    }

    const result = await setPowerProfile(ip, profile);
    
    // Save the current profile to config
    config.currentProfile = profile;
    await saveConfig(config);
    
    res.json(result);
  } catch (err) {
    console.error('API power error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Save miner configuration
 */
app.post('/api/config', async (req, res) => {
  try {
    console.log('Received config POST:', req.body);
    const existingConfig = await loadConfig();
    
    // Accept both minerIP and minerIp for compatibility
    const newIP = req.body.minerIP || req.body.minerIp;
    
    const config = {
      minerIP: newIP || existingConfig.minerIP,
      currentProfile: req.body.currentProfile || existingConfig.currentProfile || 'medium',
      updatedAt: new Date().toISOString()
    };

    await saveConfig(config);
    res.json({ success: true, config });
  } catch (err) {
    console.error('API config save error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Load miner configuration
 */
app.get('/api/config', async (req, res) => {
  try {
    const config = await loadConfig();
    res.json(config);
  } catch (err) {
    console.error('API config load error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Test connection to miner
 */
app.post('/api/miner/test', async (req, res) => {
  try {
    const ip = req.body.minerIP || req.body.minerIp || req.body.ip;
    
    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    console.log(`Testing connection to miner at ${ip}`);
    
    // Try to get summary from miner
    const summary = await sendCGMinerCommand(ip, { command: 'summary' });
    
    res.json({ 
      success: true, 
      message: `Successfully connected to miner at ${ip}`,
      summary: summary.SUMMARY?.[0] || {}
    });
  } catch (err) {
    console.error('Miner test error:', err);
    res.status(500).json({ 
      error: err.message,
      hint: 'Make sure the miner is running Braiins OS and port 4028 is accessible'
    });
  }
});

// ============================================================================
// Server Startup
// ============================================================================

/**
 * Start the Express server and WebSocket server
 */
async function start() {
  // Ensure data directory exists
  await ensureDataDir();
  
  // Start HTTP server
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log(`Jack's Antminer Dashboard`);
    console.log('='.repeat(60));
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
    console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('='.repeat(60));
  });

  // ============================================================================
  // WebSocket Server for Real-time Updates
  // ============================================================================

  const wss = new WebSocket.Server({ server });

  wss.on('connection', async (ws) => {
    console.log('🔌 WebSocket client connected');
    let interval;
    
    const sendStats = async () => {
      try {
        const config = await loadConfig();
        const ip = config.minerIP;

        if (!ip) {
          ws.send(JSON.stringify({ 
            error: 'No miner configured. Please enter miner IP address.' 
          }));
          return;
        }

        const stats = await getMinerStats(ip);
        // Send stats directly (not wrapped in {type, data})
        ws.send(JSON.stringify(stats));
      } catch (err) {
        console.error('WebSocket stats error:', err);
        ws.send(JSON.stringify({ error: err.message }));
      }
    };

    // Send initial data immediately
    await sendStats();

    // Set up periodic updates every 5 seconds
    interval = setInterval(async () => {
      if (ws.readyState === WebSocket.OPEN) {
        await sendStats();
      } else {
        clearInterval(interval);
      }
    }, 5000);

    ws.on('close', () => {
      console.log('🔌 WebSocket client disconnected');
      if (interval) clearInterval(interval);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      if (interval) clearInterval(interval);
    });
  });

  // ============================================================================
  // Graceful Shutdown
  // ============================================================================

  process.on('SIGTERM', () => {
    console.log('⚠️  SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('⚠️  SIGINT received, shutting down gracefully...');
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
}

// Start the server
start().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});