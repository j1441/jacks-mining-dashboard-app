const express = require('express');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3456;
const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ============================================================================
// Electricity Price Zones Configuration
// ============================================================================

const ELECTRICITY_ZONES = {
  norway: {
    name: 'Norge',
    currency: 'NOK',
    vatRate: 0.25, // 25% MVA
    zones: {
      'NO1': { name: 'Oslo / Øst-Norge', city: 'Oslo' },
      'NO2': { name: 'Kristiansand / Sør-Norge', city: 'Kristiansand' },
      'NO3': { name: 'Trondheim / Midt-Norge', city: 'Trondheim' },
      'NO4': { name: 'Tromsø / Nord-Norge', city: 'Tromsø', vatRate: 0 }, // No VAT in Nord-Norge
      'NO5': { name: 'Bergen / Vest-Norge', city: 'Bergen' }
    },
    apiBaseUrl: 'https://www.hvakosterstrommen.no/api/v1/prices'
  }
  // Future: Add more countries here
  // sweden: { ... },
  // germany: { ... },
};

// ============================================================================
// Cache Objects
// ============================================================================

let electricityPriceCache = {
  prices: [],
  currentPrice: null,
  avgPrice: null,
  minPrice: null,
  maxPrice: null,
  fetchedAt: null,
  zone: 'NO5',
  country: 'norway'
};

let btcPriceCache = {
  priceUSD: null,
  priceNOK: null,
  fetchedAt: null
};

let networkStatsCache = {
  difficulty: null,
  hashrate: null, // in TH/s
  blockHeight: null,
  blockReward: 3.125, // Current block reward after 2024 halving
  fetchedAt: null
};

// ============================================================================
// Utility Functions
// ============================================================================

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    console.log(`Data directory ready: ${DATA_DIR}`);
  } catch (err) {
    console.error('Failed to create data directory:', err);
  }
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          // Some endpoints return plain text
          resolve(data);
        }
      });
    });
    
    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function httpGetText(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data.trim()));
    });
    
    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

// ============================================================================
// External API Functions
// ============================================================================

/**
 * Fetch electricity prices for a specific zone
 * @param {string} country - Country code (e.g., 'norway')
 * @param {string} zone - Zone code (e.g., 'NO5')
 */
async function fetchElectricityPrices(country = 'norway', zone = 'NO5') {
  try {
    const countryConfig = ELECTRICITY_ZONES[country];
    if (!countryConfig) {
      throw new Error(`Unknown country: ${country}`);
    }
    
    const zoneConfig = countryConfig.zones[zone];
    if (!zoneConfig) {
      throw new Error(`Unknown zone: ${zone} for country ${country}`);
    }
    
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
    const url = `${countryConfig.apiBaseUrl}/${year}/${month}-${day}_${zone}.json`;
    console.log(`Fetching electricity prices from: ${url}`);
    
    const prices = await httpsGet(url);
    
    if (!Array.isArray(prices) || prices.length === 0) {
      throw new Error('Invalid price data received');
    }
    
    // Determine VAT rate (some zones like NO4 have 0% VAT)
    const vatRate = zoneConfig.vatRate !== undefined ? zoneConfig.vatRate : countryConfig.vatRate;
    const vatMultiplier = 1 + vatRate;
    
    // Find current hour's price
    const currentHour = now.getHours();
    const currentPrice = prices.find(p => {
      const priceHour = new Date(p.time_start).getHours();
      return priceHour === currentHour;
    });
    
    // Calculate stats with VAT
    const pricesWithVat = prices.map(p => p.NOK_per_kWh * vatMultiplier);
    const avgPrice = pricesWithVat.reduce((a, b) => a + b, 0) / pricesWithVat.length;
    const minPrice = Math.min(...pricesWithVat);
    const maxPrice = Math.max(...pricesWithVat);
    
    electricityPriceCache = {
      prices: prices.map(p => ({
        time: p.time_start,
        priceExVat: p.NOK_per_kWh,
        priceIncVat: p.NOK_per_kWh * vatMultiplier,
        eur: p.EUR_per_kWh
      })),
      currentPrice: currentPrice ? currentPrice.NOK_per_kWh * vatMultiplier : avgPrice,
      avgPrice,
      minPrice,
      maxPrice,
      fetchedAt: new Date().toISOString(),
      zone,
      country,
      zoneName: zoneConfig.name,
      currency: countryConfig.currency,
      vatRate
    };
    
    console.log(`Electricity prices updated for ${zone}: ${electricityPriceCache.currentPrice.toFixed(2)} ${countryConfig.currency}/kWh`);
    return electricityPriceCache;
  } catch (err) {
    console.error('Failed to fetch electricity prices:', err.message);
    return electricityPriceCache;
  }
}

/**
 * Fetch BTC price from CoinGecko
 */
async function fetchBTCPrice() {
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,nok,eur,sek';
    const data = await httpsGet(url);
    
    if (data.bitcoin) {
      btcPriceCache = {
        priceUSD: data.bitcoin.usd,
        priceNOK: data.bitcoin.nok,
        priceEUR: data.bitcoin.eur,
        priceSEK: data.bitcoin.sek,
        fetchedAt: new Date().toISOString()
      };
      
      console.log(`BTC price updated: $${btcPriceCache.priceUSD.toLocaleString()} / ${btcPriceCache.priceNOK.toLocaleString()} NOK`);
    }
    
    return btcPriceCache;
  } catch (err) {
    console.error('Failed to fetch BTC price:', err.message);
    return btcPriceCache;
  }
}

/**
 * Fetch Bitcoin network stats (difficulty, hashrate) from blockchain.info
 */
async function fetchNetworkStats() {
  try {
    // Fetch stats from blockchain.info (free, no auth required)
    const statsUrl = 'https://api.blockchain.info/stats';
    const stats = await httpsGet(statsUrl);
    
    if (stats && stats.difficulty) {
      // blockchain.info returns hashrate in GH/s, convert to EH/s
      const hashrateEHs = stats.hash_rate / 1e9; // GH/s to EH/s
      
      networkStatsCache = {
        difficulty: stats.difficulty,
        hashrate: hashrateEHs, // in EH/s
        hashrateFormatted: `${hashrateEHs.toFixed(2)} EH/s`,
        blockHeight: stats.n_blocks_total,
        blockReward: 3.125, // Current block reward (post-2024 halving)
        blocksPerDay: 144,
        marketPriceUSD: stats.market_price_usd,
        fetchedAt: new Date().toISOString()
      };
      
      console.log(`Network stats updated: Difficulty ${(networkStatsCache.difficulty / 1e12).toFixed(2)}T, Hashrate ${networkStatsCache.hashrateFormatted}`);
    }
    
    return networkStatsCache;
  } catch (err) {
    console.error('Failed to fetch network stats:', err.message);
    return networkStatsCache;
  }
}

/**
 * Calculate mining profitability and efficiency metrics
 */
function calculateEfficiency(hashrateTHs, powerWatts, electricityPricePerKWh, btcPrice, currency = 'NOK') {
  // Use actual network stats if available
  const networkHashrateEHs = networkStatsCache.hashrate || 700; // Fallback to 700 EH/s
  const blockReward = networkStatsCache.blockReward || 3.125;
  const blocksPerDay = networkStatsCache.blocksPerDay || 144;
  
  // Calculate daily BTC earnings estimate
  const hashrateEHs = hashrateTHs / 1000000; // Convert TH/s to EH/s
  const dailyBTCEstimate = (hashrateEHs / networkHashrateEHs) * blockReward * blocksPerDay;
  
  // Calculate power costs
  const powerKW = powerWatts / 1000;
  const dailyKWh = powerKW * 24;
  const dailyElectricityCost = dailyKWh * electricityPricePerKWh;
  
  // Calculate earnings in local currency
  const dailyEarnings = dailyBTCEstimate * btcPrice;
  
  // Net profit/loss
  const dailyProfit = dailyEarnings - dailyElectricityCost;
  
  // Efficiency metrics
  const efficiency = hashrateTHs / powerKW; // TH/s per kW
  const costPerTH = dailyElectricityCost / hashrateTHs;
  
  // Hashprice: Revenue per TH/s per day
  const hashprice = dailyEarnings / hashrateTHs;
  
  // Heat equivalent comparison (SCOP comparison)
  const heatOutputKWh = dailyKWh; // All electricity becomes heat
  const equivalentHeatPumpCost = dailyKWh / 3.5 * electricityPricePerKWh; // Assuming SCOP 3.5
  const heatingSavings = equivalentHeatPumpCost - dailyElectricityCost + dailyEarnings;
  
  // Effective SCOP calculation
  const effectiveMultiplier = dailyEarnings / dailyElectricityCost;
  const effectiveSCOP = 1 / (1 - Math.min(effectiveMultiplier, 0.99));
  
  return {
    // Power metrics
    powerKW,
    dailyKWh,
    
    // Mining earnings
    dailyBTCEstimate,
    dailyEarnings,
    hourlyEarnings: dailyEarnings / 24,
    
    // Costs
    dailyElectricityCost,
    hourlyElectricityCost: dailyElectricityCost / 24,
    
    // Profit
    dailyProfit,
    hourlyProfit: dailyProfit / 24,
    isProfitable: dailyProfit > 0,
    
    // Efficiency
    efficiency,
    costPerTH,
    hashprice,
    
    // Network context
    networkHashrate: networkHashrateEHs,
    networkDifficulty: networkStatsCache.difficulty,
    
    // Heating comparison
    heatOutputKWh,
    equivalentHeatPumpCost,
    heatingSavings,
    effectiveSCOP: Math.min(effectiveSCOP, 10),
    
    // Breakeven
    breakevenBTCPrice: dailyElectricityCost / dailyBTCEstimate,
    currentBTCPrice: btcPrice,
    
    // Currency
    currency
  };
}

// ============================================================================
// Miner Communication Functions
// ============================================================================

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

async function getMinerStats(ip, config = {}) {
  try {
    console.log(`Getting stats from miner at ${ip}`);
    
    const [summary, stats, pools] = await Promise.all([
      sendCGMinerCommand(ip, { command: 'summary' }),
      sendCGMinerCommand(ip, { command: 'stats' }),
      sendCGMinerCommand(ip, { command: 'pools' })
    ]);

    const summaryData = summary.SUMMARY?.[0] || {};
    const statsData = stats.STATS?.[1] || stats.STATS?.[0] || {};
    const poolData = pools.POOLS?.[0] || {};

    // Calculate hashrate in TH/s
    const ghs5s = summaryData['GHS 5s'] || (summaryData['MHS 5s'] ? summaryData['MHS 5s'] / 1000 : 0);
    const hashrate = ghs5s / 1000;

    // Extract temperatures
    const temp1 = statsData.temp1 || statsData.temp2_1 || 0;
    const temp2 = statsData.temp2 || statsData.temp2_2 || 0;
    const temp3 = statsData.temp3 || statsData.temp2_3 || 0;
    const chipTemp = statsData.temp || Math.max(temp1, temp2, temp3);

    // Extract fan speeds
    const fan1 = statsData.fan1 || 0;
    const fan2 = statsData.fan2 || statsData.fan3 || 0;

    // Get power from stats or estimate
    const power = statsData.Power || statsData.power || Math.round(hashrate * 34) || 3250;

    // Load power profile from config
    const powerProfile = config.currentProfile || 'medium';

    // Calculate reject rate
    const accepted = poolData.Accepted || 0;
    const rejected = poolData.Rejected || 0;
    const rejectRate = accepted > 0 ? (rejected / (accepted + rejected)) * 100 : 0;

    // Get currency based on country
    const countryConfig = ELECTRICITY_ZONES[config.country || 'norway'];
    const currency = countryConfig?.currency || 'NOK';
    
    // Get BTC price in the right currency
    let btcPrice = btcPriceCache.priceNOK || 1000000;
    if (currency === 'EUR') btcPrice = btcPriceCache.priceEUR || 90000;
    if (currency === 'SEK') btcPrice = btcPriceCache.priceSEK || 1000000;
    if (currency === 'USD') btcPrice = btcPriceCache.priceUSD || 95000;

    // Calculate efficiency metrics
    const electricityPrice = electricityPriceCache.currentPrice || 1.0;
    const efficiency = calculateEfficiency(hashrate, power, electricityPrice, btcPrice, currency);

    return {
      // Basic stats
      hashrate,
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
      rejectRate,
      powerProfile,
      
      // Electricity data
      electricity: {
        currentPrice: electricityPriceCache.currentPrice,
        avgPrice: electricityPriceCache.avgPrice,
        minPrice: electricityPriceCache.minPrice,
        maxPrice: electricityPriceCache.maxPrice,
        zone: electricityPriceCache.zone,
        zoneName: electricityPriceCache.zoneName,
        country: electricityPriceCache.country,
        currency: electricityPriceCache.currency,
        vatRate: electricityPriceCache.vatRate,
        prices: electricityPriceCache.prices,
        updatedAt: electricityPriceCache.fetchedAt
      },
      
      // BTC price
      btcPrice: {
        usd: btcPriceCache.priceUSD,
        nok: btcPriceCache.priceNOK,
        eur: btcPriceCache.priceEUR,
        sek: btcPriceCache.priceSEK,
        updatedAt: btcPriceCache.fetchedAt
      },
      
      // Network stats
      network: {
        difficulty: networkStatsCache.difficulty,
        hashrate: networkStatsCache.hashrate,
        hashrateFormatted: networkStatsCache.hashrateFormatted,
        blockHeight: networkStatsCache.blockHeight,
        blockReward: networkStatsCache.blockReward,
        updatedAt: networkStatsCache.fetchedAt
      },
      
      // Efficiency metrics
      efficiency
    };
  } catch (err) {
    console.error('getMinerStats error:', err);
    throw new Error(`Failed to get miner stats: ${err.message}`);
  }
}

async function setPowerProfile(ip, profile) {
  const profiles = {
    low: 2000,
    medium: 3250,
    high: 3500
  };

  const targetPower = profiles[profile];
  
  try {
    await sendCGMinerCommand(ip, {
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
      note: 'Command sent but response uncertain'
    };
  }
}

// ============================================================================
// Configuration Functions
// ============================================================================

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { 
        minerIP: null, 
        currentProfile: 'medium',
        country: 'norway',
        electricityZone: 'NO5',
        gridFeePerKwh: 0.50
      };
    }
    throw err;
  }
}

async function saveConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('Configuration saved:', config);
}

async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { entries: [] };
    }
    throw err;
  }
}

async function saveHistoryEntry(stats) {
  try {
    const history = await loadHistory();
    const maxEntries = 720; // 30 days of hourly data
    
    history.entries.push({
      timestamp: new Date().toISOString(),
      hashrate: stats.hashrate,
      power: stats.powerDraw,
      temperature: stats.temperature,
      electricityPrice: stats.electricity?.currentPrice,
      btcPrice: stats.btcPrice?.nok,
      networkDifficulty: stats.network?.difficulty,
      dailyProfit: stats.efficiency?.dailyProfit,
      effectiveSCOP: stats.efficiency?.effectiveSCOP
    });
    
    if (history.entries.length > maxEntries) {
      history.entries = history.entries.slice(-maxEntries);
    }
    
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('Failed to save history:', err);
  }
}

// ============================================================================
// API Routes
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get available electricity zones
app.get('/api/electricity/zones', (req, res) => {
  const zones = {};
  for (const [countryCode, country] of Object.entries(ELECTRICITY_ZONES)) {
    zones[countryCode] = {
      name: country.name,
      currency: country.currency,
      zones: Object.entries(country.zones).map(([code, zone]) => ({
        code,
        name: zone.name,
        city: zone.city
      }))
    };
  }
  res.json(zones);
});

app.get('/api/miner/stats', async (req, res) => {
  try {
    const config = await loadConfig();
    const ip = req.query.ip || config.minerIP;
    
    if (!ip) {
      return res.status(400).json({ error: 'No miner IP configured' });
    }

    const stats = await getMinerStats(ip, config);
    res.json(stats);
  } catch (err) {
    console.error('API stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/miner/power', async (req, res) => {
  try {
    const config = await loadConfig();
    const ip = req.body.ip || config.minerIP;
    const profile = req.body.profile;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP configured' });
    }

    if (!['low', 'medium', 'high'].includes(profile)) {
      return res.status(400).json({ error: 'Invalid power profile' });
    }

    const result = await setPowerProfile(ip, profile);
    
    config.currentProfile = profile;
    await saveConfig(config);
    
    res.json(result);
  } catch (err) {
    console.error('API power error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    console.log('Received config POST:', req.body);
    const existingConfig = await loadConfig();
    
    const newIP = req.body.minerIP || req.body.minerIp;
    const newCountry = req.body.country || existingConfig.country || 'norway';
    const newZone = req.body.electricityZone || existingConfig.electricityZone || 'NO5';
    
    const config = {
      minerIP: newIP || existingConfig.minerIP,
      currentProfile: req.body.currentProfile || existingConfig.currentProfile || 'medium',
      country: newCountry,
      electricityZone: newZone,
      gridFeePerKwh: req.body.gridFeePerKwh ?? existingConfig.gridFeePerKwh ?? 0.50,
      updatedAt: new Date().toISOString()
    };

    await saveConfig(config);
    
    // Refresh electricity prices for new zone
    await fetchElectricityPrices(newCountry, newZone);
    
    res.json({ success: true, config });
  } catch (err) {
    console.error('API config save error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', async (req, res) => {
  try {
    const config = await loadConfig();
    res.json(config);
  } catch (err) {
    console.error('API config load error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/miner/test', async (req, res) => {
  try {
    const ip = req.body.minerIP || req.body.minerIp || req.body.ip;
    
    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    console.log(`Testing connection to miner at ${ip}`);
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

app.get('/api/electricity/prices', async (req, res) => {
  try {
    const config = await loadConfig();
    const country = req.query.country || config.country || 'norway';
    const zone = req.query.zone || config.electricityZone || 'NO5';
    
    // Refresh if older than 30 minutes or zone changed
    if (!electricityPriceCache.fetchedAt || 
        electricityPriceCache.zone !== zone ||
        Date.now() - new Date(electricityPriceCache.fetchedAt).getTime() > 30 * 60 * 1000) {
      await fetchElectricityPrices(country, zone);
    }
    res.json(electricityPriceCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/btc/price', async (req, res) => {
  try {
    if (!btcPriceCache.fetchedAt || 
        Date.now() - new Date(btcPriceCache.fetchedAt).getTime() > 5 * 60 * 1000) {
      await fetchBTCPrice();
    }
    res.json(btcPriceCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/network/stats', async (req, res) => {
  try {
    if (!networkStatsCache.fetchedAt || 
        Date.now() - new Date(networkStatsCache.fetchedAt).getTime() > 10 * 60 * 1000) {
      await fetchNetworkStats();
    }
    res.json(networkStatsCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const history = await loadHistory();
    const days = parseInt(req.query.days) || 7;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    
    const filtered = history.entries.filter(e => new Date(e.timestamp) >= cutoff);
    res.json({ entries: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Server Startup
// ============================================================================

async function start() {
  await ensureDataDir();
  
  // Load config to get zone
  const config = await loadConfig();
  
  // Initial fetch of external data
  console.log('Fetching initial data...');
  await Promise.all([
    fetchElectricityPrices(config.country || 'norway', config.electricityZone || 'NO5'),
    fetchBTCPrice(),
    fetchNetworkStats()
  ]);
  
  // Set up periodic refresh
  setInterval(() => fetchElectricityPrices(
    electricityPriceCache.country || 'norway', 
    electricityPriceCache.zone || 'NO5'
  ), 30 * 60 * 1000);
  setInterval(fetchBTCPrice, 5 * 60 * 1000);
  setInterval(fetchNetworkStats, 10 * 60 * 1000);
  
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log(`Jack's Mining Dashboard v2.1`);
    console.log('='.repeat(60));
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
    console.log(`⚡ Electricity zone: ${electricityPriceCache.zone} (${electricityPriceCache.zoneName || 'Loading...'})`);
    console.log(`💰 BTC Price: ${btcPriceCache.priceNOK?.toLocaleString() || 'Loading...'} NOK`);
    console.log(`🔌 Current electricity: ${electricityPriceCache.currentPrice?.toFixed(2) || 'Loading...'} NOK/kWh`);
    console.log(`⛏️  Network hashrate: ${networkStatsCache.hashrateFormatted || 'Loading...'}`);
    console.log('='.repeat(60));
  });

  // WebSocket Server
  const wss = new WebSocket.Server({ server });
  
  let lastHistorySave = 0;
  const historySaveInterval = 60 * 60 * 1000;

  wss.on('connection', async (ws) => {
    console.log('🔌 WebSocket client connected');
    let interval;
    
    const sendStats = async () => {
      try {
        const config = await loadConfig();
        const ip = config.minerIP;

        if (!ip) {
          ws.send(JSON.stringify({ 
            error: 'No miner configured. Please enter miner IP address.',
            electricity: electricityPriceCache,
            btcPrice: btcPriceCache,
            network: networkStatsCache
          }));
          return;
        }

        const stats = await getMinerStats(ip, config);
        ws.send(JSON.stringify(stats));
        
        if (Date.now() - lastHistorySave > historySaveInterval) {
          await saveHistoryEntry(stats);
          lastHistorySave = Date.now();
        }
      } catch (err) {
        console.error('WebSocket stats error:', err);
        ws.send(JSON.stringify({ 
          error: err.message,
          electricity: electricityPriceCache,
          btcPrice: btcPriceCache,
          network: networkStatsCache
        }));
      }
    };

    await sendStats();

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

start().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});