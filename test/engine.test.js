// test/engine.test.js — unit tests for lib/engine.js (DESIGN §7): objective math
// (incl. negative prices), hysteresis transitions, dwell blocking, one-time
// board-switch cost test, heat-demand emergency (alt none), thermal-ceiling latch
// (no sawtooth), TUNING hold, stale-horizon fallback, plan/live consistency,
// dry-run semantics, modes and the statusLine template catalog.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, buildPlan, scoreCandidate, STATUS_TEMPLATES, statusLine } = require('../lib/engine.js');

const NOW = '2026-01-15T10:00:00.000Z';
const iso = (minOffset) => new Date(Date.parse(NOW) + minOffset * 60000).toISOString();

// Synthetic candidate grid. hashprice 4.8 NOK/TH/day => revenue = ths * 0.2 NOK/h.
const C1 = { boards: 1, targetW: 1000, hashrateThs: 13, wallW: 500 };   // rev 2.6
const C2 = { boards: 2, targetW: 2000, hashrateThs: 26, wallW: 1000 };  // rev 5.2
const C3a = { boards: 3, targetW: 2500, hashrateThs: 33, wallW: 1250 }; // rev 6.6
const C3 = { boards: 3, targetW: 3000, hashrateThs: 39, wallW: 1500 };  // rev 7.8
const CANDS = [C1, C2, C3a, C3];

const BOARD_ORDER = ['2', '1', '3'];

function mkSnapshot({ online = true, paused = false, boardsOn = 3, targetW = 3000,
  chipT = 65, boardT = 50, fanRpm = 4000, tuner = 'STABLE', wallW } = {}) {
  const enabled = BOARD_ORDER.slice(0, boardsOn);
  const boards = ['1', '2', '3'].map((id) => ({
    id,
    enabled: enabled.includes(id),
    hashing: enabled.includes(id) && !paused,
    boardTempC: enabled.includes(id) && !paused ? boardT : null,
    chipTempC: enabled.includes(id) && !paused ? chipT : null,
    hashrateThs: enabled.includes(id) && !paused ? 13 : 0,
  }));
  const cand = CANDS.find((c) => c.boards === boardsOn && c.targetW === targetW);
  return {
    ts: NOW,
    online,
    paused,
    model: 'Antminer S19j Pro',
    minerStatus: paused ? 'PAUSED' : 'NORMAL',
    boards,
    boardsEnabledCount: boardsOn,
    boardsHashingCount: paused ? 0 : boardsOn,
    tuner: { state: tuner, targetW },
    wallW: wallW !== undefined ? wallW : (paused ? 0 : (cand ? cand.wallW : Math.round(targetW / 2))),
    cooling: { mode: 'auto', fans: [{ rpm: fanRpm, ratio: 0.6 }], highestTempC: paused ? 45 : chipT },
    pools: [{ url: 'stratum+tcp://pool', user: 'u', active: true, accepted: 1, rejected: 0 }],
    hashrate: { m1: 39, m15: 39, h1: 39, h24: 39 },
    dps: { enabled: true },
    constraints: { minTargetW: 944, maxTargetW: 6435 },
    errors: [],
  };
}

function mkInputs(o = {}) {
  return {
    now: o.now || NOW,
    snapshot: o.snapshot || mkSnapshot(o.snap || {}),
    candidates: o.candidates || CANDS,
    market: {
      marginalPrice: 1, householdPrice: 1, regime: 'subsidised',
      hashpriceNokPerThDay: 4.8, horizonCoversNow: true, fallbackPrice: null,
      ...(o.market || {}),
    },
    priceHours: o.priceHours || [],
    heat: { demandKW: 0, altType: 'heatpump', altPricePerKWh: 0.5, ...(o.heat || {}) },
    settings: {
      mode: 'auto', dryRun: false,
      economics: { poolFeePct: 0, startMarginNokH: 0.5, keepMarginNokH: 0.2, boardSwitch: { retuneMin: 45, wearNok: 2 } },
      dwell: { powerMin: 15, boardsMin: 120, offMin: 20, deadbandW: 100 },
      safety: { derateChipTemp: 80, pauseChipTemp: 90, maxBoardTemp: 75, maxFanRpm: 6100, safetyStepW: 250 },
      limits: { minTargetW: 944, maxTargetW: 3500, allowedBoards: ['1', '2', '3'] },
      manual: { boards: 1, targetW: 944 },
      ...(o.settings || {}),
    },
    state: {
      lastPowerChangeAt: null, lastBoardsChangeAt: null, lastOffAt: null, lastOnAt: null,
      pausedBy: null, thermalCeilingW: 3500, thermalCeilingRaisedAt: null,
      tuningHoldSince: null, safetyPauseClearSince: null, dryRunActionCount: 0,
      ...(o.state || {}),
    },
  };
}

const hoursFrom = (prices, startMin = 0) => prices.map((p, i) => ({
  hourStartIso: iso(startMin + i * 60), marginalPrice: p, householdPrice: p, regime: 'subsidised',
}));

// ---- objective math ---------------------------------------------------------

test('scoreCandidate: revenue/cost/heatValue/score per DESIGN §3.2', () => {
  const s = scoreCandidate(C3, {
    marginalPrice: 1.5, hashpriceNokPerThDay: 4.8, poolFeePct: 0,
    heat: { demandKW: 0.8, altType: 'heatpump', altPricePerKWh: 0.5 },
  });
  assert.ok(Math.abs(s.revenueNokH - 7.8) < 1e-9);
  assert.ok(Math.abs(s.costNokH - 2.25) < 1e-9);
  assert.ok(Math.abs(s.heatValueNokH - 0.4) < 1e-9); // useful heat clamped to demand
  assert.ok(Math.abs(s.scoreNokH - (7.8 + 0.4 - 2.25)) < 1e-9);
});

test('scoreCandidate: btcPremiumPct values mined sats above spot (non-KYC premium)', () => {
  const base = scoreCandidate(C3, { marginalPrice: 1, hashpriceNokPerThDay: 4.8, poolFeePct: 0, heat: { demandKW: 0, altPricePerKWh: 0 } });
  const prem = scoreCandidate(C3, { marginalPrice: 1, hashpriceNokPerThDay: 4.8, poolFeePct: 0, btcPremiumPct: 6, heat: { demandKW: 0, altPricePerKWh: 0 } });
  assert.ok(Math.abs(prem.revenueNokH - base.revenueNokH * 1.06) < 1e-9);
  assert.ok(Math.abs(prem.scoreNokH - (base.scoreNokH + base.revenueNokH * 0.06)) < 1e-9, 'cost unaffected');
  // premium composes with the pool fee
  const both = scoreCandidate(C3, { marginalPrice: 1, hashpriceNokPerThDay: 4.8, poolFeePct: 0.02, btcPremiumPct: 6, heat: { demandKW: 0, altPricePerKWh: 0 } });
  assert.ok(Math.abs(both.revenueNokH - 7.8 * 0.98 * 1.06) < 1e-9);
});

test('scoreCandidate: pool fee reduces revenue; OFF scores exactly zero', () => {
  const s = scoreCandidate(C3, { marginalPrice: 1, hashpriceNokPerThDay: 4.8, poolFeePct: 0.02, heat: { demandKW: 0, altPricePerKWh: 0 } });
  assert.ok(Math.abs(s.revenueNokH - 7.8 * 0.98) < 1e-9);
  const off = scoreCandidate({ off: true, boards: 0, targetW: 0, hashrateThs: 0, wallW: 0 },
    { marginalPrice: 5, hashpriceNokPerThDay: 4.8, poolFeePct: 0, heat: { demandKW: 2, altPricePerKWh: 3 } });
  assert.equal(off.scoreNokH, 0);
});

test('scoreCandidate: negative prices are legal and make running more attractive', () => {
  const s = scoreCandidate(C3, { marginalPrice: -0.5, hashpriceNokPerThDay: 4.8, poolFeePct: 0, heat: { demandKW: 0, altPricePerKWh: 0 } });
  assert.ok(Math.abs(s.costNokH - (-0.75)) < 1e-9);
  assert.ok(Math.abs(s.scoreNokH - 8.55) < 1e-9);
});

test('decide: negative price -> start at full throttle', () => {
  const d = decide(mkInputs({ snap: { paused: true }, market: { marginalPrice: -0.5 } }));
  assert.equal(d.action.type, 'RESUME');
  assert.deepEqual(d.trace.chosen, { boards: 3, targetW: 3000 });
});

// Board config drifted while paused (e.g. a disable that reported failure but
// persisted — live incident 2026-07-26): RESUME must carry the reconciliation.
test('decide: resume reconciles board config drift — enables boards disabled while paused', () => {
  const d = decide(mkInputs({ snap: { paused: true, boardsOn: 2 } }));
  assert.equal(d.action.type, 'RESUME');
  assert.equal(d.action.boards, 3);
  assert.deepEqual(d.action.enableIds, ['3']);
  assert.deepEqual(d.action.disableIds, []);
  assert.equal(d.action.targetW, 3000);
  assert.equal(d.stateUpdates.lastBoardsChangeAt, NOW);
  assert.deepEqual(d.trace.chosen, { boards: 3, targetW: 3000 });
});

test('decide: resume with a matching board config carries no board reconciliation', () => {
  const d = decide(mkInputs({ snap: { paused: true, boardsOn: 3 } }));
  assert.equal(d.action.type, 'RESUME');
  assert.equal(d.action.enableIds, undefined);
  assert.equal(d.action.disableIds, undefined);
  assert.ok(!('lastBoardsChangeAt' in d.stateUpdates));
});

test('decide: resume reconciles the other way — disables boards the pick does not want', () => {
  const d = decide(mkInputs({ snap: { paused: true, boardsOn: 3 }, candidates: [C1, C2] }));
  assert.equal(d.action.type, 'RESUME');
  assert.equal(d.action.boards, 2);
  assert.deepEqual(d.action.enableIds, []);
  assert.deepEqual(d.action.disableIds, ['3']);
  assert.equal(d.stateUpdates.lastBoardsChangeAt, NOW);
});

test('decide: engine adds the OFF candidate itself (inputs contain none)', () => {
  const d = decide(mkInputs({ snap: { paused: true }, market: { marginalPrice: 6 }, state: { lastOffAt: iso(-60) } }));
  assert.ok(d.trace.candidatesTop.some((c) => c.off));
  assert.equal(d.trace.candidatesTop[0].off, true); // at 6 kr/kWh OFF wins
});

// ---- hysteresis ----------------------------------------------------------------

test('hysteresis: OFF stays off below start margin', () => {
  // p=5.3: best ON score is -0.025 (< startMargin 0.5)
  const d = decide(mkInputs({ snap: { paused: true }, market: { marginalPrice: 5.3 }, state: { lastOffAt: iso(-60) } }));
  assert.equal(d.action, null);
  assert.deepEqual(d.trace.chosen, { off: true });
  assert.match(d.statusLine, /unprofitable/);
});

test('hysteresis: OFF starts when best score clears the start margin', () => {
  const d = decide(mkInputs({ snap: { paused: true }, market: { marginalPrice: 1 }, state: { lastOffAt: iso(-60), pausedBy: 'engine' } }));
  assert.equal(d.action.type, 'RESUME');
  assert.equal(d.stateUpdates.lastOnAt, NOW);
  assert.equal(d.stateUpdates.pausedBy, null);
  assert.match(d.statusLine, /^Starting/);
});

test('hysteresis: ON rides out a small loss (keep margin)', () => {
  // p=5.3 at 3 boards @2500: best same-count score -0.025, above -keepMargin
  const d = decide(mkInputs({ snap: { boardsOn: 3, targetW: 2500 }, market: { marginalPrice: 5.3 } }));
  assert.equal(d.action, null);
  assert.match(d.statusLine, /small loss/);
});

test('hysteresis: ON stops when best score drops below -keepMargin', () => {
  const d = decide(mkInputs({ market: { marginalPrice: 6 } }));
  assert.equal(d.action.type, 'PAUSE');
  assert.equal(d.action.severity, 'info');
  assert.equal(d.stateUpdates.pausedBy, 'engine');
  assert.equal(d.stateUpdates.lastOffAt, NOW);
  assert.deepEqual(d.trace.chosen, { off: true });
});

// ---- dwell blocking --------------------------------------------------------------

test('power dwell blocks a wanted change, then allows it', () => {
  const base = { snap: { boardsOn: 3, targetW: 2500 }, market: { marginalPrice: 1 } };
  const blocked = decide(mkInputs({ ...base, state: { lastPowerChangeAt: iso(-5) } }));
  assert.equal(blocked.action, null);
  assert.ok(blocked.trace.blockedBy.includes('power dwell'));
  assert.match(blocked.statusLine, /Holding 3 boards @ 2500 W/);

  const allowed = decide(mkInputs({ ...base, state: { lastPowerChangeAt: iso(-16) } }));
  assert.equal(allowed.action.type, 'SET_POWER');
  assert.equal(allowed.action.targetW, 3000);
  assert.equal(allowed.stateUpdates.lastPowerChangeAt, NOW);
});

test('deadband: |delta| < deadbandW means no action, steady running status', () => {
  const d = decide(mkInputs({ snap: { boardsOn: 3, targetW: 2950, wallW: 1475 }, market: { marginalPrice: 1 } }));
  assert.equal(d.action, null);
  assert.match(d.statusLine, /Mining with 3 boards @ 2950 W/);
  assert.equal(d.statusSeverity, 'ok');
});

test('off dwell blocks a restart, then allows it', () => {
  const base = { snap: { paused: true }, market: { marginalPrice: 1 } };
  const blocked = decide(mkInputs({ ...base, state: { lastOffAt: iso(-10) } }));
  assert.equal(blocked.action, null);
  assert.ok(blocked.trace.blockedBy.includes('off dwell'));
  assert.match(blocked.statusLine, /rapid on\/off cycling/);

  const allowed = decide(mkInputs({ ...base, state: { lastOffAt: iso(-25) } }));
  assert.equal(allowed.action.type, 'RESUME');
});

// ---- one-time board-switch cost test ----------------------------------------------

test('board switch blocked when the integrated advantage does not cover the one-time cost', () => {
  // 1 board @1000 at p=1: advantage 4.2/h; horizon empty -> current hour only.
  // switchCost = 0.75 * (2.1 - (-1.5)) + 2 = 4.7 > 4.2
  const d = decide(mkInputs({ snap: { boardsOn: 1, targetW: 1000 }, market: { marginalPrice: 1 } }));
  assert.equal(d.action, null);
  assert.ok(d.trace.blockedBy.some((b) => b.startsWith('board switch advantage')));
  assert.match(d.statusLine, /board switch would cost more than it gains today/);
});

test('board switch allowed when the day-ahead integral exceeds the one-time cost', () => {
  // 6 known cheap hours: advantage 6 * 4.2 = 25.2 > 4.7
  const d = decide(mkInputs({
    snap: { boardsOn: 1, targetW: 1000 },
    market: { marginalPrice: 1 },
    priceHours: hoursFrom([1, 1, 1, 1, 1, 1]),
  }));
  assert.equal(d.action.type, 'SET_BOARDS');
  assert.equal(d.action.boards, 3);
  assert.deepEqual(d.action.enableIds.sort(), ['1', '3']); // '2' already enabled
  assert.deepEqual(d.action.disableIds, []);
  assert.equal(d.action.targetW, 3000);
  assert.equal(d.stateUpdates.lastBoardsChangeAt, NOW);
  assert.equal(d.stateUpdates.lastPowerChangeAt, NOW);
});

test('boards dwell rate-limits an otherwise-worthwhile switch', () => {
  const d = decide(mkInputs({
    snap: { boardsOn: 1, targetW: 1000 },
    market: { marginalPrice: 1 },
    priceHours: hoursFrom([1, 1, 1, 1, 1, 1]),
    state: { lastBoardsChangeAt: iso(-60) }, // 60 < boardsMin 120
  }));
  assert.equal(d.action, null);
  assert.ok(d.trace.blockedBy.includes('boards dwell'));
});

// ---- heat-demand emergency (alt = none) ---------------------------------------------

test('heat emergency: never off while demand > 0 with no alternative source', () => {
  // p=6 would normally PAUSE; demand 1.4 kW forces the 1500 W candidate to stay on
  const d = decide(mkInputs({
    market: { marginalPrice: 6 },
    heat: { demandKW: 1.4, altType: 'none', altPricePerKWh: 0 },
  }));
  assert.equal(d.action, null); // already at the eligible candidate
  assert.deepEqual(d.trace.chosen, { boards: 3, targetW: 3000 });
  assert.match(d.statusLine, /Heating override/);
  assert.equal(d.statusSeverity, 'warn');
});

test('heat emergency: overrides off-dwell and start hysteresis to restart', () => {
  const d = decide(mkInputs({
    snap: { paused: true },
    market: { marginalPrice: 6 },
    heat: { demandKW: 1.4, altType: 'none', altPricePerKWh: 0 },
    state: { lastOffAt: iso(-5), pausedBy: 'engine' }, // off-dwell would still block
  }));
  assert.equal(d.action.type, 'RESUME');
  assert.match(d.statusLine, /Heating override/);
  assert.ok(d.trace.reasons.some((r) => r.includes('off-dwell overridden')));
});

test('heat emergency: exits when demand returns to zero', () => {
  const d = decide(mkInputs({
    market: { marginalPrice: 6 },
    heat: { demandKW: 0, altType: 'none', altPricePerKWh: 0 },
  }));
  assert.equal(d.action.type, 'PAUSE');
});

test('heat emergency: picks cheapest-net candidate with wall power >= demand', () => {
  // demand 0.9 kW at p=6: eligible are C2/C3a/C3 (wall >= 900); C2 has the least loss
  const d = decide(mkInputs({
    snap: { paused: true },
    market: { marginalPrice: 6 },
    heat: { demandKW: 0.9, altType: 'none', altPricePerKWh: 0 },
    state: { lastOffAt: iso(-60) },
  }));
  assert.equal(d.action.type, 'RESUME');
  assert.deepEqual(d.trace.chosen, { boards: 2, targetW: 2000 });
});

// ---- safety + thermal-ceiling latch ---------------------------------------------------

test('safety pause at pauseChipTemp, bypassing everything, critical severity', () => {
  const d = decide(mkInputs({ snap: { chipT: 91, tuner: 'TUNING' }, market: { marginalPrice: 1 } }));
  assert.equal(d.action.type, 'PAUSE');
  assert.equal(d.action.severity, 'critical');
  assert.equal(d.statusSeverity, 'critical');
  assert.match(d.statusLine, /^SAFETY: chip 91/);
  assert.equal(d.stateUpdates.pausedBy, 'safety');
  assert.equal(d.stateUpdates.lastOffAt, NOW);
});

test('safety derate steps down by safetyStepW, latches the thermal ceiling, bypasses dwell', () => {
  const d = decide(mkInputs({
    snap: { chipT: 85 },
    market: { marginalPrice: 1 },
    state: { lastPowerChangeAt: iso(-1) }, // dwell would block an economic change
  }));
  assert.equal(d.action.type, 'SET_POWER');
  assert.equal(d.action.targetW, 2750);
  assert.equal(d.stateUpdates.thermalCeilingW, 2750);
  assert.equal(d.stateUpdates.lastPowerChangeAt, NOW);
  assert.equal(d.statusSeverity, 'warn');
  assert.match(d.statusLine, /^SAFETY/);
});

test('safety derate triggers on board temp and max fans too; holds at min power', () => {
  const boardHot = decide(mkInputs({ snap: { boardT: 76 }, market: { marginalPrice: 1 } }));
  assert.equal(boardHot.action.type, 'SET_POWER');
  const fansMax = decide(mkInputs({ snap: { fanRpm: 6100 }, market: { marginalPrice: 1 } }));
  assert.equal(fansMax.action.type, 'SET_POWER');
  const atMin = decide(mkInputs({
    snap: { boardsOn: 1, targetW: 944, chipT: 85, wallW: 470 },
    market: { marginalPrice: 1 },
  }));
  assert.equal(atMin.action, null);
  assert.ok(atMin.trace.blockedBy.includes('already at minimum power'));
  assert.equal(atMin.stateUpdates.thermalCeilingW, 944);
});

test('thermal ceiling: economics cannot re-raise into a sawtooth', () => {
  // ceiling latched at 2750; candidates already clamped by the controller
  const clamped = [C1, C2, C3a, { boards: 3, targetW: 2750, hashrateThs: 36, wallW: 1400 }];
  const d = decide(mkInputs({
    candidates: clamped,
    snap: { boardsOn: 3, targetW: 2750, chipT: 70, wallW: 1400 },
    market: { marginalPrice: 1 },
    state: { thermalCeilingW: 2750, thermalCeilingRaisedAt: iso(-5) },
  }));
  assert.equal(d.action, null); // holds at the ceiling, no raise attempt
  assert.ok(d.trace.blockedBy.includes('thermalCeiling 2750'));
  assert.equal(d.stateUpdates.thermalCeilingW, undefined);
  assert.match(d.statusLine, /capped at 2750 W/);
});

test('thermal ceiling: rises by safetyStepW at most once per 30 min, only while cool', () => {
  const base = {
    candidates: [C1, C2, C3a, { boards: 3, targetW: 2750, hashrateThs: 36, wallW: 1400 }],
    snap: { boardsOn: 3, targetW: 2750, chipT: 70, wallW: 1400 },
    market: { marginalPrice: 1 },
  };
  const raised = decide(mkInputs({ ...base, state: { thermalCeilingW: 2750, thermalCeilingRaisedAt: iso(-31) } }));
  assert.equal(raised.stateUpdates.thermalCeilingW, 3000);
  assert.equal(raised.stateUpdates.thermalCeilingRaisedAt, NOW);

  const tooWarm = decide(mkInputs({
    ...base,
    snap: { ...base.snap, chipT: 76 }, // not < derate-5
    state: { thermalCeilingW: 2750, thermalCeilingRaisedAt: iso(-31) },
  }));
  assert.equal(tooWarm.stateUpdates.thermalCeilingW, undefined);

  const cleared = decide(mkInputs({ ...base, state: { thermalCeilingW: 3400, thermalCeilingRaisedAt: iso(-31) } }));
  assert.equal(cleared.stateUpdates.thermalCeilingW, 3500); // clears at limits.maxTargetW
  assert.equal(cleared.stateUpdates.thermalCeilingRaisedAt, null);
});

test('safety pause resume: requires chip < derate-5 held for 5 min, then economics restarts', () => {
  const paused = { paused: true, chipT: 85 };
  const still = decide(mkInputs({ snap: paused, state: { pausedBy: 'safety' } }));
  assert.equal(still.action, null);
  assert.equal(still.statusSeverity, 'critical');

  const cooling = decide(mkInputs({ snap: { paused: true, chipT: 70 }, state: { pausedBy: 'safety' } }));
  assert.equal(cooling.action, null);
  assert.equal(cooling.stateUpdates.safetyPauseClearSince, NOW);

  const notYet = decide(mkInputs({ snap: { paused: true, chipT: 70 }, state: { pausedBy: 'safety', safetyPauseClearSince: iso(-3) } }));
  assert.equal(notYet.action, null);

  const resumes = decide(mkInputs({
    snap: { paused: true, chipT: 70 },
    market: { marginalPrice: 1 },
    state: { pausedBy: 'safety', safetyPauseClearSince: iso(-6), lastOffAt: iso(-30) },
  }));
  assert.equal(resumes.action.type, 'RESUME');
  assert.equal(resumes.stateUpdates.pausedBy, null);
  assert.equal(resumes.stateUpdates.safetyPauseClearSince, null);
});

// paused snapshot reports no chip temp -> cooling.highestTempC drives the check
test('safety resume: cool cooling.highestTempC counts when board temps are gone', () => {
  const snap = mkSnapshot({ paused: true });
  snap.cooling.highestTempC = 70;
  const d = decide(mkInputs({ snapshot: snap, state: { pausedBy: 'safety' } }));
  assert.equal(d.stateUpdates.safetyPauseClearSince, NOW);
});

// ---- comfort ceiling -----------------------------------------------------------------

test('comfort limit: profitable mining stops at maxRoomC and will not restart until cooler', () => {
  // profitable (p=0.1) but room at the limit → running miner pauses
  const stop = decide(mkInputs({
    snap: { boardsOn: 3 },
    market: { marginalPrice: 0.1 },
    heat: { demandKW: 0, altType: 'none', altPricePerKWh: 0, roomTempC: 28, maxRoomC: 28 },
  }));
  assert.equal(stop.action && stop.action.type, 'PAUSE');
  assert.match(stop.statusLine, /comfort limit/);

  // paused, profitable, room just under the limit (hysteresis band) → no restart
  const hold = decide(mkInputs({
    snap: { paused: true, boardsOn: 3 },
    market: { marginalPrice: 0.1 },
    heat: { demandKW: 0, altType: 'none', altPricePerKWh: 0, roomTempC: 27.7, maxRoomC: 28 },
    state: { lastOffAt: iso(-60) },
  }));
  assert.equal(hold.action, null);
  assert.match(hold.statusLine, /comfort limit/);

  // cooled below the band → restarts
  const start = decide(mkInputs({
    snap: { paused: true, boardsOn: 3 },
    market: { marginalPrice: 0.1 },
    heat: { demandKW: 0, altType: 'none', altPricePerKWh: 0, roomTempC: 27.2, maxRoomC: 28 },
    state: { lastOffAt: iso(-60) },
  }));
  assert.equal(start.action && start.action.type, 'RESUME');

  // no room reading → comfort limit cannot act; profitable mining proceeds
  const blind = decide(mkInputs({
    snap: { paused: true, boardsOn: 3 },
    market: { marginalPrice: 0.1 },
    heat: { demandKW: 0, altType: 'none', altPricePerKWh: 0, roomTempC: null, maxRoomC: 28 },
    state: { lastOffAt: iso(-60) },
  }));
  assert.equal(blind.action && blind.action.type, 'RESUME');
});

// ---- TUNING hold ---------------------------------------------------------------------

test('TUNING hold: adjustments deferred while profitable, hold timestamp set once', () => {
  // profitable (would normally optimise the operating point) — hold defers it
  const d = decide(mkInputs({ snap: { tuner: 'TUNING', targetW: 2500, boardsOn: 3 }, market: { marginalPrice: 0.1 } }));
  assert.equal(d.action, null);
  assert.ok(d.trace.blockedBy.includes('tuner tuning'));
  assert.equal(d.stateUpdates.tuningHoldSince, NOW);
  assert.match(d.statusLine, /Tuner is optimising/);

  const again = decide(mkInputs({ snap: { tuner: 'PREHEAT', targetW: 2500, boardsOn: 3 }, market: { marginalPrice: 0.1 }, state: { tuningHoldSince: iso(-10) } }));
  assert.equal(again.action, null);
  assert.equal(again.stateUpdates.tuningHoldSince, undefined); // not overwritten
});

test('TUNING hold: shutdown passes through — no waiting out a re-tune with nothing to run for', () => {
  // Live incident 2026-07-24 #2: thermostat satisfied (demand 0), mining deeply
  // unprofitable, tuner mid-re-tune — the miner must stop, not idle at 850 W.
  const d = decide(mkInputs({
    snap: { tuner: 'TUNING', boardsOn: 3 },
    market: { marginalPrice: 6 },
    heat: { demandKW: 0, altType: 'none', altPricePerKWh: 0 },
  }));
  assert.ok(d.action, 'stop not deferred by tuning hold');
  assert.equal(d.action.type, 'PAUSE');
  assert.ok(d.trace.reasons.some((r) => /tuning hold/.test(r)));

  // but heat-emergency keeps it on: demand present + no alt heat → hold, not stop
  const heat = decide(mkInputs({
    snap: { tuner: 'TUNING', boardsOn: 3 },
    market: { marginalPrice: 6 },
    heat: { demandKW: 1.5, altType: 'none', altPricePerKWh: 0 },
  }));
  assert.equal(heat.action, null);
  assert.match(heat.statusLine, /Tuner is optimising/);

  // and never START mid-tune, however profitable
  const start = decide(mkInputs({
    snap: { tuner: 'TUNING', boardsOn: 0, targetW: 0 },
    market: { marginalPrice: 0.1 },
    state: { lastOffAt: iso(-60) },
  }));
  assert.equal(start.action, null);
  assert.ok(start.trace.blockedBy.includes('tuner tuning'));
});

test('TUNING hold skipped while paused: stale tuner state cannot deadlock auto control', () => {
  // Live incident 2026-07-24: pause interrupted a re-tune, BOSer kept reporting
  // TUNING forever, and the engine could never act again. While paused, the
  // engine must fall through to economics.
  const stuck = decide(mkInputs({
    snap: { paused: true, tuner: 'TUNING', boardsOn: 3 },
    market: { marginalPrice: 1 }, // profitable → should RESUME, not hold
    state: { lastOffAt: iso(-60), tuningHoldSince: iso(-90) },
  }));
  assert.ok(!stuck.trace.blockedBy.includes('tuner tuning'), 'no tuning hold while paused');
  assert.ok(stuck.action, 'engine acts despite stale TUNING');
  assert.equal(stuck.action.type, 'RESUME');

  // and when unprofitable it explains the economics instead of "tuner optimising"
  const off = decide(mkInputs({
    snap: { paused: true, tuner: 'TUNING', boardsOn: 3 },
    market: { marginalPrice: 6, hashpriceNokPerThDay: 0.3 },
    heat: { demandKW: 1.75, altType: 'heatpump', altPricePerKWh: 2 },
    state: { lastOffAt: iso(-60) },
  }));
  assert.equal(off.action, null);
  assert.match(off.statusLine, /heat pump covers the 1\.8 kW of heat more cheaply/);
});

test('TUNING hold clears when tuner is STABLE again; ERROR still defers economics', () => {
  const cleared = decide(mkInputs({ market: { marginalPrice: 1 }, state: { tuningHoldSince: iso(-20) } }));
  assert.equal(cleared.stateUpdates.tuningHoldSince, null);

  const err = decide(mkInputs({ snap: { tuner: 'ERROR' }, market: { marginalPrice: 6 } }));
  assert.equal(err.action, null);
  assert.ok(err.trace.blockedBy.includes('tuner error'));
  assert.equal(err.statusSeverity, 'warn');
});

// ---- stale-horizon fallback -------------------------------------------------------------

test('horizon exhausted: pessimistic fallback price replaces the stale marginal price', () => {
  const d = decide(mkInputs({
    snap: { paused: true },
    market: { marginalPrice: 1, horizonCoversNow: false, fallbackPrice: 6 },
    state: { lastOffAt: iso(-60) },
  }));
  assert.equal(d.action, null); // 6 kr/kWh: pure-profit mining stays off
  assert.equal(d.trace.marginalPrice, 6);
  assert.ok(d.trace.reasons.some((r) => r.includes('price horizon exhausted')));
  assert.match(d.statusLine, /prices for the coming hours are not published/);
  assert.equal(d.statusSeverity, 'warn');
});

test('horizon exhausted: heat-driven operation continues (alt none)', () => {
  const d = decide(mkInputs({
    market: { marginalPrice: 1, horizonCoversNow: false, fallbackPrice: 6 },
    heat: { demandKW: 1.4, altType: 'none', altPricePerKWh: 0 },
  }));
  assert.equal(d.action, null); // stays on at 3000 W
  assert.match(d.statusLine, /Heating override/);
});

// ---- modes, user pause, offline -----------------------------------------------------------

test('mode off: pauses a running miner once, then rests', () => {
  const d = decide(mkInputs({ settings: { mode: 'off' }, market: { marginalPrice: 1 } }));
  assert.equal(d.action.type, 'PAUSE');
  // 'engine', not 'user': Off→Auto must let the optimizer resume on its own.
  assert.equal(d.stateUpdates.pausedBy, 'engine');
  const idle = decide(mkInputs({ settings: { mode: 'off' }, snap: { paused: true } }));
  assert.equal(idle.action, null);
  assert.match(idle.statusLine, /Off mode/);
});

test('mode manual: engine never acts economically, safety still supervises', () => {
  const hands = decide(mkInputs({ settings: { mode: 'manual' }, market: { marginalPrice: 6 } }));
  assert.equal(hands.action, null);
  assert.match(hands.statusLine, /Manual mode/);
  const safety = decide(mkInputs({ settings: { mode: 'manual' }, snap: { chipT: 91 } }));
  assert.equal(safety.action.type, 'PAUSE');
});

test('user pause in auto mode is respected', () => {
  const d = decide(mkInputs({ snap: { paused: true }, market: { marginalPrice: 1 }, state: { pausedBy: 'user' } }));
  assert.equal(d.action, null);
  assert.match(d.statusLine, /Paused by you/);
});

test('offline: no actuation, warn status', () => {
  const d = decide(mkInputs({ snap: { online: false }, market: { marginalPrice: 1 } }));
  assert.equal(d.action, null);
  assert.ok(d.trace.blockedBy.includes('miner offline'));
  assert.match(d.statusLine, /unreachable/);
  assert.equal(d.statusSeverity, 'warn');
});

test('zero boards enabled but not paused: start enables boards instead of resuming', () => {
  const d = decide(mkInputs({ snap: { paused: false, boardsOn: 0, targetW: 3000, wallW: 80, chipT: 50 }, market: { marginalPrice: 1 } }));
  assert.equal(d.action.type, 'SET_BOARDS');
  assert.deepEqual(d.action.enableIds, ['2', '1', '3']); // preferred order
  assert.equal(d.action.boards, 3);
});

// ---- dry run -----------------------------------------------------------------------------

test('dry run: never returns an action; statusLine says would-have; counter increments', () => {
  const d = decide(mkInputs({ settings: { dryRun: true }, market: { marginalPrice: 6 } }));
  assert.equal(d.action, null);
  assert.match(d.statusLine, /^Dry run: observing only — would have: pause mining/);
  assert.equal(d.stateUpdates.dryRunActionCount, 1);
  // actuation-coupled state updates are dropped (nothing actually changed)
  assert.equal(d.stateUpdates.lastOffAt, undefined);
  assert.equal(d.stateUpdates.pausedBy, undefined);
});

test('dry run: suppressed safety pause keeps critical severity', () => {
  const d = decide(mkInputs({ settings: { dryRun: true }, snap: { chipT: 91 } }));
  assert.equal(d.action, null);
  assert.equal(d.statusSeverity, 'critical');
  assert.match(d.statusLine, /would have: pause mining/);
});

test('dry run: would-have describes board/power changes in plain words', () => {
  const d = decide(mkInputs({
    settings: { dryRun: true },
    snap: { boardsOn: 1, targetW: 1000 },
    market: { marginalPrice: 1 },
    priceHours: hoursFrom([1, 1, 1, 1, 1, 1]),
  }));
  assert.equal(d.action, null);
  assert.match(d.statusLine, /enable boards 1,3/);
  assert.match(d.statusLine, /set 3000 W/);
  assert.equal(d.stateUpdates.lastBoardsChangeAt, undefined);
});

// ---- statusLine template catalog ------------------------------------------------------------

test('STATUS_TEMPLATES: every template renders and has a valid severity', () => {
  const params = {
    chipTempC: 91, resumeBelowC: 75, what: 'chip 85.0 °C', targetW: 2750, ceilingW: 2750,
    boards: 2, netNokH: 1.23, heatKW: 1.5, price: 1.86, nextStartHour: '23:00',
    nextStartPrice: 0.62, wouldHave: 'pause mining', paused: false,
  };
  for (const [key, t] of Object.entries(STATUS_TEMPLATES)) {
    assert.ok(['ok', 'warn', 'critical'].includes(t.severity), `${key} severity`);
    const line = statusLine(key, params);
    assert.ok(typeof line === 'string' && line.length > 10, `${key} renders`);
    assert.ok(!/dwell|deadband|envelope/i.test(line), `${key} leaks raw identifiers`);
  }
  assert.equal(statusLine('no-such-key', {}), 'no-such-key');
});

test('off-unprofitable statusLine includes the next planned start from the horizon', () => {
  const d = decide(mkInputs({
    snap: { paused: true },
    market: { marginalPrice: 6 },
    priceHours: hoursFrom([6, 6, 1]), // profitable from NOW+120min = 12:00Z
    state: { lastOffAt: iso(-60) },
  }));
  assert.match(d.statusLine, /Off — mining unprofitable \(price 6\.00 kr\/kWh\)/);
  assert.match(d.statusLine, /Next planned start: 12:00 \(1\.00 kr\/kWh\)/);
});

test('off-unprofitable statusLine omits next start when the horizon has none', () => {
  const d = decide(mkInputs({
    snap: { paused: true },
    market: { marginalPrice: 6 },
    priceHours: hoursFrom([6, 6, 6]),
    state: { lastOffAt: iso(-60) },
  }));
  assert.ok(!d.statusLine.includes('Next planned start'));
});

// ---- buildPlan --------------------------------------------------------------------------------

test('buildPlan: threads on/off state across hours with hysteresis and off-dwell', () => {
  const inputs = mkInputs({
    snap: { boardsOn: 3, targetW: 3000 },
    market: { marginalPrice: 1 },
    priceHours: hoursFrom([1, 1, 5.3, 6, 1, 1]),
  });
  const plan = buildPlan(inputs);
  assert.equal(plan.length, 6);
  assert.deepEqual(plan.map((r) => r.off), [false, false, false, true, false, false]);
  assert.deepEqual(plan.map((r) => r.targetW), [3000, 3000, 2500, 0, 3000, 3000]);
  assert.deepEqual(plan.map((r) => r.boards), [3, 3, 3, 0, 3, 3]);
  assert.ok(Math.abs(plan[0].expScoreNokH - 6.3) < 1e-9);
  assert.equal(plan[3].expScoreNokH, 0);
  assert.equal(plan[0].expHeatKW, 0);
  assert.equal(plan[0].hourStartIso, iso(0));
  assert.equal(plan[0].regime, 'subsidised');
});

test('buildPlan: expNetNokH excludes heat value, expHeatKW clamped to demand', () => {
  const inputs = mkInputs({
    snap: { boardsOn: 3, targetW: 3000 },
    market: { marginalPrice: 1 },
    heat: { demandKW: 1.2, altType: 'resistive', altPricePerKWh: 1.0 },
    priceHours: hoursFrom([1]),
  });
  const [row] = buildPlan(inputs);
  assert.ok(Math.abs(row.expNetNokH - (7.8 - 1.5)) < 1e-9);
  assert.ok(Math.abs(row.expScoreNokH - (7.8 + 1.2 - 1.5)) < 1e-9);
  assert.equal(row.expHeatKW, 1.2);
});

test('buildPlan: boards dwell threads hour-to-hour; switch happens only when unlocked AND worth it', () => {
  const base = {
    snap: { boardsOn: 1, targetW: 1000 },
    market: { marginalPrice: 1 },
    state: { lastBoardsChangeAt: iso(-30) }, // 90 more minutes of boards dwell
  };
  // short horizon: after the dwell unlocks (row 2), only 1 hour remains -> not worth it
  const short = buildPlan(mkInputs({ ...base, priceHours: hoursFrom([1, 1, 1]) }));
  assert.deepEqual(short.map((r) => r.boards), [1, 1, 1]);
  // long horizon: at row 2 the remaining 6 hours justify the switch
  const long = buildPlan(mkInputs({ ...base, priceHours: hoursFrom([1, 1, 1, 1, 1, 1, 1, 1]) }));
  assert.deepEqual(long.map((r) => r.boards), [1, 1, 3, 3, 3, 3, 3, 3]);
});

test('buildPlan: heat emergency rows never go off', () => {
  const plan = buildPlan(mkInputs({
    snap: { paused: true },
    heat: { demandKW: 1.4, altType: 'none', altPricePerKWh: 0 },
    priceHours: hoursFrom([6, 6, 6]),
  }));
  assert.ok(plan.every((r) => !r.off));
  assert.ok(plan.every((r) => r.expHeatKW >= 1.4 - 1e-9));
});

test('plan/live consistency: first plan hour matches decide() for the same inputs', () => {
  const inputs = mkInputs({
    snap: { boardsOn: 3, targetW: 3000 },
    market: { marginalPrice: 1 },
    priceHours: hoursFrom([1, 1, 1]),
  });
  const d = decide(inputs);
  const plan = buildPlan(inputs);
  assert.equal(d.action, null); // already at the optimum
  assert.deepEqual({ boards: plan[0].boards, targetW: plan[0].targetW },
    { boards: d.trace.chosen.boards, targetW: d.trace.chosen.targetW });
});

test('buildPlan: empty horizon -> empty plan', () => {
  assert.deepEqual(buildPlan(mkInputs({ priceHours: [] })), []);
});

// --- regression tests for the adversarial-review fixes (2026-07-05) ---------

test('no usable price at all: engine holds, never treats electricity as free', () => {
  const d = decide(mkInputs({
    market: { marginalPrice: null, horizonCoversNow: false, fallbackPrice: null },
    snap: { paused: true },
  }));
  assert.equal(d.action, null);
  assert.ok(d.trace.blockedBy.includes('no price data'));
});

test('paused + hot chip: economics never restarts until below resume threshold', () => {
  const snapshot = mkSnapshot({ paused: true });
  snapshot.boards[0].chipTempC = 78; // paused but still >= derate(80) - 5
  const d = decide(mkInputs({
    market: { marginalPrice: 0.01 }, // wildly profitable
    snapshot,
  }));
  assert.equal(d.action, null);
  assert.ok(d.trace.blockedBy.some((b) => b.includes('too hot to start')));
});

test('hot with unreadable tuner target: derate deferred, ceiling not slammed', () => {
  const d = decide(mkInputs({
    snap: { chipT: 85, targetW: 0 },
  }));
  assert.equal(d.action, null);
  assert.notEqual(d.stateUpdates.thermalCeilingW, 944);
});

test('off mode then auto: engine resumes by itself when profitable', () => {
  const off = decide(mkInputs({ settings: { mode: 'off' } }));
  assert.equal(off.stateUpdates.pausedBy, 'engine');
  const resumed = decide(mkInputs({
    market: { marginalPrice: 0.01 },
    snap: { paused: true },
    state: { pausedBy: 'engine' },
  }));
  assert.ok(resumed.action && resumed.action.type === 'RESUME');
});
