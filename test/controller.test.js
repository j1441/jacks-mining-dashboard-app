// test/controller.test.js — Controller tick pipeline against fakes (fixture-shaped
// snapshots, canned engine decisions, in-memory stores) plus the /health route of
// lib/api.js exercised over real HTTP. No timers are relied on: start() runs one tick.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { Controller, resolveHeatDemand } = require('../lib/controller');
const { createApi } = require('../lib/api');
const fixture = require('./fixtures/live-s19jpro.json');

// ---------- fixture-shaped snapshot ------------------------------------------------

function fixtureSnapshot(over = {}) {
  const boards = fixture.hashboards.hashboards.map((b) => ({
    id: b.id,
    enabled: b.enabled,
    hashing: (b.stats.real_hashrate.last_1m.gigahash_per_second || 0) > 0,
    boardTempC: b.board_temp ? b.board_temp.degree_c : null,
    chipTempC: b.highest_chip_temp ? b.highest_chip_temp.temperature.degree_c : null,
    hashrateThs: (b.stats.real_hashrate.last_1m.gigahash_per_second || 0) / 1000,
  }));
  const rh = fixture.stats.miner_stats.real_hashrate;
  return {
    ts: new Date().toISOString(),
    online: true,
    paused: fixture.details.status === 'MINER_STATUS_PAUSED',
    model: fixture.details.miner_identity.miner_model,
    minerStatus: 'NORMAL',
    boards,
    boardsEnabledCount: boards.filter((b) => b.enabled).length,
    boardsHashingCount: boards.filter((b) => b.hashing).length,
    tuner: { state: 'STABLE', targetW: Number(fixture.tunerState.power_target_mode_state.current_target.watt) },
    wallW: Number(fixture.stats.power_stats.approximated_consumption.watt),
    cooling: {
      mode: fixture.configuration.temperature.mode,
      fans: fixture.cooling.fans.map((f) => ({ rpm: f.rpm, ratio: f.target_speed_ratio })),
      highestTempC: fixture.cooling.highest_temperature.temperature.degree_c,
    },
    pools: fixture.configuration.pool_groups[0].pools.map((p, i) => ({
      url: p.url, user: p.user, active: i === 0, accepted: 12206, rejected: 26,
    })),
    hashrate: {
      m1: rh.last_1m.gigahash_per_second / 1000,
      m15: rh.last_15m.gigahash_per_second / 1000,
      h1: rh.last_1h.gigahash_per_second / 1000,
      h24: rh.last_24h.gigahash_per_second / 1000,
    },
    dps: { enabled: fixture.configuration.dps.enabled },
    constraints: {
      minTargetW: Number(fixture.constraints.tuner_constraints.power_target.min.watt),
      maxTargetW: Number(fixture.constraints.tuner_constraints.power_target.max.watt),
    },
    errors: [],
    ...over,
  };
}

// ---------- fakes ------------------------------------------------------------------

const ACTUATION_METHODS = ['pause', 'resume', 'setPowerTarget', 'setBoards'];

function fakeClient(snapshotOver = {}, seq = []) {
  const calls = [];
  const failures = new Set();
  const client = {
    calls, failures, seq,
    async getSnapshot() { return fixtureSnapshot(snapshotOver); },
    async listTunedProfiles() { return []; },
    async close() {},
  };
  for (const m of ACTUATION_METHODS) {
    client[m] = async (...args) => {
      seq.push(`client:${m}`);
      calls.push([m, ...args]);
      if (failures.has(m)) throw new Error(`read-back verify failed for ${m}`);
    };
  }
  return client;
}

function fakeEngine(decisions = []) {
  const decideCalls = [];
  return {
    decideCalls,
    decisions,
    decide(inputs) {
      decideCalls.push(inputs);
      return decisions.length ? decisions.shift() : cannedDecision();
    },
    buildPlan() { return []; },
    scoreCandidate(c, { marginalPrice, hashpriceNokPerThDay, poolFeePct, heat }) {
      const revenueNokH = (c.hashrateThs * hashpriceNokPerThDay * (1 - (poolFeePct || 0))) / 24;
      const costNokH = (c.wallW / 1000) * marginalPrice;
      const heatValueNokH = Math.min(c.wallW / 1000, heat.demandKW) * heat.altPricePerKWh;
      return { ...c, revenueNokH, costNokH, heatValueNokH, scoreNokH: revenueNokH + heatValueNokH - costNokH };
    },
    STATUS_TEMPLATES: {},
  };
}

function cannedDecision(over = {}) {
  return {
    action: null,
    stateUpdates: {},
    statusLine: 'test status',
    statusSeverity: 'ok',
    trace: {
      ts: new Date().toISOString(), marginalPrice: 0.8, regime: 'subsidised',
      hashpriceNokPerThDay: 5, heatDemandKW: 0, candidatesTop: [],
      chosen: { boards: 1, targetW: 944 }, blockedBy: [], reasons: [],
    },
    ...over,
  };
}

function fakeStateStore(preset = {}) {
  const saves = [];
  let current = {
    lastPowerChangeAt: null, lastBoardsChangeAt: null, lastOffAt: null, lastOnAt: null,
    pausedBy: null, thermalCeilingW: 0, thermalCeilingRaisedAt: null, tuningHoldSince: null,
    safetyPauseClearSince: null, dryRunActionCount: 0,
    ...preset,
  };
  return {
    saves,
    async load() { return { ...current }; },
    async save(id, state) { current = { ...state }; saves.push(JSON.parse(JSON.stringify(state))); },
    get current() { return current; },
  };
}

function fakeHistory(seq = []) {
  const samples = [];
  const events = [];
  return {
    samples, events,
    async appendSample(s) { samples.push(s); },
    async appendEvent(e) { seq.push(`event:${e.type}`); events.push(e); },
    async querySamples() { return samples; },
    async queryEvents({ limit = 100 } = {}) { return events.slice(-limit).reverse(); },
    async minerKWhThisMonth() { return 42; },
  };
}

function fakeMarket() {
  const hourStartIso = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  return {
    state() {
      return {
        today: [], tomorrow: null,
        horizonEndsAt: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
        currentMarginal: 0.8, currentHousehold: 0.9, regime: 'subsidised',
        btcNok: 1000000, btcUsd: 100000, hashpriceNokPerThDay: 5,
        networkThs: 9e8, fetchedAt: new Date().toISOString(), errors: [],
      };
    },
    priceHours() {
      return [
        { hourStartIso, marginalPrice: 0.8, householdPrice: 0.9, regime: 'subsidised' },
        { hourStartIso, marginalPrice: 1.2, householdPrice: 1.3, regime: 'subsidised' },
      ];
    },
  };
}

function fakeEnvelope() {
  const learned = [];
  const candidateCalls = [];
  return {
    learned, candidateCalls,
    candidates(opts) {
      candidateCalls.push(opts);
      return [{ boards: 1, targetW: 944, hashrateThs: 13.2, wallW: 475 }];
    },
    predict() { return { hashrateThs: 13.2, wallW: 475 }; },
    learn(boards, targetW, obs) { learned.push({ boards, targetW, obs }); },
    importProfiles() {},
    stats() { return { learnedPoints: 0, perBoardMinW: 397, perBoardMaxW: 996, overheadW: 80 }; },
    async load() {}, async save() {},
  };
}

function fakeAlerts() {
  const fired = [];
  const evaluated = [];
  return {
    fired, evaluated,
    async fire(ruleKey, info) { fired.push({ ruleKey, ...info }); },
    async evaluate(ctx) { evaluated.push(ctx); },
    async test() { return { ok: true }; },
  };
}

function fakeWsHub() {
  const broadcasts = [];
  return { broadcasts, broadcast(obj) { broadcasts.push(obj); }, clientCount() { return 0; } };
}

function minerCfg(over = {}) {
  return {
    id: 's19j4', ip: '192.168.1.89', name: 'S19j Pro', username: 'root', password: 'root',
    mode: 'auto', dryRun: false,
    manual: { boards: 1, targetW: 944 },
    limits: { minTargetW: 944, maxTargetW: 3500, allowedBoards: ['1', '2', '3'] },
    dwell: { powerMin: 15, boardsMin: 120, offMin: 20, deadbandW: 100 },
    safety: { derateChipTemp: 80, pauseChipTemp: 90, maxBoardTemp: 75, maxFanRpm: 6100, safetyStepW: 250 },
    cooling: { manage: false, mode: 'auto', targetC: 60 },
    dpsManage: 'leave',
    ...over,
  };
}

function fakeConfigStore(cfgOver = {}, minerOver = {}) {
  let cfg = {
    version: 2,
    electricity: { timezone: 'Europe/Oslo' },
    heating: { demandSource: 'manual', manualKW: 2, schedule: null, alt: { type: 'heatpump', scop: 3 } },
    economics: { poolFeePct: 0, startMarginNokH: 0.5, keepMarginNokH: 0.2, boardSwitch: { retuneMin: 45, wearNok: 2 } },
    miners: [minerCfg(minerOver)],
    ui: { currency: 'NOK' },
    pollSeconds: 10,
    ...cfgOver,
  };
  return {
    get() { return cfg; },
    async update(partial) { cfg = { ...cfg, ...partial }; return cfg; },
    redacted() { return JSON.parse(JSON.stringify({ ...cfg, miners: cfg.miners.map((m) => ({ ...m, password: '•••' })) })); },
  };
}

function makeController({ minerOver = {}, cfgOver = {}, decisions = [], statePreset = {}, clientOver = {} } = {}) {
  const seq = [];
  const client = fakeClient(clientOver, seq);
  const engine = fakeEngine(decisions);
  const stateStore = fakeStateStore(statePreset);
  const history = fakeHistory(seq);
  const market = fakeMarket();
  const envelope = fakeEnvelope();
  const alerts = fakeAlerts();
  const wsHub = fakeWsHub();
  const configStore = fakeConfigStore(cfgOver, minerOver);
  const controller = new Controller({
    minerCfg: configStore.get().miners[0],
    client, envelope, market, engine, stateStore, history, alerts, wsHub, configStore,
  });
  return { controller, seq, client, engine, stateStore, history, market, envelope, alerts, wsHub, configStore };
}

const minutesAgoIso = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const actuationCalls = (client) => client.calls.filter(([m]) => ACTUATION_METHODS.includes(m));

// ---------- tests -------------------------------------------------------------------

test('live action: intent event is appended BEFORE actuation, stateUpdates persisted on success', async () => {
  const marker = '2031-01-01T00:00:00.000Z';
  const t = makeController({
    decisions: [cannedDecision({
      action: { type: 'SET_POWER', targetW: 1200, reason: 'cheap hour', severity: 'info' },
      stateUpdates: { lastPowerChangeAt: marker },
    })],
  });
  await t.controller.start();
  try {
    const intentIdx = t.seq.indexOf('event:action-intent');
    const actuateIdx = t.seq.indexOf('client:setPowerTarget');
    assert.ok(intentIdx !== -1, 'intent event was appended');
    assert.ok(actuateIdx !== -1, 'actuation happened');
    assert.ok(intentIdx < actuateIdx, `intent (${intentIdx}) must precede actuation (${actuateIdx})`);
    assert.ok(t.seq.indexOf('event:action-applied') > actuateIdx, 'applied event follows actuation');

    assert.equal(t.stateStore.current.lastPowerChangeAt, marker, 'stateUpdates merged + persisted after success');
    assert.ok(t.stateStore.saves.some((s) => s.lastPowerChangeAt === marker), 'persisted via stateStore.save');

    // engine received properly built inputs
    const inputs = t.engine.decideCalls[0];
    assert.equal(inputs.heat.demandKW, 2, 'manual heat demand resolved');
    assert.ok(Math.abs(inputs.heat.altPricePerKWh - 0.3) < 1e-9, 'heat pump alt price = household/scop');
    assert.equal(inputs.market.marginalPrice, 0.8);
    assert.equal(inputs.market.horizonCoversNow, true);
    assert.equal(inputs.market.fallbackPrice, 1.2, 'fallback = max known marginal price');
    assert.equal(t.envelope.candidateCalls[0].thermalCeilingW, 3500, 'candidates clamped by thermal ceiling');
    assert.equal(inputs.candidates.length, 1);

    // per-tick side effects
    assert.ok(t.wsHub.broadcasts.length >= 1, 'broadcast every tick');
    assert.equal(t.history.samples.length, 1, 'one history sample on first tick');
    assert.equal(t.alerts.evaluated.length, 1, 'alert rules evaluated');

    const api = t.controller.snapshotForApi();
    assert.equal(api.id, 's19j4');
    assert.equal(api.power.targetW, 944);
    assert.equal(api.power.wallW, 475);
    assert.equal(api.hw.chipTempMax, 65);
    assert.equal(api.pool.failoverActive, false);
    assert.equal(api.statusLine, 'test status');
  } finally {
    await t.controller.stop();
  }
});

test('RESUME with board reconciliation: setBoards applied BEFORE resume, follow-up power after', async () => {
  const t = makeController({
    decisions: [cannedDecision({
      action: { type: 'RESUME', boards: 3, enableIds: ['3'], disableIds: [], targetW: 3068, reason: 'start after config drift', severity: 'info' },
      stateUpdates: { pausedBy: null },
    })],
  });
  await t.controller.start();
  try {
    const sb = t.seq.indexOf('client:setBoards');
    const rs = t.seq.indexOf('client:resume');
    assert.ok(sb !== -1, 'setBoards called');
    assert.ok(rs !== -1, 'resume called');
    assert.ok(sb < rs, `setBoards (${sb}) must precede resume (${rs}) — one hashchain bring-up`);
    assert.deepEqual(t.client.calls.find(([m]) => m === 'setBoards').slice(1), [['3'], []]);
    assert.ok(t.client.calls.some(([m, w]) => m === 'setPowerTarget' && w === 3068), 'follow-up power applied');
    assert.ok(t.seq.includes('event:action-applied'));
  } finally {
    await t.controller.stop();
  }
});

test('RESUME without board ids never touches boards', async () => {
  const t = makeController({
    decisions: [cannedDecision({
      action: { type: 'RESUME', targetW: 3068, reason: 'start', severity: 'info' },
    })],
  });
  await t.controller.start();
  try {
    assert.ok(!t.client.calls.some(([m]) => m === 'setBoards'), 'no setBoards call');
    assert.ok(t.client.calls.some(([m]) => m === 'resume'));
  } finally {
    await t.controller.stop();
  }
});

test('RESUME reconcile: a resume failure after setBoards still records the board dwell', async () => {
  const marker = '2020-01-01T00:00:00.000Z';
  const t = makeController({
    statePreset: { lastBoardsChangeAt: marker },
    decisions: [cannedDecision({
      action: { type: 'RESUME', boards: 3, enableIds: ['3'], disableIds: [], targetW: 3068, reason: 'start after config drift', severity: 'info' },
      stateUpdates: { pausedBy: null },
    })],
  });
  t.client.failures.add('resume');
  await t.controller.start();
  try {
    assert.ok(t.seq.includes('event:action-failed'), 'action reported failed');
    assert.notEqual(t.stateStore.current.lastBoardsChangeAt, marker,
      'boards DID change — dwell must be recorded despite the resume failure');
  } finally {
    await t.controller.stop();
  }
});

test('partial snapshot holds a reconcile RESUME — board changes computed from incomplete reads never actuate', async () => {
  const t = makeController({
    clientOver: { errors: ['GetHashboards: deadline exceeded'] },
    decisions: [cannedDecision({
      action: { type: 'RESUME', boards: 3, enableIds: ['3'], disableIds: [], targetW: 3068, reason: 'start after config drift', severity: 'info' },
    })],
  });
  await t.controller.start();
  try {
    assert.equal(actuationCalls(t.client).length, 0, 'no actuation on a partial snapshot');
    assert.ok(t.seq.includes('event:partial-snapshot-hold'));
  } finally {
    await t.controller.stop();
  }
});

test('dry run: no actuation ever, dryRunActionCount persisted, wouldHave derived', async () => {
  const t = makeController({
    minerOver: { dryRun: true },
    decisions: [
      cannedDecision({
        action: null,
        stateUpdates: { dryRunActionCount: 1 },
        statusLine: 'Dry run: observing only',
        trace: { ...cannedDecision().trace, chosen: { boards: 1, targetW: 1200 } },
      }),
      // defense in depth: a buggy engine returning an action must still not actuate
      cannedDecision({
        action: { type: 'SET_POWER', targetW: 2000, reason: 'buggy engine', severity: 'info' },
        stateUpdates: { dryRunActionCount: 2 },
      }),
    ],
  });
  await t.controller.start();
  try {
    assert.equal(actuationCalls(t.client).length, 0, 'no actuation in dry run');
    assert.equal(t.stateStore.current.dryRunActionCount, 1, 'would-have count persisted');
    assert.ok(t.stateStore.saves.some((s) => s.dryRunActionCount === 1));

    const api1 = t.controller.snapshotForApi();
    assert.equal(api1.dryRun, true);
    assert.match(api1.controller.wouldHave, /1200/, 'wouldHave names the target the engine chose');
    assert.equal(api1.controller.dryRunActionCount, 1);

    await t.controller.tick(); // consumes the buggy decision
    assert.equal(actuationCalls(t.client).length, 0, 'defense in depth: still no actuation');
    assert.equal(t.stateStore.current.dryRunActionCount, 2);
    assert.equal(t.seq.indexOf('event:action-intent'), -1, 'no intent events in dry run');
  } finally {
    await t.controller.stop();
  }
});

test('actuation verify failure: stateUpdates NOT persisted, alert fired, failure event logged', async () => {
  const marker = '2031-02-02T00:00:00.000Z';
  const t = makeController({
    decisions: [cannedDecision({
      action: { type: 'SET_POWER', targetW: 1500, reason: 'test', severity: 'info' },
      stateUpdates: { lastPowerChangeAt: marker },
    })],
  });
  t.client.failures.add('setPowerTarget');
  await t.controller.start();
  try {
    assert.notEqual(t.stateStore.current.lastPowerChangeAt, marker, 'dwell timestamp not persisted on failure');
    assert.ok(!t.stateStore.saves.some((s) => s.lastPowerChangeAt === marker), 'no save ever contained the update');
    assert.ok(t.history.events.some((e) => e.type === 'action-failed' && e.severity === 'critical'), 'failure event logged');
    assert.ok(t.alerts.fired.some((a) => a.ruleKey === 'actuation-verify-failed' && a.severity === 'critical'), 'alert fired');
    assert.ok(t.history.events.some((e) => e.type === 'action-intent'), 'intent was still logged first');
  } finally {
    await t.controller.stop();
  }
});

test('learn gate: feeds envelope only when tuner STABLE and >=10 min since any actuation', async () => {
  const staleTs = {
    lastPowerChangeAt: minutesAgoIso(11), lastBoardsChangeAt: minutesAgoIso(11),
    lastOffAt: minutesAgoIso(11), lastOnAt: minutesAgoIso(11),
  };

  // a) STABLE + old actuations → learns
  const a = makeController({ statePreset: staleTs });
  await a.controller.start();
  await a.controller.stop();
  assert.equal(a.envelope.learned.length, 1, 'learned once');
  assert.deepEqual(
    { boards: a.envelope.learned[0].boards, targetW: a.envelope.learned[0].targetW },
    { boards: 1, targetW: 944 }
  );
  assert.equal(a.envelope.learned[0].obs.wallW, 475);

  // b) tuner TUNING → no learning
  const b = makeController({ statePreset: staleTs, clientOver: { tuner: { state: 'TUNING', targetW: 944 } } });
  await b.controller.start();
  await b.controller.stop();
  assert.equal(b.envelope.learned.length, 0, 'no learning while TUNING');

  // c) recent actuation (2 min ago) → no learning
  const c = makeController({ statePreset: { ...staleTs, lastPowerChangeAt: minutesAgoIso(2) } });
  await c.controller.start();
  await c.controller.stop();
  assert.equal(c.envelope.learned.length, 0, 'no learning within 10 min of actuation');
});

test('startup reconcile: missing dwell timestamps init to now, safety pause not trusted', async () => {
  const t = makeController({ statePreset: { pausedBy: 'safety', thermalCeilingW: 0 } });
  const before = Date.now();
  await t.controller.start();
  try {
    const st = t.stateStore.current;
    for (const k of ['lastPowerChangeAt', 'lastBoardsChangeAt', 'lastOffAt', 'lastOnAt']) {
      const ts = Date.parse(st[k]);
      assert.ok(Number.isFinite(ts) && ts >= before - 1000, `${k} initialized to ~now`);
    }
    assert.equal(st.pausedBy, null, 'safety pause re-derives from live temps');
    assert.equal(st.thermalCeilingW, 3500, 'thermal ceiling initialized to limits.maxTargetW');
  } finally {
    await t.controller.stop();
  }
});

test('userAction: manual power/board changes rejected in auto mode without force', async () => {
  const t = makeController();
  await t.controller.start();
  try {
    await assert.rejects(() => t.controller.userAction({ type: 'setPower', targetW: 2000 }), /force/);
    await assert.rejects(() => t.controller.userAction({ type: 'setBoards', boards: 2 }), /force/);
    assert.equal(actuationCalls(t.client).length, 0);

    const res = await t.controller.userAction({ type: 'setPower', targetW: 2000, force: true });
    assert.deepEqual(res, { ok: true, targetW: 2000 });
    assert.ok(t.client.calls.some(([m, w]) => m === 'setPowerTarget' && w === 2000));

    // goLive clears dryRun in config; dryRun re-enables
    await t.controller.userAction({ type: 'dryRun' });
    assert.equal(t.configStore.get().miners[0].dryRun, true);
    const live = await t.controller.userAction({ type: 'goLive' });
    assert.deepEqual(live, { ok: true, dryRun: false });
    assert.equal(t.configStore.get().miners[0].dryRun, false);
  } finally {
    await t.controller.stop();
  }
});

test('resolveHeatDemand: off → 0, manual → manualKW, schedule → weekly grid slot', () => {
  const now = new Date().toISOString();
  assert.equal(resolveHeatDemand({ demandSource: 'off', manualKW: 5 }, now), 0);
  assert.equal(resolveHeatDemand({ demandSource: 'manual', manualKW: 2.5 }, now), 2.5);
  const sched = new Array(168).fill(1.5);
  assert.equal(
    resolveHeatDemand({ demandSource: 'schedule', schedule: sched }, now, null, 'Europe/Oslo'),
    1.5
  );
  assert.equal(
    resolveHeatDemand({ demandSource: 'schedule', schedule: [1, 2, 3] }, now),
    0, 'malformed schedule falls back to 0'
  );
});

test('resolveHeatDemand: thermostat modulates 0→maxKW across the band below target', () => {
  const now = new Date().toISOString();
  const zone = { demandSource: 'thermostat', thermostat: { targetC: 21, bandC: 2, maxKW: 3.5, idleOffsetC: 1.5 } };
  assert.equal(resolveHeatDemand(zone, now, 22), 0, 'above target → no demand');
  assert.equal(resolveHeatDemand(zone, now, 21), 0, 'at target → no demand');
  assert.equal(resolveHeatDemand(zone, now, 20), 1.75, 'halfway down the band → half of maxKW');
  assert.equal(resolveHeatDemand(zone, now, 19), 3.5, 'band exhausted → full demand');
  assert.equal(resolveHeatDemand(zone, now, 10), 3.5, 'far below target clamps at maxKW');
  assert.equal(resolveHeatDemand(zone, now, null), 0, 'no sensor reading → never heat blind');
  assert.equal(resolveHeatDemand(zone, now, undefined), 0);
});

test('classifyRoomReading: trusts fans-at-speed hashing and cooled idle; flags transitions', () => {
  const { classifyRoomReading } = require('../lib/controller');
  const thermo = { idleOffsetC: 1.5 };
  const snap = ({ inlet = 22, chip = null, fanRpm = 0, hashing = 0 }) => ({
    online: true,
    boards: [{ inletTempC: inlet, chipTempC: chip }],
    boardsHashingCount: hashing,
    cooling: { fans: [{ rpm: fanRpm }] },
  });
  // hashing with fans at sustained speed → reliable, no offset by default
  assert.deepEqual(classifyRoomReading(snap({ inlet: 22.5, chip: 65, fanRpm: 3000, hashing: 1 }), thermo, null, 15),
    { tempC: 22.5, reliable: true });
  // a fan burst over a hot chassis (fans fast but not yet sustained) → NOT reliable
  assert.equal(classifyRoomReading(snap({ inlet: 30, chip: 55, fanRpm: 3000, hashing: 1 }), thermo, null, 2).reliable, false);
  // runningOffsetC compensates exhaust recirculation into the intake
  assert.deepEqual(
    classifyRoomReading(snap({ inlet: 23.9, chip: 65, fanRpm: 3000, hashing: 1 }), { ...thermo, runningOffsetC: 4 }, null, 15),
    { tempC: 19.9, reliable: true });
  // warm-up: hashing but fans crawling (the live 31°-at-900rpm case) → NOT reliable
  assert.equal(classifyRoomReading(snap({ inlet: 31, chip: 55, fanRpm: 900, hashing: 1 }), thermo, null).reliable, false);
  // just paused, boards still hot → offset applied but NOT reliable
  const hot = classifyRoomReading(snap({ inlet: 27, chip: 60, fanRpm: 0, hashing: 0 }), thermo, 5);
  assert.equal(hot.reliable, false);
  assert.equal(hot.tempC, 25.5);
  // chips under 45° but stopped only 10 min ago (the live 29.5° poisoning case) → NOT reliable
  assert.equal(classifyRoomReading(snap({ inlet: 36, chip: 45, fanRpm: 0, hashing: 0 }), thermo, 10).reliable, false);
  // missing chip temps (boards re-initialising mid-restart, the live 28.0° case) → NOT reliable
  assert.equal(classifyRoomReading(snap({ inlet: 34.6, chip: null, fanRpm: 0, hashing: 0 }), thermo, 75).reliable, false);
  // idle, cooled AND ≥45 min since stop → reliable with idle offset
  assert.deepEqual(classifyRoomReading(snap({ inlet: 24, chip: 40, fanRpm: 0, hashing: 0 }), thermo, 90),
    { tempC: 22.5, reliable: true });
  // never ran since boot (idleMinutes unknown) behaves like a long-idle miner
  assert.equal(classifyRoomReading(snap({ inlet: 24, chip: 40, fanRpm: 0, hashing: 0 }), thermo, null).reliable, true);
  // no sensor → null
  assert.equal(classifyRoomReading({ online: true, boards: [{}], boardsHashingCount: 0, cooling: { fans: [] } }, thermo, null), null);
});

test('maybeApplyCooling: applies configured mode once when miner disagrees, throttled', async () => {
  const calls = [];
  const events = [];
  const fake = {
    minerCfg: { cooling: { manage: true, mode: 'auto', targetC: 60 } },
    client: { async setCoolingMode(cfg) { calls.push(cfg); } },
    async appendEvent(type, sev, msg) { events.push(type); },
  };
  const snap = { online: true, cooling: { mode: 'manual' } };
  await Controller.prototype.maybeApplyCooling.call(fake, snap);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { mode: 'auto', targetC: 60 });
  assert.deepEqual(events, ['cooling-config']);

  // throttled: a second disagreeing tick within 5 min does not re-apply
  await Controller.prototype.maybeApplyCooling.call(fake, snap);
  assert.equal(calls.length, 1);

  // agreement or manage=false → no calls
  fake._lastCoolingApplyMs = 0;
  await Controller.prototype.maybeApplyCooling.call(fake, { online: true, cooling: { mode: 'auto' } });
  fake.minerCfg.cooling.manage = false;
  await Controller.prototype.maybeApplyCooling.call(fake, snap);
  assert.equal(calls.length, 1);
});

test('zones: zoneForMiner resolves by zoneId; zoneRoomTemp takes coolest fresh reading', () => {
  const { zoneForMiner, zoneRoomTemp } = require('../lib/controller');
  const cfg = {
    heating: { zones: [{ id: 'up', name: 'Upstairs' }, { id: 'garage', name: 'Garage' }] },
    miners: [{ id: 'a', zoneId: 'garage' }, { id: 'b', zoneId: 'up' }],
  };
  assert.equal(zoneForMiner(cfg, 'a').id, 'garage');
  assert.equal(zoneForMiner(cfg, 'b').id, 'up');
  assert.equal(zoneForMiner(cfg, 'missing').id, 'up', 'unknown miner falls back to first zone');

  const reg = new Map([
    ['a', { zoneId: 'garage', tempC: 9, ts: Date.now() }],
    ['b', { zoneId: 'garage', tempC: 7.5, ts: Date.now() }],
    ['c', { zoneId: 'garage', tempC: 2, ts: Date.now() - 10 * 60 * 1000 }], // stale
    ['d', { zoneId: 'up', tempC: 22, ts: Date.now() }],                     // other zone
  ]);
  assert.equal(zoneRoomTemp(reg, 'garage', 9), 7.5, 'coolest fresh reading in the zone');
  assert.equal(zoneRoomTemp(reg, 'up', null), 22, 'own reading may be null');
  assert.equal(zoneRoomTemp(new Map(), 'x', null), null);
});

test('estimateRoomTempC: min inlet across boards, idle offset only when fans are off', () => {
  const { estimateRoomTempC } = require('../lib/controller');
  const thermo = { idleOffsetC: 1.5 };
  const snap = (boards, fans) => ({ online: true, boards, cooling: { fans } });
  const fansOn = [{ rpm: 3000 }, { rpm: 3010 }];
  const fansOff = [{ rpm: 0 }, { rpm: 0 }];

  // mining: fans pull room air — min inlet used as-is (26.5 beats the hot board's 33.5)
  assert.equal(estimateRoomTempC(snap([{ inletTempC: 33.5 }, { inletTempC: 26.5 }], fansOn), thermo), 26.5);
  // paused: fans off → subtract idle offset
  assert.equal(estimateRoomTempC(snap([{ inletTempC: 26.5 }, { inletTempC: 27 }], fansOff), thermo), 25);
  // no inlet data at all → null
  assert.equal(estimateRoomTempC(snap([{ inletTempC: null }, {}], fansOn), thermo), null);
  // offline → null
  assert.equal(estimateRoomTempC({ online: false, boards: [{ inletTempC: 25 }], cooling: { fans: fansOn } }, thermo), null);
  // implausible reading → null
  assert.equal(estimateRoomTempC(snap([{ inletTempC: 250 }], fansOn), thermo), null);
});

test('/health: 200 while every controller ticked recently, 503 once one goes stale', async () => {
  const configStore = fakeConfigStore(); // pollSeconds 10 → threshold max(60s, 50s) = 60s
  const ctrl = {
    id: 'm1', running: true,
    lastTickAt: new Date().toISOString(),
    traces: [], plan: [],
    snapshotForApi() { return { id: 'm1', online: true }; },
  };
  const app = express();
  app.use(createApi({
    configStore, controllers: [ctrl], market: fakeMarket(),
    history: fakeHistory(), alerts: fakeAlerts(), version: '2.0.0-test',
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.ok, true);

    ctrl.lastTickAt = minutesAgoIso(10); // stale: > 60s
    res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);
    body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.controllers[0].stale, true);

    ctrl.lastTickAt = null; // never ticked → also unhealthy
    res = await fetch(`${base}/health`);
    assert.equal(res.status, 503);

    // /api/state still works and includes the miner snapshot
    ctrl.lastTickAt = new Date().toISOString();
    res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.equal(state.version, '2.0.0-test');
    assert.equal(state.miners.length, 1);
    assert.equal(state.miners[0].id, 'm1');
    // zone-less legacy config synthesizes one pseudo-zone from the top-level heating fields
    assert.equal(state.heating.zones.length, 1);
    assert.equal(state.heating.zones[0].demandKW, 2);
    assert.equal(state.heating.zones[0].miners[0], configStore.get().miners[0].id);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
