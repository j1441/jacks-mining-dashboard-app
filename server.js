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
  hashrate: null,
  blockHeight: null,
  blockReward: 3.125,
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

/**
 * Fetch temperature and fan data from Braiins OS GraphQL API
 * This is more reliable than CGMiner API for temperature data
 */
async function fetchBraiinsGraphQL(ip) {
  // Detailed introspection to discover the schema
  const introspectionQuery = `{
    __schema {
      queryType {
        fields {
          name
          type {
            name
            kind
            fields {
              name
              type {
                name
                kind
              }
            }
          }
        }
      }
    }
  }`;
  
  // First, run introspection to see what fields are available
  console.log('Running GraphQL introspection...');
  let availableFields = [];
  let bosminerFields = [];
  let bosFields = [];
  const schemaResult = await graphqlRequest(ip, introspectionQuery);
  
  if (schemaResult?.data?.__schema?.queryType?.fields) {
    const fields = schemaResult.data.__schema.queryType.fields;
    availableFields = fields.map(f => f.name);
    console.log('Available GraphQL root fields:', availableFields);
    
    // Find bosminer fields specifically
    const bosminerType = fields.find(f => f.name === 'bosminer');
    if (bosminerType?.type?.fields) {
      bosminerFields = bosminerType.type.fields.map(f => `${f.name}(${f.type?.name || f.type?.kind})`);
      console.log('Bosminer fields:', bosminerFields);
    }
    
    // Also check 'bos' type
    const bosType = fields.find(f => f.name === 'bos');
    if (bosType?.type?.fields) {
      bosFields = bosType.type.fields.map(f => f.name);
      console.log('BOS fields:', bosFields);
    }
  } else if (schemaResult?.errors) {
    console.log('GraphQL introspection failed:', schemaResult.errors[0]?.message);
  }
  
  // Try deeper introspection on bosminer
  const bosminerIntrospection = `{
    __type(name: "BosminerQuery") {
      fields {
        name
        type {
          name
          kind
          ofType {
            name
            kind
          }
        }
      }
    }
  }`;
  
  const bosminerSchema = await graphqlRequest(ip, bosminerIntrospection);
  if (bosminerSchema?.data?.__type?.fields) {
    const fields = bosminerSchema.data.__type.fields;
    console.log('BosminerQuery fields (detailed):', fields.map(f => f.name));
    bosminerFields = fields.map(f => f.name);
  }
  
  // Introspect BosQuery
  const bosIntrospection = `{
    __type(name: "BosQuery") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;
  
  const bosSchema = await graphqlRequest(ip, bosIntrospection);
  if (bosSchema?.data?.__type?.fields) {
    console.log('BosQuery fields:', bosSchema.data.__type.fields.map(f => f.name));
    bosFields = bosSchema.data.__type.fields.map(f => f.name);
  }
  
  // Introspect BosInfo type to find temperature/fan fields
  const bosInfoIntrospection = `{
    __type(name: "BosInfo") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;
  
  const bosInfoSchema = await graphqlRequest(ip, bosInfoIntrospection);
  if (bosInfoSchema?.data?.__type?.fields) {
    console.log('BosInfo fields:', bosInfoSchema.data.__type.fields.map(f => f.name));
  }
  
  // Introspect Manager type
  const managerIntrospection = `{
    __type(name: "Manager") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;
  
  const managerSchema = await graphqlRequest(ip, managerIntrospection);
  if (managerSchema?.data?.__type?.fields) {
    console.log('Manager fields:', managerSchema.data.__type.fields.map(f => f.name));
  }
  
  // Introspect BosminerInfo type
  const bosminerInfoIntrospection = `{
    __type(name: "BosminerInfo") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;
  
  const bosminerInfoSchema = await graphqlRequest(ip, bosminerInfoIntrospection);
  if (bosminerInfoSchema?.data?.__type?.fields) {
    console.log('BosminerInfo fields:', bosminerInfoSchema.data.__type.fields.map(f => `${f.name}(${f.type?.name || f.type?.kind})`));
  }
  
  // Introspect Fan type to see exact fields
  const fanIntrospection = `{
    __type(name: "Fan") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;
  
  const fanSchema = await graphqlRequest(ip, fanIntrospection);
  if (fanSchema?.data?.__type?.fields) {
    console.log('Fan type fields:', fanSchema.data.__type.fields.map(f => f.name));
  }
  
  // Introspect TempCtrlInfo type (NOT TempCtrl - based on error message!)
  const tempCtrlIntrospection = `{
    __type(name: "TempCtrlInfo") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;
  
  const tempCtrlSchema = await graphqlRequest(ip, tempCtrlIntrospection);
  if (tempCtrlSchema?.data?.__type?.fields) {
    console.log('TempCtrlInfo type fields:', tempCtrlSchema.data.__type.fields.map(f => f.name));
  }
  
  // Also introspect WorkSolverInfo to find temperature data
  const workSolverIntrospection = `{
    __type(name: "WorkSolverInfo") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;
  
  const workSolverSchema = await graphqlRequest(ip, workSolverIntrospection);
  if (workSolverSchema?.data?.__type?.fields) {
    console.log('WorkSolverInfo type fields:', workSolverSchema.data.__type.fields.map(f => f.name));
  }
  
  // Build queries dynamically based on discovered fields
  const queries = [];
  
  // Query 1: Get fans with just rpm (most common field)
  queries.push(`{
    bosminer {
      info {
        fans {
          rpm
        }
      }
    }
  }`);
  
  // Query 2: Try workSolver which might have hashboard temperatures
  queries.push(`{
    bosminer {
      info {
        workSolver {
          hashboards {
            id
            temperature
          }
        }
      }
    }
  }`);
  
  // Query 3: Try workSolver with different structure
  queries.push(`{
    bosminer {
      info {
        workSolver {
          realHashrate {
            mhs15M
          }
          nominalHashrate {
            mhs15M
          }
        }
      }
    }
  }`);
  
  // Query 4: Try summary which might have overall temp
  queries.push(`{
    bosminer {
      info {
        summary {
          temperature
        }
      }
    }
  }`);
  
  // Query 5: Just hostname to confirm auth works
  queries.push(`{
    bos {
      hostname
    }
  }`);
  
  // Try each query format until one works
  for (let i = 0; i < queries.length; i++) {
    console.log(`Trying GraphQL query format ${i + 1}...`);
    const result = await graphqlRequest(ip, queries[i]);
    
    if (result?.data && !result.errors) {
      console.log(`GraphQL query format ${i + 1} succeeded:`, JSON.stringify(result.data, null, 2).substring(0, 1500));
      result._availableFields = availableFields;
      result._bosminerFields = bosminerFields;
      result._bosFields = bosFields;
      return result;
    } else if (result?.errors) {
      console.log(`GraphQL query format ${i + 1} failed:`, result.errors[0]?.message);
    }
  }
  
  // Return an object with just the available fields for debugging
  return { 
    _availableFields: availableFields, 
    _bosminerFields: bosminerFields,
    _bosFields: bosFields,
    data: null 
  };
}

/**
 * Helper function to make GraphQL requests with authentication
 */
function graphqlRequest(ip, query) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });
    
    // Create Basic Auth header with root:root credentials (Braiins OS default)
    const authHeader = 'Basic ' + Buffer.from('root:root').toString('base64');
    
    const options = {
      hostname: ip,
      port: 80,
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': authHeader
      },
      timeout: 10000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (err) {
          console.error('Failed to parse GraphQL response:', err.message);
          resolve(null);
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('GraphQL request error:', err.message);
      resolve(null);
    });
    
    req.on('timeout', () => {
      req.destroy();
      console.error('GraphQL request timeout');
      resolve(null);
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Alternative: Fetch from Braiins OS HTTP API
 */
async function fetchBraiinsHTTPApi(ip) {
  return new Promise((resolve, reject) => {
    // Create Basic Auth header with root:root credentials (Braiins OS default)
    const authHeader = 'Basic ' + Buffer.from('root:root').toString('base64');
    
    const options = {
      hostname: ip,
      port: 80,
      path: '/cgi-bin/luci/admin/miner/api_status',
      method: 'GET',
      headers: {
        'Authorization': authHeader
      },
      timeout: 10000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log('HTTP API response:', JSON.stringify(parsed, null, 2).substring(0, 1000));
          resolve(parsed);
        } catch (err) {
          console.error('Failed to parse HTTP API response:', err.message);
          resolve(null);
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('HTTP API request error:', err.message);
      resolve(null);
    });
    
    req.on('timeout', () => {
      req.destroy();
      console.error('HTTP API request timeout');
      resolve(null);
    });
    
    req.end();
  });
}

// ============================================================================
// External API Functions
// ============================================================================

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
    
    const vatRate = zoneConfig.vatRate !== undefined ? zoneConfig.vatRate : countryConfig.vatRate;
    const vatMultiplier = 1 + vatRate;
    
    const currentHour = now.getHours();
    const currentPrice = prices.find(p => {
      const priceHour = new Date(p.time_start).getHours();
      return priceHour === currentHour;
    });
    
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

async function fetchNetworkStats() {
  try {
    const statsUrl = 'https://api.blockchain.info/stats';
    const stats = await httpsGet(statsUrl);
    
    if (stats && stats.difficulty) {
      const hashrateEHs = stats.hash_rate / 1e9;
      
      networkStatsCache = {
        difficulty: stats.difficulty,
        hashrate: hashrateEHs,
        hashrateFormatted: `${hashrateEHs.toFixed(2)} EH/s`,
        blockHeight: stats.n_blocks_total,
        blockReward: 3.125,
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
 * @param {number} electricityPricePerKWh - The effective price (spot or spot+grid fee)
 */
function calculateEfficiency(hashrateTHs, powerWatts, electricityPricePerKWh, btcPrice, currency = 'NOK') {
  const networkHashrateEHs = networkStatsCache.hashrate || 700;
  const blockReward = networkStatsCache.blockReward || 3.125;
  const blocksPerDay = networkStatsCache.blocksPerDay || 144;
  
  const hashrateEHs = hashrateTHs / 1000000;
  const dailyBTCEstimate = (hashrateEHs / networkHashrateEHs) * blockReward * blocksPerDay;
  
  const powerKW = powerWatts / 1000;
  const dailyKWh = powerKW * 24;
  const dailyElectricityCost = dailyKWh * electricityPricePerKWh;
  
  const dailyEarnings = dailyBTCEstimate * btcPrice;
  const dailyProfit = dailyEarnings - dailyElectricityCost;
  
  const efficiency = hashrateTHs / powerKW;
  const costPerTH = dailyElectricityCost / hashrateTHs;
  const hashprice = dailyEarnings / hashrateTHs;
  
  const heatOutputKWh = dailyKWh;
  const equivalentHeatPumpCost = dailyKWh / 3.5 * electricityPricePerKWh;
  const heatingSavings = equivalentHeatPumpCost - dailyElectricityCost + dailyEarnings;
  
  const effectiveMultiplier = dailyEarnings / dailyElectricityCost;
  const effectiveSCOP = 1 / (1 - Math.min(effectiveMultiplier, 0.99));
  
  return {
    powerKW,
    dailyKWh,
    dailyBTCEstimate,
    dailyEarnings,
    hourlyEarnings: dailyEarnings / 24,
    dailyElectricityCost,
    hourlyElectricityCost: dailyElectricityCost / 24,
    dailyProfit,
    hourlyProfit: dailyProfit / 24,
    isProfitable: dailyProfit > 0,
    efficiency,
    costPerTH,
    hashprice,
    networkHashrate: networkHashrateEHs,
    networkDifficulty: networkStatsCache.difficulty,
    heatOutputKWh,
    equivalentHeatPumpCost,
    heatingSavings,
    effectiveSCOP: Math.min(effectiveSCOP, 10),
    breakevenBTCPrice: dailyElectricityCost / dailyBTCEstimate,
    currentBTCPrice: btcPrice,
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
        console.log(`Response from ${ip}:`, cleaned.substring(0, 500) + '...');
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
 * Extract temperature from various possible field names in Braiins OS stats
 * Checks multiple data sources: stats, devs, and all stats combined
 */
function extractTemperatures(statsData, devsData = {}, allStatsData = {}) {
  // Merge all data sources for searching
  const combinedData = { ...allStatsData, ...statsData, ...devsData };
  
  // Debug: Log all keys to help identify the correct field names
  console.log('Combined data keys for temp search:', Object.keys(combinedData).join(', '));
  
  const temps = {
    board1: null,
    board2: null,
    board3: null,
    chip: null
  };
  
  // List all numeric fields for debugging
  const numericFields = {};
  for (const [key, value] of Object.entries(combinedData)) {
    if (typeof value === 'number') {
      numericFields[key] = value;
    }
  }
  console.log('All numeric fields:', JSON.stringify(numericFields, null, 2));
  
  // Common Braiins OS field patterns for S19 series
  // Pattern 1: temp_chip_X, temp_pcb_X
  if (combinedData.temp_chip_1 !== undefined) {
    temps.board1 = combinedData.temp_pcb_1 || combinedData.temp_chip_1;
    temps.board2 = combinedData.temp_pcb_2 || combinedData.temp_chip_2;
    temps.board3 = combinedData.temp_pcb_3 || combinedData.temp_chip_3;
    temps.chip = Math.max(
      combinedData.temp_chip_1 || 0,
      combinedData.temp_chip_2 || 0,
      combinedData.temp_chip_3 || 0
    );
    console.log('Found temps using pattern: temp_chip_X');
  }
  // Pattern 2: temp1, temp2, temp3 (older format)
  else if (combinedData.temp1 !== undefined) {
    temps.board1 = combinedData.temp1;
    temps.board2 = combinedData.temp2;
    temps.board3 = combinedData.temp3;
    temps.chip = combinedData.temp || Math.max(temps.board1 || 0, temps.board2 || 0, temps.board3 || 0);
    console.log('Found temps using pattern: temp1/temp2/temp3');
  }
  // Pattern 3: temp2_1, temp2_2, temp2_3 (some Antminer models)
  else if (combinedData.temp2_1 !== undefined) {
    temps.board1 = combinedData.temp2_1;
    temps.board2 = combinedData.temp2_2;
    temps.board3 = combinedData.temp2_3;
    temps.chip = Math.max(temps.board1 || 0, temps.board2 || 0, temps.board3 || 0);
    console.log('Found temps using pattern: temp2_X');
  }
  // Pattern 4: Temperature field from devs
  else if (combinedData.Temperature !== undefined) {
    temps.chip = combinedData.Temperature;
    console.log('Found temps using pattern: Temperature (devs)');
  }
  // Pattern 5: Check for chain_ prefixed fields
  else if (Object.keys(combinedData).some(k => k.startsWith('chain_'))) {
    for (let i = 1; i <= 3; i++) {
      const tempKey = `chain_temp${i}` || `chain${i}_temp`;
      if (combinedData[tempKey] !== undefined) {
        temps[`board${i}`] = combinedData[tempKey];
      }
    }
    console.log('Found temps using pattern: chain_tempX');
  }
  
  // Pattern 6: Search for any field containing 'temp' (fallback)
  if (temps.chip === null) {
    const tempFields = [];
    for (const [key, value] of Object.entries(combinedData)) {
      if (typeof value === 'number' && key.toLowerCase().includes('temp') && value > 0 && value < 150) {
        tempFields.push({ key, value });
        console.log(`Found potential temperature field: ${key} = ${value}`);
        
        if (key.toLowerCase().includes('chip')) {
          temps.chip = value;
        } else if (key.includes('1') && temps.board1 === null) {
          temps.board1 = value;
        } else if (key.includes('2') && temps.board2 === null) {
          temps.board2 = value;
        } else if (key.includes('3') && temps.board3 === null) {
          temps.board3 = value;
        }
      }
    }
    if (tempFields.length > 0) {
      console.log('Found temps using pattern: search for *temp*');
    }
  }
  
  // Pattern 7: Look for fields that might be temperatures by value range (20-100°C typical)
  if (temps.chip === null) {
    const potentialTemps = [];
    for (const [key, value] of Object.entries(combinedData)) {
      // Skip known non-temperature fields
      const skipKeys = ['elapsed', 'uptime', 'accepted', 'rejected', 'hw', 'diff', 'power', 'watt', 'freq', 'rate', 'speed', 'rpm', 'ghs', 'mhs', 'ths'];
      const keyLower = key.toLowerCase();
      if (typeof value === 'number' && value >= 20 && value <= 100 && 
          !skipKeys.some(skip => keyLower.includes(skip))) {
        potentialTemps.push({ key, value });
      }
    }
    if (potentialTemps.length > 0) {
      console.log('Potential temperature fields by value range:', potentialTemps);
    }
  }
  
  // If we still have no chip temp, use the max of board temps
  if (temps.chip === null && (temps.board1 || temps.board2 || temps.board3)) {
    temps.chip = Math.max(temps.board1 || 0, temps.board2 || 0, temps.board3 || 0);
  }
  
  console.log('Final extracted temperatures:', temps);
  return temps;
}

/**
 * Extract fan speeds from stats data
 */
function extractFanSpeeds(statsData, devsData = {}, allStatsData = {}) {
  const combinedData = { ...allStatsData, ...statsData, ...devsData };
  
  const fans = {
    speed1: null,
    speed2: null,
    speed3: null,
    speed4: null
  };
  
  // Common patterns
  if (combinedData.fan1 !== undefined) {
    fans.speed1 = combinedData.fan1;
    fans.speed2 = combinedData.fan2;
    fans.speed3 = combinedData.fan3;
    fans.speed4 = combinedData.fan4;
    console.log('Found fans using pattern: fan1/fan2/fan3/fan4');
  } else if (combinedData.fan_speed_in !== undefined) {
    fans.speed1 = combinedData.fan_speed_in;
    fans.speed2 = combinedData.fan_speed_out;
    console.log('Found fans using pattern: fan_speed_in/out');
  } else if (combinedData.Fan1 !== undefined) {
    fans.speed1 = combinedData.Fan1;
    fans.speed2 = combinedData.Fan2;
    fans.speed3 = combinedData.Fan3;
    fans.speed4 = combinedData.Fan4;
    console.log('Found fans using pattern: Fan1/Fan2/Fan3/Fan4');
  } else if (combinedData['Fan Speed In'] !== undefined) {
    fans.speed1 = combinedData['Fan Speed In'];
    fans.speed2 = combinedData['Fan Speed Out'];
    console.log('Found fans using pattern: Fan Speed In/Out');
  }
  
  // Search for fan fields if not found
  if (fans.speed1 === null) {
    for (const [key, value] of Object.entries(combinedData)) {
      if (typeof value === 'number' && key.toLowerCase().includes('fan') && value > 0) {
        console.log(`Found potential fan field: ${key} = ${value}`);
        if (fans.speed1 === null && (key.includes('1') || key.toLowerCase().includes('in'))) {
          fans.speed1 = value;
        } else if (fans.speed2 === null && (key.includes('2') || key.toLowerCase().includes('out'))) {
          fans.speed2 = value;
        } else if (fans.speed3 === null && key.includes('3')) {
          fans.speed3 = value;
        } else if (fans.speed4 === null && key.includes('4')) {
          fans.speed4 = value;
        }
      }
    }
  }
  
  // Look for RPM values that might be fans (typically 1000-10000 range)
  if (fans.speed1 === null) {
    const potentialFans = [];
    for (const [key, value] of Object.entries(combinedData)) {
      if (typeof value === 'number' && value >= 500 && value <= 10000 && 
          (key.toLowerCase().includes('rpm') || key.toLowerCase().includes('speed'))) {
        potentialFans.push({ key, value });
      }
    }
    if (potentialFans.length > 0) {
      console.log('Potential fan fields by value range:', potentialFans);
    }
  }
  
  console.log('Final extracted fan speeds:', fans);
  return fans;
}

async function getMinerStats(ip, config = {}) {
  try {
    console.log(`Getting stats from miner at ${ip}`);
    
    // Try to get data from Braiins OS GraphQL API (has temperature/fan data)
    let graphqlData = null;
    let httpApiData = null;
    
    try {
      graphqlData = await fetchBraiinsGraphQL(ip);
    } catch (e) {
      console.log('GraphQL not available:', e.message);
    }
    
    // Try HTTP API as fallback
    if (!graphqlData) {
      try {
        httpApiData = await fetchBraiinsHTTPApi(ip);
      } catch (e) {
        console.log('HTTP API not available:', e.message);
      }
    }
    
    // Try to get devs data too - sometimes has temperature info
    let devs = null;
    try {
      devs = await sendCGMinerCommand(ip, { command: 'devs' });
    } catch (e) {
      console.log('devs command not available:', e.message);
    }
    
    const [summary, stats, pools] = await Promise.all([
      sendCGMinerCommand(ip, { command: 'summary' }),
      sendCGMinerCommand(ip, { command: 'stats' }),
      sendCGMinerCommand(ip, { command: 'pools' })
    ]);

    const summaryData = summary.SUMMARY?.[0] || {};
    
    // Log ALL stats entries for debugging
    console.log('=== RAW STATS RESPONSE ===');
    console.log('Number of STATS entries:', stats.STATS?.length || 0);
    if (stats.STATS) {
      stats.STATS.forEach((s, idx) => {
        console.log(`\n--- STATS[${idx}] keys:`, Object.keys(s || {}).join(', '));
        // Log all numeric values to help identify temp/fan fields
        if (s && typeof s === 'object') {
          const numericFields = Object.entries(s)
            .filter(([k, v]) => typeof v === 'number')
            .map(([k, v]) => `${k}=${v}`);
          console.log(`  Numeric fields:`, numericFields.join(', '));
        }
      });
    }
    
    // Also log devs response if available
    if (devs?.DEVS) {
      console.log('\n=== RAW DEVS RESPONSE ===');
      devs.DEVS.forEach((d, idx) => {
        console.log(`--- DEVS[${idx}]:`, JSON.stringify(d).substring(0, 500));
      });
    }
    
    // Collect ALL stats data from all STATS entries
    let allStatsData = {};
    let statsData = {};
    if (stats.STATS) {
      // Merge all stats entries to find temperature data
      for (const s of stats.STATS) {
        if (s && typeof s === 'object') {
          // Add all keys to allStatsData for debugging
          Object.assign(allStatsData, s);
          
          const hasTemp = Object.keys(s).some(k => k.toLowerCase().includes('temp'));
          const hasFan = Object.keys(s).some(k => k.toLowerCase().includes('fan'));
          const hasChain = Object.keys(s).some(k => k.toLowerCase().includes('chain'));
          const hasBoard = Object.keys(s).some(k => k.toLowerCase().includes('board'));
          
          if (hasTemp || hasFan || hasChain || hasBoard) {
            // Merge this entry into statsData
            Object.assign(statsData, s);
          }
        }
      }
      // If still empty, use the largest STATS entry (most keys)
      if (Object.keys(statsData).length === 0) {
        statsData = stats.STATS.reduce((best, current) => {
          if (!current || typeof current !== 'object') return best;
          return Object.keys(current).length > Object.keys(best).length ? current : best;
        }, {});
      }
    }
    
    // Also check devs for temperature data
    let devsData = {};
    if (devs?.DEVS) {
      for (const d of devs.DEVS) {
        if (d && typeof d === 'object') {
          Object.assign(devsData, d);
        }
      }
    }
    
    // Log what we're working with
    console.log('\n=== MERGED STATS DATA ===');
    console.log('Keys:', Object.keys(statsData).join(', '));
    console.log('Full data:', JSON.stringify(statsData, null, 2).substring(0, 3000));
    
    if (Object.keys(devsData).length > 0) {
      console.log('\n=== MERGED DEVS DATA ===');
      console.log('Keys:', Object.keys(devsData).join(', '));
    }
    
    const poolData = pools.POOLS?.[0] || {};

    // Calculate hashrate in TH/s
    const ghs5s = summaryData['GHS 5s'] || (summaryData['MHS 5s'] ? summaryData['MHS 5s'] / 1000 : 0);
    const hashrate = ghs5s / 1000;

    // Extract temperatures - prefer GraphQL data, fall back to CGMiner
    let temps = { board1: null, board2: null, board3: null, chip: null };
    let fans = { speed1: null, speed2: null, speed3: null, speed4: null };
    
    // Try GraphQL data first (most reliable for Braiins OS)
    if (graphqlData?.data) {
      console.log('=== PROCESSING GRAPHQL DATA ===');
      console.log('Raw GraphQL data:', JSON.stringify(graphqlData.data, null, 2));
      
      // Handle bosminer.info.fans and bosminer.info.tempCtrl format (BOSer)
      if (graphqlData.data.bosminer?.info) {
        const info = graphqlData.data.bosminer.info;
        console.log('Found bosminer.info format');
        
        // Extract fans
        if (info.fans && Array.isArray(info.fans)) {
          console.log('Found fans array:', info.fans);
          info.fans.forEach((fan, idx) => {
            if (fan.rpm !== undefined) {
              fans[`speed${idx + 1}`] = fan.rpm;
            } else if (fan.speed !== undefined) {
              fans[`speed${idx + 1}`] = fan.speed;
            }
          });
        }
        
        // Extract temperature from tempCtrl
        if (info.tempCtrl) {
          console.log('Found tempCtrl:', info.tempCtrl);
          if (info.tempCtrl.target !== undefined) {
            temps.chip = info.tempCtrl.target;
          }
          if (info.tempCtrl.hot !== undefined) {
            // hot might be max temp threshold, use as reference
            console.log('Hot threshold:', info.tempCtrl.hot);
          }
        }
        
        // Try to get workSolver data
        if (info.workSolver) {
          console.log('Found workSolver:', JSON.stringify(info.workSolver).substring(0, 500));
        }
      }
      
      // Handle multiple possible GraphQL response formats
      
      // Format 1: bosminer.hashChains with temperature objects
      if (graphqlData.data.bosminer?.hashChains) {
        console.log('Found bosminer.hashChains format');
        const chains = graphqlData.data.bosminer.hashChains;
        chains.forEach((chain, idx) => {
          if (chain.temperature) {
            if (chain.temperature.board !== undefined) {
              temps[`board${idx + 1}`] = chain.temperature.board;
            }
            if (chain.temperature.chip !== undefined) {
              if (temps.chip === null || chain.temperature.chip > temps.chip) {
                temps.chip = chain.temperature.chip;
              }
            }
          }
          if (typeof chain.temperature === 'number') {
            temps[`board${idx + 1}`] = chain.temperature;
          }
          if (chain.fanRpm !== undefined) {
            fans[`speed${idx + 1}`] = chain.fanRpm;
          }
        });
        // Also check for fans array in bosminer
        if (graphqlData.data.bosminer.fans) {
          graphqlData.data.bosminer.fans.forEach((f, idx) => {
            if (f.rpm !== undefined) {
              fans[`speed${idx + 1}`] = f.rpm;
            }
          });
        }
      }
      
      // Format 2: Direct temperatures/fans arrays
      if (graphqlData.data.temperatures && Array.isArray(graphqlData.data.temperatures)) {
        console.log('Found temperatures array format');
        graphqlData.data.temperatures.forEach((t, idx) => {
          if (t.celsius !== undefined && t.celsius !== null) {
            const name = (t.name || '').toLowerCase();
            if (name.includes('board') || name.includes('pcb') || name.includes('hashboard')) {
              const boardNum = name.match(/\d+/)?.[0] || (idx + 1);
              temps[`board${boardNum}`] = t.celsius;
            } else if (name.includes('chip')) {
              temps.chip = t.celsius;
            } else {
              if (idx < 3) temps[`board${idx + 1}`] = t.celsius;
            }
          }
        });
      }
      
      if (graphqlData.data.fans && Array.isArray(graphqlData.data.fans)) {
        console.log('Found fans array format');
        graphqlData.data.fans.forEach((f, idx) => {
          if (f.rpm !== undefined && f.rpm !== null) {
            fans[`speed${idx + 1}`] = f.rpm;
          }
        });
      }
      
      // Format 3: miner.hashboards
      if (graphqlData.data.miner?.hashboards) {
        console.log('Found miner.hashboards format');
        graphqlData.data.miner.hashboards.forEach((board, idx) => {
          if (board.temperature !== undefined) {
            temps[`board${idx + 1}`] = board.temperature;
          }
          if (board.chipTemperature !== undefined) {
            if (temps.chip === null || board.chipTemperature > temps.chip) {
              temps.chip = board.chipTemperature;
            }
          }
        });
        if (graphqlData.data.miner.fans) {
          graphqlData.data.miner.fans.forEach((f, idx) => {
            if (f.rpm !== undefined) {
              fans[`speed${idx + 1}`] = f.rpm;
            }
          });
        }
      }
      
      // Format 4: Tuner chain state
      if (graphqlData.data.bosminer?.info?.workSolver?.tuner?.chainTunerState) {
        console.log('Found tuner chainTunerState format');
        const states = graphqlData.data.bosminer.info.workSolver.tuner.chainTunerState;
        if (Array.isArray(states)) {
          states.forEach((state, idx) => {
            if (state.temperature !== undefined) {
              temps[`board${idx + 1}`] = state.temperature;
            }
          });
        }
      }
      
      // Format 5: bosminer.hashboards with stats
      if (graphqlData.data.bosminer?.hashboards) {
        console.log('Found bosminer.hashboards format');
        graphqlData.data.bosminer.hashboards.forEach((board, idx) => {
          if (board.stats?.temp !== undefined) {
            temps[`board${idx + 1}`] = board.stats.temp;
          }
        });
      }
      
      // Set chip temp to max board temp if not explicitly provided
      if (temps.chip === null) {
        const boardTemps = [temps.board1, temps.board2, temps.board3].filter(t => t !== null);
        if (boardTemps.length > 0) {
          temps.chip = Math.max(...boardTemps);
        }
      }
      
      console.log('Extracted from GraphQL - temps:', temps, 'fans:', fans);
    }
    
    // Try HTTP API data if GraphQL didn't work
    if (httpApiData && temps.chip === null) {
      console.log('=== TRYING HTTP API DATA ===');
      console.log('HTTP API data:', JSON.stringify(httpApiData, null, 2).substring(0, 1000));
      
      // Try to extract from various HTTP API response formats
      if (httpApiData.temp) {
        temps.chip = httpApiData.temp;
      }
      if (httpApiData.temp1) temps.board1 = httpApiData.temp1;
      if (httpApiData.temp2) temps.board2 = httpApiData.temp2;
      if (httpApiData.temp3) temps.board3 = httpApiData.temp3;
      if (httpApiData.fan1) fans.speed1 = httpApiData.fan1;
      if (httpApiData.fan2) fans.speed2 = httpApiData.fan2;
    }
    
    // Fall back to CGMiner stats/devs data if GraphQL/HTTP API didn't provide temps
    if (temps.chip === null || temps.chip === 0) {
      console.log('=== FALLING BACK TO CGMINER DATA ===');
      temps = extractTemperatures(statsData, devsData, allStatsData);
      fans = extractFanSpeeds(statsData, devsData, allStatsData);
    }
    
    console.log('Final temperatures:', temps);
    console.log('Final fans:', fans);

    // Get power from stats or estimate
    const power = statsData.Power || statsData.power || statsData.power_limit || 
                  summaryData.Power || Math.round(hashrate * 34) || 3250;

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

    // Calculate effective electricity price based on pricing mode
    const spotPrice = electricityPriceCache.currentPrice || 1.0;
    const gridFee = config.gridFeePerKwh || 0.50;
    const useNorgespris = config.priceMode === 'norgespris';
    const effectivePrice = useNorgespris ? spotPrice + gridFee : spotPrice;

    // Calculate efficiency metrics with effective price
    const efficiency = calculateEfficiency(hashrate, power, effectivePrice, btcPrice, currency);

    return {
      // Basic stats
      hashrate,
      temperature: temps.chip,
      powerDraw: power,
      uptime: summaryData.Elapsed || 0,
      boards: [
        { temp: temps.board1 },
        { temp: temps.board2 },
        { temp: temps.board3 }
      ],
      fans: {
        speed1: fans.speed1,
        speed2: fans.speed2,
        speed3: fans.speed3,
        speed4: fans.speed4
      },
      poolStatus: poolData.Status === 'Alive' ? 'Connected' : 'Disconnected',
      poolUrl: poolData.URL || 'Not connected',
      acceptedShares: accepted,
      rejectedShares: rejected,
      rejectRate,
      powerProfile,
      
      // Electricity data with both prices
      electricity: {
        spotPrice: spotPrice,
        gridFee: gridFee,
        effectivePrice: effectivePrice,
        priceMode: useNorgespris ? 'norgespris' : 'spotpris',
        currentPrice: effectivePrice, // For backward compatibility
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
      efficiency,
      
      // Debug info (remove in production)
      _debug: {
        graphqlAvailable: graphqlData?.data ? true : false,
        graphqlRootFields: graphqlData?._availableFields || [],
        graphqlBosminerFields: graphqlData?._bosminerFields || [],
        graphqlBosFields: graphqlData?._bosFields || [],
        graphqlTemps: graphqlData?.data?.temperatures || graphqlData?.data?.bosminer?.hashChains || [],
        graphqlFans: graphqlData?.data?.fans || graphqlData?.data?.bosminer?.fans || [],
        graphqlRawData: graphqlData?.data ? JSON.stringify(graphqlData.data).substring(0, 500) : null,
        httpApiAvailable: httpApiData ? true : false,
        statsEntryCount: stats.STATS?.length || 0,
        allNumericFields: Object.entries(allStatsData)
          .filter(([k, v]) => typeof v === 'number')
          .map(([k, v]) => `${k}=${v}`)
          .slice(0, 30), // Limit to first 30
        devsNumericFields: Object.entries(devsData)
          .filter(([k, v]) => typeof v === 'number')
          .map(([k, v]) => `${k}=${v}`)
          .slice(0, 20),
        tempFields: Object.entries({ ...allStatsData, ...devsData })
          .filter(([k, v]) => typeof v === 'number' && k.toLowerCase().includes('temp'))
          .map(([k, v]) => `${k}=${v}`),
        fanFields: Object.entries({ ...allStatsData, ...devsData })
          .filter(([k, v]) => typeof v === 'number' && k.toLowerCase().includes('fan'))
          .map(([k, v]) => `${k}=${v}`)
      }
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
        gridFeePerKwh: 0.50,
        priceMode: 'norgespris' // 'spotpris' or 'norgespris'
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
    const maxEntries = 720;
    
    history.entries.push({
      timestamp: new Date().toISOString(),
      hashrate: stats.hashrate,
      power: stats.powerDraw,
      temperature: stats.temperature,
      electricityPrice: stats.electricity?.effectivePrice,
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
      priceMode: req.body.priceMode || existingConfig.priceMode || 'norgespris',
      updatedAt: new Date().toISOString()
    };

    await saveConfig(config);
    
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
    const stats = await sendCGMinerCommand(ip, { command: 'stats' });
    
    // Log available fields for debugging
    const statsData = stats.STATS?.[1] || stats.STATS?.[0] || {};
    console.log('Available stats fields:', Object.keys(statsData));
    
    res.json({ 
      success: true, 
      message: `Successfully connected to miner at ${ip}`,
      summary: summary.SUMMARY?.[0] || {},
      availableFields: Object.keys(statsData)
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
  
  const config = await loadConfig();
  
  console.log('Fetching initial data...');
  await Promise.all([
    fetchElectricityPrices(config.country || 'norway', config.electricityZone || 'NO5'),
    fetchBTCPrice(),
    fetchNetworkStats()
  ]);
  
  setInterval(() => fetchElectricityPrices(
    electricityPriceCache.country || 'norway', 
    electricityPriceCache.zone || 'NO5'
  ), 30 * 60 * 1000);
  setInterval(fetchBTCPrice, 5 * 60 * 1000);
  setInterval(fetchNetworkStats, 10 * 60 * 1000);
  
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log(`Jack's Mining Dashboard v2.2`);
    console.log('='.repeat(60));
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`💾 Data directory: ${DATA_DIR}`);
    console.log(`⚡ Electricity zone: ${electricityPriceCache.zone} (${electricityPriceCache.zoneName || 'Loading...'})`);
    console.log(`💰 BTC Price: ${btcPriceCache.priceNOK?.toLocaleString() || 'Loading...'} NOK`);
    console.log(`🔌 Current spot price: ${electricityPriceCache.currentPrice?.toFixed(2) || 'Loading...'} NOK/kWh`);
    console.log(`⛏️  Network hashrate: ${networkStatsCache.hashrateFormatted || 'Loading...'}`);
    console.log('='.repeat(60));
  });

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