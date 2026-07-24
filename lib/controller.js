// lib/controller.js — Per-miner control loop. Each tick: getSnapshot → build EngineInputs
// (clamped candidates, marginal price hours, heat demand) → engine.decide → verified
// actuation with intent-event-first ordering (crash recovery, DESIGN §3.3), state
// persistence, gated envelope learning, alert evaluation, ≤1/min history sampling and a
// WS broadcast. Also serves user actions (pause/resume/setPower/setBoards/goLive/dryRun).
'use strict';

const LEARN_GATE_MS = 10 * 60 * 1000;          // no learning within 10 min of any actuation
const DIVERGENCE_COOLDOWN_MS = 30 * 60 * 1000; // throttle wall-vs-predicted divergence events
const DIVERGENCE_PCT = 0.15;
const SAMPLE_INTERVAL_MS = 60 * 1000;
const TRACE_KEEP = 50;
const PREFERRED_BOARD_ORDER = ['2', '1', '3']; // board 2 is the proven one (DESIGN §3.1)
const DWELL_TS_KEYS = ['lastPowerChangeAt', 'lastBoardsChangeAt', 'lastOffAt', 'lastOnAt'];

const log = (...a) => console.log('[controller]', ...a);

// --- timezone helpers -------------------------------------------------------
// Prefer market.js's exported helpers so the 168-slot schedule index convention is
// shared with the rest of the app; fall back to a local Intl implementation
// (Monday = 0) when market.js is absent (isolated unit tests).
let tzHelpersCache = null;
function tzHelpers() {
  if (tzHelpersCache) return tzHelpersCache;
  try {
    const m = require('./market');
    if (typeof m.hourInTz === 'function' && typeof m.weekdayInTz === 'function') {
      tzHelpersCache = { hourInTz: m.hourInTz, weekdayInTz: m.weekdayInTz };
      return tzHelpersCache;
    }
  } catch (_e) { /* market.js unavailable — use local fallback */ }
  tzHelpersCache = { hourInTz: localHourInTz, weekdayInTz: localWeekdayInTz };
  return tzHelpersCache;
}
function localHourInTz(dateIso, tz) {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(dateIso));
  return parseInt(s, 10) % 24;
}
// Same convention as market.weekdayInTz / Date#getDay: 0 = Sunday.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function localWeekdayInTz(dateIso, tz) {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' })
    .format(new Date(dateIso));
  return Math.max(0, WEEKDAYS.indexOf(s));
}

// --- heat demand resolution (shared with api.js snapshot builder) -----------

// Room temperature estimate from the miner's own sensors: the minimum hashboard
// inlet temp is the air being pulled into the boards ≈ ambient. With fans off
// (paused) residual board heat inflates the reading, so subtract idleOffsetC.
// Returns °C rounded to 0.1, or null when no board reports an inlet temp.
function estimateRoomTempC(snapshot, thermo) {
  if (!snapshot || !snapshot.online) return null;
  const inlets = (snapshot.boards || [])
    .filter((b) => b && b.inletTempC != null)
    .map((b) => Number(b.inletTempC))
    .filter(Number.isFinite);
  if (!inlets.length) return null;
  const fansOn = ((snapshot.cooling && snapshot.cooling.fans) || []).some((f) => Number(f.rpm) > 100);
  const off = Number((thermo || {}).idleOffsetC);
  const t = Math.min(...inlets) - (fansOn ? 0 : (Number.isFinite(off) ? off : 1.5));
  if (t < -30 || t > 60) return null; // implausible sensor value
  return Math.round(t * 10) / 10;
}

// A "zone" is one heating area: {demandSource, manualKW, schedule, thermostat, alt}.
// The legacy top-level cfg.heating has the same shape, so both work here.
// Reading reliability: the inlet tracks the room only when the fans are pulling
// room air at speed while hashing, or when an idle miner has fully cooled down.
// In between — warm-up at low fan speed, or just-paused with hot boards — the
// miner's own heat contaminates the sensor (seen live: 22.5° room read as 31°
// at 900 rpm during startup). Callers hold the last reliable value across the
// contaminated windows. Returns {tempC, reliable} or null (no usable sensor).
function classifyRoomReading(snapshot, thermo) {
  if (!snapshot || !snapshot.online) return null;
  const inlets = (snapshot.boards || [])
    .filter((b) => b && b.inletTempC != null)
    .map((b) => Number(b.inletTempC))
    .filter(Number.isFinite);
  if (!inlets.length) return null;
  const minInlet = Math.min(...inlets);
  if (minInlet < -30 || minInlet > 60) return null;
  const fans = ((snapshot.cooling && snapshot.cooling.fans) || []).map((f) => Number(f.rpm) || 0);
  const fanMax = fans.length ? Math.max(...fans) : 0;
  const hashing = (snapshot.boardsHashingCount || 0) > 0;
  const chips = (snapshot.boards || []).map((b) => Number(b.chipTempC)).filter(Number.isFinite);
  const chipMax = chips.length ? Math.max(...chips) : null;
  const off = Number((thermo || {}).idleOffsetC);
  const idleOff = Number.isFinite(off) ? off : 1.5;
  const r1v = (n) => Math.round(n * 10) / 10;
  if (hashing && fanMax >= 2000) return { tempC: r1v(minInlet), reliable: true };
  if (!hashing && fanMax < 100) {
    // idle: offset-corrected; only reliable once the boards have shed their heat
    return { tempC: r1v(minInlet - idleOff), reliable: chipMax === null || chipMax <= 45 };
  }
  return { tempC: r1v(minInlet), reliable: false }; // transitional state
}

const ROOM_HOLD_MS = 30 * 60 * 1000; // trust a held reading for at most 30 min

// roomTempC is only consulted for demandSource 'thermostat'; null → 0 demand
// (no sensor reading — never heat blind).
function resolveHeatDemand(zone, nowIso, roomTempC, tz) {
  const h = zone || {};
  const src = h.demandSource || 'off';
  if (src === 'manual') return Number(h.manualKW) || 0;
  if (src === 'thermostat') {
    const th = h.thermostat || {};
    if (!Number.isFinite(roomTempC)) return 0;
    const target = Number.isFinite(Number(th.targetC)) ? Number(th.targetC) : 21;
    const band = Number(th.bandC) > 0 ? Number(th.bandC) : 2;
    const maxKW = Number(th.maxKW) >= 0 ? Number(th.maxKW) : 3.5;
    const frac = Math.min(1, Math.max(0, (target - roomTempC) / band));
    return Math.round(frac * maxKW * 100) / 100;
  }
  if (src === 'schedule') {
    const sched = Array.isArray(h.schedule) ? h.schedule : null;
    if (!sched || sched.length !== 168) return 0;
    const zoneTz = tz || 'Europe/Oslo';
    const { hourInTz, weekdayInTz } = tzHelpers();
    // Schedule slot 0 = Monday 00:00 (the UI paints Monday-first). market.js's
    // weekdayInTz follows Date#getDay (0 = Sunday), so shift to Monday-first here.
    const mondayFirst = (weekdayInTz(nowIso, zoneTz) + 6) % 7;
    const idx = mondayFirst * 24 + hourInTz(nowIso, zoneTz);
    return Number(sched[idx]) || 0;
  }
  return 0; // 'off' or unknown source
}

function altHeatPrice(alt, householdPrice) {
  const a = alt || {};
  const p = Number(householdPrice) || 0;
  if (a.type === 'heatpump') {
    const scop = Number(a.scop) > 0 ? Number(a.scop) : 3;
    return p / scop;
  }
  if (a.type === 'resistive') return p;
  return 0; // 'none': heat becomes a hard constraint in the engine, not a price
}

// The zone a miner belongs to; falls back to the first zone (ensureZones
// guarantees zoneId integrity, this is belt-and-braces for tests/fakes).
function zoneForMiner(cfg, minerId) {
  const zones = (((cfg || {}).heating || {}).zones) || [];
  const m = ((cfg || {}).miners || []).find((x) => x && x.id === minerId);
  return zones.find((z) => z && m && z.id === m.zoneId) || zones[0]
    || (cfg && cfg.heating) || {}; // legacy shape as last resort
}

// Coolest fresh reading across a zone's miners (shared registry), falling back
// to the caller's own reading. Stale entries (>5 min) are ignored.
function zoneRoomTemp(roomTemps, zoneId, ownTempC) {
  const temps = [];
  if (Number.isFinite(ownTempC)) temps.push(ownTempC);
  if (roomTemps && zoneId) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const e of roomTemps.values()) {
      if (e && e.zoneId === zoneId && Number.isFinite(e.tempC) && e.ts >= cutoff) temps.push(e.tempC);
    }
  }
  return temps.length ? Math.min(...temps) : null;
}

// --- small utilities ---------------------------------------------------------
class UserActionError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}
const nowIso = () => new Date().toISOString();
const parseTs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);

function offlineSnapshot(errMsg) {
  return {
    ts: nowIso(), online: false, paused: false, model: null, minerStatus: 'UNKNOWN',
    boards: [], boardsEnabledCount: 0, boardsHashingCount: 0,
    tuner: { state: 'UNKNOWN', targetW: 0 }, wallW: null,
    cooling: { mode: 'unknown', fans: [], highestTempC: null },
    pools: [], hashrate: { m1: 0, m15: 0, h1: 0, h24: 0 },
    dps: null, constraints: null, errors: [errMsg],
  };
}

function describeAction(action) {
  switch (action.type) {
    case 'PAUSE': return 'pause mining';
    case 'RESUME': return 'resume mining';
    case 'SET_POWER': return `set power target ${action.targetW} W`;
    case 'SET_BOARDS': {
      const en = (action.enableIds || []).join(',');
      const dis = (action.disableIds || []).join(',');
      return `set boards (enable [${en}], disable [${dis}])`;
    }
    default: return `${action.type}`;
  }
}

function describeWouldHave(trace, snapshot) {
  const ch = trace && trace.chosen;
  if (!ch) return null;
  if (ch.off) return snapshot.paused ? null : 'pause mining';
  const parts = [];
  if (snapshot.paused) parts.push('resume mining');
  const curBoards = snapshot.boardsEnabledCount;
  if (Number.isFinite(ch.boards) && ch.boards !== curBoards) {
    parts.push(`set ${ch.boards} board${ch.boards === 1 ? '' : 's'} (now ${curBoards})`);
  }
  const curW = snapshot.tuner ? snapshot.tuner.targetW : null;
  if (Number.isFinite(ch.targetW) && ch.targetW !== curW) {
    parts.push(`set power target ${ch.targetW} W (now ${curW} W)`);
  }
  return parts.length ? parts.join(' and ') : null;
}

// --- Controller ---------------------------------------------------------------
class Controller {
  constructor({ minerCfg, client, envelope, market, engine, stateStore, history, alerts, wsHub, configStore, roomTemps }) {
    this.roomTemps = roomTemps || null; // shared Map minerId -> {zoneId, tempC, ts}
    this.minerCfg = minerCfg;
    this.id = minerCfg.id;
    this.client = client;
    this.envelope = envelope;
    this.market = market;
    this.engine = engine;
    this.stateStore = stateStore;
    this.history = history;
    this.alerts = alerts;
    this.wsHub = wsHub;
    this.configStore = configStore;

    this.state = null;              // EngineState, loaded in start()
    this.running = false;
    this.lastTickAt = null;         // ISO heartbeat for watchdog + /health
    this.lastSnapshot = null;
    this.lastDecision = null;
    this.traces = [];               // newest first, ≤ TRACE_KEEP
    this.plan = [];
    this.wouldHave = null;

    this._timer = null;
    this._ticking = false;
    this._lastActuationMs = null;   // in-memory attempt timestamp (learn gate)
    this._lastSampleMs = null;
    this._lastDivergenceMs = null;
  }

  // ---- lifecycle -------------------------------------------------------------

  async start() {
    this.state = await this.stateStore.load(this.id);

    // Crash recovery (DESIGN §3.3): the miner is the source of truth. Read it
    // before any actuation; err toward longer dwells for missing timestamps.
    let snapshot;
    try { snapshot = await this.client.getSnapshot(); }
    catch (e) { snapshot = offlineSnapshot(`getSnapshot failed: ${e.message}`); }
    this.lastSnapshot = snapshot;

    const now = nowIso();
    for (const k of DWELL_TS_KEYS) {
      if (parseTs(this.state[k]) === null) this.state[k] = now;
    }
    if (this.state.pausedBy === 'safety') this.state.pausedBy = null; // re-derive from live temps
    const maxW = (this.minerCfg.limits && this.minerCfg.limits.maxTargetW) || 0;
    if (!(Number(this.state.thermalCeilingW) > 0)) this.state.thermalCeilingW = maxW;
    if (!Number.isFinite(this.state.dryRunActionCount)) this.state.dryRunActionCount = 0;
    await this.persistState();

    // Seed the envelope from the miner's tuned profiles, tagged with the board
    // count active right now (DESIGN §3.1). Best-effort.
    try {
      if (snapshot.online && typeof this.client.listTunedProfiles === 'function'
          && typeof this.envelope.importProfiles === 'function') {
        const profiles = await this.client.listTunedProfiles();
        if (Array.isArray(profiles) && profiles.length) {
          this.envelope.importProfiles(profiles, snapshot.boardsEnabledCount);
          if (typeof this.envelope.save === 'function') await this.envelope.save();
        }
      }
    } catch (e) { log(this.id, 'profile import skipped:', e.message); }

    await this.appendEvent('controller-start', 'info',
      `controller started for ${this.minerCfg.name || this.id} (mode ${this.minerCfg.mode}, dryRun ${!!this.minerCfg.dryRun})`);

    this.running = true;
    await this.tick(snapshot); // first tick reuses the reconcile snapshot

    const cfg = this.configStore.get();
    const pollS = Number(cfg.pollSeconds) > 0 ? Number(cfg.pollSeconds) : 10;
    this._timer = setInterval(() => { this.tick().catch((e) => log(this.id, 'tick error:', e.message)); }, pollS * 1000);
    if (this._timer.unref) this._timer.unref();
  }

  async stop() {
    if (!this.running && !this._timer) return;
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    const deadline = Date.now() + 15000;
    while (this._ticking && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await this.persistState();
  }

  // ---- tick pipeline -----------------------------------------------------------

  async tick(preloadedSnapshot) {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const cfg = this.configStore.get();
      const minerCfg = (cfg.miners || []).find((m) => m.id === this.id) || this.minerCfg;
      this.minerCfg = minerCfg; // config edits apply live

      let snapshot = preloadedSnapshot;
      if (!snapshot) {
        try { snapshot = await this.client.getSnapshot(); }
        catch (e) { snapshot = offlineSnapshot(`getSnapshot failed: ${e.message}`); }
      }
      this.lastSnapshot = snapshot;

      const inputs = await this.buildInputs(cfg, minerCfg, snapshot);

      let decision = null;
      try { decision = this.engine.decide(inputs); }
      catch (e) {
        log(this.id, 'engine.decide failed:', e.message);
        await this.appendEvent('engine-error', 'critical', `engine.decide failed: ${e.message}`);
      }

      if (decision) {
        this.lastDecision = decision;
        if (decision.trace) {
          this.traces.unshift(decision.trace);
          if (this.traces.length > TRACE_KEEP) this.traces.length = TRACE_KEEP;
        }
        // A decision computed from a partial snapshot (transport errors this tick)
        // may rest on coerced fields — only critical safety actions may proceed.
        if (decision.action && snapshot.errors && snapshot.errors.length
            && decision.action.severity !== 'critical') {
          await this.appendEvent('partial-snapshot-hold', 'warn',
            `holding ${decision.action.type} — snapshot incomplete (${snapshot.errors.join('; ').slice(0, 160)})`);
          decision = { ...decision, action: null };
        }
        await this.applyDecision(decision, inputs, snapshot);
        try { this.plan = this.engine.buildPlan(inputs) || []; }
        catch (e) { log(this.id, 'buildPlan failed:', e.message); this.plan = []; }
      }

      this.maybeLearn(snapshot);
      await this.checkDivergence(snapshot);

      try {
        const tuningHold = Boolean(this.state.tuningHoldSince)
          || (snapshot.tuner && (snapshot.tuner.state === 'TUNING' || snapshot.tuner.state === 'PREHEAT'));
        let expectedHashrateThs = null;
        if (snapshot.online && !snapshot.paused
            && snapshot.boardsEnabledCount > 0 && snapshot.tuner && snapshot.tuner.targetW > 0) {
          try {
            expectedHashrateThs = this.envelope
              .predict(snapshot.boardsEnabledCount, snapshot.tuner.targetW).hashrateThs;
          } catch (_e) { /* no expectation → hashrate-low rule stays silent */ }
        }
        await this.alerts.evaluate({
          minerId: this.id, minerCfg, snapshot, state: this.state,
          market: inputs.market, priceHours: inputs.priceHours, decision, now: inputs.now,
          tuningHold, expectedHashrateThs,
        });
      } catch (e) { log(this.id, 'alerts.evaluate failed:', e.message); }

      await this.maybeSample(snapshot, inputs, cfg);

      try { this.wsHub.broadcast(this.snapshotForApi()); }
      catch (e) { log(this.id, 'ws broadcast failed:', e.message); }
    } catch (e) {
      log(this.id, 'tick failed:', e.message); // errors never crash the loop
    } finally {
      this.lastTickAt = nowIso(); // heartbeat: a completed tick counts even if the miner was offline
      this._ticking = false;
    }
  }

  async buildInputs(cfg, minerCfg, snapshot) {
    const now = nowIso();
    let marketState = {};
    try { marketState = this.market.state() || {}; }
    catch (e) { log(this.id, 'market.state failed:', e.message); }

    let monthKWh = 0;
    try { monthKWh = (await this.history.minerKWhThisMonth(this.id)) || 0; }
    catch (e) { log(this.id, 'minerKWhThisMonth failed:', e.message); }

    let priceHours = [];
    try { priceHours = this.market.priceHours(monthKWh) || []; }
    catch (e) { log(this.id, 'priceHours failed:', e.message); }

    const horizonEnd = parseTs(marketState.horizonEndsAt);
    const horizonCoversNow = horizonEnd !== null && Date.parse(now) < horizonEnd;
    // Pessimistic fallback for exhausted horizons (DESIGN §4.2): worst known marginal price.
    const known = priceHours.map((h) => Number(h.marginalPrice)).filter(Number.isFinite);
    const fallbackPrice = known.length ? Math.max(...known) : null;

    const householdPrice = Number.isFinite(marketState.currentHousehold) ? marketState.currentHousehold : 0;
    const zone = zoneForMiner(cfg, this.id);
    // Effective room temp: latest reliable reading, else the last reliable one
    // held for up to 30 min through contaminated transitions (see classifyRoomReading).
    const reading = classifyRoomReading(snapshot, zone.thermostat);
    if (reading && reading.reliable) {
      this.state.lastRoomTempC = reading.tempC;
      this.state.lastRoomTs = now;
      await this.persistState();
    }
    const heldTs = parseTs(this.state.lastRoomTs);
    const ownRoomC = (reading && reading.reliable) ? reading.tempC
      : (heldTs !== null && Date.now() - heldTs < ROOM_HOLD_MS && Number.isFinite(this.state.lastRoomTempC))
        ? this.state.lastRoomTempC
        : null;
    this.roomTempC = ownRoomC; // cached for snapshotForApi / API zone summaries
    if (this.roomTemps) this.roomTemps.set(this.id, { zoneId: zone.id, tempC: ownRoomC, ts: Date.now() });
    const roomTempC = zoneRoomTemp(this.roomTemps, zone.id, ownRoomC);
    const tz = ((cfg.electricity || {}).timezone) || 'Europe/Oslo';
    const heat = {
      demandKW: resolveHeatDemand(zone, now, roomTempC, tz),
      altType: (zone.alt || {}).type || 'none',
      altPricePerKWh: altHeatPrice(zone.alt, householdPrice),
      roomTempC,
      zoneId: zone.id || null,
    };
    if (zone.demandSource === 'thermostat' && snapshot.online && roomTempC === null) {
      if (!this._thermoSensorWarned) {
        this._thermoSensorWarned = true;
        await this.appendEvent('thermostat-sensor-unavailable', 'warn',
          'thermostat active but no hashboard inlet temperature available — heat demand held at 0');
      }
    } else {
      this._thermoSensorWarned = false;
    }

    let candidates = [];
    try {
      candidates = this.envelope.candidates({
        limits: minerCfg.limits,
        thermalCeilingW: this.state.thermalCeilingW,
        allowedBoardsCount: ((minerCfg.limits || {}).allowedBoards || []).length,
      }) || [];
    } catch (e) { log(this.id, 'envelope.candidates failed:', e.message); }

    return {
      now,
      snapshot,
      candidates,
      market: {
        marginalPrice: Number.isFinite(marketState.currentMarginal) ? marketState.currentMarginal : null,
        householdPrice,
        regime: marketState.regime || 'subsidised',
        hashpriceNokPerThDay: Number.isFinite(marketState.hashpriceNokPerThDay) ? marketState.hashpriceNokPerThDay : 0,
        horizonCoversNow,
        fallbackPrice,
      },
      priceHours,
      heat,
      settings: {
        mode: minerCfg.mode,
        dryRun: !!minerCfg.dryRun,
        economics: cfg.economics || {},
        dwell: minerCfg.dwell || {},
        safety: minerCfg.safety || {},
        limits: minerCfg.limits || {},
        manual: minerCfg.manual || {},
      },
      state: { ...this.state },
    };
  }

  async applyDecision(decision, inputs, snapshot) {
    const dryRun = inputs.settings.dryRun;
    const action = decision.action;
    const updates = decision.stateUpdates || {};
    const prevDryCount = this.state.dryRunActionCount || 0;

    if (dryRun) {
      // No actuation ever in dry run — even if a buggy engine returns an action
      // (defense in depth; the engine contract says it must not).
      if (action) log(this.id, 'dry run: suppressed engine action', describeAction(action));
      if (Object.keys(updates).length) {
        Object.assign(this.state, updates);
        await this.persistState();
      }
      this.wouldHave = ((this.state.dryRunActionCount || 0) > prevDryCount)
        ? (describeWouldHave(decision.trace, snapshot) || decision.statusLine || null)
        : null;
      return;
    }

    this.wouldHave = null;

    if (!action) {
      if (Object.keys(updates).length) { // e.g. thermal-ceiling / tuning-hold bookkeeping
        Object.assign(this.state, updates);
        await this.persistState();
      }
      return;
    }

    // Intent event BEFORE actuation (DESIGN §3.3): observed miner state must
    // always be explainable after a crash mid-actuation.
    await this.appendEvent('action-intent', action.severity || 'info',
      `intent: ${describeAction(action)} — ${action.reason}`, { action });

    this._lastActuationMs = Date.now(); // attempted actuation gates learning either way
    try {
      await this.actuate(action);
      Object.assign(this.state, updates); // persist stateUpdates only on verified success
      await this.persistState();
      await this.appendEvent('action-applied', action.severity || 'info',
        `${describeAction(action)} — ${action.reason}`, { action });
    } catch (e) {
      await this.appendEvent('action-failed', 'critical',
        `${describeAction(action)} FAILED: ${e.message}`, { action, error: String(e.message) });
      try {
        await this.alerts.fire('actuation-verify-failed', {
          severity: 'critical',
          title: 'Actuation failed',
          message: `${this.minerCfg.name || this.id}: ${describeAction(action)} failed: ${e.message}`,
          minerId: this.id,
        });
      } catch (ae) { log(this.id, 'alert dispatch failed:', ae.message); }
    }
  }

  async actuate(action) {
    switch (action.type) {
      case 'PAUSE': return this.client.pause();
      case 'RESUME': {
        const r = await this.client.resume();
        // Engine attaches a targetW hint so a restart lands at the planned point.
        // The primary step succeeded — a failed follow-up must not void it (the
        // next tick re-adjusts power), so it degrades to a warning event.
        await this.applyFollowUpPower(action);
        return r;
      }
      case 'SET_POWER': return this.client.setPowerTarget(action.targetW);
      case 'SET_BOARDS': {
        const r = await this.client.setBoards(action.enableIds || [], action.disableIds || []);
        // Boards DID change: dwell state must be recorded even if the power
        // follow-up fails, or the rate limiter would allow an immediate re-switch.
        await this.applyFollowUpPower(action);
        return r;
      }
      default: throw new Error(`unknown action type: ${action.type}`);
    }
  }

  async applyFollowUpPower(action) {
    if (!(action.targetW > 0)) return;
    try {
      await this.client.setPowerTarget(action.targetW);
    } catch (e) {
      await this.appendEvent('action-partial', 'warn',
        `${action.type} applied, but follow-up power target ${action.targetW} W failed: ${e.message} — next tick will re-adjust`,
        { action, error: String(e.message) });
    }
  }

  // Learning gate (DESIGN §3.1): tuner STABLE and ≥10 min since any actuation.
  maybeLearn(snapshot) {
    const s = snapshot;
    if (!s.online || s.paused) return;
    if (!s.tuner || s.tuner.state !== 'STABLE') return;
    if (s.wallW == null || !(s.boardsEnabledCount > 0) || !(s.tuner.targetW > 0)) return;
    // A dead board (enabled but not hashing) would poison the (boards, target) key.
    if (s.boardsHashingCount !== s.boardsEnabledCount) return;
    const hr = s.hashrate && (s.hashrate.m15 || s.hashrate.m1);
    if (!(hr > 0)) return;
    const last = this.lastActuationMs();
    if (last !== null && Date.now() - last < LEARN_GATE_MS) return;
    try {
      this.envelope.learn(s.boardsEnabledCount, s.tuner.targetW, { hashrateThs: hr, wallW: s.wallW });
    } catch (e) { log(this.id, 'envelope.learn failed:', e.message); }
  }

  lastActuationMs() {
    let max = this._lastActuationMs;
    for (const k of DWELL_TS_KEYS) {
      const t = parseTs(this.state && this.state[k]);
      if (t !== null && (max === null || t > max)) max = t;
    }
    return max;
  }

  // Surface >15 % realized-wall vs predicted divergence (DESIGN §3.1, v1's lesson).
  async checkDivergence(snapshot) {
    const s = snapshot;
    if (!s.online || s.paused || !s.tuner || s.tuner.state !== 'STABLE') return;
    if (s.wallW == null || !(s.boardsEnabledCount > 0)) return;
    let pred = null;
    try { pred = this.envelope.predict(s.boardsEnabledCount, s.tuner.targetW); } catch (_e) { return; }
    if (!pred || !(pred.wallW > 0)) return;
    const div = Math.abs(s.wallW - pred.wallW) / pred.wallW;
    if (div <= DIVERGENCE_PCT) return;
    if (this._lastDivergenceMs && Date.now() - this._lastDivergenceMs < DIVERGENCE_COOLDOWN_MS) return;
    this._lastDivergenceMs = Date.now();
    await this.appendEvent('envelope-divergence', 'warn',
      `realized wall ${s.wallW} W diverges ${Math.round(div * 100)}% from predicted ${Math.round(pred.wallW)} W `
      + `(${s.boardsEnabledCount} boards @ ${s.tuner.targetW} W target)`);
  }

  async maybeSample(snapshot, inputs, cfg) {
    if (this._lastSampleMs && Date.now() - this._lastSampleMs < SAMPLE_INTERVAL_MS) return;
    const s = snapshot;
    const econ = this.currentEconomics(s, cfg);
    const chipTemps = (s.boards || []).map((b) => b.chipTempC).filter((t) => t != null);
    const sample = {
      ts: inputs.now, id: this.id,
      hr: s.hashrate ? s.hashrate.m1 : 0,
      wallW: s.wallW,
      targetW: s.tuner ? s.tuner.targetW : null,
      boards: s.boardsEnabledCount,
      chipT: chipTemps.length ? Math.max(...chipTemps) : null,
      priceMarginal: inputs.market.marginalPrice,
      regime: inputs.market.regime,
      netNokH: econ.netNokH,
    };
    try {
      await this.history.appendSample(sample);
      this._lastSampleMs = Date.now();
    } catch (e) { log(this.id, 'appendSample failed:', e.message); }
  }

  // ---- API surface --------------------------------------------------------------

  currentEconomics(snapshot, cfg) {
    const base = { revenueNokH: 0, costNokH: 0, heatValueNokH: 0, netNokH: 0, netNokDay: 0, effJPerTh: null, effectiveScop: null };
    const s = snapshot;
    if (!s || !s.online || s.paused || s.wallW == null) return base;
    let marketState = {};
    try { marketState = this.market.state() || {}; } catch (_e) { return base; }
    const hr = (s.hashrate && (s.hashrate.m15 || s.hashrate.m1)) || 0;
    const householdPrice = Number.isFinite(marketState.currentHousehold) ? marketState.currentHousehold : 0;
    const zone = zoneForMiner(cfg, this.id);
    const tz = ((cfg.electricity || {}).timezone) || 'Europe/Oslo';
    const roomC = zoneRoomTemp(this.roomTemps, zone.id, this.roomTempC != null ? this.roomTempC : null);
    const heat = {
      demandKW: resolveHeatDemand(zone, nowIso(), roomC, tz),
      altType: (zone.alt || {}).type || 'none',
      altPricePerKWh: altHeatPrice(zone.alt, householdPrice),
    };
    let sc;
    try {
      sc = this.engine.scoreCandidate(
        { boards: s.boardsEnabledCount, targetW: s.tuner ? s.tuner.targetW : 0, hashrateThs: hr, wallW: s.wallW },
        {
          marginalPrice: Number.isFinite(marketState.currentMarginal) ? marketState.currentMarginal : 0,
          hashpriceNokPerThDay: Number.isFinite(marketState.hashpriceNokPerThDay) ? marketState.hashpriceNokPerThDay : 0,
          poolFeePct: ((cfg.economics || {}).poolFeePct) || 0,
          heat,
        }
      );
    } catch (_e) { return base; }
    const net = Number(sc.scoreNokH) || 0;
    const heatKW = s.wallW / 1000;
    const netHeatCostNokH = (Number(sc.costNokH) || 0) - (Number(sc.revenueNokH) || 0);
    let effectiveScop = null;
    if (heatKW > 0 && netHeatCostNokH > 0 && householdPrice > 0) {
      effectiveScop = r2((householdPrice * heatKW) / netHeatCostNokH);
    }
    return {
      revenueNokH: r2(sc.revenueNokH || 0),
      costNokH: r2(sc.costNokH || 0),
      heatValueNokH: r2(sc.heatValueNokH || 0),
      netNokH: r2(net),
      netNokDay: r2(net * 24),
      effJPerTh: hr > 0 ? r2(s.wallW / hr) : null,
      effectiveScop,
    };
  }

  snapshotForApi() {
    const s = this.lastSnapshot || offlineSnapshot('no snapshot yet');
    const d = this.lastDecision;
    const cfg = this.configStore.get();
    const minerCfg = (cfg.miners || []).find((m) => m.id === this.id) || this.minerCfg;
    const chipTemps = (s.boards || []).map((b) => b.chipTempC).filter((t) => t != null);
    const chipTempMax = chipTemps.length
      ? Math.max(...chipTemps)
      : (s.cooling ? s.cooling.highestTempC : null);
    const pools = s.pools || [];
    const active = pools.find((p) => p.active) || null;
    const shares = active ? (Number(active.accepted) || 0) + (Number(active.rejected) || 0) : 0;
    return {
      id: this.id,
      name: minerCfg.name || this.id,
      ip: minerCfg.ip,
      online: !!s.online,
      mode: minerCfg.mode,
      dryRun: !!minerCfg.dryRun,
      statusLine: d ? d.statusLine : (s.online ? 'Starting…' : 'Miner unreachable'),
      statusSeverity: d ? d.statusSeverity : (s.online ? 'ok' : 'warn'),
      hw: {
        model: s.model,
        boards: s.boards || [],
        fans: (s.cooling && s.cooling.fans) || [],
        chipTempMax,
        coolingMode: s.cooling ? s.cooling.mode : 'unknown',
        tunerState: s.tuner ? s.tuner.state : 'UNKNOWN',
      },
      power: { targetW: s.tuner ? s.tuner.targetW : null, wallW: s.wallW },
      roomTempC: this.roomTempC != null ? this.roomTempC : null,
      zoneId: minerCfg.zoneId || null,
      hashrate: s.hashrate,
      pool: {
        url: active ? active.url : null,
        user: active ? active.user : null,
        failoverActive: !!active && pools.indexOf(active) > 0,
        rejectRatePct: shares > 0 ? r2(((Number(active.rejected) || 0) / shares) * 100) : 0,
      },
      economics: this.currentEconomics(s, cfg),
      controller: {
        trace: d ? d.trace : null,
        wouldHave: this.wouldHave || null,
        dryRunActionCount: (this.state && this.state.dryRunActionCount) || 0,
        migrationNotice: !!(cfg._v1 && minerCfg.dryRun),
      },
      plan: this.plan || [],
    };
  }

  envelopeForApi() {
    let stats = {};
    try { stats = this.envelope.stats() || {}; } catch (_e) { /* keep {} */ }
    let candidates = [];
    try {
      candidates = this.envelope.candidates({
        limits: this.minerCfg.limits,
        thermalCeilingW: this.state ? this.state.thermalCeilingW : ((this.minerCfg.limits || {}).maxTargetW || 0),
        allowedBoardsCount: ((this.minerCfg.limits || {}).allowedBoards || []).length,
      }) || [];
    } catch (_e) { /* keep [] */ }
    return {
      minerId: this.id,
      thermalCeilingW: this.state ? this.state.thermalCeilingW : null,
      stats,
      candidates,
    };
  }

  // ---- user actions ----------------------------------------------------------------

  async userAction(action = {}) {
    if (!this.state) throw new UserActionError(503, 'controller not started yet');
    // Serialize with the tick loop: an actuation mid-tick could be overwritten by
    // the tick's stateUpdates (e.g. a user pause clobbered back to running).
    const waitUntil = Date.now() + 10 * 1000;
    while (this._ticking && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this._ticking) throw new UserActionError(503, 'controller busy — try again');
    // Hold the tick flag while acting so a tick can't start mid-action either.
    this._ticking = true;
    try {
      return await this._userActionInner(action);
    } finally {
      this._ticking = false;
    }
  }

  async _userActionInner(action) {
    const type = action.type;
    const cfg = this.configStore.get();
    const minerCfg = (cfg.miners || []).find((m) => m.id === this.id) || this.minerCfg;
    const now = nowIso();
    const force = !!action.force;

    switch (type) {
      case 'pause': {
        await this.appendEvent('user-action', 'info', 'user: pause mining', { action });
        await this.client.pause();
        this._lastActuationMs = Date.now();
        Object.assign(this.state, { pausedBy: 'user', lastOffAt: now });
        await this.persistState();
        return { ok: true };
      }
      case 'resume': {
        await this.appendEvent('user-action', 'info', 'user: resume mining', { action });
        await this.client.resume();
        this._lastActuationMs = Date.now();
        Object.assign(this.state, { pausedBy: null, lastOnAt: now });
        await this.persistState();
        return { ok: true };
      }
      case 'setPower': {
        if (minerCfg.mode === 'auto' && !force) {
          throw new UserActionError(409, 'miner is in auto mode — manual power change requires force:true');
        }
        const requested = Math.round(Number(action.targetW));
        if (!Number.isFinite(requested) || requested <= 0) {
          throw new UserActionError(400, 'setPower requires a positive targetW');
        }
        const lim = minerCfg.limits || {};
        const ceiling = Math.min(lim.maxTargetW || Infinity, this.state.thermalCeilingW || Infinity);
        const targetW = Math.min(Math.max(requested, lim.minTargetW || 0), ceiling);
        await this.appendEvent('user-action', 'info', `user: set power target ${targetW} W`, { action, targetW });
        await this.client.setPowerTarget(targetW);
        this._lastActuationMs = Date.now();
        Object.assign(this.state, { lastPowerChangeAt: now });
        await this.persistState();
        return { ok: true, targetW };
      }
      case 'setBoards': {
        if (minerCfg.mode === 'auto' && !force) {
          throw new UserActionError(409, 'miner is in auto mode — manual board change requires force:true');
        }
        const allowed = ((minerCfg.limits || {}).allowedBoards) || ['1', '2', '3'];
        let enableIds = Array.isArray(action.enableIds) ? action.enableIds.map(String) : null;
        let disableIds = Array.isArray(action.disableIds) ? action.disableIds.map(String) : null;
        if (!enableIds && !disableIds) {
          const n = Math.round(Number(action.boards));
          if (!Number.isFinite(n) || n < 0) {
            throw new UserActionError(400, 'setBoards requires enableIds/disableIds or a boards count');
          }
          const order = PREFERRED_BOARD_ORDER.filter((id) => allowed.includes(id))
            .concat(allowed.filter((id) => !PREFERRED_BOARD_ORDER.includes(id)));
          const count = Math.min(n, order.length);
          enableIds = order.slice(0, count);
          disableIds = order.slice(count);
        }
        enableIds = (enableIds || []).filter((id) => allowed.includes(id));
        disableIds = (disableIds || []).filter((id) => allowed.includes(id));
        await this.appendEvent('user-action', 'info',
          `user: ${describeAction({ type: 'SET_BOARDS', enableIds, disableIds })}`, { action, enableIds, disableIds });
        await this.client.setBoards(enableIds, disableIds);
        this._lastActuationMs = Date.now();
        Object.assign(this.state, { lastBoardsChangeAt: now });
        await this.persistState();
        return { ok: true, enableIds, disableIds };
      }
      case 'goLive': {
        if (!minerCfg.dryRun) return { ok: true, dryRun: false };
        await this.setDryRun(false);
        this.state.dryRunActionCount = 0;
        this.wouldHave = null;
        await this.persistState();
        await this.appendEvent('go-live', 'info', 'dry run disabled — controller is live');
        return { ok: true, dryRun: false };
      }
      case 'dryRun': {
        await this.setDryRun(true);
        await this.appendEvent('dry-run-enabled', 'info', 'dry run re-enabled — observing only');
        return { ok: true, dryRun: true };
      }
      default:
        throw new UserActionError(400, `unknown action type: ${type}`);
    }
  }

  async setDryRun(flag) {
    const cfg = this.configStore.get();
    const miners = (cfg.miners || []).map((m) => (m.id === this.id ? { ...m, dryRun: flag } : m));
    await this.configStore.update({ miners });
    const updated = this.configStore.get();
    this.minerCfg = (updated.miners || []).find((m) => m.id === this.id) || this.minerCfg;
  }

  // ---- internals ----------------------------------------------------------------------

  async appendEvent(type, severity, message, data) {
    const evt = { ts: nowIso(), id: this.id, type, severity, message };
    if (data !== undefined) evt.data = data;
    try { await this.history.appendEvent(evt); }
    catch (e) { log(this.id, 'appendEvent failed:', e.message); }
  }

  async persistState() {
    try { await this.stateStore.save(this.id, this.state); }
    catch (e) { log(this.id, 'state save failed:', e.message); }
  }
}

module.exports = {
  Controller, resolveHeatDemand, altHeatPrice, estimateRoomTempC, classifyRoomReading,
  zoneForMiner, zoneRoomTemp, UserActionError,
};
