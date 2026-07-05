// lib/configStore.js — single responsibility: load/validate/persist config.json (schema v2),
// including v1→v2 migration, corruption recovery, atomic queued saves, deep-merge updates
// that ignore redaction sentinels, and secret redaction for API output.
'use strict';

const fs = require('fs/promises');
const path = require('path');

const log = (...a) => console.log('[configStore]', ...a);

const REDACT_SENTINEL = '•••';

// Schema v2 defaults — matches DESIGN.md §4.3 exactly.
const DEFAULT_CONFIG = {
  version: 2,
  electricity: {
    country: 'norway', zone: 'NO5', timezone: 'Europe/Oslo',
    priceMode: 'spot_stromstotte',
    gridFee: { dayWeekday: 0.50, nightWeekend: 0.30, dayStartHour: 6, nightStartHour: 22 },
    householdBaseKWhMonth: 1500, subsidyCapKWhMonth: 5000,
  },
  heating: {
    demandSource: 'off', manualKW: 0, schedule: null,
    presets: [{ name: 'Off', kw: 0 }, { name: 'Eco', kw: 1.0 }, { name: 'Comfort', kw: 2.5 }],
    alt: { type: 'heatpump', scop: 3.0 },
  },
  economics: {
    poolFeePct: 0, startMarginNokH: 0.5, keepMarginNokH: 0.2,
    boardSwitch: { retuneMin: 45, wearNok: 2 },
  },
  alerts: {
    ntfy: { url: '', topic: '' }, telegram: { botToken: '', chatId: '' },
    rules: { offlineAfterS: 300, hashrateLowPct: 25 },
  },
  miners: [{
    id: 's19j4', ip: '192.168.1.89', name: 'S19j Pro',
    username: 'root', password: 'root',
    mode: 'auto', dryRun: true,
    manual: { boards: 1, targetW: 944 },
    limits: { minTargetW: 944, maxTargetW: 3500, allowedBoards: ['1', '2', '3'] },
    dwell: { powerMin: 15, boardsMin: 120, offMin: 20, deadbandW: 100 },
    safety: { derateChipTemp: 80, pauseChipTemp: 90, maxBoardTemp: 75,
              maxFanRpm: 6100, safetyStepW: 250 },
    cooling: { manage: false, mode: 'auto', targetC: 60 },
    dpsManage: 'leave',
  }],
  ui: { currency: 'NOK' },
  pollSeconds: 10,
};

const TOP_LEVEL_KEYS = new Set([
  'version', 'electricity', 'heating', 'economics', 'alerts', 'miners', 'ui',
  'pollSeconds', '_v1',
]);

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// ---------------------------------------------------------------------------
// Deep merge: objects merge recursively; arrays of {id} objects merge by id
// (so a PUT round-trip with redacted miner passwords keeps stored secrets);
// other arrays and scalars are replaced by the patch value.
function deepMerge(base, patch) {
  if (Array.isArray(patch)) {
    if (Array.isArray(base) && patch.every((p) => isPlainObject(p) && typeof p.id === 'string')) {
      return patch.map((p) => {
        const b = base.find((x) => isPlainObject(x) && x.id === p.id);
        return b ? deepMerge(b, p) : clone(p);
      });
    }
    return clone(patch);
  }
  if (isPlainObject(patch)) {
    if (!isPlainObject(base)) return clone(patch);
    const out = clone(base);
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return clone(patch);
}

// Remove any string value containing the redaction sentinel (in place, recursively),
// so redacted values round-tripped through the UI never clobber stored secrets.
function stripSentinels(obj) {
  if (Array.isArray(obj)) { obj.forEach(stripSentinels); return obj; }
  if (!isPlainObject(obj)) return obj;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.includes(REDACT_SENTINEL)) delete obj[k];
    else stripSentinels(v);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Validation (types + ranges). Throws Error on first problem found.
function fail(msg) { throw new Error(`config invalid: ${msg}`); }
function checkNum(v, name, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a number`);
  if (v < min || v > max) fail(`${name} out of range [${min}, ${max}]: ${v}`);
}
function checkStr(v, name, { nonEmpty = false } = {}) {
  if (typeof v !== 'string') fail(`${name} must be a string`);
  if (nonEmpty && v.trim() === '') fail(`${name} must not be empty`);
}
function checkBool(v, name) { if (typeof v !== 'boolean') fail(`${name} must be a boolean`); }
function checkEnum(v, name, values) {
  if (!values.includes(v)) fail(`${name} must be one of ${values.join('|')}: ${v}`);
}

function validateConfig(cfg) {
  if (!isPlainObject(cfg)) fail('root must be an object');
  for (const k of Object.keys(cfg)) if (!TOP_LEVEL_KEYS.has(k)) fail(`unknown top-level key "${k}"`);
  if (cfg.version !== 2) fail('version must be 2');
  checkNum(cfg.pollSeconds, 'pollSeconds', 2, 3600);

  const el = cfg.electricity;
  if (!isPlainObject(el)) fail('electricity must be an object');
  checkStr(el.country, 'electricity.country', { nonEmpty: true });
  checkStr(el.zone, 'electricity.zone', { nonEmpty: true });
  checkStr(el.timezone, 'electricity.timezone', { nonEmpty: true });
  checkEnum(el.priceMode, 'electricity.priceMode', ['spot_stromstotte', 'norgespris', 'spot']);
  if (!isPlainObject(el.gridFee)) fail('electricity.gridFee must be an object');
  checkNum(el.gridFee.dayWeekday, 'electricity.gridFee.dayWeekday', 0, 10);
  checkNum(el.gridFee.nightWeekend, 'electricity.gridFee.nightWeekend', 0, 10);
  checkNum(el.gridFee.dayStartHour, 'electricity.gridFee.dayStartHour', 0, 23);
  checkNum(el.gridFee.nightStartHour, 'electricity.gridFee.nightStartHour', 0, 23);
  checkNum(el.householdBaseKWhMonth, 'electricity.householdBaseKWhMonth', 0, 100000);
  checkNum(el.subsidyCapKWhMonth, 'electricity.subsidyCapKWhMonth', 0, 1000000);

  const he = cfg.heating;
  if (!isPlainObject(he)) fail('heating must be an object');
  checkEnum(he.demandSource, 'heating.demandSource', ['off', 'manual', 'schedule']);
  checkNum(he.manualKW, 'heating.manualKW', 0, 100);
  if (he.schedule !== null) {
    if (!Array.isArray(he.schedule) || he.schedule.length !== 168) fail('heating.schedule must be null or a 168-slot array');
    he.schedule.forEach((v, i) => checkNum(v, `heating.schedule[${i}]`, 0, 100));
  }
  if (!Array.isArray(he.presets)) fail('heating.presets must be an array');
  he.presets.forEach((p, i) => {
    checkStr(p.name, `heating.presets[${i}].name`, { nonEmpty: true });
    checkNum(p.kw, `heating.presets[${i}].kw`, 0, 100);
  });
  if (!isPlainObject(he.alt)) fail('heating.alt must be an object');
  checkEnum(he.alt.type, 'heating.alt.type', ['heatpump', 'resistive', 'none']);
  if (he.alt.type === 'heatpump') checkNum(he.alt.scop, 'heating.alt.scop', 0.5, 10);

  const ec = cfg.economics;
  if (!isPlainObject(ec)) fail('economics must be an object');
  checkNum(ec.poolFeePct, 'economics.poolFeePct', 0, 100);
  checkNum(ec.startMarginNokH, 'economics.startMarginNokH', 0, 1000);
  checkNum(ec.keepMarginNokH, 'economics.keepMarginNokH', 0, 1000);
  if (!isPlainObject(ec.boardSwitch)) fail('economics.boardSwitch must be an object');
  checkNum(ec.boardSwitch.retuneMin, 'economics.boardSwitch.retuneMin', 0, 1440);
  checkNum(ec.boardSwitch.wearNok, 'economics.boardSwitch.wearNok', 0, 1000);

  const al = cfg.alerts;
  if (!isPlainObject(al)) fail('alerts must be an object');
  if (!isPlainObject(al.ntfy)) fail('alerts.ntfy must be an object');
  checkStr(al.ntfy.url, 'alerts.ntfy.url');
  checkStr(al.ntfy.topic, 'alerts.ntfy.topic');
  if (!isPlainObject(al.telegram)) fail('alerts.telegram must be an object');
  checkStr(al.telegram.botToken, 'alerts.telegram.botToken');
  checkStr(String(al.telegram.chatId), 'alerts.telegram.chatId');
  if (!isPlainObject(al.rules)) fail('alerts.rules must be an object');
  checkNum(al.rules.offlineAfterS, 'alerts.rules.offlineAfterS', 30, 86400);
  checkNum(al.rules.hashrateLowPct, 'alerts.rules.hashrateLowPct', 1, 95);
  if (al.webhook !== undefined) {
    if (!isPlainObject(al.webhook)) fail('alerts.webhook must be an object');
    checkStr(al.webhook.url, 'alerts.webhook.url');
  }

  if (!Array.isArray(cfg.miners)) fail('miners must be an array');
  const ids = new Set();
  cfg.miners.forEach((m, i) => {
    const p = `miners[${i}]`;
    if (!isPlainObject(m)) fail(`${p} must be an object`);
    checkStr(m.id, `${p}.id`, { nonEmpty: true });
    if (typeof m.id === 'string' && !/^[A-Za-z0-9_-]+$/.test(m.id)) {
      fail(`${p}.id must match [A-Za-z0-9_-]+ (it is used in data file names)`);
    }
    if (ids.has(m.id)) fail(`${p}.id duplicated: ${m.id}`);
    ids.add(m.id);
    checkStr(m.ip, `${p}.ip`, { nonEmpty: true });
    checkStr(m.name, `${p}.name`, { nonEmpty: true });
    checkStr(m.username, `${p}.username`, { nonEmpty: true });
    checkStr(m.password, `${p}.password`);
    checkEnum(m.mode, `${p}.mode`, ['auto', 'manual', 'off']);
    checkBool(m.dryRun, `${p}.dryRun`);
    if (!isPlainObject(m.manual)) fail(`${p}.manual must be an object`);
    checkNum(m.manual.boards, `${p}.manual.boards`, 0, 8);
    checkNum(m.manual.targetW, `${p}.manual.targetW`, 0, 100000);
    if (!isPlainObject(m.limits)) fail(`${p}.limits must be an object`);
    checkNum(m.limits.minTargetW, `${p}.limits.minTargetW`, 1, 100000);
    checkNum(m.limits.maxTargetW, `${p}.limits.maxTargetW`, 1, 100000);
    if (m.limits.minTargetW > m.limits.maxTargetW) fail(`${p}.limits.minTargetW > maxTargetW`);
    if (!Array.isArray(m.limits.allowedBoards)) fail(`${p}.limits.allowedBoards must be an array`);
    m.limits.allowedBoards.forEach((b, j) => checkStr(b, `${p}.limits.allowedBoards[${j}]`, { nonEmpty: true }));
    if (!isPlainObject(m.dwell)) fail(`${p}.dwell must be an object`);
    checkNum(m.dwell.powerMin, `${p}.dwell.powerMin`, 0, 1440);
    checkNum(m.dwell.boardsMin, `${p}.dwell.boardsMin`, 0, 10080);
    checkNum(m.dwell.offMin, `${p}.dwell.offMin`, 0, 1440);
    checkNum(m.dwell.deadbandW, `${p}.dwell.deadbandW`, 0, 10000);
    if (!isPlainObject(m.safety)) fail(`${p}.safety must be an object`);
    checkNum(m.safety.derateChipTemp, `${p}.safety.derateChipTemp`, 40, 120);
    checkNum(m.safety.pauseChipTemp, `${p}.safety.pauseChipTemp`, 40, 130);
    if (m.safety.derateChipTemp >= m.safety.pauseChipTemp) fail(`${p}.safety.derateChipTemp must be < pauseChipTemp`);
    checkNum(m.safety.maxBoardTemp, `${p}.safety.maxBoardTemp`, 40, 120);
    checkNum(m.safety.maxFanRpm, `${p}.safety.maxFanRpm`, 100, 20000);
    checkNum(m.safety.safetyStepW, `${p}.safety.safetyStepW`, 10, 5000);
    if (!isPlainObject(m.cooling)) fail(`${p}.cooling must be an object`);
    checkBool(m.cooling.manage, `${p}.cooling.manage`);
    checkEnum(m.cooling.mode, `${p}.cooling.mode`, ['auto', 'manual', 'immersion']);
    checkNum(m.cooling.targetC, `${p}.cooling.targetC`, 30, 90);
    checkEnum(m.dpsManage, `${p}.dpsManage`, ['leave', 'on', 'off']);
  });

  if (!isPlainObject(cfg.ui)) fail('ui must be an object');
  checkStr(cfg.ui.currency, 'ui.currency', { nonEmpty: true });
  return cfg;
}

// ---------------------------------------------------------------------------
// v1 → v2 migration (a v1 file is any config.json without a `version` field).
function slugId(name, ip, index, taken) {
  let base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!base) base = `miner${index + 1}`;
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}${n++}`;
  taken.add(id);
  return id;
}

function migrateV1(v1) {
  const cfg = clone(DEFAULT_CONFIG);
  const defMiner = DEFAULT_CONFIG.miners[0];

  // Ancient single-miner / single-grid-fee shapes v1's own loadConfig migrated in place.
  const src = clone(v1) || {};
  if (src.minerIP && !src.miners) src.miners = [{ ip: src.minerIP, name: 'Miner 1' }];
  if (src.gridFeePerKwh !== undefined && src.gridFeeWeekdayDay === undefined) {
    src.gridFeeWeekdayDay = src.gridFeePerKwh;
    src.gridFeeWeekendNight = src.gridFeePerKwh * 0.6;
  }

  if (typeof src.country === 'string') cfg.electricity.country = src.country;
  if (typeof src.electricityZone === 'string') cfg.electricity.zone = src.electricityZone;
  cfg.electricity.priceMode = src.priceMode === 'norgespris' ? 'norgespris' : 'spot_stromstotte';
  if (typeof src.gridFeeWeekdayDay === 'number') cfg.electricity.gridFee.dayWeekday = src.gridFeeWeekdayDay;
  if (typeof src.gridFeeWeekendNight === 'number') cfg.electricity.gridFee.nightWeekend = src.gridFeeWeekendNight;

  const lowHash = src.alerts?.lowHashrate;
  if (lowHash && typeof lowHash.threshold === 'number') {
    // v1: alert when hashrate < threshold% of expected → v2: pct below expected.
    cfg.alerts.rules.hashrateLowPct = Math.min(95, Math.max(1, 100 - lowHash.threshold));
  }

  const taken = new Set();
  cfg.miners = (Array.isArray(src.miners) ? src.miners : []).map((m, i) => {
    const ac = m.autoControl || {};
    const out = clone(defMiner);
    out.id = slugId(m.name, m.ip, i, taken);
    out.ip = m.ip || '';
    out.name = m.name || `Miner ${i + 1}`;
    out.username = m.username || 'root';
    out.password = m.password || 'root';
    out.mode = ac.price?.enabled ? 'auto' : 'manual';
    out.dryRun = true; // always: v2's engine is new and must be observed first
    if (typeof ac.power?.minPower === 'number') out.limits.minTargetW = ac.power.minPower;
    if (typeof ac.power?.maxPower === 'number') out.limits.maxTargetW = ac.power.maxPower;
    // "current target" is not stored in v1 config; use the migrated upper bound as
    // the manual starting point (controller reads the real target from the miner).
    out.manual = { boards: 3, targetW: out.limits.maxTargetW };
    if (typeof ac.price?.minDwellMinutes === 'number') out.dwell.powerMin = ac.price.minDwellMinutes;
    if (typeof ac.price?.deadbandWatts === 'number') out.dwell.deadbandW = ac.price.deadbandWatts;
    if (typeof ac.safety?.maxChipTemp === 'number') {
      out.safety.pauseChipTemp = ac.safety.maxChipTemp;
      if (out.safety.derateChipTemp >= out.safety.pauseChipTemp) {
        out.safety.derateChipTemp = out.safety.pauseChipTemp - 10;
      }
    }
    if (typeof ac.thermal?.maxBoardTemp === 'number') out.safety.maxBoardTemp = ac.thermal.maxBoardTemp;
    if (typeof ac.thermal?.maxFanSpeed === 'number') out.safety.maxFanRpm = ac.thermal.maxFanSpeed;
    if (typeof ac.power?.powerStepDown === 'number') out.safety.safetyStepW = ac.power.powerStepDown;
    return out;
  });

  cfg._v1 = clone(v1); // preserve everything v2 has no mapping for
  return validateConfig(cfg);
}

// ---------------------------------------------------------------------------
class ConfigStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.config = null;
    this._queue = Promise.resolve();
    // Populated by load(); the caller (server.js) drains these into the events log.
    this.loadEvents = [];
    this.migrated = false;
    this.corruptFile = null;
  }

  defaults() { return clone(DEFAULT_CONFIG); }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.loadEvents = [];
    let raw = null;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (raw === null) {
      this.config = this.defaults();
      await this._save();
      return this.config;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error('config root is not an object');
    } catch (err) {
      return this._recoverCorrupt(`unparseable config.json: ${err.message}`);
    }

    if (parsed.version === undefined) {
      // v1 file: back up the original untouched, then migrate.
      const backup = path.join(this.dataDir, 'config.v1.backup.json');
      await fs.writeFile(backup, raw);
      try {
        this.config = migrateV1(parsed);
      } catch (err) {
        return this._recoverCorrupt(`v1 migration failed: ${err.message}`);
      }
      this.migrated = true;
      this.loadEvents.push({
        ts: new Date().toISOString(), type: 'MIGRATION', severity: 'info',
        message: `Migrated v1 config to v2 (${this.config.miners.length} miner(s), dry-run enabled). Backup: config.v1.backup.json`,
        data: { minerCount: this.config.miners.length, backupFile: backup },
      });
      log('migrated v1 config, backup at', backup);
      await this._save();
      return this.config;
    }

    try {
      // Merge over defaults so fields added in later releases pick up defaults.
      this.config = validateConfig(deepMerge(this.defaults(), parsed));
    } catch (err) {
      return this._recoverCorrupt(err.message);
    }
    return this.config;
  }

  async _recoverCorrupt(reason) {
    const corrupt = path.join(this.dataDir, `config.corrupt-${Date.now()}.json`);
    await fs.rename(this.file, corrupt);
    this.corruptFile = corrupt;
    this.config = this.defaults();
    this.loadEvents.push({
      ts: new Date().toISOString(), type: 'CONFIG_CORRUPT', severity: 'critical',
      message: `config.json unusable (${reason}); preserved as ${path.basename(corrupt)}, running on defaults in dry-run`,
      data: { corruptFile: corrupt, reason },
    });
    log('corrupt config preserved at', corrupt, '-', reason);
    await this._save();
    return this.config;
  }

  get() {
    if (!this.config) throw new Error('ConfigStore not loaded');
    return this.config;
  }

  async update(partial) {
    if (!this.config) throw new Error('ConfigStore not loaded');
    if (!isPlainObject(partial)) throw new Error('config update must be an object');
    const cleaned = stripSentinels(clone(partial));
    const merged = deepMerge(this.config, cleaned);
    validateConfig(merged); // throws before any state change
    const previous = this.config;
    this.config = merged;
    try {
      await this._save();
    } catch (e) {
      this.config = previous; // memory must not outlive a failed persist
      throw e;
    }
    return this.config;
  }

  redacted() {
    const cfg = clone(this.get());
    for (const m of cfg.miners) {
      if (m.password) m.password = REDACT_SENTINEL;
    }
    if (cfg.alerts.telegram.botToken) cfg.alerts.telegram.botToken = REDACT_SENTINEL;
    cfg.alerts.ntfy.url = redactUrlCredentials(cfg.alerts.ntfy.url);
    if (cfg.alerts.webhook?.url) cfg.alerts.webhook.url = redactUrlCredentials(cfg.alerts.webhook.url);
    if (cfg._v1) redactDeep(cfg._v1); // migrated v1 blob carries plaintext miner passwords
    return cfg;
  }

  // Serialize all saves through one in-process promise queue; tmp+rename for atomicity.
  _save() {
    this._queue = this._queue
      .then(async () => {
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.config, null, 2));
        await fs.rename(tmp, this.file);
      })
      .catch((err) => { log('save failed:', err.message); throw err; });
    // Prevent one failed save from wedging the queue for subsequent saves.
    const result = this._queue;
    this._queue = this._queue.catch(() => {});
    return result;
  }
}

const SECRET_KEY_RE = /^(password|botToken|token|apiKey|secret)$/i;
function redactDeep(obj) {
  if (Array.isArray(obj)) { obj.forEach(redactDeep); return; }
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    if (SECRET_KEY_RE.test(k) && typeof obj[k] === 'string' && obj[k]) obj[k] = REDACT_SENTINEL;
    else redactDeep(obj[k]);
  }
}

function redactUrlCredentials(urlStr) {
  if (!urlStr) return urlStr;
  try {
    const u = new URL(urlStr);
    if (u.username || u.password) {
      return `${u.protocol}//${REDACT_SENTINEL}@${u.host}${u.pathname}${u.search}`;
    }
  } catch { /* not a URL — leave as-is */ }
  return urlStr;
}

// CONTRACTS.md shows one export block for configStore+stateStore; re-export StateStore
// here so `require('./configStore')` satisfies the contract shape verbatim.
const { StateStore } = require('./stateStore');

module.exports = { ConfigStore, StateStore, DEFAULT_CONFIG, migrateV1, REDACT_SENTINEL, validateConfig, deepMerge };
