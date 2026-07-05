// test/simulate.js — scenario simulator (DESIGN §7): drives the pure engine +
// envelope hour-by-hour against synthetic 24h/168h price days, prints a timeline
// per scenario and asserts the stated invariants. Runs standalone
// (`node test/simulate.js`) and under the test runner (`node --test`), since
// node:test executes registered tests in both modes.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { decide } = require('../lib/engine.js');
const { Envelope } = require('../lib/envelope.js');

const BASE_MS = Date.parse('2026-01-19T00:00:00.000Z'); // a Monday, hour 0
const HOUR_MS = 3600000;
const isoAt = (h) => new Date(BASE_MS + h * HOUR_MS).toISOString();
const LIMITS = { minTargetW: 944, maxTargetW: 3500, allowedBoards: ['1', '2', '3'] };
const HASHPRICE = 1.1; // NOK/TH/day -> revenue ≈ 1.55 NOK per kWh at full efficiency

const SETTINGS = {
  mode: 'auto',
  dryRun: false,
  economics: { poolFeePct: 0, startMarginNokH: 0.5, keepMarginNokH: 0.2, boardSwitch: { retuneMin: 45, wearNok: 2 } },
  dwell: { powerMin: 15, boardsMin: 120, offMin: 20, deadbandW: 100 },
  safety: { derateChipTemp: 80, pauseChipTemp: 90, maxBoardTemp: 75, maxFanRpm: 6100, safetyStepW: 250 },
  limits: LIMITS,
  manual: { boards: 1, targetW: 944 },
};

// ---- simulation harness -------------------------------------------------------

function simulate({
  name, hours, priceAt,
  demandAt = () => 0, altType = 'heatpump', altPriceAt = () => 0,
  start = { paused: true, enabledIds: ['2', '1', '3'], targetW: 3068 },
  chipModel = null,
  horizonAt = null, // (i) -> { priceHours, horizonCoversNow, fallbackPrice }
}) {
  const env = new Envelope({ minerId: 'sim', dataDir: os.tmpdir() });
  const miner = { paused: start.paused, enabledIds: [...start.enabledIds], targetW: start.targetW };
  let engState = {
    lastPowerChangeAt: null, lastBoardsChangeAt: null, lastOffAt: null, lastOnAt: null,
    pausedBy: miner.paused ? 'engine' : null, thermalCeilingW: LIMITS.maxTargetW,
    thermalCeilingRaisedAt: null, tuningHoldSince: null, safetyPauseClearSince: null,
    dryRunActionCount: 0,
  };
  const actions = [];
  const log = [];

  console.log(`# === ${name} ===`);
  for (let i = 0; i < hours; i++) {
    const now = isoAt(i);
    const price = priceAt(i);
    const count = miner.enabledIds.length;
    const pred = miner.paused ? { hashrateThs: 0, wallW: 0 } : env.predict(count, miner.targetW);
    const chip = chipModel ? chipModel({ wallW: pred.wallW, paused: miner.paused }) : (miner.paused ? 45 : 65);

    const snapshot = {
      ts: now,
      online: true,
      paused: miner.paused,
      model: 'Antminer S19j Pro',
      minerStatus: miner.paused ? 'PAUSED' : 'NORMAL',
      boards: ['1', '2', '3'].map((id) => {
        const en = miner.enabledIds.includes(id);
        const hashing = en && !miner.paused;
        return {
          id, enabled: en, hashing,
          boardTempC: hashing ? Math.max(30, chip - 15) : null,
          chipTempC: hashing ? chip : null,
          hashrateThs: hashing ? pred.hashrateThs / count : 0,
        };
      }),
      boardsEnabledCount: count,
      boardsHashingCount: miner.paused ? 0 : count,
      tuner: { state: 'STABLE', targetW: miner.targetW },
      wallW: pred.wallW,
      cooling: { mode: 'auto', fans: [{ rpm: miner.paused ? 0 : 4000, ratio: 0.6 }], highestTempC: chip },
      pools: [{ url: 'stratum+tcp://pool', user: 'u', active: true, accepted: 1, rejected: 0 }],
      hashrate: { m1: pred.hashrateThs, m15: pred.hashrateThs, h1: pred.hashrateThs, h24: pred.hashrateThs },
      dps: { enabled: true },
      constraints: { minTargetW: 944, maxTargetW: 6435 },
      errors: [],
    };

    const horizon = horizonAt ? horizonAt(i) : {
      priceHours: [],
      horizonCoversNow: true,
      fallbackPrice: null,
    };
    if (!horizonAt) {
      for (let j = i; j < Math.min(hours, i + 36); j++) {
        horizon.priceHours.push({ hourStartIso: isoAt(j), marginalPrice: priceAt(j), householdPrice: priceAt(j), regime: 'subsidised' });
      }
    }

    const inputs = {
      now,
      snapshot,
      candidates: env.candidates({ limits: LIMITS, thermalCeilingW: engState.thermalCeilingW, allowedBoardsCount: LIMITS.allowedBoards.length }),
      market: {
        marginalPrice: price, householdPrice: price, regime: 'subsidised',
        hashpriceNokPerThDay: HASHPRICE,
        horizonCoversNow: horizon.horizonCoversNow, fallbackPrice: horizon.fallbackPrice,
      },
      priceHours: horizon.priceHours,
      heat: { demandKW: demandAt(i), altType, altPricePerKWh: altPriceAt(i) },
      settings: SETTINGS,
      state: engState,
    };

    const d = decide(inputs);
    engState = { ...engState, ...d.stateUpdates };
    if (d.action) {
      actions.push({ hour: i, ...d.action });
      switch (d.action.type) {
        case 'PAUSE': miner.paused = true; break;
        case 'RESUME': miner.paused = false; break;
        case 'SET_POWER': miner.targetW = d.action.targetW; break;
        case 'SET_BOARDS':
          miner.enabledIds = miner.enabledIds
            .filter((id) => !(d.action.disableIds || []).includes(id))
            .concat((d.action.enableIds || []).filter((id) => !miner.enabledIds.includes(id)));
          if (d.action.targetW) miner.targetW = d.action.targetW;
          break;
        default: break;
      }
    }

    const postCount = miner.enabledIds.length;
    const postPred = miner.paused ? { hashrateThs: 0, wallW: 0 } : env.predict(postCount, miner.targetW);
    const row = {
      hour: i, price, off: miner.paused, boards: miner.paused ? 0 : postCount,
      targetW: miner.paused ? 0 : miner.targetW, wallW: postPred.wallW, chip,
      demandKW: demandAt(i), action: d.action ? d.action.type : null,
      statusLine: d.statusLine, statusSeverity: d.statusSeverity,
      marginalUsed: d.trace.marginalPrice,
    };
    log.push(row);
    const state = row.off ? 'OFF          ' : `ON ${row.boards}b@${String(row.targetW).padStart(4)}W`;
    console.log(`# h${String(i).padStart(3, '0')} ${price.toFixed(2).padStart(5)} kr `
      + `dem=${row.demandKW.toFixed(1)}kW | ${state} wall=${String(row.wallW).padStart(4)}W chip=${String(Math.round(chip)).padStart(2)}C | `
      + `${row.action ? row.action.padEnd(10) : '-'.padEnd(10)} | ${row.statusLine}`);
  }
  console.log(`# actions: ${actions.length} (${actions.map((a) => `${a.type}@h${a.hour}`).join(', ') || 'none'})`);
  return { log, actions, engState };
}

// ---- scenarios ------------------------------------------------------------------

test('scenario (a): summer profit day — cheap night full throttle, expensive evening off', () => {
  const priceAt = (i) => (i <= 6 || i >= 22 ? 0.3 : i <= 16 ? 1.2 : 6.0);
  const { log, actions } = simulate({ name: 'Scenario (a) summer profit day', hours: 24, priceAt });

  for (let h = 1; h <= 6; h++) {
    assert.equal(log[h].off, false, `h${h} should be mining`);
    assert.equal(log[h].targetW, 3068, `h${h} should be full throttle`);
  }
  for (let h = 18; h <= 21; h++) assert.equal(log[h].off, true, `h${h} should be off`);
  assert.equal(log[23].off, false, 'cheap late night resumes');
  assert.ok(actions.length <= 6, `too many actions: ${actions.length}`);
});

test('scenario (b): winter heating week (168h) with schedule — heat pump takes over spikes', () => {
  const priceAt = (i) => {
    const h = i % 24;
    if (h <= 5) return 0.5;
    if (h <= 8) return 0.9;
    if (h <= 16) return 0.7;
    if (h <= 20) return 2.8; // evening spike: heat pump is cheaper
    return 0.6;
  };
  const demandAt = (i) => {
    const h = i % 24;
    return h >= 6 && h < 22 ? 2.5 : 1.0; // weekly schedule: comfort by day, eco at night
  };
  const { log, actions } = simulate({
    name: 'Scenario (b) winter heating week',
    hours: 168, priceAt, demandAt,
    altType: 'heatpump', altPriceAt: (i) => priceAt(i) / 3, // SCOP 3
  });

  const offHours = log.filter((r) => r.off);
  for (const r of offHours) assert.equal(r.price, 2.8, `off at h${r.hour} outside the spike (price ${r.price})`);
  const onShare = (log.length - offHours.length) / log.length;
  assert.ok(onShare >= 0.75, `heat coverage too low: ${(onShare * 100).toFixed(0)}%`);
  for (const r of log.filter((x) => !x.off)) {
    assert.ok(Math.min(r.wallW / 1000, r.demandKW) > 0, `h${r.hour} running but delivering no heat`);
  }
  assert.ok(actions.length <= 21, `more than 3 actions/day on average: ${actions.length}`);
});

test('scenario (c): volatile prices — hysteresis absorbs the noise, < 6 actions/day', () => {
  const priceAt = (i) => {
    if (i <= 2 || i >= 20) return 1.3;
    if (i >= 17) return 3.0; // one genuine spike
    return i % 2 ? 1.5 : 1.3; // hourly flapping around the start margin
  };
  const { log, actions } = simulate({ name: 'Scenario (c) volatile price day', hours: 24, priceAt });

  assert.ok(actions.length < 6, `volatile day must cause < 6 actions, got ${actions.length}`);
  assert.ok(actions.every((a) => a.type === 'RESUME' || a.type === 'PAUSE'),
    `no power/board thrash expected, got ${actions.map((a) => a.type).join(',')}`);
  for (let h = 3; h <= 16; h++) assert.equal(log[h].off, false, `h${h} should ride out the oscillation`);
  for (let h = 18; h <= 19; h++) assert.equal(log[h].off, true, `h${h} spike should pause`);
});

test('scenario (d): price-feed outage — pessimistic fallback stops pure-profit mining', () => {
  const priceAt = () => 0.8;
  const { log, actions } = simulate({
    name: 'Scenario (d) price-feed outage at hour 12',
    hours: 24, priceAt,
    horizonAt: (i) => {
      const priceHours = [];
      for (let j = i; j <= 11; j++) {
        priceHours.push({ hourStartIso: isoAt(j), marginalPrice: 0.8, householdPrice: 0.8, regime: 'subsidised' });
      }
      return { priceHours, horizonCoversNow: i <= 11, fallbackPrice: 1.8 };
    },
  });

  for (let h = 1; h <= 11; h++) assert.equal(log[h].off, false, `h${h} inside horizon should mine`);
  for (let h = 12; h <= 23; h++) {
    assert.equal(log[h].off, true, `h${h} beyond horizon should be off`);
    assert.equal(log[h].marginalUsed, 1.8, `h${h} must be scored at the fallback price`);
  }
  const outage = log.filter((r) => r.hour >= 13);
  assert.ok(outage.every((r) => r.statusSeverity === 'warn'), 'horizon exhaustion should warn');
  assert.ok(outage.every((r) => /not published/.test(r.statusLine)));
  assert.equal(actions.length, 2); // one resume, one pause — no churn
});

test('scenario (e): heat demand + unprofitable mining — sized to demand, not full throttle', () => {
  const priceAt = () => 1.9; // mining alone loses ≈0.35 kr/kWh
  const { log, actions } = simulate({
    name: 'Scenario (e) heat demand with unprofitable mining (resistive alt)',
    hours: 24, priceAt,
    demandAt: () => 1.0,
    altType: 'resistive', altPriceAt: () => 1.9,
  });

  assert.ok(!actions.some((a) => a.type === 'PAUSE'), 'never pauses: heat is worth it');
  assert.ok(actions.some((a) => a.type === 'SET_BOARDS' && a.boards === 1), 'downsizes to 1 board');
  for (const r of log.slice(2)) {
    assert.equal(r.off, false, `h${r.hour} should heat`);
    assert.equal(r.boards, 1, `h${r.hour} should run one board`);
    assert.ok(r.wallW >= 950 && r.wallW <= 1100, `h${r.hour} wall ${r.wallW} W not sized to the 1.0 kW demand`);
  }
});

test('scenario (f): winter spike with alt=none — never off while demand > 0', () => {
  const priceAt = (i) => (i >= 8 && i <= 11 ? 8.0 : 0.9);
  const { log, actions } = simulate({
    name: 'Scenario (f) winter spike, no alternative heat source',
    hours: 24, priceAt,
    demandAt: () => 2.0,
    altType: 'none', altPriceAt: () => 0,
  });

  for (const r of log) assert.equal(r.off, false, `h${r.hour}: alt=none must never be off while demand > 0`);
  for (let h = 8; h <= 11; h++) {
    assert.ok(log[h].wallW >= 2000, `h${h} must keep delivering the 2.0 kW demand (wall ${log[h].wallW})`);
    assert.match(log[h].statusLine, /Heating override/);
  }
  // sized down during the spike (cheapest-net eligible), back up after
  assert.ok(log[9].wallW < 2600, 'spike hours should not burn full throttle');
  assert.equal(log[13].targetW, 3068, 'cheap hours resume full throttle');
  assert.ok(!actions.some((a) => a.type === 'PAUSE'));
});

test('scenario (g): hot-room derate — thermal ceiling latches, no sawtooth', () => {
  const { log, actions, engState } = simulate({
    name: 'Scenario (g) hot room derate',
    hours: 24, priceAt: () => 0.3,
    start: { paused: false, enabledIds: ['2', '1', '3'], targetW: 3068 },
    chipModel: ({ wallW, paused }) => (paused ? 45 : 55 + wallW / 100),
  });

  const derates = actions.filter((a) => a.type === 'SET_POWER');
  assert.deepEqual(derates.map((a) => a.targetW), [2818, 2568, 2318], 'expected three clean derate steps');
  assert.equal(actions.length, derates.length, 'no other actions');
  for (let k = 1; k < log.length; k++) {
    assert.ok(log[k].targetW <= log[k - 1].targetW, `sawtooth: target rose at h${k}`);
  }
  assert.equal(engState.thermalCeilingW, 2318, 'ceiling latched at the settled level');
  assert.ok(log.every((r) => r.chip < 90), 'never reaches the pause threshold');
  assert.ok(log.slice(4).every((r) => /capped at 2318 W/.test(r.statusLine)), 'ceiling surfaced in plain language');
});
