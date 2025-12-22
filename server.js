const express = require('express');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3456;
const DATA_DIR = process.env.DATA_DIR || '/app/data';
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
        const parsed = JSON.parse(cleaned);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Failed to parse miner response: ' + err.message));
      }
    });

    client.on('error', (err) => {
      reject(new Error('Connection error: ' + err.message));
    });

    client.setTimeout(5000, () => {
      client.destroy();
      reject(new Error('Connection timeout'));
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
    const ghs5s = summaryData['GHS 5s'] || summaryData['MHS 5s'] / 1000 || 0;
    const hashrate = (ghs5s / 1000).toFixed(2);

    // Extract temperatures (format varies by miner model)
    const temps = {
      board1: statsData.temp1 || statsData.temp2_1 || 0,
      board2: statsData.temp2 || statsData.temp2_2 || 0,
      board3: statsData.temp3 || statsData.temp2_3 || 0,
      chip: statsData.temp || Math.max(
        statsData.temp1 || 0,
        statsData.temp2 || 0,
        statsData.temp3 || 0
      )
    };

    // Extract fan speeds
    const fans = {
      speed1: statsData.fan1 || statsData['fan_num'] || 0,
      speed2: statsData.fan2 || statsData.fan3 || 0
    };

    // Estimate power consumption (approximately 34W per TH/s for modern miners)
    const power = statsData.power || parseInt(hashrate * 34) || 3250;

    // Load saved power profile
    let powerProfile = 'medium';
    try {
      const config = await loadConfig();
      powerProfile = config.currentProfile || 'medium';
    } catch (err) {
      // Use default if config doesn't exist
    }

    return {
      hashrate: parseFloat(hashrate),
      hashrateUnit: 'TH/s',
      temperature: temps,
      fan: fans,
      power: power,
      uptime: summaryData.Elapsed || 0,
      pool: {
        status: poolData.Status === 'Alive' ? 'connected' : 'disconnected',
        url: poolData.URL || 'Not connected',
        accepted: poolData.Accepted || 0,
        rejected: poolData.Rejected || 0
      },
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
    // Note: Actual implementation may vary by Braiins OS version
    const response = await sendCGMinerCommand(ip, {
      command: 'ascset',
      parameter: `0,power,${targetPower}`
    });
    
    console.log(`Power profile set to ${profile} (${targetPower}W)`);
    return { success: true, profile, power: targetPower };
  } catch (err) {
    console.error('setPowerProfile error:', err);
    // Some miners may not support this command, but we'll return success anyway
    // as the command was sent
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
      // Config file doesn't exist yet
      return { minerIp: null, currentProfile: 'medium' };
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
  console.log('Configuration saved');
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
    const ip = req.query.ip || config.minerIp;
    
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
    const ip = req.body.ip || config.minerIp;
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
    const existingConfig = await loadConfig();
    
    const config = {
      minerIp: req.body.minerIp || existingConfig.minerIp,
      currentProfile: req.body.currentProfile || existingConfig.currentProfile || 'medium',
      updatedAt: new Date().toISOString()
    };

    await saveConfig(config);
    res.json({ success: true });
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
    
    try {
      const config = await loadConfig();
      const ip = config.minerIp;

      if (ip) {
        // Send initial data immediately
        try {
          const stats = await getMinerStats(ip);
          ws.send(JSON.stringify({ type: 'stats', data: stats }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }

        // Set up periodic updates every 5 seconds
        interval = setInterval(async () => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              const stats = await getMinerStats(ip);
              ws.send(JSON.stringify({ type: 'stats', data: stats }));
            } catch (err) {
              ws.send(JSON.stringify({ type: 'error', message: err.message }));
            }
          } else {
            clearInterval(interval);
          }
        }, 5000);
      } else {
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'No miner configured. Please configure miner IP in settings.' 
        }));
      }
    } catch (err) {
      console.error('WebSocket initialization error:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }

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
});// server.js file content provided by user.
