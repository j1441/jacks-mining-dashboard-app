// lib/minerClient.js — per-miner Braiins OS+ gRPC wrapper (+ cgminer TCP fallback reads).
//
// Single responsibility: talk to one miner. Loads the vendored bos/v1 protos once
// (module-level cache shared by all instances), creates each gRPC service client
// exactly once per instance and reuses it for the process lifetime (close() only on
// miner removal/shutdown), caches the auth token with expiry and transparently
// refreshes it once on UNAUTHENTICATED, applies a 10 s deadline to every call, and
// verifies every write by read-back (throws Error with .verifyFailed=true on mismatch).
//
// getSnapshot() fans out the fast-cadence reads in parallel (Promise.allSettled) and
// returns partial results + errors[]; slow-cadence reads (GetMinerConfiguration,
// GetErrors, GetConstraints) are cached for 60 s between ticks. If GetMinerStats
// degrades, hashrate/pools fall back to the cgminer TCP API (reads only).
//
// Field-name traps handled here (see DESIGN §0): Power.watt is uint64 → string
// (longs: String); hashrates arrive as gigahash_per_second; chip temp is nested
// (highest_chip_temp.temperature.degree_c); cooling config lives under the
// `temperature` field of GetMinerConfigurationResponse; SetDPSRequest's flag field
// is `enable` (NOT `enabled` like the response — proto-loader silently drops unknown
// request keys, hence read-back verification and test/proto-roundtrip.test.js).
//
// Exports: { MinerClient, loadProtos } per CONTRACTS, plus pure parser helpers
// (parseHashboards, parseTunerState, parseMinerStats, parseCooling,
// parseConfiguration, parseConstraints, parseMinerErrors, parseCgminerSummary,
// parseCgminerPools, parseOutOfRangeBounds) unit-tested against
// test/fixtures/live-s19jpro.json.

'use strict';

const path = require('path');
const net = require('net');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const log = (...a) => console.log('[minerClient]', ...a);

const DEADLINE_MS = 10000;      // per-call gRPC deadline
const SLOW_CADENCE_MS = 60000;  // config/errors/constraints refresh interval
const SAVE_AND_APPLY = 'SAVE_ACTION_SAVE_AND_APPLY';

// ---------------------------------------------------------------------------
// Proto loading (module-level cache — loaded once per process)
// ---------------------------------------------------------------------------

const PROTO_ROOT = path.resolve(__dirname, '..', 'proto');
const PROTO_FILES = ['authentication', 'actions', 'configuration', 'cooling', 'miner', 'performance']
  .map((name) => path.join(PROTO_ROOT, 'bos', 'v1', `${name}.proto`));

// Options chosen to match the captured fixtures exactly: snake_case field names,
// uint64 as strings, enums as strings, oneof indicator fields present.
const LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [PROTO_ROOT],
};

let protoCache = null;

function loadProtos() {
  if (!protoCache) {
    const packageDefinition = protoLoader.loadSync(PROTO_FILES, LOADER_OPTIONS);
    protoCache = grpc.loadPackageDefinition(packageDefinition);
  }
  return protoCache;
}

// ---------------------------------------------------------------------------
// Pure parsers (raw gRPC JSON → contract shapes) — unit-tested against fixtures
// ---------------------------------------------------------------------------

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function tempC(t) {
  return t ? numOrNull(t.degree_c) : null;
}

function ghsToThs(h) {
  if (!h) return 0;
  const n = Number(h.gigahash_per_second);
  return Number.isNaN(n) ? 0 : n / 1000;
}

// GetHashboardsResponse → [{id, enabled, hashing, boardTempC, chipTempC, hashrateThs}]
function parseHashboards(raw) {
  const list = (raw && raw.hashboards) || [];
  return list.map((hb) => {
    const rh = hb.stats && hb.stats.real_hashrate ? hb.stats.real_hashrate : null;
    const hashrateThs = rh ? ghsToThs(rh.last_1m) : 0;
    return {
      id: hb.id,
      enabled: !!hb.enabled,
      hashing: hashrateThs > 0,
      boardTempC: tempC(hb.board_temp),
      chipTempC: hb.highest_chip_temp ? tempC(hb.highest_chip_temp.temperature) : null,
      hashrateThs,
    };
  });
}

// GetTunerStateResponse → {state, targetW}. States outside the contract enum
// (e.g. TUNER_STATE_CONTINUOUS) map to 'UNKNOWN'.
const TUNER_STATES = ['STABLE', 'TUNING', 'PREHEAT', 'ERROR', 'DISABLED'];

function parseTunerState(raw) {
  const short = String((raw && raw.overall_tuner_state) || '').replace('TUNER_STATE_', '');
  const state = TUNER_STATES.includes(short) ? short : 'UNKNOWN';
  let targetW = 0;
  const pm = raw && raw.power_target_mode_state;
  if (pm && pm.current_target) targetW = numOrNull(pm.current_target.watt) || 0;
  return { state, targetW };
}

// GetMinerStatsResponse → {wallW, efficiencyJPerTh, hashrate{m1,m15,h1,h24}, poolStats}
// wallW comes from power_stats.approximated_consumption.watt (uint64 → string).
function parseMinerStats(raw) {
  const rh = (raw && raw.miner_stats && raw.miner_stats.real_hashrate) || {};
  const ps = raw && raw.power_stats;
  const pool = raw && raw.pool_stats;
  return {
    wallW: ps && ps.approximated_consumption ? numOrNull(ps.approximated_consumption.watt) : null,
    efficiencyJPerTh: ps && ps.efficiency ? numOrNull(ps.efficiency.joule_per_terahash) : null,
    hashrate: {
      m1: ghsToThs(rh.last_1m),
      m15: ghsToThs(rh.last_15m),
      h1: ghsToThs(rh.last_1h),
      h24: ghsToThs(rh.last_24h),
    },
    poolStats: {
      accepted: pool ? numOrNull(pool.accepted_shares) || 0 : 0,
      rejected: pool ? numOrNull(pool.rejected_shares) || 0 : 0,
    },
  };
}

// GetCoolingStateResponse → {fans:[{rpm, ratio}], highestTempC}
// (cooling *mode* is not in this response — it comes from parseConfiguration)
function parseCooling(raw) {
  const fans = ((raw && raw.fans) || []).map((f) => ({
    rpm: numOrNull(f.rpm) || 0,
    ratio: f.target_speed_ratio !== null && f.target_speed_ratio !== undefined
      ? Number(f.target_speed_ratio) : null,
  }));
  const ht = raw && raw.highest_temperature;
  return { fans, highestTempC: ht ? tempC(ht.temperature) : null };
}

const COOLING_MODES = ['auto', 'manual', 'immersion'];

// GetMinerConfigurationResponse → {pools, cooling, dps, tuner}
// ⚠ cooling config lives under the field named `temperature`.
function parseConfiguration(raw) {
  const temp = raw && raw.temperature;
  let modeName = null;
  if (temp) {
    if (typeof temp.mode === 'string' && temp.mode) modeName = temp.mode; // oneof indicator
    else modeName = ['auto', 'manual', 'immersion', 'hydro', 'disabled'].find((k) => temp[k]) || null;
  }
  const active = temp && modeName && temp[modeName] ? temp[modeName] : null;
  const cooling = {
    mode: COOLING_MODES.includes(modeName) ? modeName : 'unknown',
    targetC: active ? tempC(active.target_temperature) : null,
    hotC: active ? tempC(active.hot_temperature) : null,
    dangerousC: active ? tempC(active.dangerous_temperature) : null,
    fanSpeedRatio: active && active.fan_speed_ratio !== null && active.fan_speed_ratio !== undefined
      ? Number(active.fan_speed_ratio) : null,
  };
  const pools = ((raw && raw.pool_groups) || []).flatMap((g) =>
    ((g && g.pools) || []).map((p) => ({ url: p.url, user: p.user })));
  const dpsRaw = raw && raw.dps;
  const tunerRaw = raw && raw.tuner;
  return {
    pools,
    cooling,
    dps: dpsRaw ? { enabled: !!dpsRaw.enabled } : null,
    tuner: tunerRaw
      ? {
          enabled: !!tunerRaw.enabled,
          powerTargetW: tunerRaw.power_target ? numOrNull(tunerRaw.power_target.watt) : null,
        }
      : null,
  };
}

// GetConstraintsResponse → {minTargetW, maxTargetW, defaultTargetW}|null
function parseConstraints(raw) {
  const pt = raw && raw.tuner_constraints && raw.tuner_constraints.power_target;
  if (!pt || !pt.min || !pt.max) return null;
  return {
    minTargetW: numOrNull(pt.min.watt),
    maxTargetW: numOrNull(pt.max.watt),
    defaultTargetW: pt.default ? numOrNull(pt.default.watt) : null,
  };
}

// GetErrorsResponse → [{timestamp, message, codes:[string]}]
function parseMinerErrors(raw) {
  return ((raw && raw.errors) || []).map((e) => ({
    timestamp: e.timestamp || null,
    message: e.message || '',
    codes: (e.error_codes || []).map((c) => c.code),
  }));
}

// cgminer `summary` → {hashrate:{m1,m15,h1,h24}} (TH/s; cgminer has no 1h window → null)
function parseCgminerSummary(raw) {
  const s = (raw && raw.SUMMARY && raw.SUMMARY[0]) || {};
  const mhsToThs = (k) => {
    const n = Number(s[k]);
    return Number.isNaN(n) ? 0 : n / 1e6;
  };
  return {
    hashrate: { m1: mhsToThs('MHS 1m'), m15: mhsToThs('MHS 15m'), h1: null, h24: mhsToThs('MHS 24h') },
  };
}

// cgminer `pools` → [{url, user, active, accepted, rejected}]
function parseCgminerPools(raw) {
  return ((raw && raw.POOLS) || []).map((p) => ({
    url: p.URL,
    user: p.User,
    active: !!p['Stratum Active'],
    accepted: numOrNull(p.Accepted) || 0,
    rejected: numOrNull(p.Rejected) || 0,
  }));
}

// OUT_OF_RANGE error detail 'min: Some(944), max: Some(6435)' → {min, max}|null
function parseOutOfRangeBounds(message) {
  const m = /min:\s*Some\((\d+)\)[\s\S]*?max:\s*Some\((\d+)\)/.exec(String(message || ''));
  if (!m) return null;
  return { min: Number(m[1]), max: Number(m[2]) };
}

function verifyError(what, expected, actual) {
  const err = new Error(`verify failed: ${what} — expected ${JSON.stringify(expected)}, read back ${JSON.stringify(actual)}`);
  err.verifyFailed = true;
  return err;
}

// ---------------------------------------------------------------------------
// MinerClient
// ---------------------------------------------------------------------------

class MinerClient {
  constructor({ id, ip, username = 'root', password = 'root', grpcPort = 50051, cgminerPort = 4028 }) {
    this.id = id;
    this.ip = ip;
    this.username = username;
    this.password = password;
    this.grpcPort = grpcPort;
    this.cgminerPort = cgminerPort;

    const pkg = loadProtos().braiins.bos.v1;
    const address = `${ip}:${grpcPort}`;
    const creds = grpc.credentials.createInsecure();
    // Created ONCE per instance, reused for the process lifetime (v1 leaked channels).
    this._clients = {
      auth: new pkg.AuthenticationService(address, creds),
      miner: new pkg.MinerService(address, creds),
      perf: new pkg.PerformanceService(address, creds),
      cooling: new pkg.CoolingService(address, creds),
      config: new pkg.ConfigurationService(address, creds),
      actions: new pkg.ActionsService(address, creds),
    };

    this._token = null;
    this._tokenExpiresAt = 0;
    this._loginPromise = null; // single-flight login

    // Slow-cadence cache (parsed values), refreshed every SLOW_CADENCE_MS.
    this._slow = { configuration: null, constraints: null, minerErrors: [], fetchedAt: 0 };

    this._sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- auth ---------------------------------------------------------------

  async _getToken(force = false) {
    if (!force && this._token && Date.now() < this._tokenExpiresAt) return this._token;
    if (!this._loginPromise) {
      this._loginPromise = (async () => {
        try {
          const res = await new Promise((resolve, reject) => {
            this._clients.auth.Login(
              { username: this.username, password: this.password },
              new grpc.Metadata(),
              { deadline: new Date(Date.now() + DEADLINE_MS) },
              (err, response) => (err ? reject(err) : resolve(response)),
            );
          });
          const timeoutS = Number(res.timeout_s) || 3600;
          this._token = res.token;
          // Renew a minute early (never below 30 s validity).
          this._tokenExpiresAt = Date.now() + Math.max(30, timeoutS - 60) * 1000;
          return this._token;
        } finally {
          this._loginPromise = null;
        }
      })();
    }
    return this._loginPromise;
  }

  // Promisified unary call with deadline + auth metadata.
  // On UNAUTHENTICATED: drop the cached token, re-login once, retry once.
  async _call(svc, method, request = {}) {
    const attempt = async (forceLogin) => {
      const metadata = new grpc.Metadata();
      metadata.set('authorization', await this._getToken(forceLogin));
      return new Promise((resolve, reject) => {
        this._clients[svc][method](
          request,
          metadata,
          { deadline: new Date(Date.now() + DEADLINE_MS) },
          (err, response) => (err ? reject(err) : resolve(response)),
        );
      });
    };
    try {
      return await attempt(false);
    } catch (err) {
      if (err && err.code === grpc.status.UNAUTHENTICATED) {
        log(`${this.id}: token rejected, re-authenticating`);
        this._token = null;
        return attempt(true);
      }
      throw err;
    }
  }

  // --- cgminer TCP fallback (reads only) ------------------------------------

  _cgminerCommand(command) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.ip, port: this.cgminerPort });
      sock.setTimeout(DEADLINE_MS);
      let buf = '';
      sock.on('connect', () => sock.write(JSON.stringify({ command })));
      sock.on('data', (d) => { buf += d.toString('utf8'); });
      sock.on('timeout', () => sock.destroy(new Error(`cgminer ${command}: timeout`)));
      sock.on('error', (err) => reject(new Error(`cgminer ${command}: ${err.message}`)));
      sock.on('close', () => {
        try {
          resolve(JSON.parse(buf.replace(/\x00+$/, '').trim()));
        } catch (err) {
          reject(new Error(`cgminer ${command}: bad response (${err.message})`));
        }
      });
    });
  }

  // --- snapshot -------------------------------------------------------------

  async getSnapshot() {
    const ts = new Date().toISOString();
    const errors = [];

    const fastCalls = [
      ['hashboards', 'miner', 'GetHashboards'],
      ['details', 'miner', 'GetMinerDetails'],
      ['stats', 'miner', 'GetMinerStats'],
      ['tunerState', 'perf', 'GetTunerState'],
      ['coolingState', 'cooling', 'GetCoolingState'],
    ];
    const slowDue = Date.now() - this._slow.fetchedAt >= SLOW_CADENCE_MS;
    const slowCalls = slowDue
      ? [
          ['configuration', 'config', 'GetMinerConfiguration'],
          ['constraints', 'config', 'GetConstraints'],
          ['minerErrors', 'miner', 'GetErrors'],
        ]
      : [];
    const calls = fastCalls.concat(slowCalls);

    const settled = await Promise.allSettled(calls.map(([, svc, method]) => this._call(svc, method, {})));
    const raw = {};
    settled.forEach((result, i) => {
      const [key, , method] = calls[i];
      if (result.status === 'fulfilled') raw[key] = result.value;
      else errors.push(`${method}: ${(result.reason && result.reason.message) || result.reason}`);
    });

    if (slowDue) {
      if (raw.configuration) this._slow.configuration = parseConfiguration(raw.configuration);
      if (raw.constraints) this._slow.constraints = parseConstraints(raw.constraints);
      if (raw.minerErrors) this._slow.minerErrors = parseMinerErrors(raw.minerErrors);
      // Only advance the clock when the whole slow set succeeded, so failed
      // reads are retried on the next tick rather than in a minute.
      if (raw.configuration && raw.constraints && raw.minerErrors) this._slow.fetchedAt = Date.now();
    }

    const online = fastCalls.some(([key]) => raw[key] !== undefined);
    const boards = raw.hashboards ? parseHashboards(raw.hashboards) : [];
    const tuner = raw.tunerState ? parseTunerState(raw.tunerState) : { state: 'UNKNOWN', targetW: 0 };
    const stats = raw.stats ? parseMinerStats(raw.stats) : null;
    const coolingState = raw.coolingState ? parseCooling(raw.coolingState) : { fans: [], highestTempC: null };
    const conf = this._slow.configuration;

    let hashrate = stats ? stats.hashrate : null;
    // gRPC pool config carries no live "active" flag; assume the first
    // (highest-priority) pool is active and attach the aggregate share counters
    // to it. The cgminer fallback below reports true per-pool state.
    let pools = conf
      ? conf.pools.map((p, i) => ({
          url: p.url,
          user: p.user,
          active: i === 0,
          accepted: i === 0 && stats ? stats.poolStats.accepted : 0,
          rejected: i === 0 && stats ? stats.poolStats.rejected : 0,
        }))
      : [];

    if (!stats) {
      try {
        const [summary, cgPools] = await Promise.all([
          this._cgminerCommand('summary'),
          this._cgminerCommand('pools'),
        ]);
        hashrate = parseCgminerSummary(summary).hashrate;
        pools = parseCgminerPools(cgPools);
      } catch (err) {
        errors.push(`cgminer fallback: ${err.message}`);
      }
    }

    const status = raw.details ? String(raw.details.status || '') : '';
    const minerStatus = status ? status.replace('MINER_STATUS_', '') : 'UNKNOWN';

    return {
      ts,
      online,
      paused: minerStatus === 'PAUSED',
      model: raw.details && raw.details.miner_identity ? raw.details.miner_identity.miner_model : null,
      minerStatus,
      boards,
      boardsEnabledCount: boards.filter((b) => b.enabled).length,
      boardsHashingCount: boards.filter((b) => b.hashing).length,
      tuner,
      wallW: stats ? stats.wallW : null,
      cooling: {
        mode: conf ? conf.cooling.mode : 'unknown',
        fans: coolingState.fans,
        highestTempC: coolingState.highestTempC,
      },
      pools,
      hashrate: hashrate || { m1: 0, m15: 0, h1: 0, h24: 0 },
      dps: conf ? conf.dps : null,
      constraints: this._slow.constraints,
      errors,
      minerErrors: this._slow.minerErrors, // structured GetErrors (alerts/dead-board input)
    };
  }

  // --- writes (all verified by read-back) -----------------------------------

  async setPowerTarget(watts) {
    const want = Math.round(watts);
    let applied = want;
    let clamped = false;
    const doSet = (w) =>
      this._call('perf', 'SetPowerTarget', {
        save_action: SAVE_AND_APPLY,
        power_target: { watt: String(w) },
      });
    try {
      await doSet(want);
    } catch (err) {
      const bounds = err && err.code === grpc.status.OUT_OF_RANGE
        ? parseOutOfRangeBounds(err.details || err.message)
        : null;
      if (!bounds) throw err;
      applied = Math.min(Math.max(want, bounds.min), bounds.max);
      clamped = true;
      log(`${this.id}: power target ${want} W out of range [${bounds.min}, ${bounds.max}] — retrying with ${applied} W`);
      await doSet(applied);
    }
    const readBack = parseTunerState(await this._call('perf', 'GetTunerState', {}));
    if (readBack.targetW !== applied) throw verifyError('power target', applied, readBack.targetW);
    return { targetW: applied, clamped };
  }

  async pause() {
    await this._call('actions', 'PauseMining', {});
    if (!(await this._awaitPausedState(true))) {
      throw verifyError('pause', 'MINER_STATUS_PAUSED', 'not paused');
    }
    return { paused: true };
  }

  async resume() {
    await this._call('actions', 'ResumeMining', {});
    if (!(await this._awaitPausedState(false))) {
      throw verifyError('resume', 'not paused', 'MINER_STATUS_PAUSED');
    }
    return { paused: false };
  }

  // Poll GetMinerDetails.status until it matches (pause/resume apply asynchronously).
  async _awaitPausedState(wantPaused) {
    for (let i = 0; i < 3; i++) {
      const details = await this._call('miner', 'GetMinerDetails', {});
      const paused = details.status === 'MINER_STATUS_PAUSED';
      if (paused === wantPaused) return true;
      if (i < 2) await this._sleep(1500);
    }
    return false;
  }

  async setBoards(enableIds = [], disableIds = []) {
    if (enableIds.length) {
      await this._call('miner', 'EnableHashboards', {
        save_action: SAVE_AND_APPLY,
        hashboard_ids: enableIds,
      });
    }
    if (disableIds.length) {
      await this._call('miner', 'DisableHashboards', {
        save_action: SAVE_AND_APPLY,
        hashboard_ids: disableIds,
      });
    }
    const boards = parseHashboards(await this._call('miner', 'GetHashboards', {}));
    const byId = new Map(boards.map((b) => [b.id, b]));
    for (const id of enableIds) {
      const b = byId.get(id);
      if (!b || !b.enabled) throw verifyError(`board ${id} enabled`, true, b ? b.enabled : 'missing');
    }
    for (const id of disableIds) {
      const b = byId.get(id);
      if (!b || b.enabled) throw verifyError(`board ${id} enabled`, false, b ? b.enabled : 'missing');
    }
    return { boards };
  }

  // → [{targetW, hashrateThs, boardW, createdAt}] (boardW = tuner's measured
  // per-run estimated board power draw; caller tags entries with the active board count)
  async listTunedProfiles() {
    const res = await this._call('perf', 'ListTargetProfiles', {});
    return ((res && res.power_target_profiles) || []).map((p) => ({
      targetW: p.target ? numOrNull(p.target.watt) : null,
      hashrateThs: p.measured_hashrate ? ghsToThs(p.measured_hashrate) : null,
      boardW: p.estimated_power_consumption ? numOrNull(p.estimated_power_consumption.watt) : null,
      createdAt: p.created && p.created.seconds
        ? new Date(Number(p.created.seconds) * 1000).toISOString()
        : null,
    }));
  }

  // cfg: {mode:'auto'|'manual'|'immersion', targetC?, hotC?, dangerousC?, fanSpeedRatio?}
  // AUTO defaults per DESIGN §0: target 60 / hot 80 / dangerous 90.
  async setCoolingMode(cfg) {
    const mode = cfg && cfg.mode;
    const t = (c) => ({ degree_c: c });
    const request = { save_action: SAVE_AND_APPLY };
    if (mode === 'auto') {
      request.auto = {
        target_temperature: t(cfg.targetC != null ? cfg.targetC : 60),
        hot_temperature: t(cfg.hotC != null ? cfg.hotC : 80),
        dangerous_temperature: t(cfg.dangerousC != null ? cfg.dangerousC : 90),
      };
    } else if (mode === 'manual') {
      request.manual = {
        fan_speed_ratio: cfg.fanSpeedRatio != null ? cfg.fanSpeedRatio : 1,
        hot_temperature: t(cfg.hotC != null ? cfg.hotC : 80),
        dangerous_temperature: t(cfg.dangerousC != null ? cfg.dangerousC : 90),
      };
    } else if (mode === 'immersion') {
      request.immersion = {
        hot_temperature: t(cfg.hotC != null ? cfg.hotC : 80),
        dangerous_temperature: t(cfg.dangerousC != null ? cfg.dangerousC : 90),
        target_temperature: t(cfg.targetC != null ? cfg.targetC : 60),
      };
    } else {
      throw new Error(`unsupported cooling mode: ${mode}`);
    }
    await this._call('cooling', 'SetCoolingMode', request);
    const conf = parseConfiguration(await this._call('config', 'GetMinerConfiguration', {}));
    this._slow.configuration = conf; // keep the slow cache fresh after a write
    if (conf.cooling.mode !== mode) throw verifyError('cooling mode', mode, conf.cooling.mode);
    return { cooling: conf.cooling };
  }

  // ⚠ request flag field is `enable`; response/config field is `enabled`.
  async setDps(enabled) {
    const want = !!enabled;
    await this._call('perf', 'SetDPS', { save_action: SAVE_AND_APPLY, enable: want });
    const conf = parseConfiguration(await this._call('config', 'GetMinerConfiguration', {}));
    this._slow.configuration = conf;
    if (!conf.dps || conf.dps.enabled !== want) {
      throw verifyError('dps.enabled', want, conf.dps ? conf.dps.enabled : null);
    }
    return { dps: conf.dps };
  }

  // Only on miner removal / process shutdown — channels are reused otherwise.
  async close() {
    for (const client of Object.values(this._clients)) client.close();
  }
}

module.exports = {
  MinerClient,
  loadProtos,
  parseHashboards,
  parseTunerState,
  parseMinerStats,
  parseCooling,
  parseConfiguration,
  parseConstraints,
  parseMinerErrors,
  parseCgminerSummary,
  parseCgminerPools,
  parseOutOfRangeBounds,
};
