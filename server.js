const express = require('express');
const WebSocket = require('ws');
const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

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

// Miner stats cache - populated by background polling
let minerStatsCache = {
  miners: [],
  alerts: [],
  fetchedAt: null,
  isPolling: false
};

// Alert tracking
let alertHistory = [];
let lastAlertTimes = {}; // Track when each alert type last fired for cooldown

// Miner control state tracking
// Enhanced state tracking for active SCOP auto-control
let minerControlState = {};
// Structure: {
//   ip: {
//     isPaused: bool,              // Current actual state (from miner)
//     intendedState: 'mining'|'paused'|null,  // What auto-control wants
//     stateReason: string,         // Why auto-control set this state
//     lastControlAction: Date,     // When we last issued a control command
//     lastSCOPCheck: Date,         // When we last evaluated SCOP
//     authToken: string,
//     tokenExpiry: Date,
//     controlAttempts: number,     // Consecutive failed sync attempts
//     lastSyncError: string,       // Last error when trying to sync state
//     // Efficiency tracking for projected SCOP when paused
//     measuredEfficiency: number,  // Last measured J/TH when mining
//     measuredPower: number,       // Last measured power in watts when mining
//     measuredHashrate: number,    // Last measured hashrate in TH/s when mining
//     lastEfficiencyUpdate: Date,  // When efficiency was last measured
//     // Auto mining control state
//     autoMiningControlState: {
//       lastCheck: Date,
//       lastAdjustment: Date,
//       lastAdjustmentType: string,
//       currentTargetPower: number,
//       adjustmentReason: string,
//       readings: object,
//       violations: object
//     }
//   }
// }

// Auto mining control logs buffer (in-memory, per miner)
let autoControlLogs = {}; // { [ip]: LogEntry[] }
const MAX_AUTO_CONTROL_LOGS = 100;

// ============================================================================
// Braiins OS gRPC API Functions (for miner pause/resume control)
// ============================================================================

// Load proto files for Braiins OS gRPC API
const PROTO_PATH_AUTH = path.join(__dirname, 'proto', 'bos', 'v1', 'authentication.proto');
const PROTO_PATH_ACTIONS = path.join(__dirname, 'proto', 'bos', 'v1', 'actions.proto');

const protoOptions = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
};

// Load proto definitions
let authProto = null;
let actionsProto = null;

function loadProtos() {
  try {
    console.log('Loading Braiins OS proto files from:', PROTO_PATH_AUTH);
    const authPackageDef = protoLoader.loadSync(PROTO_PATH_AUTH, protoOptions);
    const authDef = grpc.loadPackageDefinition(authPackageDef);
    authProto = authDef.braiins?.bos?.v1;

    if (!authProto || !authProto.AuthenticationService) {
      console.error('Failed to load AuthenticationService from proto. Package structure:', JSON.stringify(Object.keys(authDef), null, 2));
      return;
    }

    console.log('Loading Braiins OS proto files from:', PROTO_PATH_ACTIONS);
    const actionsPackageDef = protoLoader.loadSync(PROTO_PATH_ACTIONS, protoOptions);
    const actionsDef = grpc.loadPackageDefinition(actionsPackageDef);
    actionsProto = actionsDef.braiins?.bos?.v1;

    if (!actionsProto || !actionsProto.ActionsService) {
      console.error('Failed to load ActionsService from proto. Package structure:', JSON.stringify(Object.keys(actionsDef), null, 2));
      return;
    }

    console.log('Braiins OS gRPC proto files loaded successfully');
    console.log('Available auth services:', Object.keys(authProto));
    console.log('Available action services:', Object.keys(actionsProto));
  } catch (err) {
    console.error('Failed to load Braiins OS proto files:', err.message);
    console.error(err.stack);
  }
}

// Initialize protos on startup
loadProtos();

// Cache for gRPC clients to reuse connections
const grpcClientCache = {};

/**
 * Get or create a gRPC client for a miner
 * @param {string} ip - Miner IP address
 * @param {string} serviceName - 'auth' or 'actions'
 * @returns {object} gRPC client
 */
function getGrpcClient(ip, serviceName) {
  const cacheKey = `${ip}:${serviceName}`;

  if (grpcClientCache[cacheKey]) {
    return grpcClientCache[cacheKey];
  }

  const address = `${ip}:50051`;

  if (serviceName === 'auth') {
    if (!authProto || !authProto.AuthenticationService) {
      throw new Error('gRPC AuthenticationService not loaded. Check proto files and server startup logs.');
    }
    grpcClientCache[cacheKey] = new authProto.AuthenticationService(
      address,
      grpc.credentials.createInsecure()
    );
  } else if (serviceName === 'actions') {
    if (!actionsProto || !actionsProto.ActionsService) {
      throw new Error('gRPC ActionsService not loaded. Check proto files and server startup logs.');
    }
    grpcClientCache[cacheKey] = new actionsProto.ActionsService(
      address,
      grpc.credentials.createInsecure()
    );
  }

  return grpcClientCache[cacheKey];
}

/**
 * Login to Braiins OS gRPC API and get auth token
 * @param {string} ip - Miner IP address
 * @param {string} username - Braiins OS username (default: 'root')
 * @param {string} password - Braiins OS password (default: 'root')
 * @returns {Promise<{token: string, timeout_s: number}>}
 */
async function braiinsLogin(ip, username = 'root', password = 'root') {
  return new Promise((resolve, reject) => {
    const client = getGrpcClient(ip, 'auth');

    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 10);

    client.Login({ username, password }, { deadline }, (err, response) => {
      if (err) {
        reject(new Error(`gRPC Login failed: ${err.message}`));
      } else {
        resolve({
          token: response.token,
          timeout_s: parseInt(response.timeout_s) || 3600
        });
      }
    });
  });
}

/**
 * Get or refresh auth token for a miner
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Miner config with optional username/password
 * @returns {Promise<string>} Auth token
 */
async function getMinerAuthToken(ip, minerConfig = {}) {
  const state = minerControlState[ip] || {};

  // Check if we have a valid cached token (with 60s buffer before expiry)
  if (state.authToken && state.tokenExpiry && new Date() < new Date(state.tokenExpiry.getTime() - 60000)) {
    return state.authToken;
  }

  // Login and cache token
  const username = minerConfig.username || 'root';
  const password = minerConfig.password || 'root';

  console.log(`Logging into Braiins OS gRPC at ${ip}:50051...`);
  const loginResult = await braiinsLogin(ip, username, password);

  minerControlState[ip] = {
    ...state,
    authToken: loginResult.token,
    tokenExpiry: new Date(Date.now() + (loginResult.timeout_s || 3600) * 1000)
  };

  console.log(`Braiins OS gRPC login successful for ${ip}, token expires in ${loginResult.timeout_s}s`);
  return loginResult.token;
}

/**
 * Create gRPC metadata with auth token
 * @param {string} token - Auth token
 * @returns {grpc.Metadata}
 */
function createAuthMetadata(token) {
  const metadata = new grpc.Metadata();
  metadata.add('authorization', token);
  return metadata;
}

/**
 * Invalidate cached auth token for a miner (forces re-login on next request)
 * @param {string} ip - Miner IP address
 */
function invalidateAuthToken(ip) {
  if (minerControlState[ip]) {
    delete minerControlState[ip].authToken;
    delete minerControlState[ip].tokenExpiry;
    console.log(`Invalidated auth token for ${ip}`);
  }
  // Also clear the gRPC client cache for this IP to force fresh connections
  const authKey = `${ip}:auth`;
  const actionsKey = `${ip}:actions`;
  if (grpcClientCache[authKey]) {
    delete grpcClientCache[authKey];
  }
  if (grpcClientCache[actionsKey]) {
    delete grpcClientCache[actionsKey];
  }
}

/**
 * Check if error is an authentication error that should trigger re-auth
 * @param {Error} err - The error to check
 * @returns {boolean}
 */
function isAuthError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('UNAUTHENTICATED') ||
         msg.includes('authentication') ||
         msg.includes('token') ||
         (err.code === 16); // gRPC UNAUTHENTICATED status code
}

/**
 * Pause mining on a Braiins OS miner via gRPC
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Optional miner config
 * @param {boolean} isRetry - Whether this is a retry after re-authentication
 * @returns {Promise<{success: boolean, wasAlreadyPaused: boolean}>}
 */
async function pauseMining(ip, minerConfig = {}, isRetry = false) {
  const token = await getMinerAuthToken(ip, minerConfig);
  const metadata = createAuthMetadata(token);

  return new Promise((resolve, reject) => {
    const client = getGrpcClient(ip, 'actions');

    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 10);

    client.PauseMining({}, metadata, { deadline }, async (err, response) => {
      if (err) {
        // If auth error and not already retrying, invalidate token and retry once
        if (isAuthError(err) && !isRetry) {
          console.log(`Auth error on PauseMining for ${ip}, invalidating token and retrying...`);
          invalidateAuthToken(ip);
          try {
            const result = await pauseMining(ip, minerConfig, true);
            resolve(result);
          } catch (retryErr) {
            reject(retryErr);
          }
        } else {
          reject(new Error(`gRPC PauseMining failed: ${err.code} ${err.message}`));
        }
      } else {
        const wasAlreadyPaused = response.already_paused || false;
        minerControlState[ip] = { ...minerControlState[ip], isPaused: true };
        console.log(`Mining paused on ${ip} via gRPC (was already paused: ${wasAlreadyPaused})`);
        resolve({ success: true, wasAlreadyPaused });
      }
    });
  });
}

/**
 * Resume mining on a Braiins OS miner via gRPC
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Optional miner config
 * @param {boolean} isRetry - Whether this is a retry after re-authentication
 * @returns {Promise<{success: boolean, wasAlreadyMining: boolean}>}
 */
async function resumeMining(ip, minerConfig = {}, isRetry = false) {
  const token = await getMinerAuthToken(ip, minerConfig);
  const metadata = createAuthMetadata(token);

  return new Promise((resolve, reject) => {
    const client = getGrpcClient(ip, 'actions');

    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 10);

    client.ResumeMining({}, metadata, { deadline }, async (err, response) => {
      if (err) {
        // If auth error and not already retrying, invalidate token and retry once
        if (isAuthError(err) && !isRetry) {
          console.log(`Auth error on ResumeMining for ${ip}, invalidating token and retrying...`);
          invalidateAuthToken(ip);
          try {
            const result = await resumeMining(ip, minerConfig, true);
            resolve(result);
          } catch (retryErr) {
            reject(retryErr);
          }
        } else {
          reject(new Error(`gRPC ResumeMining failed: ${err.code} ${err.message}`));
        }
      } else {
        const wasAlreadyMining = response.already_mining || false;
        minerControlState[ip] = { ...minerControlState[ip], isPaused: false };
        console.log(`Mining resumed on ${ip} via gRPC (was already mining: ${wasAlreadyMining})`);
        resolve({ success: true, wasAlreadyMining });
      }
    });
  });
}

/**
 * Get current mining status from Braiins OS
 * @param {string} ip - Miner IP address
 * @returns {Promise<{isPaused: boolean, status: string}>}
 */
async function getMiningStatus(ip) {
  try {
    // Use the summary endpoint to check if miner is actively mining
    const summary = await sendCGMinerCommand(ip, { command: 'summary' });
    const hashrate = summary.SUMMARY?.[0]?.['MHS 5s'] || 0;

    // If hashrate is essentially zero, consider it paused
    const isPaused = hashrate < 1; // Less than 1 MH/s means paused

    minerControlState[ip] = { ...minerControlState[ip], isPaused };

    return { isPaused, status: isPaused ? 'paused' : 'mining', hashrate };
  } catch (err) {
    console.error(`Failed to get mining status for ${ip}:`, err.message);
    return { isPaused: null, status: 'unknown', error: err.message };
  }
}

/**
 * Calculate projected SCOP based on expected efficiency when miner would be running
 * @param {number} powerWatts - Expected power consumption
 * @param {number} hashrateTHs - Expected hashrate
 * @param {number} electricityPrice - Current electricity price per kWh
 * @param {number} btcPrice - Current BTC price
 * @returns {number} Projected SCOP
 */
function calculateProjectedSCOP(powerWatts, hashrateTHs, electricityPrice, btcPrice) {
  if (!powerWatts || !hashrateTHs || !electricityPrice || !btcPrice) return null;

  const networkHashrateEHs = networkStatsCache.hashrate || 700;
  const blockReward = networkStatsCache.blockReward || 3.125;
  const blocksPerDay = networkStatsCache.blocksPerDay || 144;

  const hashrateEHs = hashrateTHs / 1000000;
  const dailyBTCEstimate = (hashrateEHs / networkHashrateEHs) * blockReward * blocksPerDay;

  const powerKW = powerWatts / 1000;
  const dailyKWh = powerKW * 24;
  const dailyElectricityCost = dailyKWh * electricityPrice;
  const dailyEarnings = dailyBTCEstimate * btcPrice;

  const effectiveMultiplier = dailyEarnings / dailyElectricityCost;
  const effectiveSCOP = 1 / (1 - Math.min(effectiveMultiplier, 0.99));

  return Math.min(effectiveSCOP, 10);
}

/**
 * Determine what state the miner should be in based on SCOP and temperature
 * Always uses projected SCOP from manual override for decisions
 * @returns {{ intendedState: 'mining'|'paused', reason: string, scopUsed: number, scopType: string }}
 */
function determineIntendedState(projectedSCOP, boardTemp, threshold, minTemp) {
  // Priority 1: Temperature override - if board temp is below minimum, must mine for heat
  if (minTemp !== undefined && boardTemp !== undefined && boardTemp < minTemp) {
    return {
      intendedState: 'mining',
      reason: `Board temp ${boardTemp.toFixed(1)}°C < min ${minTemp}°C (heating needed)`,
      scopUsed: projectedSCOP,
      scopType: 'override'
    };
  }

  // Priority 2: SCOP-based decision
  // ALWAYS use projected SCOP (from manual override) for control decisions
  // The measured SCOP is only used for comparison/validation
  const scopToUse = projectedSCOP;
  const scopType = 'override';

  if (scopToUse === undefined || scopToUse === null) {
    return {
      intendedState: 'mining',
      reason: `Override SCOP not configured, defaulting to mining`,
      scopUsed: null,
      scopType: 'none'
    };
  }

  if (scopToUse >= threshold) {
    return {
      intendedState: 'mining',
      reason: `Override SCOP ${scopToUse.toFixed(2)} >= threshold ${threshold} (profitable)`,
      scopUsed: scopToUse,
      scopType
    };
  } else {
    return {
      intendedState: 'paused',
      reason: `Override SCOP ${scopToUse.toFixed(2)} < threshold ${threshold} (unprofitable)`,
      scopUsed: scopToUse,
      scopType
    };
  }
}

/**
 * Check SCOP thresholds and actively control miners
 * This function ensures the miner is in the correct state when auto-control is enabled
 * Called periodically during miner polling
 */
async function checkSCOPThresholds(minerIp, stats, minerConfig) {
  // Determine actual miner state from hashrate (more reliable than stored state)
  const hashrate = stats.hashrate || 0;
  const actuallyMining = hashrate > 0.1; // More than 0.1 TH/s means mining
  const actualState = actuallyMining ? 'mining' : 'paused';

  if (!minerConfig.autoControl?.enabled) {
    // For manual control, intended state matches actual state (user controls it)
    minerControlState[minerIp] = {
      ...minerControlState[minerIp],
      intendedState: actualState,
      stateReason: 'Manual control - state set by user'
    };
    return;
  }

  const scop = stats.efficiency?.effectiveSCOP;
  const currentPrice = stats.efficiency?.hourlyElectricityCost ?
    (stats.efficiency.hourlyElectricityCost / (stats.efficiency.dailyKWh / 24)) : null;

  // Use board temperature (not chip temp) for room temp estimation
  const boardTemps = stats.boards
    ?.map(b => b.temp)
    .filter(t => t !== null && t !== undefined && t > 0) || [];
  const boardTemp = boardTemps.length > 0
    ? boardTemps.reduce((a, b) => a + b, 0) / boardTemps.length
    : stats.temperature;

  const threshold = minerConfig.autoControl.scopThreshold || 2.0;
  const minTemp = minerConfig.autoControl.minTemperature;

  // Get efficiency override or use measured values
  const efficiencyOverride = minerConfig.autoControl.efficiencyOverride; // { power: watts, hashrate: TH/s }

  const state = minerControlState[minerIp] || {};
  const power = stats.power || 0;
  const isPaused = !actuallyMining;

  // If miner is actively mining, update measured efficiency tracking
  if (actuallyMining && hashrate > 0 && power > 0) {
    const currentEfficiency = power / hashrate; // W/TH
    const now = new Date();

    // Initialize efficiency tracking if not exists
    if (!state.efficiencyTracking) {
      state.efficiencyTracking = {
        samples: [],
        best1hPower: null,
        best1hHashrate: null,
        best1hEfficiency: null,
        best1hTimestamp: null
      };
    }

    // Add current sample (keep last 12 samples = 1 hour at 5s intervals)
    state.efficiencyTracking.samples.push({
      power,
      hashrate,
      efficiency: currentEfficiency,
      timestamp: now
    });

    // Keep only last 12 samples (1 minute at 5-second polling)
    // For 1h we'd need 720 samples, but let's keep a rolling window
    const maxSamples = 720; // 1 hour of data at 5-second intervals
    if (state.efficiencyTracking.samples.length > maxSamples) {
      state.efficiencyTracking.samples = state.efficiencyTracking.samples.slice(-maxSamples);
    }

    // Calculate average from all samples
    const avgPower = state.efficiencyTracking.samples.reduce((sum, s) => sum + s.power, 0) / state.efficiencyTracking.samples.length;
    const avgHashrate = state.efficiencyTracking.samples.reduce((sum, s) => sum + s.hashrate, 0) / state.efficiencyTracking.samples.length;
    const avgEfficiency = avgPower / avgHashrate;

    // Update best 1h efficiency if this is better (lower W/TH is better)
    if (state.efficiencyTracking.best1hEfficiency === null || avgEfficiency < state.efficiencyTracking.best1hEfficiency) {
      state.efficiencyTracking.best1hPower = avgPower;
      state.efficiencyTracking.best1hHashrate = avgHashrate;
      state.efficiencyTracking.best1hEfficiency = avgEfficiency;
      state.efficiencyTracking.best1hTimestamp = now;
    }

    minerControlState[minerIp] = {
      ...state,
      measuredPower: power,
      measuredHashrate: hashrate,
      measuredEfficiency: currentEfficiency,
      measuredAvgPower: avgPower,
      measuredAvgHashrate: avgHashrate,
      measuredAvgEfficiency: avgEfficiency,
      lastEfficiencyUpdate: now
    };
  }

  // Update actual state in our tracking
  minerControlState[minerIp] = {
    ...minerControlState[minerIp],
    isPaused,
    lastSCOPCheck: new Date()
  };

  // Calculate projected SCOP using ONLY the manual override
  // Measured efficiency is tracked separately for comparison only
  let projectedPower, projectedHashrate, projectedSource;

  if (efficiencyOverride?.power && efficiencyOverride?.hashrate) {
    projectedPower = efficiencyOverride.power;
    projectedHashrate = efficiencyOverride.hashrate;
    projectedSource = 'override';
  } else {
    // No override configured - auto-control cannot function
    projectedPower = null;
    projectedHashrate = null;
    projectedSource = 'none';
  }

  // Get current electricity price and BTC price for projection
  const btcPrice = stats.efficiency?.currentBTCPrice || networkStatsCache.btcPrice;
  const electricityPrice = currentPrice || 0.5; // fallback

  const projectedSCOP = projectedPower && projectedHashrate ?
    calculateProjectedSCOP(projectedPower, projectedHashrate, electricityPrice, btcPrice) : null;

  // Store projected values for frontend display
  minerControlState[minerIp].projectedSCOP = projectedSCOP;
  minerControlState[minerIp].projectedSource = projectedSource;
  minerControlState[minerIp].projectedPower = projectedPower;
  minerControlState[minerIp].projectedHashrate = projectedHashrate;

  // Determine what state the miner SHOULD be in
  const { intendedState, reason, scopUsed, scopType } = determineIntendedState(
    projectedSCOP, boardTemp, threshold, minTemp
  );

  // Always update the intended state and reason
  minerControlState[minerIp].intendedState = intendedState;
  minerControlState[minerIp].stateReason = reason;
  minerControlState[minerIp].scopUsed = scopUsed;
  minerControlState[minerIp].scopType = scopType;

  // Check if actual state matches intended state
  const stateMatches = actualState === intendedState;

  console.log(`[SCOP Auto-Control] ${minerIp}: measured SCOP=${scop?.toFixed(2) || 'N/A'}, projected SCOP=${projectedSCOP?.toFixed(2) || 'N/A'} (${projectedSource})`);
  console.log(`  → boardTemp=${boardTemp?.toFixed(1) || 'N/A'}°C, hashrate=${hashrate.toFixed(2)} TH/s, power=${power}W`);
  console.log(`  → Using ${scopType} SCOP: ${scopUsed?.toFixed(2) || 'N/A'}`);
  console.log(`  → Actual: ${actualState.toUpperCase()}, Intended: ${intendedState.toUpperCase()}, Match: ${stateMatches ? 'YES' : 'NO'}`);
  console.log(`  → Reason: ${reason}`);

  // If states don't match, take corrective action
  if (!stateMatches) {
    // Rate limit control actions to prevent rapid toggling (at least 30 seconds between actions)
    const lastAction = minerControlState[minerIp].lastControlAction;
    const timeSinceLastAction = lastAction ? Date.now() - new Date(lastAction).getTime() : Infinity;

    if (timeSinceLastAction < 30000) {
      console.log(`  → Waiting for control cooldown (${Math.ceil((30000 - timeSinceLastAction) / 1000)}s remaining)`);
      return;
    }

    try {
      if (intendedState === 'paused') {
        console.log(`  → ACTION: Pausing miner to match intended state`);
        await pauseMining(minerIp, minerConfig);
        minerControlState[minerIp].lastControlAction = new Date();
        minerControlState[minerIp].controlAttempts = 0;
        minerControlState[minerIp].lastSyncError = null;
      } else if (intendedState === 'mining') {
        console.log(`  → ACTION: Resuming miner to match intended state`);
        await resumeMining(minerIp, minerConfig);
        minerControlState[minerIp].lastControlAction = new Date();
        minerControlState[minerIp].controlAttempts = 0;
        minerControlState[minerIp].lastSyncError = null;
      }
    } catch (err) {
      console.error(`  → ERROR: Failed to sync miner state: ${err.message}`);
      minerControlState[minerIp].controlAttempts = (minerControlState[minerIp].controlAttempts || 0) + 1;
      minerControlState[minerIp].lastSyncError = err.message;
    }
  } else {
    // States match, clear any error state
    minerControlState[minerIp].controlAttempts = 0;
    minerControlState[minerIp].lastSyncError = null;
  }
}

// ============================================================================
// Auto Mining Control Functions (Comprehensive Hardware Monitoring)
// ============================================================================

/**
 * Get default threshold values for auto mining control
 */
function getDefaultAutoMiningThresholds() {
  return {
    maxChipTemp: 95,       // Pause if exceeded (critical)
    maxBoardTemp: 75,      // Power down if exceeded
    minBoardTemp: 20,      // Override SCOP for heating
    maxFanSpeed: 6000,     // Power down if exceeded
    maxPower: 3500,        // Max watts
    minPower: 1500,        // Min watts floor
    minHashrate: 100,      // Alert if below (TH/s)
    minActiveBoards: 3     // Alert if below
  };
}

/**
 * Get default behavior values for auto mining control
 */
function getDefaultAutoMiningBehavior() {
  return {
    powerStepDown: 250,        // Watts to reduce per adjustment
    powerStepUp: 100,          // Watts to increase per adjustment
    cooldownSeconds: 60,       // Minimum seconds between adjustments
    recoveryDelaySeconds: 300  // Delay before increasing power after reduction
  };
}

/**
 * Log an auto control event to the buffer
 */
function logAutoControlEvent(minerIp, event) {
  if (!autoControlLogs[minerIp]) {
    autoControlLogs[minerIp] = [];
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    ...event
  };

  // Add to beginning (newest first)
  autoControlLogs[minerIp].unshift(logEntry);

  // Trim to max entries
  if (autoControlLogs[minerIp].length > MAX_AUTO_CONTROL_LOGS) {
    autoControlLogs[minerIp] = autoControlLogs[minerIp].slice(0, MAX_AUTO_CONTROL_LOGS);
  }

  // Console log for debugging
  const prefix = `[AutoMiningControl ${minerIp}]`;
  if (event.severity === 'critical') {
    console.error(`${prefix} ${event.message}`);
  } else if (event.severity === 'warning') {
    console.warn(`${prefix} ${event.message}`);
  } else {
    console.log(`${prefix} ${event.message}`);
  }
}

/**
 * Gather current readings from miner stats
 */
function gatherMinerReadings(stats) {
  const boardTemps = stats.boards?.map(b => b.temp).filter(t => t > 0) || [];
  const chipTemps = stats.boards?.map(b => b.chipTemp).filter(t => t > 0) || [];
  const fanSpeeds = [
    stats.fans?.speed1,
    stats.fans?.speed2,
    stats.fans?.speed3,
    stats.fans?.speed4
  ].filter(s => s > 0);

  // Count active boards (has hashrate or reasonable temp)
  const activeBoards = stats.boards?.filter(b =>
    (b.hashrate && b.hashrate > 0) || (b.temp && b.temp > 20)
  ).length || 0;

  const maxChipTemp = chipTemps.length > 0 ? Math.max(...chipTemps) : stats.temperature;
  const avgBoardTemp = boardTemps.length > 0
    ? boardTemps.reduce((a, b) => a + b, 0) / boardTemps.length
    : null;
  const maxBoardTemp = boardTemps.length > 0 ? Math.max(...boardTemps) : null;
  const avgFanSpeed = fanSpeeds.length > 0
    ? Math.round(fanSpeeds.reduce((a, b) => a + b, 0) / fanSpeeds.length)
    : null;
  const maxFanSpeed = fanSpeeds.length > 0 ? Math.max(...fanSpeeds) : null;

  return {
    chipTemp: maxChipTemp || 0,
    boardTemps,
    avgBoardTemp,
    maxBoardTemp,
    fanSpeeds,
    avgFanSpeed,
    maxFanSpeed,
    hashrate: stats.hashrate1m || stats.hashrate || 0,
    power: stats.powerDraw || 0,
    powerLimit: stats.powerLimit || stats.powerDraw || 0,
    activeBoards,
    totalBoards: stats.boards?.length || 0,
    isPaused: (stats.hashrate || 0) < 0.1
  };
}

/**
 * Check for threshold violations
 */
function checkMiningViolations(readings, thresholds) {
  return {
    chipTempCritical: readings.chipTemp > thresholds.maxChipTemp,
    boardTempHigh: readings.maxBoardTemp !== null && readings.maxBoardTemp > thresholds.maxBoardTemp,
    boardTempLow: readings.avgBoardTemp !== null && readings.avgBoardTemp < thresholds.minBoardTemp,
    fanSpeedHigh: readings.maxFanSpeed !== null && readings.maxFanSpeed > thresholds.maxFanSpeed,
    powerHigh: readings.power > thresholds.maxPower,
    hashrateLow: readings.hashrate < thresholds.minHashrate && !readings.isPaused,
    boardsLow: readings.activeBoards < thresholds.minActiveBoards,

    // Severity flags
    hasCritical: readings.chipTemp > thresholds.maxChipTemp,
    hasWarning: (
      (readings.maxBoardTemp !== null && readings.maxBoardTemp > thresholds.maxBoardTemp) ||
      (readings.maxFanSpeed !== null && readings.maxFanSpeed > thresholds.maxFanSpeed)
    )
  };
}

/**
 * Determine what action to take based on readings and violations
 */
function determineMiningAction(readings, violations, thresholds, behavior, state) {
  const now = Date.now();
  const lastAdjustment = state?.lastAdjustment ? new Date(state.lastAdjustment).getTime() : 0;
  const timeSinceAdjustment = (now - lastAdjustment) / 1000;

  // Cooldown check (except for critical situations)
  if (timeSinceAdjustment < behavior.cooldownSeconds && !violations.hasCritical) {
    return null;
  }

  // Priority 1: Critical chip temperature - PAUSE IMMEDIATELY
  if (violations.chipTempCritical) {
    return {
      type: 'PAUSE',
      reason: `CRITICAL: Chip temp ${readings.chipTemp}°C exceeds max ${thresholds.maxChipTemp}°C`,
      severity: 'critical'
    };
  }

  // Priority 2: Board temp low (heating needed) - RESUME if paused, increase power
  if (violations.boardTempLow && readings.isPaused) {
    return {
      type: 'RESUME',
      reason: `Heating needed: Board temp ${readings.avgBoardTemp?.toFixed(1)}°C below min ${thresholds.minBoardTemp}°C`,
      severity: 'info'
    };
  }

  if (violations.boardTempLow && !readings.isPaused && readings.powerLimit < thresholds.maxPower) {
    return {
      type: 'POWER_UP',
      targetPower: Math.min(readings.powerLimit + behavior.powerStepUp, thresholds.maxPower),
      reason: `Heating needed: Board temp ${readings.avgBoardTemp?.toFixed(1)}°C below min ${thresholds.minBoardTemp}°C`,
      severity: 'info'
    };
  }

  // Priority 3: High board temp or high fan speed - reduce power
  if ((violations.boardTempHigh || violations.fanSpeedHigh) && !readings.isPaused) {
    const newPower = Math.max(
      readings.powerLimit - behavior.powerStepDown,
      thresholds.minPower
    );

    if (newPower < readings.powerLimit) {
      const reasons = [];
      if (violations.boardTempHigh) {
        reasons.push(`Board temp ${readings.maxBoardTemp}°C > max ${thresholds.maxBoardTemp}°C`);
      }
      if (violations.fanSpeedHigh) {
        reasons.push(`Fan speed ${readings.maxFanSpeed} RPM > max ${thresholds.maxFanSpeed} RPM`);
      }

      return {
        type: 'POWER_DOWN',
        targetPower: newPower,
        reason: `Thermal protection: ${reasons.join(', ')}`,
        severity: 'warning'
      };
    }
  }

  // Priority 4: Recovery - increase power if stable for a while
  if (timeSinceAdjustment > behavior.recoveryDelaySeconds &&
      !violations.hasWarning &&
      !violations.hasCritical &&
      readings.powerLimit < thresholds.maxPower &&
      state?.lastAdjustmentType === 'POWER_DOWN') {

    return {
      type: 'POWER_UP',
      targetPower: Math.min(readings.powerLimit + behavior.powerStepUp, thresholds.maxPower),
      reason: `Recovery: Stable temps for ${Math.round(timeSinceAdjustment)}s, increasing power`,
      severity: 'info'
    };
  }

  return null;
}

/**
 * Execute a control action on the miner
 */
async function executeMiningControlAction(minerIp, action, minerConfig, readings) {
  const startTime = Date.now();

  try {
    switch (action.type) {
      case 'PAUSE':
        logAutoControlEvent(minerIp, {
          type: 'ADJUSTMENT',
          severity: action.severity,
          message: `PAUSING MINER: ${action.reason}`,
          details: { action: 'pause', readings }
        });
        await pauseMining(minerIp, minerConfig);
        break;

      case 'RESUME':
        logAutoControlEvent(minerIp, {
          type: 'ADJUSTMENT',
          severity: action.severity,
          message: `RESUMING MINER: ${action.reason}`,
          details: { action: 'resume', readings }
        });
        await resumeMining(minerIp, minerConfig);
        break;

      case 'POWER_DOWN':
      case 'POWER_UP':
        const arrow = action.type === 'POWER_DOWN' ? '↓' : '↑';
        logAutoControlEvent(minerIp, {
          type: 'ADJUSTMENT',
          severity: action.severity,
          message: `POWER ${arrow}: ${readings.powerLimit}W -> ${action.targetPower}W - ${action.reason}`,
          details: {
            action: 'power_adjust',
            direction: action.type,
            oldPower: readings.powerLimit,
            newPower: action.targetPower,
            readings
          }
        });
        await sendCGMinerCommand(minerIp, {
          command: 'ascset',
          parameter: `0,power,${action.targetPower}`
        });
        break;
    }

    const duration = Date.now() - startTime;
    logAutoControlEvent(minerIp, {
      type: 'ADJUSTMENT',
      severity: 'info',
      message: `Action completed in ${duration}ms`,
      details: { action: action.type, duration, success: true }
    });

    return { success: true, duration };

  } catch (err) {
    logAutoControlEvent(minerIp, {
      type: 'ERROR',
      severity: 'critical',
      message: `Action failed: ${err.message}`,
      details: { action: action.type, error: err.message }
    });
    return { success: false, error: err.message };
  }
}

/**
 * Main auto mining control check - called during each poll cycle
 */
async function checkAutoMiningControl(minerIp, stats, minerConfig) {
  const config = minerConfig.autoMiningControl;
  if (!config?.enabled) return;

  const thresholds = { ...getDefaultAutoMiningThresholds(), ...config.thresholds };
  const behavior = { ...getDefaultAutoMiningBehavior(), ...config.behavior };

  // Initialize state if needed
  if (!minerControlState[minerIp]) {
    minerControlState[minerIp] = {};
  }
  const state = minerControlState[minerIp].autoMiningControlState || {};

  // Step 1: Gather current readings
  const readings = gatherMinerReadings(stats);

  // Step 2: Check violations
  const violations = checkMiningViolations(readings, thresholds);

  // Step 3: Log current state check
  const tempInfo = `Chip ${readings.chipTemp}°C`;
  const boardInfo = readings.avgBoardTemp !== null ? `, Board ${readings.avgBoardTemp.toFixed(1)}°C` : '';
  const fanInfo = readings.avgFanSpeed !== null ? `, Fan ${readings.avgFanSpeed} RPM` : '';
  const powerInfo = `, Power ${readings.power}W`;
  const hashrateInfo = `, ${readings.hashrate.toFixed(1)} TH/s`;

  logAutoControlEvent(minerIp, {
    type: 'CHECK',
    severity: violations.hasCritical ? 'critical' : violations.hasWarning ? 'warning' : 'info',
    message: `State check: ${tempInfo}${boardInfo}${fanInfo}${powerInfo}${hashrateInfo}`,
    details: { readings, thresholds, violations }
  });

  // Step 4: Determine and execute action
  const action = determineMiningAction(readings, violations, thresholds, behavior, state);

  if (action) {
    await executeMiningControlAction(minerIp, action, minerConfig, readings);

    // Update state after action
    minerControlState[minerIp].autoMiningControlState = {
      ...state,
      lastAdjustment: new Date().toISOString(),
      lastAdjustmentType: action.type,
      currentTargetPower: action.targetPower || readings.powerLimit,
      adjustmentReason: action.reason
    };
  }

  // Step 5: Update state with current readings
  minerControlState[minerIp].autoMiningControlState = {
    ...minerControlState[minerIp].autoMiningControlState,
    lastCheck: new Date().toISOString(),
    readings,
    violations
  };
}

// ============================================================================
// Miner Capability Discovery Functions
// ============================================================================

/**
 * Test all CGMiner API commands to determine which ones work
 * @param {string} ip - Miner IP address
 * @returns {Promise<object>} CGMiner capabilities
 */
async function discoverCGMinerCapabilities(ip) {
  console.log(`[Discovery] Testing CGMiner API for ${ip}...`);

  const result = {
    available: false,
    port: 4028,
    commands: {}
  };

  const commands = ['summary', 'stats', 'pools', 'devs', 'temps', 'fans', 'devdetails', 'tunerstatus'];

  for (const cmd of commands) {
    try {
      const response = await sendCGMinerCommand(ip, { command: cmd });
      const hasData = response && (response.STATUS || response.SUMMARY || response[cmd.toUpperCase()]);
      result.commands[cmd] = {
        working: !!hasData,
        hasData: !!hasData
      };
      if (hasData) result.available = true;
    } catch (err) {
      result.commands[cmd] = {
        working: false,
        error: err.message
      };
    }
  }

  console.log(`[Discovery] CGMiner for ${ip}: available=${result.available}, working commands: ${Object.entries(result.commands).filter(([k, v]) => v.working).map(([k]) => k).join(', ')}`);
  return result;
}

/**
 * Test GraphQL API capabilities with simplified queries (no powerLimitW)
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Miner configuration
 * @returns {Promise<object>} GraphQL capabilities
 */
async function discoverGraphQLCapabilities(ip, minerConfig = {}) {
  console.log(`[Discovery] Testing GraphQL API for ${ip}...`);

  const result = {
    available: false,
    port: 80,
    authMethod: null,
    workingQueryIndex: null,
    error: null
  };

  try {
    const username = minerConfig.username || 'root';
    const password = minerConfig.password || 'root';

    // Try to get session token
    const sessionToken = await getSessionViaWebUI(ip, username, password);
    result.authMethod = sessionToken ? 'session' : 'none';

    // Test simplified queries WITHOUT powerLimitW
    const testQueries = [
      // Query 0: Fans and basic info only
      `{ bosminer { info { fans { rpm } } } bos { hostname } }`,
      // Query 1: Temperatures via workSolver
      `{ bosminer { info { workSolver { temperatures { name degreesC } } } } }`,
      // Query 2: Full info without tuner power fields
      `{ bosminer { info { tempCtrl { targetC hotC dangerousC } fans { name speed rpm } workSolver { temperatures { name degreesC } } } } }`,
      // Query 3: Just hostname (most basic)
      `{ bos { hostname } }`
    ];

    for (let i = 0; i < testQueries.length; i++) {
      try {
        const response = await graphqlRequest(ip, testQueries[i], sessionToken);
        if (response?.data && !response.errors) {
          result.available = true;
          result.workingQueryIndex = i;
          console.log(`[Discovery] GraphQL for ${ip}: query ${i} works`);
          break;
        }
      } catch (err) {
        // Continue to next query
      }
    }

    if (!result.available) {
      result.error = 'No GraphQL queries succeeded';
    }
  } catch (err) {
    result.error = err.message;
  }

  console.log(`[Discovery] GraphQL for ${ip}: available=${result.available}, authMethod=${result.authMethod}`);
  return result;
}

/**
 * Test REST API capabilities
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Miner configuration
 * @returns {Promise<object>} REST API capabilities
 */
async function discoverRESTCapabilities(ip, minerConfig = {}) {
  console.log(`[Discovery] Testing REST API for ${ip}...`);

  const result = {
    available: false,
    port: 80,
    authWorking: false,
    endpoints: {}
  };

  try {
    const username = minerConfig.username || 'root';
    const password = minerConfig.password || 'root';

    // Try to authenticate
    const token = await braiinsRestAuth(ip, username, password);
    result.authWorking = !!token;

    if (token) {
      // Test key endpoints
      const endpoints = [
        '/api/v1/miner/stats',
        '/api/v1/performance/tuner-state',
        '/api/v1/miner/details'
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await braiinsRestFetch(ip, endpoint, token);
          result.endpoints[endpoint] = { working: !!response };
          if (response) result.available = true;
        } catch (err) {
          result.endpoints[endpoint] = { working: false, error: err.message };
        }
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  console.log(`[Discovery] REST API for ${ip}: available=${result.available}, authWorking=${result.authWorking}`);
  return result;
}

/**
 * Test gRPC API capabilities
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Miner configuration
 * @returns {Promise<object>} gRPC capabilities
 */
async function discoverGRPCCapabilities(ip, minerConfig = {}) {
  console.log(`[Discovery] Testing gRPC API for ${ip}...`);

  const result = {
    available: false,
    port: 50051,
    authWorking: false,
    services: []
  };

  try {
    const username = minerConfig.username || 'root';
    const password = minerConfig.password || 'root';

    // Try to login via gRPC
    const loginResult = await braiinsLogin(ip, username, password);
    if (loginResult?.token) {
      result.available = true;
      result.authWorking = true;
      result.services = ['AuthenticationService', 'ActionsService'];
    }
  } catch (err) {
    result.error = err.message;
  }

  console.log(`[Discovery] gRPC for ${ip}: available=${result.available}`);
  return result;
}

/**
 * Determine optimal data sources based on discovered capabilities
 * @param {object} capabilities - Discovered capabilities
 * @returns {object} Optimal data source mapping
 */
function determineOptimalDataSources(capabilities) {
  const sources = {};
  const cgminer = capabilities.apis?.cgminer;
  const graphql = capabilities.apis?.graphql;
  const rest = capabilities.apis?.rest;

  // Hashrate - always CGMiner summary
  if (cgminer?.commands?.summary?.working) {
    sources.hashrate = { api: 'cgminer', command: 'summary' };
  }

  // Temperature - prefer CGMiner temps command, fallback to stats
  if (cgminer?.commands?.temps?.working) {
    sources.temperature = { api: 'cgminer', command: 'temps' };
  } else if (graphql?.available) {
    sources.temperature = { api: 'graphql' };
  } else if (cgminer?.commands?.stats?.working) {
    sources.temperature = { api: 'cgminer', command: 'stats' };
  }

  // Fans - prefer CGMiner fans command
  if (cgminer?.commands?.fans?.working) {
    sources.fans = { api: 'cgminer', command: 'fans' };
  } else if (graphql?.available) {
    sources.fans = { api: 'graphql' };
  }

  // Power - tunerstatus is most accurate
  if (cgminer?.commands?.tunerstatus?.working) {
    sources.power = { api: 'cgminer', command: 'tunerstatus' };
  } else if (rest?.endpoints?.['/api/v1/performance/tuner-state']?.working) {
    sources.power = { api: 'rest', endpoint: '/api/v1/performance/tuner-state' };
  }

  // Pools
  if (cgminer?.commands?.pools?.working) {
    sources.pools = { api: 'cgminer', command: 'pools' };
  }

  // Device details
  if (cgminer?.commands?.devdetails?.working) {
    sources.devdetails = { api: 'cgminer', command: 'devdetails' };
  }

  // Devs (for additional device info)
  if (cgminer?.commands?.devs?.working) {
    sources.devs = { api: 'cgminer', command: 'devs' };
  }

  return sources;
}

/**
 * Run full capability discovery for a miner
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Miner configuration
 * @returns {Promise<object>} Complete capability profile
 */
async function discoverMinerCapabilities(ip, minerConfig = {}) {
  console.log(`[Discovery] ========================================`);
  console.log(`[Discovery] Starting full capability discovery for ${ip}`);
  console.log(`[Discovery] ========================================`);

  const capabilities = {
    discoveredAt: new Date().toISOString(),
    minerModel: null,
    firmwareVersion: null,
    apis: {},
    dataSources: {},
    consecutiveFailures: 0,
    failureThreshold: 3,
    lastFailure: null
  };

  // Test all APIs
  capabilities.apis.cgminer = await discoverCGMinerCapabilities(ip);
  capabilities.apis.graphql = await discoverGraphQLCapabilities(ip, minerConfig);
  capabilities.apis.rest = await discoverRESTCapabilities(ip, minerConfig);
  capabilities.apis.grpc = await discoverGRPCCapabilities(ip, minerConfig);

  // Try to get miner model from devdetails
  if (capabilities.apis.cgminer?.commands?.devdetails?.working) {
    try {
      const devdetails = await sendCGMinerCommand(ip, { command: 'devdetails' });
      if (devdetails?.DEVDETAILS?.[0]?.Model) {
        capabilities.minerModel = devdetails.DEVDETAILS[0].Model;
      }
      if (devdetails?.STATUS?.[0]?.Description) {
        capabilities.firmwareVersion = devdetails.STATUS[0].Description;
      }
    } catch (err) {
      // Ignore
    }
  }

  // Determine optimal data sources
  capabilities.dataSources = determineOptimalDataSources(capabilities);

  console.log(`[Discovery] ========================================`);
  console.log(`[Discovery] Discovery complete for ${ip}`);
  console.log(`[Discovery] Model: ${capabilities.minerModel || 'Unknown'}`);
  console.log(`[Discovery] Firmware: ${capabilities.firmwareVersion || 'Unknown'}`);
  console.log(`[Discovery] Data sources: ${JSON.stringify(capabilities.dataSources)}`);
  console.log(`[Discovery] ========================================`);

  return capabilities;
}

/**
 * Check if a miner needs capability re-discovery
 * @param {object} minerConfig - Miner configuration
 * @returns {{ rediscover: boolean, reason: string }}
 */
function shouldRediscover(minerConfig) {
  const caps = minerConfig.capabilities;

  // No profile exists
  if (!caps || !caps.discoveredAt) {
    return { rediscover: true, reason: 'No capability profile exists' };
  }

  // Failure threshold exceeded
  if (caps.consecutiveFailures >= (caps.failureThreshold || 3)) {
    return { rediscover: true, reason: `${caps.consecutiveFailures} consecutive failures exceeded threshold` };
  }

  // Profile is stale (>24h) and had a recent failure
  const profileAge = Date.now() - new Date(caps.discoveredAt).getTime();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  if (profileAge > maxAge && caps.lastFailure) {
    const failureAge = Date.now() - new Date(caps.lastFailure).getTime();
    if (failureAge < 60 * 60 * 1000) { // Failure in last hour
      return { rediscover: true, reason: 'Stale profile with recent failure' };
    }
  }

  return { rediscover: false, reason: null };
}

/**
 * Optimized miner stats collection using capability profile
 * Only uses APIs that are known to work for this miner
 * @param {string} ip - Miner IP address
 * @param {object} minerConfig - Miner configuration with capabilities
 * @returns {Promise<object>} Miner stats
 */
async function getMinerStatsOptimized(ip, minerConfig) {
  const capabilities = minerConfig.capabilities;
  const sources = capabilities?.dataSources || {};

  // Collect which CGMiner commands we need
  const cgminerCommands = new Set();

  // Always need summary for hashrate
  if (sources.hashrate?.api === 'cgminer') {
    cgminerCommands.add(sources.hashrate.command);
  } else {
    cgminerCommands.add('summary'); // Fallback
  }

  // Add other needed commands
  if (sources.temperature?.api === 'cgminer') cgminerCommands.add(sources.temperature.command);
  if (sources.fans?.api === 'cgminer') cgminerCommands.add(sources.fans.command);
  if (sources.power?.api === 'cgminer') cgminerCommands.add(sources.power.command);
  if (sources.pools?.api === 'cgminer') cgminerCommands.add(sources.pools.command);
  if (sources.devdetails?.api === 'cgminer') cgminerCommands.add(sources.devdetails.command);
  if (sources.devs?.api === 'cgminer') cgminerCommands.add(sources.devs.command);

  // Execute CGMiner commands in parallel
  const cgminerResults = {};
  const commandList = [...cgminerCommands];

  const cgminerPromises = commandList.map(async (cmd) => {
    try {
      cgminerResults[cmd] = await sendCGMinerCommand(ip, { command: cmd });
    } catch (err) {
      cgminerResults[cmd] = { error: err.message };
    }
  });

  await Promise.all(cgminerPromises);

  // Extract data from results
  const summaryData = cgminerResults.summary?.SUMMARY?.[0] || {};
  const tempsData = cgminerResults.temps?.TEMPS || [];
  const fansData = cgminerResults.fans?.FANS || [];
  const tunerData = cgminerResults.tunerstatus?.TUNERSTATUS?.[0] || null;
  const poolsData = cgminerResults.pools?.POOLS?.[0] || {};
  const devsData = cgminerResults.devs?.DEVS || [];
  const devdetailsData = cgminerResults.devdetails?.DEVDETAILS || [];

  // Calculate hashrate
  const mhs5s = summaryData['MHS 5s'] || 0;
  const mhs15m = summaryData['MHS 15m'] || 0;
  const hashrate = mhs5s / 1000000; // Convert MH/s to TH/s
  const hashrate15m = mhs15m / 1000000;

  // Extract temperatures
  let temps = { board1: null, board2: null, board3: null, chip: null };
  if (tempsData.length > 0) {
    tempsData.forEach((t, idx) => {
      if (t.Board !== undefined) temps[`board${idx + 1}`] = t.Board;
      if (t.Chip !== undefined && (temps.chip === null || t.Chip > temps.chip)) {
        temps.chip = t.Chip;
      }
    });
  }

  // Extract fans
  let fans = { speed1: null, speed2: null, speed3: null, speed4: null };
  if (fansData.length > 0) {
    fansData.forEach((f, idx) => {
      if (f.RPM !== undefined) fans[`speed${idx + 1}`] = f.RPM;
    });
  }

  // Extract power
  let power = null;
  let powerLimit = null;
  let powerSource = 'unavailable';

  if (tunerData) {
    if (tunerData.ApproximateMinerPowerConsumption > 0) {
      power = tunerData.ApproximateMinerPowerConsumption;
      powerSource = 'tunerstatus';
    }
    if (tunerData.PowerLimit > 0) {
      powerLimit = tunerData.PowerLimit;
    }
  }

  // Calculate reject rate
  const accepted = poolsData.Accepted || 0;
  const rejected = poolsData.Rejected || 0;
  const rejectRate = accepted > 0 ? (rejected / (accepted + rejected)) * 100 : 0;

  // Get currency and prices
  const countryConfig = ELECTRICITY_ZONES[minerConfig.country || 'norway'];
  const currency = countryConfig?.currency || 'NOK';
  let btcPrice = btcPriceCache.priceNOK || 1000000;
  if (currency === 'EUR') btcPrice = btcPriceCache.priceEUR || 90000;
  if (currency === 'SEK') btcPrice = btcPriceCache.priceSEK || 1000000;
  if (currency === 'USD') btcPrice = btcPriceCache.priceUSD || 95000;

  // Calculate effective electricity price
  const rawSpotPrice = electricityPriceCache.currentPrice || 1.0;
  const gridFee = getGridFeeForTime(minerConfig);
  const useNorgespris = minerConfig.priceMode === 'norgespris';

  let basePrice, subsidyApplied = false, subsidyAmount = 0;
  if (useNorgespris) {
    basePrice = 0.50;
  } else {
    const threshold = 0.9375;
    if (rawSpotPrice > threshold) {
      const excessPrice = rawSpotPrice - threshold;
      subsidyAmount = excessPrice * 0.90;
      basePrice = rawSpotPrice - subsidyAmount;
      subsidyApplied = true;
    } else {
      basePrice = rawSpotPrice;
    }
  }
  const effectivePrice = basePrice + gridFee;

  // Calculate efficiency for all hashrate periods
  const hashrate1mValue = (summaryData['MHS 1m'] || 0) / 1000000;
  const hashrate15mValue = hashrate15m;
  const hashrate1hValue = (summaryData['MHS 1h'] || 0) / 1000000;
  const hashrate24hValue = (summaryData['MHS 24h'] || 0) / 1000000;

  // Calculate efficiency and effective SCOP for each time period
  const efficiency = power !== null ? calculateEfficiency(hashrate, power, effectivePrice, btcPrice, currency) : null;
  const efficiency1m = power !== null && hashrate1mValue > 0 ? calculateEfficiency(hashrate1mValue, power, effectivePrice, btcPrice, currency) : null;
  const efficiency15m = power !== null && hashrate15mValue > 0 ? calculateEfficiency(hashrate15mValue, power, effectivePrice, btcPrice, currency) : null;
  const efficiency1h = power !== null && hashrate1hValue > 0 ? calculateEfficiency(hashrate1hValue, power, effectivePrice, btcPrice, currency) : null;
  const efficiency24h = power !== null && hashrate24hValue > 0 ? calculateEfficiency(hashrate24hValue, power, effectivePrice, btcPrice, currency) : null;

  // Calculate W/TH for each time period
  const efficiencyWPerTH = (power !== null && hashrate > 0) ? power / hashrate : null;
  const efficiencyWPerTH1m = (power !== null && hashrate1mValue > 0) ? power / hashrate1mValue : null;
  const efficiencyWPerTH15m = (power !== null && hashrate15mValue > 0) ? power / hashrate15mValue : null;
  const efficiencyWPerTH1h = (power !== null && hashrate1hValue > 0) ? power / hashrate1hValue : null;
  const efficiencyWPerTH24h = (power !== null && hashrate24hValue > 0) ? power / hashrate24hValue : null;

  // Concise log output
  const workingApis = commandList.filter(cmd => !cgminerResults[cmd]?.error).join(',');
  console.log(`[Poll] ${ip}: CGMiner(${workingApis}) -> ${hashrate.toFixed(2)} TH/s, ${temps.chip || 'N/A'}°C, ${power || 'N/A'}W`);

  return {
    hashrate,
    hashrate15m,
    hashrate1m: (summaryData['MHS 1m'] || 0) / 1000000,
    hashrate1h: (summaryData['MHS 1h'] || 0) / 1000000,
    hashrate24h: (summaryData['MHS 24h'] || 0) / 1000000,
    hashrateAv: (summaryData['MHS av'] || 0) / 1000000,
    efficiencyWPerTH,
    efficiencyWPerTH1m,
    efficiencyWPerTH15m,
    efficiencyWPerTH1h,
    efficiencyWPerTH24h,
    temperature: temps.chip,
    powerDraw: power,
    powerLimit,
    powerSource,
    uptime: summaryData.Elapsed || 0,
    boards: [
      { temp: temps.board1, chipTemp: tempsData[0]?.Chip || null },
      { temp: temps.board2, chipTemp: tempsData[1]?.Chip || null },
      { temp: temps.board3, chipTemp: tempsData[2]?.Chip || null }
    ],
    fans,
    poolStatus: poolsData.Status === 'Alive' ? 'Connected' : 'Disconnected',
    poolUrl: poolsData.URL || 'Not connected',
    acceptedShares: accepted,
    rejectedShares: rejected,
    rejectRate,
    powerProfile: minerConfig.powerProfile || 'medium',

    electricity: {
      rawSpotPrice,
      basePrice,
      gridFee,
      effectivePrice,
      subsidyApplied,
      subsidyAmount,
      priceMode: useNorgespris ? 'norgespris' : 'stromstotteavtale',
      currentPrice: effectivePrice,
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

    btcPrice: {
      usd: btcPriceCache.priceUSD,
      nok: btcPriceCache.priceNOK,
      eur: btcPriceCache.priceEUR,
      sek: btcPriceCache.priceSEK,
      updatedAt: btcPriceCache.fetchedAt
    },

    network: {
      difficulty: networkStatsCache.difficulty,
      hashrate: networkStatsCache.hashrate,
      hashrateFormatted: networkStatsCache.hashrateFormatted,
      blockHeight: networkStatsCache.blockHeight,
      blockReward: networkStatsCache.blockReward,
      updatedAt: networkStatsCache.fetchedAt
    },

    efficiency,
    efficiency1m,
    efficiency15m,
    efficiency1h,
    efficiency24h,

    // Minimal debug info
    _debug: {
      powerSource,
      powerLimit,
      capabilities: {
        cgminerCommands: commandList,
        model: capabilities?.minerModel,
        firmware: capabilities?.firmwareVersion
      }
    }
  };
}

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
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'MiningDashboard/1.0'
      }
    };

    const request = protocol.get(options, (res) => {
      let data = '';

      // Check for HTTP error status codes
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        });
        return;
      }

      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
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
async function fetchBraiinsGraphQL(ip, minerConfig = {}) {
  console.log('=== STARTING GRAPHQL DISCOVERY ===');

  const username = minerConfig.username || 'root';
  const password = minerConfig.password || 'root';

  // First, authenticate with LuCI to get a session token
  console.log('Authenticating with LuCI...');
  const sessionToken = await getSessionViaWebUI(ip, username, password);
  
  if (sessionToken) {
    console.log('Got session token, will use for GraphQL requests');
  } else {
    console.log('No session token obtained, will try Basic Auth fallback');
  }
  
  // First, get ALL types in the schema to find temp/fan related ones
  const fullSchemaQuery = `{
    __schema {
      types {
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
  }`;
  
  const fullSchema = await graphqlRequest(ip, fullSchemaQuery, sessionToken);
  if (fullSchema?.data?.__schema?.types) {
    // Find relevant types (Fan, TempCtrl, etc.)
    const relevantTypes = fullSchema.data.__schema.types.filter(t => 
      t.name && !t.name.startsWith('__') && t.fields &&
      (t.name.toLowerCase().includes('fan') || 
       t.name.toLowerCase().includes('temp') || 
       t.name.toLowerCase().includes('hash') ||
       t.name.toLowerCase().includes('solver') ||
       t.name.toLowerCase().includes('cooling') ||
       t.name.toLowerCase().includes('board'))
    );
    
    console.log('=== RELEVANT GRAPHQL TYPES WITH TEMP/FAN DATA ===');
    relevantTypes.forEach(t => {
      if (t.fields && t.fields.length > 0) {
        console.log(`${t.name}: ${t.fields.map(f => f.name).join(', ')}`);
      }
    });
  }
  
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
  const schemaResult = await graphqlRequest(ip, introspectionQuery, sessionToken);
  
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
  
  const bosminerSchema = await graphqlRequest(ip, bosminerIntrospection, sessionToken);
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
  
  const bosSchema = await graphqlRequest(ip, bosIntrospection, sessionToken);
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
  
  const bosInfoSchema = await graphqlRequest(ip, bosInfoIntrospection, sessionToken);
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
  
  const managerSchema = await graphqlRequest(ip, managerIntrospection, sessionToken);
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
  
  const bosminerInfoSchema = await graphqlRequest(ip, bosminerInfoIntrospection, sessionToken);
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
  
  const fanSchema = await graphqlRequest(ip, fanIntrospection, sessionToken);
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
  
  const tempCtrlSchema = await graphqlRequest(ip, tempCtrlIntrospection, sessionToken);
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

  const workSolverSchema = await graphqlRequest(ip, workSolverIntrospection, sessionToken);
  if (workSolverSchema?.data?.__type?.fields) {
    console.log('WorkSolverInfo type fields:', workSolverSchema.data.__type.fields.map(f => f.name));
  }

  // Introspect TunerInfo type for power consumption data
  const tunerIntrospection = `{
    __type(name: "TunerInfo") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;

  const tunerSchema = await graphqlRequest(ip, tunerIntrospection, sessionToken);
  if (tunerSchema?.data?.__type?.fields) {
    console.log('TunerInfo type fields:', tunerSchema.data.__type.fields.map(f => f.name));
  }

  // Introspect MinerStats or similar for power data
  const minerStatsIntrospection = `{
    __type(name: "MinerStats") {
      fields {
        name
        type {
          name
          kind
        }
      }
    }
  }`;

  const minerStatsSchema = await graphqlRequest(ip, minerStatsIntrospection, sessionToken);
  if (minerStatsSchema?.data?.__type?.fields) {
    console.log('MinerStats type fields:', minerStatsSchema.data.__type.fields.map(f => f.name));
  }

  // Build queries with CORRECT field names based on schema discovery
  // FanInfo has: name, speed, rpm
  // TempCtrlInfo has: targetC, hotC, dangerousC
  // WorkSolverInfo.temperatures is array of Temperature with: name, degreesC
  // TunerInfo has: powerLimitW, powerReal (actual power consumption)
  const queries = [];

  // Query 1: Full data with power consumption from tuner
  queries.push(`{
    bosminer {
      info {
        tempCtrl {
          targetC
          hotC
          dangerousC
        }
        fans {
          name
          speed
          rpm
        }
        workSolver {
          temperatures {
            name
            degreesC
          }
          tuner {
            powerLimitW
            approximatePowerConsumptionW
          }
        }
      }
    }
  }`);

  // Query 2: Temps, fans, and power with alternative tuner fields
  queries.push(`{
    bosminer {
      info {
        tempCtrl {
          targetC
          hotC
        }
        fans {
          rpm
        }
        workSolver {
          tuner {
            powerLimitW
            approximatePowerConsumptionW
          }
        }
      }
    }
  }`);

  // Query 3: Just workSolver with temperatures and tuner
  queries.push(`{
    bosminer {
      info {
        workSolver {
          temperatures {
            name
            degreesC
          }
          tuner {
            powerLimitW
            approximatePowerConsumptionW
          }
        }
      }
    }
  }`);
  
  // Query 4: Just fans
  queries.push(`{
    bosminer {
      info {
        fans {
          rpm
        }
      }
    }
  }`);
  
  // Query 5: Just tempCtrl
  queries.push(`{
    bosminer {
      info {
        tempCtrl {
          targetC
        }
      }
    }
  }`);
  
  // Query 6: Just hostname to confirm connection works
  queries.push(`{
    bos {
      hostname
    }
  }`);
  
  // Try each query format until one works
  for (let i = 0; i < queries.length; i++) {
    console.log(`Trying GraphQL query format ${i + 1}...`);
    const result = await graphqlRequest(ip, queries[i], sessionToken);
    
    if (result?.data && !result.errors) {
      console.log(`GraphQL query format ${i + 1} succeeded:`, JSON.stringify(result.data, null, 2).substring(0, 1500));
      result._availableFields = availableFields;
      result._bosminerFields = bosminerFields;
      result._bosFields = bosFields;
      result._sessionToken = sessionToken ? 'present' : 'none';
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
    _sessionToken: sessionToken ? 'present' : 'none',
    data: null 
  };
}

/**
 * Authenticate with LuCI to get a session token
 * This is required for accessing bosminer data on BOSer
 * Handles redirects to capture the session cookie
 */
function luciLogin(ip, username = 'root', password = 'root') {
  return new Promise((resolve, reject) => {
    const postData = `luci_username=${encodeURIComponent(username)}&luci_password=${encodeURIComponent(password)}`;
    
    const options = {
      hostname: ip,
      port: 80,
      path: '/cgi-bin/luci/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Look for sysauth cookie in response headers
        const cookies = res.headers['set-cookie'];
        let sessionToken = null;
        
        console.log(`LuCI login response: status=${res.statusCode}, cookies=${JSON.stringify(cookies)}`);
        
        if (cookies) {
          for (const cookie of cookies) {
            // Try sysauth (standard LuCI)
            let match = cookie.match(/sysauth[^=]*=([^;]+)/);
            if (match) {
              sessionToken = match[0]; // Keep the full "sysauth=value" or "sysauth_http=value"
              console.log('Found sysauth cookie:', sessionToken);
              break;
            }
          }
        }
        
        // If we got a redirect (301, 302, 307, 308), follow it to get the cookie
        if (!sessionToken && [301, 302, 307, 308].includes(res.statusCode)) {
          const location = res.headers['location'];
          console.log('Following redirect to:', location);
          
          if (location) {
            // Build the cookie header from any cookies we got
            const cookieHeader = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
            
            // Follow the redirect
            followRedirect(ip, location, cookieHeader).then(result => {
              resolve(result.sessionToken);
            }).catch(() => resolve(null));
            return;
          }
        }
        
        if (sessionToken) {
          resolve(sessionToken);
        } else {
          console.log('No session token found in response');
          resolve(null);
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('LuCI login error:', err.message);
      resolve(null);
    });
    
    req.on('timeout', () => {
      req.destroy();
      console.error('LuCI login timeout');
      resolve(null);
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Follow a redirect and capture any session cookies
 */
function followRedirect(ip, location, existingCookies = '') {
  return new Promise((resolve, reject) => {
    // Parse the location - it might be relative or absolute
    let path = location;
    if (location.startsWith('http')) {
      try {
        const url = new URL(location);
        path = url.pathname + url.search;
      } catch (e) {
        path = location;
      }
    }
    
    const options = {
      hostname: ip,
      port: 80,
      path: path,
      method: 'GET',
      headers: {},
      timeout: 10000
    };
    
    if (existingCookies) {
      options.headers['Cookie'] = existingCookies;
    }
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const cookies = res.headers['set-cookie'];
        let sessionToken = null;
        
        console.log(`Redirect response: status=${res.statusCode}, cookies=${JSON.stringify(cookies)}`);
        
        // Combine existing cookies with new ones
        let allCookies = existingCookies;
        
        if (cookies) {
          for (const cookie of cookies) {
            let match = cookie.match(/sysauth[^=]*=([^;]+)/);
            if (match) {
              sessionToken = match[0];
              console.log('Found sysauth cookie after redirect:', sessionToken);
            }
          }
          // Add new cookies
          const newCookies = cookies.map(c => c.split(';')[0]).join('; ');
          allCookies = allCookies ? `${allCookies}; ${newCookies}` : newCookies;
        }
        
        // If still redirecting, follow again (max 3 redirects)
        if (!sessionToken && [301, 302, 307, 308].includes(res.statusCode) && res.headers['location']) {
          followRedirect(ip, res.headers['location'], allCookies).then(resolve).catch(reject);
          return;
        }
        
        // If no explicit sysauth, try using all cookies we collected
        if (!sessionToken && allCookies) {
          const sysauthMatch = allCookies.match(/sysauth[^=]*=[^;]+/);
          if (sysauthMatch) {
            sessionToken = sysauthMatch[0];
          }
        }
        
        resolve({ sessionToken, allCookies });
      });
    });
    
    req.on('error', (err) => {
      console.error('Redirect follow error:', err.message);
      reject(err);
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Redirect timeout'));
    });
    
    req.end();
  });
}

/**
 * Alternative: Try to get a session by accessing the web UI first
 */
async function getSessionViaWebUI(ip, username = 'root', password = 'root') {
  // Method 1: Try standard LuCI login
  let session = await luciLogin(ip, username, password);
  if (session) return session;
  
  // Method 2: Try /cgi-bin/luci/admin/status endpoint with basic auth
  // This might establish a session
  return new Promise((resolve) => {
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    
    const options = {
      hostname: ip,
      port: 80,
      path: '/cgi-bin/luci/admin/status/overview',
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
        const cookies = res.headers['set-cookie'];
        console.log(`Web UI status response: ${res.statusCode}, cookies: ${JSON.stringify(cookies)}`);
        
        if (cookies) {
          for (const cookie of cookies) {
            const match = cookie.match(/sysauth[^=]*=([^;]+)/);
            if (match) {
              console.log('Got session from web UI:', match[0]);
              resolve(match[0]);
              return;
            }
          }
        }
        resolve(null);
      });
    });
    
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Helper function to make GraphQL requests with authentication
 * Supports both Basic Auth and LuCI session auth
 */
function graphqlRequest(ip, query, sessionCookie = null) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query });
    
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    };
    
    // Use session cookie if available, otherwise try Basic Auth
    if (sessionCookie) {
      // sessionCookie might be "sysauth=xxx" or "sysauth_http=xxx"
      headers['Cookie'] = sessionCookie;
      console.log('Using session cookie for GraphQL:', sessionCookie.substring(0, 30) + '...');
    } else {
      // Try Basic Auth as fallback
      headers['Authorization'] = 'Basic ' + Buffer.from('root:root').toString('base64');
    }
    
    const options = {
      hostname: ip,
      port: 80,
      path: '/graphql',
      method: 'POST',
      headers,
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
          console.error('Failed to parse GraphQL response:', err.message, 'Raw:', data.substring(0, 200));
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
async function fetchBraiinsHTTPApi(ip, minerConfig = {}) {
  const username = minerConfig.username || 'root';
  const password = minerConfig.password || 'root';

  return new Promise((resolve, reject) => {
    // Create Basic Auth header with miner credentials
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    
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
// Braiins OS Public REST API Functions
// ============================================================================

/**
 * Authenticate with Braiins OS Public REST API
 * Returns an auth token for subsequent requests
 */
async function braiinsRestAuth(ip, username = 'root', password = 'root') {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ username, password });

    const options = {
      hostname: ip,
      port: 80,
      path: '/api/v1/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.token) {
            console.log('Braiins REST API auth successful');
            resolve(parsed.token);
          } else {
            console.log('No token in auth response:', data);
            resolve(null);
          }
        } catch (err) {
          console.error('Failed to parse REST auth response:', err.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('REST auth error:', err.message);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('REST auth timeout');
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Fetch data from Braiins OS Public REST API endpoint
 */
async function braiinsRestFetch(ip, endpoint, token = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const options = {
      hostname: ip,
      port: 80,
      path: endpoint,
      method: 'GET',
      headers,
      timeout: 10000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Check if response is an error object
          if (parsed.error || parsed.message?.includes('authentication')) {
            console.error(`REST API error for ${endpoint}:`, parsed.error || parsed.message);
            resolve(null);
          } else {
            resolve(parsed);
          }
        } catch (err) {
          console.error(`Failed to parse REST response from ${endpoint}:`, err.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error(`REST fetch error for ${endpoint}:`, err.message);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      console.error(`REST fetch timeout for ${endpoint}`);
      resolve(null);
    });

    req.end();
  });
}

/**
 * Fetch all available stats from Braiins OS Public REST API
 * Returns comprehensive debug data
 */
async function fetchBraiinsRestApiStats(ip, minerConfig = {}) {
  try {
    // Try to authenticate first
    const username = minerConfig.username || 'root';
    const password = minerConfig.password || 'root';
    const token = await braiinsRestAuth(ip, username, password);

    // Fetch from all documented endpoints (even without auth, some may work)
    const [
      minerStats,
      hashboards,
      coolingState,
      errors,
      pools,
      performanceProfiles,
      tunerState,
      minerDetails
    ] = await Promise.all([
      braiinsRestFetch(ip, '/api/v1/miner/stats', token),
      braiinsRestFetch(ip, '/api/v1/miner/hw/hashboards', token),
      braiinsRestFetch(ip, '/api/v1/cooling/state', token),
      braiinsRestFetch(ip, '/api/v1/miner/errors', token),
      braiinsRestFetch(ip, '/api/v1/pools/', token),
      braiinsRestFetch(ip, '/api/v1/performance/target-profiles', token),
      braiinsRestFetch(ip, '/api/v1/performance/tuner-state', token),
      braiinsRestFetch(ip, '/api/v1/miner/details', token)
    ]);

    return {
      authenticated: !!token,
      minerStats,
      hashboards,
      coolingState,
      errors,
      pools,
      performanceProfiles,
      tunerState,
      minerDetails
    };
  } catch (err) {
    console.error('Error fetching REST API stats:', err.message);
    return null;
  }
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
    } else {
      console.error('BTC price API response missing bitcoin data:', JSON.stringify(data).slice(0, 200));
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
 * Determine grid fee based on day of week and time
 * @param {object} config - Configuration with gridFeeWeekdayDay and gridFeeWeekendNight
 * @param {Date} date - Optional date to check (defaults to now)
 * @returns {number} - The applicable grid fee
 */
function getGridFeeForTime(config, date = new Date()) {
  const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
  const hour = date.getHours();

  // Weekend (Saturday=6, Sunday=0) or weekday night (22:00-06:00)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isNightTime = hour < 6 || hour >= 22;

  if (isWeekend || isNightTime) {
    return config.gridFeeWeekendNight || 0.30;
  } else {
    return config.gridFeeWeekdayDay || 0.50;
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
      // Only log during discovery, not during regular polling
      if (process.env.DEBUG_CGMINER) {
        console.log(`[CGMiner] ${ip}: ${command.command}`);
      }
      client.write(request);
    });

    let data = '';

    client.on('data', (chunk) => {
      data += chunk.toString();
    });

    client.on('end', () => {
      try {
        const cleaned = data.replace(/\0/g, '');
        const parsed = JSON.parse(cleaned);
        resolve(parsed);
      } catch (err) {
        reject(new Error('Failed to parse miner response: ' + err.message));
      }
    });

    client.on('error', (err) => {
      // Only log errors, not every connection
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
  
  const temps = {
    board1: null,
    board2: null,
    board3: null,
    chip: null
  };

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
  }
  // Pattern 2: temp1, temp2, temp3 (older format)
  else if (combinedData.temp1 !== undefined) {
    temps.board1 = combinedData.temp1;
    temps.board2 = combinedData.temp2;
    temps.board3 = combinedData.temp3;
    temps.chip = combinedData.temp || Math.max(temps.board1 || 0, temps.board2 || 0, temps.board3 || 0);
  }
  // Pattern 3: temp2_1, temp2_2, temp2_3 (some Antminer models)
  else if (combinedData.temp2_1 !== undefined) {
    temps.board1 = combinedData.temp2_1;
    temps.board2 = combinedData.temp2_2;
    temps.board3 = combinedData.temp2_3;
    temps.chip = Math.max(temps.board1 || 0, temps.board2 || 0, temps.board3 || 0);
  }
  // Pattern 4: Temperature field from devs
  else if (combinedData.Temperature !== undefined) {
    temps.chip = combinedData.Temperature;
  }
  // Pattern 5: Check for chain_ prefixed fields
  else if (Object.keys(combinedData).some(k => k.startsWith('chain_'))) {
    for (let i = 1; i <= 3; i++) {
      const tempKey = `chain_temp${i}` || `chain${i}_temp`;
      if (combinedData[tempKey] !== undefined) {
        temps[`board${i}`] = combinedData[tempKey];
      }
    }
  }

  // Pattern 6: Search for any field containing 'temp' (fallback)
  if (temps.chip === null) {
    for (const [key, value] of Object.entries(combinedData)) {
      if (typeof value === 'number' && key.toLowerCase().includes('temp') && value > 0 && value < 150) {
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
  }
  
  // If we still have no chip temp, use the max of board temps
  if (temps.chip === null && (temps.board1 || temps.board2 || temps.board3)) {
    temps.chip = Math.max(temps.board1 || 0, temps.board2 || 0, temps.board3 || 0);
  }
  
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
  } else if (combinedData.fan_speed_in !== undefined) {
    fans.speed1 = combinedData.fan_speed_in;
    fans.speed2 = combinedData.fan_speed_out;
  } else if (combinedData.Fan1 !== undefined) {
    fans.speed1 = combinedData.Fan1;
    fans.speed2 = combinedData.Fan2;
    fans.speed3 = combinedData.Fan3;
    fans.speed4 = combinedData.Fan4;
  } else if (combinedData['Fan Speed In'] !== undefined) {
    fans.speed1 = combinedData['Fan Speed In'];
    fans.speed2 = combinedData['Fan Speed Out'];
  }
  
  // Search for fan fields if not found
  if (fans.speed1 === null) {
    for (const [key, value] of Object.entries(combinedData)) {
      if (typeof value === 'number' && key.toLowerCase().includes('fan') && value > 0) {
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
  }
  
  return fans;
}

// ============================================================================
// Alert System
// ============================================================================

/**
 * Check miner stats against alert thresholds and create alerts
 * @param {Object} stats - Miner statistics
 * @param {Object} alertConfig - Alert configuration
 * @param {string} minerName - Name of the miner
 * @returns {Array} Array of triggered alerts
 */
function checkAlerts(stats, alertConfig, minerName) {
  if (!alertConfig || !alertConfig.enabled) {
    return [];
  }

  const alerts = [];
  const now = Date.now();
  const cooldownMs = (alertConfig.cooldownMinutes || 15) * 60 * 1000;

  // Helper to check if we should fire an alert (respects cooldown)
  const shouldAlert = (alertKey) => {
    const lastTime = lastAlertTimes[alertKey];
    if (!lastTime || (now - lastTime) > cooldownMs) {
      lastAlertTimes[alertKey] = now;
      return true;
    }
    return false;
  };

  // Check if miner is offline
  if (alertConfig.minerOffline?.enabled && stats.error) {
    const alertKey = `${stats.minerIp}_offline`;
    if (shouldAlert(alertKey)) {
      alerts.push({
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        type: 'offline',
        severity: 'critical',
        minerName: minerName,
        minerIp: stats.minerIp,
        message: `Miner "${minerName}" is offline or unreachable`,
        details: stats.error
      });
    }
  }

  // Only check other alerts if miner is online
  if (!stats.error) {
    // Check high temperature
    if (alertConfig.highTemp?.enabled && stats.temperature) {
      const threshold = alertConfig.highTemp.threshold || 80;
      if (stats.temperature >= threshold) {
        const alertKey = `${stats.minerIp}_hightemp`;
        if (shouldAlert(alertKey)) {
          alerts.push({
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            type: 'highTemp',
            severity: stats.temperature >= threshold + 5 ? 'critical' : 'warning',
            minerName: minerName,
            minerIp: stats.minerIp,
            message: `High temperature on "${minerName}": ${stats.temperature}°C`,
            details: `Temperature ${stats.temperature}°C exceeds threshold of ${threshold}°C`,
            value: stats.temperature,
            threshold: threshold
          });
        }
      }
    }

    // Check low hashrate
    if (alertConfig.lowHashrate?.enabled && stats.hashrate) {
      const thresholdPercent = alertConfig.lowHashrate.threshold || 80;
      // Estimate expected hashrate based on power draw (if available)
      let expectedHashrate = 100; // Default TH/s
      if (stats.powerDraw !== null && stats.powerDraw > 0) {
        if (stats.powerDraw < 2500) expectedHashrate = 80;
        else if (stats.powerDraw < 3000) expectedHashrate = 95;
        else expectedHashrate = 110;
      }

      const minHashrate = expectedHashrate * (thresholdPercent / 100);
      if (stats.hashrate < minHashrate) {
        const alertKey = `${stats.minerIp}_lowhash`;
        if (shouldAlert(alertKey)) {
          alerts.push({
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            type: 'lowHashrate',
            severity: 'warning',
            minerName: minerName,
            minerIp: stats.minerIp,
            message: `Low hashrate on "${minerName}": ${stats.hashrate.toFixed(1)} TH/s`,
            details: `Hashrate ${stats.hashrate.toFixed(1)} TH/s is below ${thresholdPercent}% of expected (${minHashrate.toFixed(1)} TH/s)`,
            value: stats.hashrate,
            threshold: minHashrate
          });
        }
      }
    }

    // Check high reject rate
    if (alertConfig.highRejectRate?.enabled && stats.accepted !== undefined && stats.rejected !== undefined) {
      const total = stats.accepted + stats.rejected;
      if (total > 100) { // Only check if we have enough samples
        const rejectRate = (stats.rejected / total) * 100;
        const threshold = alertConfig.highRejectRate.threshold || 5;
        if (rejectRate >= threshold) {
          const alertKey = `${stats.minerIp}_rejects`;
          if (shouldAlert(alertKey)) {
            alerts.push({
              id: Date.now() + Math.random(),
              timestamp: new Date().toISOString(),
              type: 'highRejectRate',
              severity: rejectRate >= threshold * 2 ? 'critical' : 'warning',
              minerName: minerName,
              minerIp: stats.minerIp,
              message: `High reject rate on "${minerName}": ${rejectRate.toFixed(1)}%`,
              details: `Reject rate ${rejectRate.toFixed(1)}% exceeds threshold of ${threshold}%`,
              value: rejectRate,
              threshold: threshold
            });
          }
        }
      }
    }
  }

  // Add new alerts to history (keep last 100)
  if (alerts.length > 0) {
    alertHistory.push(...alerts);
    if (alertHistory.length > 100) {
      alertHistory = alertHistory.slice(-100);
    }
  }

  return alerts;
}

async function getMinerStats(ip, config = {}) {
  try {
    // Try to get data from Braiins OS GraphQL API (has temperature/fan data)
    let graphqlData = null;
    let httpApiData = null;

    try {
      graphqlData = await fetchBraiinsGraphQL(ip, config);
    } catch (e) {
      // GraphQL not available - will try other APIs
    }

    // Try HTTP API as fallback
    if (!graphqlData) {
      try {
        httpApiData = await fetchBraiinsHTTPApi(ip, config);
      } catch (e) {
        // HTTP API not available - will use CGMiner
      }
    }

    // Try to get all BOSminer data for debug stats
    let devs = null;
    let tempsCmd = null;
    let fansCmd = null;
    let devdetailsCmd = null;
    let tunerstatusCmd = null;
    let restApiData = null;

    try {
      // Fetch all BOSminer commands in parallel
      [devs, tempsCmd, fansCmd, devdetailsCmd, tunerstatusCmd] = await Promise.all([
        sendCGMinerCommand(ip, { command: 'devs' }).catch(() => null),
        sendCGMinerCommand(ip, { command: 'temps' }).catch(() => null),
        sendCGMinerCommand(ip, { command: 'fans' }).catch(() => null),
        sendCGMinerCommand(ip, { command: 'devdetails' }).catch(() => null),
        sendCGMinerCommand(ip, { command: 'tunerstatus' }).catch(() => null)
      ]);
    } catch (e) {
      // Error fetching extended BOSminer commands - not critical
    }

    // Try to fetch REST API data
    try {
      restApiData = await fetchBraiinsRestApiStats(ip, config);
    } catch (e) {
      // REST API not available - will use CGMiner data
    }

    const [summary, stats, pools] = await Promise.all([
      sendCGMinerCommand(ip, { command: 'summary' }),
      sendCGMinerCommand(ip, { command: 'stats' }),
      sendCGMinerCommand(ip, { command: 'pools' })
    ]);

    const summaryData = summary.SUMMARY?.[0] || {};
    
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
    
    const poolData = pools.POOLS?.[0] || {};

    // Calculate hashrate in TH/s - extract all available time ranges
    // Braiins OS uses MHS (megahash) format, not GHS
    const mhs5s = summaryData['MHS 5s'] || 0;
    const mhs1m = summaryData['MHS 1m'] || 0;
    const mhs15m = summaryData['MHS 15m'] || 0;
    const mhs24h = summaryData['MHS 24h'] || 0;
    const mhsAv = summaryData['MHS av'] || 0;

    // Convert MHS to TH/s (divide by 1,000,000)
    const hashrate = mhs5s / 1000000;
    const hashrate1m = mhs1m / 1000000;
    const hashrate15m = mhs15m / 1000000;
    const hashrate24h = mhs24h / 1000000;
    const hashrateAv = mhsAv / 1000000;

    // Extract temperatures - prefer GraphQL data, fall back to CGMiner
    let temps = { board1: null, board2: null, board3: null, chip: null };
    let fans = { speed1: null, speed2: null, speed3: null, speed4: null };
    let graphqlPower = null; // Power from GraphQL API (most accurate)

    // Try GraphQL data first (most reliable for Braiins OS)
    if (graphqlData?.data) {
      // Handle bosminer.info.fans and bosminer.info.tempCtrl format (BOSer)
      if (graphqlData.data.bosminer?.info) {
        const info = graphqlData.data.bosminer.info;

        // Extract fans - FanInfo has: name, speed, rpm
        if (info.fans && Array.isArray(info.fans)) {
          info.fans.forEach((fan, idx) => {
            if (fan.rpm !== undefined && fan.rpm !== null) {
              fans[`speed${idx + 1}`] = fan.rpm;
            } else if (fan.speed !== undefined && fan.speed !== null) {
              fans[`speed${idx + 1}`] = fan.speed;
            }
          });
        }
        
        // Extract temperature from tempCtrl - TempCtrlInfo has: targetC, hotC, dangerousC
        if (info.tempCtrl) {
          // Use targetC as the operating temperature
          if (info.tempCtrl.targetC !== undefined && info.tempCtrl.targetC !== null) {
            temps.chip = info.tempCtrl.targetC;
          }
        }
        
        // Extract actual temperatures from workSolver.temperatures
        // Temperature type has: name, degreesC
        if (info.workSolver?.temperatures && Array.isArray(info.workSolver.temperatures)) {
          info.workSolver.temperatures.forEach((temp, idx) => {
            if (temp.degreesC !== undefined && temp.degreesC !== null) {
              const name = (temp.name || '').toLowerCase();
              // Try to identify board vs chip temps
              if (name.includes('board') || name.includes('pcb') || name.includes('hashboard')) {
                const boardNum = name.match(/\d+/)?.[0] || (idx + 1);
                temps[`board${boardNum}`] = temp.degreesC;
              } else if (name.includes('chip')) {
                temps.chip = temp.degreesC;
              } else {
                // Default: first 3 are boards, any after might be chip
                if (idx < 3) {
                  temps[`board${idx + 1}`] = temp.degreesC;
                } else if (temps.chip === null) {
                  temps.chip = temp.degreesC;
                }
              }
            }
          });
          
          // Set chip to max board temp if not explicitly found
          if (temps.chip === null) {
            const boardTemps = [temps.board1, temps.board2, temps.board3].filter(t => t !== null);
            if (boardTemps.length > 0) {
              temps.chip = Math.max(...boardTemps);
            }
          }
        }

        // Extract power consumption from tuner data
        if (info.workSolver?.tuner) {
          const tuner = info.workSolver.tuner;
          // Prefer actual power consumption, fall back to power limit
          if (tuner.approximatePowerConsumptionW !== undefined && tuner.approximatePowerConsumptionW !== null) {
            graphqlPower = tuner.approximatePowerConsumptionW;
          } else if (tuner.powerLimitW !== undefined && tuner.powerLimitW !== null) {
            graphqlPower = tuner.powerLimitW;
          }
        }
      }

      // Handle multiple possible GraphQL response formats
      
      // Format 1: bosminer.hashChains with temperature objects
      if (graphqlData.data.bosminer?.hashChains) {
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
        graphqlData.data.fans.forEach((f, idx) => {
          if (f.rpm !== undefined && f.rpm !== null) {
            fans[`speed${idx + 1}`] = f.rpm;
          }
        });
      }
      
      // Format 3: miner.hashboards
      if (graphqlData.data.miner?.hashboards) {
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
      
    }

    // Try HTTP API data if GraphQL didn't work
    if (httpApiData && temps.chip === null) {
      
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
    
    // Try TEMPS command from BOSminer (most reliable for newer Braiins OS)
    if (tempsCmd?.TEMPS && Array.isArray(tempsCmd.TEMPS)) {

      const tempBoards = [];
      const tempChips = [];

      tempsCmd.TEMPS.forEach((tempEntry, idx) => {
        if (tempEntry.Board !== undefined && tempEntry.Board !== null) {
          temps[`board${idx + 1}`] = tempEntry.Board;
          tempBoards.push(tempEntry.Board);
        }
        if (tempEntry.Chip !== undefined && tempEntry.Chip !== null) {
          tempChips.push(tempEntry.Chip);
        }
      });

      // Set chip temp to max of all chip temps
      if (tempChips.length > 0) {
        temps.chip = Math.max(...tempChips);
      }

    }

    // Try FANS command from BOSminer (most reliable for newer Braiins OS)
    if (fansCmd?.FANS && Array.isArray(fansCmd.FANS)) {
      fansCmd.FANS.forEach((fanEntry, idx) => {
        if (fanEntry.RPM !== undefined && fanEntry.RPM !== null) {
          fans[`speed${idx + 1}`] = fanEntry.RPM;
        }
      });

    }

    // Fall back to CGMiner stats/devs data if GraphQL/HTTP API didn't provide temps
    if (temps.chip === null || temps.chip === 0) {
      temps = extractTemperatures(statsData, devsData, allStatsData);
      fans = extractFanSpeeds(statsData, devsData, allStatsData);
    }

    // Get power from various sources - prioritize tunerstatus (most accurate), then GraphQL, then CGMiner API
    // DO NOT use fake estimates based on assumed W/TH - only show real data
    let power = null;
    let powerLimit = null; // The configured power target
    let powerSource = 'unavailable';

    // Extract tuner status data
    const tunerStatus = tunerstatusCmd?.TUNERSTATUS?.[0];

    // Priority 1: CGMiner tunerstatus command (most accurate - actual measured power from BOSer)
    if (tunerStatus?.ApproximateMinerPowerConsumption > 0) {
      power = tunerStatus.ApproximateMinerPowerConsumption;
      powerSource = 'tunerstatus';
    }
    // Priority 2: GraphQL tuner data
    else if (graphqlPower !== null && graphqlPower > 0) {
      power = graphqlPower;
      powerSource = 'graphql';
    }
    // Priority 3: CGMiner stats API
    else if (statsData.Power && statsData.Power > 0) {
      power = statsData.Power;
      powerSource = 'cgminer-stats';
    }
    else if (statsData.power && statsData.power > 0) {
      power = statsData.power;
      powerSource = 'cgminer-stats';
    }
    // Priority 4: CGMiner summary API
    else if (summaryData.Power && summaryData.Power > 0) {
      power = summaryData.Power;
      powerSource = 'cgminer-summary';
    }
    // Priority 5: REST API tuner-state (fallback for newer Braiins OS versions)
    else if (restApiData?.tunerState?.powerConsumptionW > 0) {
      power = restApiData.tunerState.powerConsumptionW;
      powerSource = 'rest-api';
    }
    else if (restApiData?.tunerState?.power?.consumptionW > 0) {
      power = restApiData.tunerState.power.consumptionW;
      powerSource = 'rest-api';
    }
    // Priority 6: REST API miner stats
    else if (restApiData?.minerStats?.powerConsumptionW > 0) {
      power = restApiData.minerStats.powerConsumptionW;
      powerSource = 'rest-api-stats';
    }
    // No fake fallbacks - if we can't get real power, leave it null

    // Extract power limit (configured target) from tunerstatus
    if (tunerStatus?.PowerLimit > 0) {
      powerLimit = tunerStatus.PowerLimit;
    } else if (tunerStatus?.DynamicPowerScaling?.ScaledPowerLimit > 0) {
      powerLimit = tunerStatus.DynamicPowerScaling.ScaledPowerLimit;
    } else if (restApiData?.tunerState?.powerTargetW > 0) {
      powerLimit = restApiData.tunerState.powerTargetW;
    } else if (restApiData?.tunerState?.power?.targetW > 0) {
      powerLimit = restApiData.tunerState.power.targetW;
    }

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
    const rawSpotPrice = electricityPriceCache.currentPrice || 1.0;
    const gridFee = getGridFeeForTime(config);
    const useNorgespris = config.priceMode === 'norgespris';

    let basePrice;
    let subsidyApplied = false;
    let subsidyAmount = 0;

    if (useNorgespris) {
      // Norgespris: Fixed 0.50 NOK/kWh + grid fees
      basePrice = 0.50;
    } else {
      // Strømstøtteavtale: Spot price with state subsidy
      // State covers 90% of spot price above 93.75 øre/kWh (0.9375 NOK/kWh)
      const threshold = 0.9375;
      if (rawSpotPrice > threshold) {
        const excessPrice = rawSpotPrice - threshold;
        subsidyAmount = excessPrice * 0.90;
        basePrice = rawSpotPrice - subsidyAmount;
        subsidyApplied = true;
      } else {
        basePrice = rawSpotPrice;
      }
    }

    // Total effective price = base price + grid fees
    const effectivePrice = basePrice + gridFee;

    // Calculate efficiency and effective SCOP for each time period
    const hashrate1hValue = (summaryData['MHS 1h'] || 0) / 1000000;

    const efficiency = power !== null ? calculateEfficiency(hashrate, power, effectivePrice, btcPrice, currency) : null;
    const efficiency1m = power !== null && hashrate1m > 0 ? calculateEfficiency(hashrate1m, power, effectivePrice, btcPrice, currency) : null;
    const efficiency15m = power !== null && hashrate15m > 0 ? calculateEfficiency(hashrate15m, power, effectivePrice, btcPrice, currency) : null;
    const efficiency1h = power !== null && hashrate1hValue > 0 ? calculateEfficiency(hashrate1hValue, power, effectivePrice, btcPrice, currency) : null;
    const efficiency24h = power !== null && hashrate24h > 0 ? calculateEfficiency(hashrate24h, power, effectivePrice, btcPrice, currency) : null;

    // Calculate W/TH for each time period
    const efficiencyWPerTH = (power !== null && hashrate > 0) ? power / hashrate : null;
    const efficiencyWPerTH1m = (power !== null && hashrate1m > 0) ? power / hashrate1m : null;
    const efficiencyWPerTH15m = (power !== null && hashrate15m > 0) ? power / hashrate15m : null;
    const efficiencyWPerTH1h = (power !== null && hashrate1hValue > 0) ? power / hashrate1hValue : null;
    const efficiencyWPerTH24h = (power !== null && hashrate24h > 0) ? power / hashrate24h : null;

    return {
      // Basic stats
      hashrate,
      hashrate1m,
      hashrate15m,
      hashrate1h: hashrate1hValue,
      hashrate24h,
      hashrateAv,
      efficiencyWPerTH, // W/TH efficiency (null if power unavailable)
      efficiencyWPerTH1m,
      efficiencyWPerTH15m,
      efficiencyWPerTH1h,
      efficiencyWPerTH24h,
      temperature: temps.chip,
      powerDraw: power, // Actual power consumption in watts (null if unavailable)
      powerLimit, // Configured power target in watts (null if unavailable)
      powerSource, // indicates where power data came from
      uptime: summaryData.Elapsed || 0,
      boards: [
        { temp: temps.board1, chipTemp: tempsCmd?.TEMPS?.[0]?.Chip || null },
        { temp: temps.board2, chipTemp: tempsCmd?.TEMPS?.[1]?.Chip || null },
        { temp: temps.board3, chipTemp: tempsCmd?.TEMPS?.[2]?.Chip || null }
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
        rawSpotPrice: rawSpotPrice,
        basePrice: basePrice,
        gridFee: gridFee,
        effectivePrice: effectivePrice,
        subsidyApplied: subsidyApplied,
        subsidyAmount: subsidyAmount,
        priceMode: useNorgespris ? 'norgespris' : 'stromstotteavtale',
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
      efficiency1m,
      efficiency15m,
      efficiency1h,
      efficiency24h,
      
      // Debug info - all available API data
      _debug: {
        // Power source tracking
        powerSource,
        powerLimit,
        graphqlPower,
        tunerStatusPower: tunerStatus?.ApproximateMinerPowerConsumption || null,

        // Miner Control State (DPS = Dynamic Power Scaling)
        minerControl: {
          isPaused: minerControlState[ip]?.isPaused || false,
          dpsCooldownSeconds: tunerStatus?.DynamicPowerScaling?.CoolingDownEndsInDuration || 0,
          tunerMode: tunerStatus?.TunerMode || null,
          tunerRunning: tunerStatus?.TunerChainStatus?.[0]?.TunerRunning || false,
          tunerStatus: tunerStatus?.TunerChainStatus?.[0]?.Status || null
        },

        // GraphQL API
        graphqlAvailable: graphqlData?.data ? true : false,
        graphqlRootFields: graphqlData?._availableFields || [],
        graphqlBosminerFields: graphqlData?._bosminerFields || [],
        graphqlBosFields: graphqlData?._bosFields || [],
        graphqlTemps: graphqlData?.data?.temperatures || graphqlData?.data?.bosminer?.hashChains || [],
        graphqlFans: graphqlData?.data?.fans || graphqlData?.data?.bosminer?.fans || [],
        graphqlTuner: graphqlData?.data?.bosminer?.info?.workSolver?.tuner || null,
        graphqlRawData: graphqlData?.data ? JSON.stringify(graphqlData.data).substring(0, 500) : null,

        // HTTP API
        httpApiAvailable: httpApiData ? true : false,

        // BOSminer Commands
        bosminer: {
          summary: summaryData,
          stats: stats,
          pools: pools,
          devs: devs,
          temps: tempsCmd,
          fans: fansCmd,
          devdetails: devdetailsCmd,
          tunerstatus: tunerstatusCmd
        },

        // REST API
        restApiAvailable: restApiData?.authenticated || false,
        restApi: restApiData,

        // Legacy debug fields
        statsEntryCount: stats.STATS?.length || 0,
        allNumericFields: Object.entries(allStatsData)
          .filter(([k, v]) => typeof v === 'number')
          .map(([k, v]) => `${k}=${v}`)
          .slice(0, 30),
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
    const config = JSON.parse(data);

    // Migrate old single-miner config to multi-miner format
    if (config.minerIP && !config.miners) {
      config.miners = [{
        ip: config.minerIP,
        name: 'Miner 1',
        powerProfile: config.currentProfile || 'medium'
      }];
      delete config.minerIP;
      delete config.currentProfile;
      await saveConfig(config);
    }

    // Migrate old single grid fee to dual grid fee format
    if (config.gridFeePerKwh !== undefined && config.gridFeeWeekdayDay === undefined) {
      config.gridFeeWeekdayDay = config.gridFeePerKwh;
      config.gridFeeWeekendNight = config.gridFeePerKwh * 0.6; // Default to 60% for off-peak
      delete config.gridFeePerKwh;
      await saveConfig(config);
    }

    // Add default alert settings if not present
    if (!config.alerts) {
      config.alerts = {
        enabled: true,
        highTemp: { enabled: true, threshold: 80 },
        lowHashrate: { enabled: true, threshold: 80 }, // % of expected hashrate
        minerOffline: { enabled: true },
        highRejectRate: { enabled: true, threshold: 5 }, // % rejects
        cooldownMinutes: 15 // Don't re-alert for same issue within this time
      };
      await saveConfig(config);
    }

    // Add default history sample interval if not present (in minutes)
    if (config.historySampleInterval === undefined) {
      config.historySampleInterval = 5; // Default: sample every 5 minutes
      await saveConfig(config);
    }

    return config;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        miners: [], // Array of {ip, name, powerProfile}
        alerts: {
          enabled: true,
          highTemp: { enabled: true, threshold: 80 },
          lowHashrate: { enabled: true, threshold: 80 },
          minerOffline: { enabled: true },
          highRejectRate: { enabled: true, threshold: 5 },
          cooldownMinutes: 15
        },
        country: 'norway',
        electricityZone: 'NO5',
        gridFeeWeekdayDay: 0.50,
        gridFeeWeekendNight: 0.30,
        priceMode: 'stromstotteavtale', // 'norgespris' or 'stromstotteavtale'
        historySampleInterval: 5 // Sample history every 5 minutes
      };
    }
    throw err;
  }
}

async function saveConfig(config) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log('Configuration saved:', config);
}

// ============================================================================
// Historical Data Management (v2)
// ============================================================================

/**
 * Load historical data with backward compatibility
 * New format: { version: 2, hourlySnapshots: [], dailyAverages: [] }
 * Old format: { entries: [] }
 */
async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf8');

    // Handle empty file
    if (!data || data.trim() === '') {
      console.log('History file is empty, returning default structure');
      return { version: 2, hourlySnapshots: [], dailyAverages: [] };
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (parseErr) {
      console.error('Failed to parse history.json, file may be corrupted:', parseErr.message);
      // Backup corrupted file and return empty history
      try {
        await fs.writeFile(HISTORY_FILE + '.corrupted.' + Date.now(), data);
        console.log('Corrupted history file backed up');
      } catch (backupErr) {
        console.error('Failed to backup corrupted file:', backupErr.message);
      }
      return { version: 2, hourlySnapshots: [], dailyAverages: [] };
    }

    // Migrate old format to new format
    if (parsed.entries && !parsed.version) {
      console.log('Migrating history from v1 to v2 format...');
      return {
        version: 2,
        hourlySnapshots: migrateV1Entries(parsed.entries),
        dailyAverages: []
      };
    }

    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { version: 2, hourlySnapshots: [], dailyAverages: [] };
    }
    console.error('Error loading history file:', err);
    return { version: 2, hourlySnapshots: [], dailyAverages: [] };
  }
}

/**
 * Migrate old v1 entries to v2 format
 * Groups entries by timestamp and creates snapshots
 */
function migrateV1Entries(entries) {
  const timestampMap = {};

  entries.forEach(entry => {
    const ts = entry.timestamp;
    if (!timestampMap[ts]) {
      timestampMap[ts] = {
        timestamp: ts,
        miners: [],
        market: {
          btcPriceNOK: entry.btcPrice,
          electricityPrice: entry.electricityPrice,
          networkDifficulty: entry.networkDifficulty
        }
      };
    }

    timestampMap[ts].miners.push({
      ip: entry.minerIp,
      name: entry.minerName,
      hashrate: entry.hashrate || 0,
      power: entry.power || 0,
      temperature: entry.temperature || 0,
      scop: entry.effectiveSCOP,
      dailyProfit: entry.dailyProfit
    });
  });

  // Convert to array and add aggregates
  return Object.values(timestampMap).map(snapshot => {
    const aggregate = {
      totalHashrate: snapshot.miners.reduce((sum, m) => sum + (m.hashrate || 0), 0),
      totalPower: snapshot.miners.reduce((sum, m) => sum + (m.power || 0), 0),
      avgTemperature: snapshot.miners.reduce((sum, m) => sum + (m.temperature || 0), 0) / snapshot.miners.length,
      totalDailyProfit: snapshot.miners.reduce((sum, m) => sum + (m.dailyProfit || 0), 0),
      avgSCOP: snapshot.miners.reduce((sum, m) => sum + (m.scop || 0), 0) / snapshot.miners.length,
      minerCount: snapshot.miners.length
    };

    return { ...snapshot, aggregate };
  });
}

/**
 * Save a complete snapshot with all miners
 * Called by background scheduler based on configured interval
 * Retention is dynamic: keeps 7 days of snapshots at the configured interval
 */
async function saveHistorySnapshot(allMinerStats) {
  try {
    if (!allMinerStats || allMinerStats.length === 0) {
      console.log('No miner stats to save, skipping history snapshot');
      return;
    }

    // Validate we have good data
    const validMiners = allMinerStats.filter(stats =>
      !stats.error &&
      stats.hashrate != null &&
      stats.powerDraw != null
    );

    if (validMiners.length === 0) {
      console.log('No valid miner data to save, skipping history snapshot');
      return;
    }

    const config = await loadConfig();
    const history = await loadHistory();
    const timestamp = new Date().toISOString();

    // Build miner entries
    const miners = validMiners.map(stats => ({
      ip: stats.minerIp,
      name: stats.minerName,
      hashrate: stats.hashrate || 0,
      power: stats.powerDraw || 0,
      temperature: stats.temperature || 0,
      isPaused: stats.isPaused || false,
      scop: stats.efficiency?.effectiveSCOP,
      dailyProfit: stats.efficiency?.dailyProfit,
      dailyBTC: stats.efficiency?.dailyBTC,
      dailyCost: stats.efficiency?.dailyCost,
      autoControlEnabled: stats.autoControl?.enabled || false,
      autoControlState: stats.autoControlState?.intendedState
    }));

    // Calculate aggregates
    const aggregate = {
      totalHashrate: miners.reduce((sum, m) => sum + m.hashrate, 0),
      totalPower: miners.reduce((sum, m) => sum + m.power, 0),
      avgTemperature: miners.reduce((sum, m) => sum + m.temperature, 0) / miners.length,
      totalDailyProfit: miners.reduce((sum, m) => sum + (m.dailyProfit || 0), 0),
      totalDailyBTC: miners.reduce((sum, m) => sum + (m.dailyBTC || 0), 0),
      totalDailyCost: miners.reduce((sum, m) => sum + (m.dailyCost || 0), 0),
      avgSCOP: miners.reduce((sum, m) => sum + (m.scop || 0), 0) / miners.filter(m => m.scop).length || 0,
      minerCount: miners.length,
      activeMinerCount: miners.filter(m => !m.isPaused).length
    };

    // Get market data from cache
    const market = {
      btcPriceNOK: btcPriceCache.priceNOK,
      btcPriceUSD: btcPriceCache.priceUSD,
      btcPriceEUR: btcPriceCache.priceEUR,
      btcPriceSEK: btcPriceCache.priceSEK,
      electricityPrice: electricityPriceCache.effectivePrice,
      electricitySpotPrice: electricityPriceCache.rawSpotPrice,
      gridFee: electricityPriceCache.gridFee,
      networkDifficulty: networkStatsCache.difficulty,
      networkHashrate: networkStatsCache.hashrate
    };

    // Create snapshot
    const snapshot = {
      timestamp,
      aggregate,
      miners,
      market
    };

    // Add to snapshots array
    history.hourlySnapshots.push(snapshot);

    // Dynamic retention based on sample interval
    // Keep 7 days worth of snapshots at the configured interval
    const sampleIntervalMinutes = config.historySampleInterval || 5;
    const samplesPerHour = 60 / sampleIntervalMinutes;
    const maxSnapshots = Math.ceil(samplesPerHour * 24 * 7); // 7 days of data

    if (history.hourlySnapshots.length > maxSnapshots) {
      // Before removing old data, aggregate into daily averages
      const oldSnapshots = history.hourlySnapshots.slice(0, history.hourlySnapshots.length - maxSnapshots);
      aggregateToDailyAverages(history, oldSnapshots);

      // Keep only recent data
      history.hourlySnapshots = history.hourlySnapshots.slice(-maxSnapshots);
    }

    // Retention: Keep last 30 daily averages
    const maxDailyAverages = 30;
    if (history.dailyAverages.length > maxDailyAverages) {
      history.dailyAverages = history.dailyAverages.slice(-maxDailyAverages);
    }

    // Save to file
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`History snapshot saved: ${miners.length} miners, ${aggregate.totalHashrate.toFixed(1)} TH/s total (interval: ${sampleIntervalMinutes}min)`);

  } catch (err) {
    console.error('Failed to save history snapshot:', err);
  }
}

/**
 * Aggregate hourly snapshots into daily averages
 */
function aggregateToDailyAverages(history, hourlySnapshots) {
  // Group snapshots by date
  const dailyGroups = {};

  hourlySnapshots.forEach(snapshot => {
    const date = snapshot.timestamp.split('T')[0]; // Get YYYY-MM-DD
    if (!dailyGroups[date]) {
      dailyGroups[date] = [];
    }
    dailyGroups[date].push(snapshot);
  });

  // Calculate daily averages
  Object.entries(dailyGroups).forEach(([date, snapshots]) => {
    // Skip if we already have this date
    if (history.dailyAverages.some(d => d.date === date)) {
      return;
    }

    const count = snapshots.length;
    const daily = {
      date,
      sampleCount: count,
      aggregate: {
        avgHashrate: snapshots.reduce((sum, s) => sum + s.aggregate.totalHashrate, 0) / count,
        avgPower: snapshots.reduce((sum, s) => sum + s.aggregate.totalPower, 0) / count,
        avgTemperature: snapshots.reduce((sum, s) => sum + s.aggregate.avgTemperature, 0) / count,
        totalDailyProfit: snapshots.reduce((sum, s) => sum + (s.aggregate.totalDailyProfit || 0), 0) / count,
        avgSCOP: snapshots.reduce((sum, s) => sum + (s.aggregate.avgSCOP || 0), 0) / count,
        avgMinerCount: snapshots.reduce((sum, s) => sum + s.aggregate.minerCount, 0) / count
      },
      market: {
        avgBtcPrice: snapshots.reduce((sum, s) => sum + (s.market.btcPriceNOK || 0), 0) / count,
        avgElectricityPrice: snapshots.reduce((sum, s) => sum + (s.market.electricityPrice || 0), 0) / count,
        avgDifficulty: snapshots.reduce((sum, s) => sum + (s.market.networkDifficulty || 0), 0) / count
      }
    };

    history.dailyAverages.push(daily);
  });

  // Sort daily averages by date
  history.dailyAverages.sort((a, b) => a.date.localeCompare(b.date));
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

    // Find miner-specific config for credentials
    const minerConfig = config.miners?.find(m => m.ip === ip) || {};
    const stats = await getMinerStats(ip, minerConfig);
    res.json(stats);
  } catch (err) {
    console.error('API stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/miner/power', async (req, res) => {
  try {
    const config = await loadConfig();
    const ip = req.body.ip;
    const profile = req.body.profile;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    if (!['low', 'medium', 'high'].includes(profile)) {
      return res.status(400).json({ error: 'Invalid power profile' });
    }

    const result = await setPowerProfile(ip, profile);

    // Update the miner's power profile in config
    const miner = config.miners.find(m => m.ip === ip);
    if (miner) {
      miner.powerProfile = profile;
      await saveConfig(config);
    }

    res.json(result);
  } catch (err) {
    console.error('API power error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Pause mining on a miner
app.post('/api/miner/pause', async (req, res) => {
  try {
    const config = await loadConfig();
    const ip = req.body.ip;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    const minerConfig = config.miners.find(m => m.ip === ip) || {};
    const result = await pauseMining(ip, minerConfig);

    res.json(result);
  } catch (err) {
    console.error('API pause error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Resume mining on a miner
app.post('/api/miner/resume', async (req, res) => {
  try {
    const config = await loadConfig();
    const ip = req.body.ip;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    const minerConfig = config.miners.find(m => m.ip === ip) || {};
    const result = await resumeMining(ip, minerConfig);

    res.json(result);
  } catch (err) {
    console.error('API resume error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get mining status for a miner
app.get('/api/miner/status', async (req, res) => {
  try {
    const ip = req.query.ip;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    const status = await getMiningStatus(ip);
    res.json(status);
  } catch (err) {
    console.error('API status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update auto-control settings for a miner
app.post('/api/miner/auto-control', async (req, res) => {
  try {
    const { ip, enabled, scopThreshold, minTemperature, efficiencyOverride } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    const config = await loadConfig();
    const miner = config.miners.find(m => m.ip === ip);

    if (!miner) {
      return res.status(404).json({ error: 'Miner not found' });
    }

    // Initialize or update autoControl settings
    miner.autoControl = {
      enabled: enabled !== undefined ? enabled : (miner.autoControl?.enabled || false),
      scopThreshold: scopThreshold !== undefined ? scopThreshold : (miner.autoControl?.scopThreshold || 2.0),
      minTemperature: minTemperature !== undefined ? minTemperature : miner.autoControl?.minTemperature,
      // Efficiency override for projected SCOP calculation when paused
      // { power: watts, hashrate: TH/s }
      efficiencyOverride: efficiencyOverride !== undefined ? efficiencyOverride : miner.autoControl?.efficiencyOverride
    };

    await saveConfig(config);

    console.log(`Auto-control settings updated for ${ip}:`, miner.autoControl);
    res.json({ success: true, autoControl: miner.autoControl });
  } catch (err) {
    console.error('API auto-control error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update auto mining control settings (comprehensive hardware monitoring)
app.post('/api/miner/auto-mining-control', async (req, res) => {
  try {
    const { ip, enabled, thresholds, behavior } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    const config = await loadConfig();
    const miner = config.miners.find(m => m.ip === ip);

    if (!miner) {
      return res.status(404).json({ error: 'Miner not found' });
    }

    // Initialize or update autoMiningControl settings
    miner.autoMiningControl = {
      enabled: enabled !== undefined ? enabled : (miner.autoMiningControl?.enabled || false),
      thresholds: {
        ...(miner.autoMiningControl?.thresholds || getDefaultAutoMiningThresholds()),
        ...thresholds
      },
      behavior: {
        ...(miner.autoMiningControl?.behavior || getDefaultAutoMiningBehavior()),
        ...behavior
      }
    };

    await saveConfig(config);

    console.log(`Auto mining control settings updated for ${ip}:`, miner.autoMiningControl);
    res.json({ success: true, autoMiningControl: miner.autoMiningControl });
  } catch (err) {
    console.error('API auto-mining-control error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get auto-control logs for a miner
app.get('/api/miner/auto-control/logs/:ip', async (req, res) => {
  try {
    const ip = req.params.ip;
    const limit = parseInt(req.query.limit) || 50;
    const logs = (autoControlLogs[ip] || []).slice(0, limit);
    res.json({ logs });
  } catch (err) {
    console.error('API auto-control logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Clear auto-control logs for a miner
app.post('/api/miner/auto-control/clear-logs', async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }
    autoControlLogs[ip] = [];
    console.log(`Auto-control logs cleared for ${ip}`);
    res.json({ success: true });
  } catch (err) {
    console.error('API clear-logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reset best efficiency tracking for a miner
app.post('/api/miner/reset-best-efficiency', async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    if (minerControlState[ip]?.efficiencyTracking) {
      minerControlState[ip].efficiencyTracking.best1hPower = null;
      minerControlState[ip].efficiencyTracking.best1hHashrate = null;
      minerControlState[ip].efficiencyTracking.best1hEfficiency = null;
      minerControlState[ip].efficiencyTracking.best1hTimestamp = null;

      console.log(`Best efficiency tracking reset for ${ip}`);
      res.json({ success: true, message: 'Best efficiency tracking reset' });
    } else {
      res.json({ success: true, message: 'No efficiency tracking found' });
    }
  } catch (err) {
    console.error('API reset-best-efficiency error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch current miner configuration settings from the miner itself
app.get('/api/miner/config/:ip', async (req, res) => {
  try {
    const ip = req.params.ip;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    const config = await loadConfig();
    const minerConfig = config.miners?.find(m => m.ip === ip) || {};
    const username = minerConfig.username || 'root';
    const password = minerConfig.password || 'root';

    // Authenticate with the miner
    const token = await braiinsRestAuth(ip, username, password);

    // Fetch cooling mode configuration and tuner state in parallel
    const [coolingMode, tunerState, performanceProfiles] = await Promise.all([
      braiinsRestFetch(ip, '/api/v1/cooling/mode', token),
      braiinsRestFetch(ip, '/api/v1/performance/tuner-state', token),
      braiinsRestFetch(ip, '/api/v1/performance/target-profiles', token)
    ]);

    // Extract configuration values
    const result = {
      success: true,
      cooling: null,
      power: null,
      profiles: null
    };

    // Parse cooling mode settings
    if (coolingMode) {
      const mode = coolingMode.mode || coolingMode;
      result.cooling = {
        mode: mode.mode || (typeof mode === 'string' ? mode : 'unknown'),
        targetTemp: mode.target_temperature ?? mode.targetTemperature ?? null,
        hotTemp: mode.hot_temperature ?? mode.hotTemperature ?? null,
        dangerousTemp: mode.dangerous_temperature ?? mode.dangerousTemperature ?? null,
        minFanSpeed: mode.min_fan_speed ?? mode.minFanSpeed ?? null,
        maxFanSpeed: mode.max_fan_speed ?? mode.maxFanSpeed ?? null,
        fanSpeedRatio: mode.fan_speed_ratio ?? mode.fanSpeedRatio ?? null
      };
    }

    // Parse tuner/power settings
    if (tunerState) {
      result.power = {
        currentPower: tunerState.powerConsumptionW ?? tunerState.power_consumption_w ?? null,
        powerTarget: tunerState.powerTargetW ?? tunerState.power_target_w ?? tunerState.powerTarget ?? null,
        minPower: tunerState.minPowerTargetW ?? tunerState.min_power_target_w ?? null,
        maxPower: tunerState.maxPowerTargetW ?? tunerState.max_power_target_w ?? null,
        tunerRunning: tunerState.tunerRunning ?? tunerState.tuner_running ?? null,
        tunerState: tunerState.state ?? null
      };
    }

    // Parse available power profiles
    if (performanceProfiles && Array.isArray(performanceProfiles)) {
      result.profiles = performanceProfiles.map(p => ({
        name: p.name,
        powerTarget: p.powerTargetW ?? p.power_target_w ?? null,
        minPower: p.minPowerTargetW ?? p.min_power_target_w ?? null,
        maxPower: p.maxPowerTargetW ?? p.max_power_target_w ?? null
      }));
    }

    console.log(`Fetched miner config for ${ip}:`, JSON.stringify(result, null, 2));
    res.json(result);
  } catch (err) {
    console.error('API miner config error:', err);
    res.status(500).json({ error: err.message, success: false });
  }
});

// ============================================================================
// API Terminal - Execute custom API commands for debugging
// ============================================================================

app.post('/api/terminal/execute', async (req, res) => {
  const startTime = Date.now();
  try {
    const { ip, command, type } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    if (!command) {
      return res.status(400).json({ error: 'No command provided' });
    }

    const config = await loadConfig();
    const minerConfig = config.miners.find(m => m.ip === ip) || {};

    let result = null;
    let commandType = type || 'cgminer';

    switch (commandType) {
      case 'cgminer':
        // CGMiner API command (e.g., "summary", "stats", "pools", "devs")
        try {
          result = await sendCGMinerCommand(ip, { command });
        } catch (err) {
          result = { error: err.message };
        }
        break;

      case 'grpc-login':
        // Test gRPC login
        try {
          const username = minerConfig.username || 'root';
          const password = minerConfig.password || 'root';
          result = await braiinsLogin(ip, username, password);
        } catch (err) {
          result = { error: err.message };
        }
        break;

      case 'grpc-pause':
        // gRPC pause mining
        try {
          result = await pauseMining(ip, minerConfig);
        } catch (err) {
          result = { error: err.message };
        }
        break;

      case 'grpc-resume':
        // gRPC resume mining
        try {
          result = await resumeMining(ip, minerConfig);
        } catch (err) {
          result = { error: err.message };
        }
        break;

      case 'rest':
        // REST API call
        try {
          result = await fetchBraiinsRestApiStats(ip, minerConfig);
        } catch (err) {
          result = { error: err.message };
        }
        break;

      case 'graphql':
        // GraphQL API call
        try {
          result = await fetchBraiinsGraphQL(ip, minerConfig);
        } catch (err) {
          result = { error: err.message };
        }
        break;

      case 'status':
        // Get mining status (paused/running)
        try {
          result = await getMiningStatus(ip);
        } catch (err) {
          result = { error: err.message };
        }
        break;

      case 'state':
        // Get current control state
        result = {
          controlState: minerControlState[ip] || {},
          minerConfig: {
            ip: minerConfig.ip,
            name: minerConfig.name,
            username: minerConfig.username,
            autoControl: minerConfig.autoControl
          }
        };
        break;

      default:
        return res.status(400).json({ error: `Unknown command type: ${commandType}` });
    }

    const duration = Date.now() - startTime;
    res.json({
      success: true,
      command,
      type: commandType,
      ip,
      duration: `${duration}ms`,
      result
    });
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error('API terminal error:', err);
    res.status(500).json({
      error: err.message,
      duration: `${duration}ms`
    });
  }
});

// Get available terminal commands
app.get('/api/terminal/commands', (req, res) => {
  res.json({
    commands: [
      { type: 'cgminer', description: 'CGMiner API commands (summary, stats, pools, devs, temps, fans, tunerstatus)', example: 'summary' },
      { type: 'grpc-login', description: 'Test gRPC authentication', example: '' },
      { type: 'grpc-pause', description: 'Pause mining via gRPC', example: '' },
      { type: 'grpc-resume', description: 'Resume mining via gRPC', example: '' },
      { type: 'rest', description: 'Fetch REST API stats', example: '' },
      { type: 'graphql', description: 'Fetch GraphQL API data', example: '' },
      { type: 'status', description: 'Get current mining status (paused/running)', example: '' },
      { type: 'state', description: 'Get current control state and miner config', example: '' }
    ]
  });
});

app.post('/api/config', async (req, res) => {
  try {
    console.log('Received config POST:', req.body);
    const existingConfig = await loadConfig();

    const newIP = req.body.minerIP || req.body.minerIp;
    const newCountry = req.body.country || existingConfig.country || 'norway';
    const newZone = req.body.electricityZone || existingConfig.electricityZone || 'NO5';

    const config = {
      ...existingConfig,
      minerIP: newIP || existingConfig.minerIP,
      currentProfile: req.body.currentProfile || existingConfig.currentProfile || 'medium',
      country: newCountry,
      electricityZone: newZone,
      gridFeeWeekdayDay: req.body.gridFeeWeekdayDay ?? existingConfig.gridFeeWeekdayDay ?? 0.50,
      gridFeeWeekendNight: req.body.gridFeeWeekendNight ?? existingConfig.gridFeeWeekendNight ?? 0.30,
      priceMode: req.body.priceMode || existingConfig.priceMode || 'norgespris',
      updatedAt: new Date().toISOString()
    };

    // Remove old gridFeePerKwh if it exists
    delete config.gridFeePerKwh;

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

// Add a new miner
app.post('/api/miners/add', async (req, res) => {
  try {
    const { ip, name } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'Miner IP is required' });
    }

    const config = await loadConfig();

    // Ensure miners array exists
    if (!config.miners) {
      config.miners = [];
    }

    // Check if miner already exists
    const exists = config.miners.some(m => m.ip === ip);
    if (exists) {
      return res.status(400).json({ error: 'Miner with this IP already exists' });
    }

    // Add new miner with optional credentials
    const { username, password } = req.body;
    const newMiner = {
      ip,
      name: name || `Miner ${config.miners.length + 1}`,
      powerProfile: 'medium',
      username: username || 'root',
      password: password || 'root'
    };

    // Run capability discovery for the new miner
    console.log(`[API] Running capability discovery for new miner ${ip}...`);
    try {
      newMiner.capabilities = await discoverMinerCapabilities(ip, newMiner);
    } catch (discErr) {
      console.error(`[API] Discovery failed for ${ip}: ${discErr.message}`);
      // Still add the miner, discovery will retry on first poll
    }

    config.miners.push(newMiner);
    await saveConfig(config);
    res.json({ success: true, config, capabilities: newMiner.capabilities || null });
  } catch (err) {
    console.error('Add miner error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Remove a miner
app.post('/api/miners/remove', async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'Miner IP is required' });
    }

    const config = await loadConfig();
    config.miners = config.miners.filter(m => m.ip !== ip);

    await saveConfig(config);
    res.json({ success: true, config });
  } catch (err) {
    console.error('Remove miner error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update miner details
app.post('/api/miners/update', async (req, res) => {
  try {
    const { ip, name, powerProfile, username, password } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'Miner IP is required' });
    }

    const config = await loadConfig();
    const miner = config.miners.find(m => m.ip === ip);

    if (!miner) {
      return res.status(404).json({ error: 'Miner not found' });
    }

    if (name) miner.name = name;
    if (powerProfile) miner.powerProfile = powerProfile;
    if (username !== undefined) miner.username = username;
    if (password !== undefined) miner.password = password;

    // Invalidate cached auth token when credentials change
    if (username !== undefined || password !== undefined) {
      invalidateAuthToken(ip);
    }

    await saveConfig(config);
    res.json({ success: true, config });
  } catch (err) {
    console.error('Update miner error:', err);
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

// Manual capability re-discovery endpoint
app.post('/api/miners/rediscover', async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'No miner IP provided' });
    }

    const config = await loadConfig();
    const miner = config.miners.find(m => m.ip === ip);

    if (!miner) {
      return res.status(404).json({ error: 'Miner not found in configuration' });
    }

    console.log(`[API] Manual capability re-discovery requested for ${ip}`);

    // Run full capability discovery
    miner.capabilities = await discoverMinerCapabilities(ip, miner);

    // Save the updated config
    await saveConfig(config);

    res.json({
      success: true,
      ip: ip,
      capabilities: miner.capabilities
    });
  } catch (err) {
    console.error('Capability re-discovery error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get miner capabilities
app.get('/api/miners/capabilities', async (req, res) => {
  try {
    const { ip } = req.query;
    const config = await loadConfig();

    if (ip) {
      const miner = config.miners.find(m => m.ip === ip);
      if (!miner) {
        return res.status(404).json({ error: 'Miner not found' });
      }
      return res.json({ ip, capabilities: miner.capabilities || null });
    }

    // Return capabilities for all miners
    const minerCapabilities = config.miners.map(m => ({
      ip: m.ip,
      name: m.name,
      capabilities: m.capabilities || null
    }));

    res.json({ miners: minerCapabilities });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    let history;
    try {
      history = await loadHistory();
    } catch (loadErr) {
      console.error('Failed to load history file:', loadErr);
      // Return empty history instead of crashing
      history = { version: 2, hourlySnapshots: [], dailyAverages: [] };
    }

    // Ensure history has the expected structure
    if (!history || typeof history !== 'object') {
      console.error('History is not an object, resetting');
      history = { version: 2, hourlySnapshots: [], dailyAverages: [] };
    }
    if (!Array.isArray(history.hourlySnapshots)) {
      console.warn('hourlySnapshots is not an array, resetting');
      history.hourlySnapshots = [];
    }
    if (!Array.isArray(history.dailyAverages)) {
      console.warn('dailyAverages is not an array, resetting');
      history.dailyAverages = [];
    }

    // Support fractional days (e.g., 0.0417 for 1 hour, 0.5 for 12 hours)
    // Also support 'hours' parameter for convenience
    let days;
    if (req.query.hours) {
      days = parseFloat(req.query.hours) / 24;
    } else {
      days = parseFloat(req.query.days) || 7;
    }
    const minerIp = req.query.minerIp;
    const cutoff = new Date();
    cutoff.setTime(cutoff.getTime() - (days * 24 * 60 * 60 * 1000));

    // For backward compatibility, convert v2 format to v1-style entries
    let entries = [];

    // Add hourly snapshots (with null safety)
    (history.hourlySnapshots || []).forEach(snapshot => {
      const snapshotTime = new Date(snapshot.timestamp);
      if (snapshotTime >= cutoff && snapshot.miners && Array.isArray(snapshot.miners)) {
        const market = snapshot.market || {};
        snapshot.miners.forEach(miner => {
          entries.push({
            timestamp: snapshot.timestamp,
            minerIp: miner.ip,
            minerName: miner.name,
            hashrate: miner.hashrate,
            power: miner.power,
            temperature: miner.temperature,
            electricityPrice: market.electricityPrice,
            btcPrice: market.btcPriceNOK,
            networkDifficulty: market.networkDifficulty,
            dailyProfit: miner.dailyProfit,
            effectiveSCOP: miner.scop,
            isPaused: miner.isPaused,
            autoControlEnabled: miner.autoControlEnabled
          });
        });
      }
    });

    // For longer time ranges, include daily averages if needed
    if (days > 7) {
      (history.dailyAverages || []).forEach(daily => {
        const dailyDate = new Date(daily.date);
        if (dailyDate >= cutoff && daily.aggregate && daily.market) {
          // Create a synthetic entry representing the daily average
          entries.push({
            timestamp: daily.date + 'T12:00:00.000Z',
            minerIp: 'daily-average',
            minerName: 'Daily Average',
            hashrate: daily.aggregate.avgHashrate,
            power: daily.aggregate.avgPower,
            temperature: daily.aggregate.avgTemperature,
            electricityPrice: daily.market.avgElectricityPrice,
            btcPrice: daily.market.avgBtcPrice,
            networkDifficulty: daily.market.avgDifficulty,
            dailyProfit: daily.aggregate.totalDailyProfit,
            effectiveSCOP: daily.aggregate.avgSCOP,
            isDaily: true,
            sampleCount: daily.sampleCount
          });
        }
      });
    }

    // Filter by miner IP if specified
    if (minerIp) {
      entries = entries.filter(e => e.minerIp === minerIp);
    }

    // Sort by timestamp
    entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({
      entries,
      version: history.version || 1,
      hasHourlyData: history.hourlySnapshots?.length > 0,
      hasDailyData: history.dailyAverages?.length > 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get alert history
app.get('/api/alerts/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ alerts: alertHistory.slice(-limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update alert settings
app.post('/api/alerts/config', async (req, res) => {
  try {
    const config = await loadConfig();
    config.alerts = {
      ...config.alerts,
      ...req.body
    };
    await saveConfig(config);
    res.json({ success: true, alerts: config.alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear alert history
app.post('/api/alerts/clear', async (req, res) => {
  try {
    alertHistory = [];
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update history sample interval
app.post('/api/history/interval', async (req, res) => {
  try {
    const { interval } = req.body;

    // Validate interval (1, 5, 10, 15, 30, or 60 minutes)
    const validIntervals = [1, 5, 10, 15, 30, 60];
    if (!validIntervals.includes(interval)) {
      return res.status(400).json({
        error: `Invalid interval. Must be one of: ${validIntervals.join(', ')} minutes`
      });
    }

    const config = await loadConfig();
    config.historySampleInterval = interval;
    await saveConfig(config);

    // Restart the history scheduler with the new interval
    await startHistoryScheduler();

    res.json({
      success: true,
      interval,
      message: `History sampling interval updated to ${interval} minute(s)`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get history settings
app.get('/api/history/settings', async (req, res) => {
  try {
    const config = await loadConfig();
    const history = await loadHistory();

    res.json({
      sampleInterval: config.historySampleInterval || 5,
      validIntervals: [1, 5, 10, 15, 30, 60],
      snapshotCount: history.hourlySnapshots?.length || 0,
      dailyAverageCount: history.dailyAverages?.length || 0,
      oldestSnapshot: history.hourlySnapshots?.[0]?.timestamp || null,
      newestSnapshot: history.hourlySnapshots?.[history.hourlySnapshots.length - 1]?.timestamp || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to diagnose history issues
app.get('/api/history/debug', async (req, res) => {
  try {
    const result = {
      dataDir: DATA_DIR,
      historyFile: HISTORY_FILE,
      fileExists: false,
      fileSize: null,
      fileContent: null,
      parseError: null,
      loadedHistory: null
    };

    // Check if file exists and get its size
    try {
      const stats = await fs.stat(HISTORY_FILE);
      result.fileExists = true;
      result.fileSize = stats.size;
    } catch (statErr) {
      result.fileExists = false;
      result.statError = statErr.message;
    }

    // Try to read raw file content (first 1000 chars)
    if (result.fileExists) {
      try {
        const rawContent = await fs.readFile(HISTORY_FILE, 'utf8');
        result.fileContent = rawContent.substring(0, 1000) + (rawContent.length > 1000 ? '...[truncated]' : '');
        result.fullLength = rawContent.length;
      } catch (readErr) {
        result.readError = readErr.message;
      }
    }

    // Try to load history through the normal function
    try {
      const history = await loadHistory();
      result.loadedHistory = {
        version: history.version,
        hourlySnapshotsCount: history.hourlySnapshots?.length || 0,
        dailyAveragesCount: history.dailyAverages?.length || 0,
        isHourlyArray: Array.isArray(history.hourlySnapshots),
        isDailyArray: Array.isArray(history.dailyAverages)
      };
    } catch (loadErr) {
      result.loadError = loadErr.message;
      result.loadStack = loadErr.stack;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ============================================================================
// Background Miner Polling
// ============================================================================

const MINER_POLL_INTERVAL = 5000; // Poll miners every 5 seconds

async function pollMiners() {
  if (minerStatsCache.isPolling) {
    return; // Skip if already polling
  }

  minerStatsCache.isPolling = true;

  try {
    const config = await loadConfig();

    if (!config.miners || config.miners.length === 0) {
      minerStatsCache.miners = [];
      minerStatsCache.alerts = [];
      minerStatsCache.fetchedAt = Date.now();
      return;
    }

    // Fetch stats for all miners in parallel
    const minerStatsPromises = config.miners.map(async (miner) => {
      try {
        // Check if capability discovery is needed
        const { rediscover, reason } = shouldRediscover(miner);
        if (rediscover) {
          console.log(`[Poll] ${miner.ip}: Discovery needed - ${reason}`);
          try {
            miner.capabilities = await discoverMinerCapabilities(miner.ip, miner);
            // Save the updated capabilities to config
            await saveConfig(config);
          } catch (discErr) {
            console.error(`[Poll] ${miner.ip}: Discovery failed - ${discErr.message}`);
          }
        }

        // Use optimized polling if capabilities are available, otherwise fall back to full getMinerStats
        let stats;
        if (miner.capabilities?.dataSources && Object.keys(miner.capabilities.dataSources).length > 0) {
          stats = await getMinerStatsOptimized(miner.ip, miner);
        } else {
          // Fall back to full getMinerStats for first run or if discovery failed
          stats = await getMinerStats(miner.ip, miner);
        }

        // Track consecutive failures - reset on success
        if (miner.capabilities) {
          miner.capabilities.consecutiveFailures = 0;
        }

        // Check SCOP thresholds and auto-control if enabled
        if (miner.autoControl?.enabled && stats.efficiency) {
          await checkSCOPThresholds(miner.ip, stats, miner);
        }

        // Check auto mining control (comprehensive hardware monitoring) if enabled
        if (miner.autoMiningControl?.enabled) {
          await checkAutoMiningControl(miner.ip, stats, miner);
        }

        // Get current control state with enhanced details
        const controlState = minerControlState[miner.ip] || {};

        return {
          ...stats,
          minerIp: miner.ip,
          minerName: miner.name,
          powerProfile: miner.powerProfile,
          autoControl: miner.autoControl || { enabled: false },
          autoMiningControl: miner.autoMiningControl || { enabled: false },
          autoMiningControlState: controlState.autoMiningControlState || null,
          autoControlLogs: (autoControlLogs[miner.ip] || []).slice(0, 20),
          isPaused: controlState.isPaused || false,
          // Enhanced auto-control state
          autoControlState: {
            intendedState: controlState.intendedState || null,
            stateReason: controlState.stateReason || null,
            stateMatches: controlState.intendedState === null ? null :
              (controlState.isPaused ? 'paused' : 'mining') === controlState.intendedState,
            lastControlAction: controlState.lastControlAction || null,
            controlAttempts: controlState.controlAttempts || 0,
            lastSyncError: controlState.lastSyncError || null,
            // Efficiency tracking for projected SCOP
            scopUsed: controlState.scopUsed || null,
            scopType: controlState.scopType || null,
            projectedSCOP: controlState.projectedSCOP || null,
            projectedSource: controlState.projectedSource || null,
            measuredPower: controlState.measuredPower || null,
            measuredHashrate: controlState.measuredHashrate || null,
            measuredEfficiency: controlState.measuredEfficiency || null,
            measuredAvgPower: controlState.measuredAvgPower || null,
            measuredAvgHashrate: controlState.measuredAvgHashrate || null,
            measuredAvgEfficiency: controlState.measuredAvgEfficiency || null,
            projectedPower: controlState.projectedPower || null,
            projectedHashrate: controlState.projectedHashrate || null,
            lastEfficiencyUpdate: controlState.lastEfficiencyUpdate || null,
            // Best 1h efficiency tracking
            best1hPower: controlState.efficiencyTracking?.best1hPower || null,
            best1hHashrate: controlState.efficiencyTracking?.best1hHashrate || null,
            best1hEfficiency: controlState.efficiencyTracking?.best1hEfficiency || null,
            best1hTimestamp: controlState.efficiencyTracking?.best1hTimestamp || null
          }
        };
      } catch (err) {
        console.error(`[Poll] ${miner.ip}: Error - ${err.message}`);

        // Track consecutive failures for re-discovery
        if (miner.capabilities) {
          miner.capabilities.consecutiveFailures = (miner.capabilities.consecutiveFailures || 0) + 1;
          miner.capabilities.lastFailure = new Date().toISOString();
        }

        const controlState = minerControlState[miner.ip] || {};
        return {
          minerIp: miner.ip,
          minerName: miner.name,
          error: err.message,
          powerProfile: miner.powerProfile,
          autoControl: miner.autoControl || { enabled: false },
          autoMiningControl: miner.autoMiningControl || { enabled: false },
          autoMiningControlState: controlState.autoMiningControlState || null,
          autoControlLogs: (autoControlLogs[miner.ip] || []).slice(0, 20),
          isPaused: controlState.isPaused || false,
          // Enhanced auto-control state
          autoControlState: {
            intendedState: controlState.intendedState || null,
            stateReason: controlState.stateReason || null,
            stateMatches: controlState.intendedState === null ? null :
              (controlState.isPaused ? 'paused' : 'mining') === controlState.intendedState,
            lastControlAction: controlState.lastControlAction || null,
            controlAttempts: controlState.controlAttempts || 0,
            lastSyncError: controlState.lastSyncError || null,
            // Efficiency tracking for projected SCOP
            scopUsed: controlState.scopUsed || null,
            scopType: controlState.scopType || null,
            projectedSCOP: controlState.projectedSCOP || null,
            projectedSource: controlState.projectedSource || null,
            measuredPower: controlState.measuredPower || null,
            measuredHashrate: controlState.measuredHashrate || null,
            measuredEfficiency: controlState.measuredEfficiency || null,
            measuredAvgPower: controlState.measuredAvgPower || null,
            measuredAvgHashrate: controlState.measuredAvgHashrate || null,
            measuredAvgEfficiency: controlState.measuredAvgEfficiency || null,
            projectedPower: controlState.projectedPower || null,
            projectedHashrate: controlState.projectedHashrate || null,
            lastEfficiencyUpdate: controlState.lastEfficiencyUpdate || null,
            // Best 1h efficiency tracking
            best1hPower: controlState.efficiencyTracking?.best1hPower || null,
            best1hHashrate: controlState.efficiencyTracking?.best1hHashrate || null,
            best1hEfficiency: controlState.efficiencyTracking?.best1hEfficiency || null,
            best1hTimestamp: controlState.efficiencyTracking?.best1hTimestamp || null
          }
        };
      }
    });

    const minersStats = await Promise.all(minerStatsPromises);

    // Check for alerts on all miners
    const newAlerts = [];
    if (config.alerts) {
      for (const stats of minersStats) {
        const alerts = checkAlerts(stats, config.alerts, stats.minerName);
        newAlerts.push(...alerts);
      }
    }

    // Update the cache
    minerStatsCache.miners = minersStats;
    minerStatsCache.alerts = newAlerts;
    minerStatsCache.fetchedAt = Date.now();

    // Log connection status on first successful poll or status changes
    const onlineCount = minersStats.filter(m => !m.error).length;
    const totalCount = minersStats.length;
    console.log(`⛏️  Miner poll complete: ${onlineCount}/${totalCount} miners online`);

  } catch (err) {
    console.error('Background miner polling error:', err);
  } finally {
    minerStatsCache.isPolling = false;
  }
}

function startBackgroundMinerPolling() {
  console.log('🔄 Starting background miner polling...');

  // Initial poll
  pollMiners();

  // Set up recurring poll
  setInterval(pollMiners, MINER_POLL_INTERVAL);
}

// Store interval ID so we can restart the scheduler when config changes
let historySchedulerInterval = null;

/**
 * Background history snapshot scheduler
 * Saves snapshots at the configured interval (default: 5 minutes)
 */
async function startHistoryScheduler() {
  const config = await loadConfig();
  const intervalMinutes = config.historySampleInterval || 5;
  const intervalMs = intervalMinutes * 60 * 1000;

  console.log(`📊 Starting history snapshot scheduler (interval: ${intervalMinutes} minutes)...`);

  // Clear any existing interval
  if (historySchedulerInterval) {
    clearInterval(historySchedulerInterval);
  }

  // Calculate time until next aligned interval
  // For 5-minute intervals, align to :00, :05, :10, etc.
  const now = new Date();
  const minutesSinceHour = now.getMinutes();
  const minutesUntilNextInterval = intervalMinutes - (minutesSinceHour % intervalMinutes);
  const msUntilNextInterval = minutesUntilNextInterval * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

  // Save first snapshot immediately (so we have data right away)
  console.log('📊 Saving initial history snapshot...');
  await saveHistorySnapshot(minerStatsCache.miners);

  // Schedule subsequent snapshots at aligned intervals
  setTimeout(() => {
    // Save at the next aligned interval
    saveHistorySnapshot(minerStatsCache.miners);

    // Then continue at the configured interval
    historySchedulerInterval = setInterval(() => {
      saveHistorySnapshot(minerStatsCache.miners);
    }, intervalMs);
  }, msUntilNextInterval);

  console.log(`📊 Next aligned snapshot in ${Math.round(msUntilNextInterval / 1000 / 60)} minutes, then every ${intervalMinutes} minutes`);
}

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

  // Start background miner polling immediately (miners connect before any client opens the dashboard)
  startBackgroundMinerPolling();

  // Start history snapshot scheduler after a short delay to let miner data be collected first
  setTimeout(async () => {
    await startHistoryScheduler();
  }, 10000); // 10 second delay to allow first miner poll to complete

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

  wss.on('connection', async (ws) => {
    console.log('🔌 WebSocket client connected');
    let interval;

    const sendCachedStats = () => {
      try {
        // Send cached stats immediately - no waiting for miner polling
        const response = {
          miners: minerStatsCache.miners,
          electricity: electricityPriceCache,
          btcPrice: {
            usd: btcPriceCache.priceUSD,
            nok: btcPriceCache.priceNOK,
            eur: btcPriceCache.priceEUR,
            sek: btcPriceCache.priceSEK,
            updatedAt: btcPriceCache.fetchedAt
          },
          network: networkStatsCache,
          alerts: minerStatsCache.alerts,
          alertHistory: alertHistory.slice(-20)
        };

        ws.send(JSON.stringify(response));
      } catch (err) {
        console.error('WebSocket stats error:', err);
        ws.send(JSON.stringify({
          error: err.message,
          miners: [],
          electricity: electricityPriceCache,
          btcPrice: {
            usd: btcPriceCache.priceUSD,
            nok: btcPriceCache.priceNOK,
            eur: btcPriceCache.priceEUR,
            sek: btcPriceCache.priceSEK,
            updatedAt: btcPriceCache.fetchedAt
          },
          network: networkStatsCache
        }));
      }
    };

    // Send cached stats immediately on connection
    sendCachedStats();

    // Send updated stats to client every 5 seconds (synced with background polling)
    interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        sendCachedStats();
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