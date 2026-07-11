// test/minerClient.test.js — unit tests for lib/minerClient.js.
// Parsers are exercised against the REAL captured responses in
// test/fixtures/live-s19jpro.json (no network); client behaviors (snapshot
// fan-out + slow-cadence cache, cgminer fallback, OUT_OF_RANGE clamp+retry,
// read-back verification, UNAUTHENTICATED retry, token caching) are tested by
// stubbing the transport layer (_call / raw service clients).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fx = require('./fixtures/live-s19jpro.json');
const {
  MinerClient,
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
} = require('../lib/minerClient.js');

const OUT_OF_RANGE = 11;
const UNAUTHENTICATED = 16;

function newClient() {
  // Real constructor (real lazy gRPC channels — nothing connects until a call),
  // transport stubbed per test.
  return new MinerClient({ id: 'test', ip: '127.0.0.1' });
}

// Route a stubbed _call by method name using fixture data.
function fixtureCall(calls = []) {
  return async (svc, method) => {
    calls.push(method);
    switch (method) {
      case 'GetHashboards': return fx.hashboards;
      case 'GetMinerDetails': return fx.details;
      case 'GetMinerStats': return fx.stats;
      case 'GetTunerState': return fx.tunerState;
      case 'GetCoolingState': return fx.cooling;
      case 'GetMinerConfiguration': return fx.configuration;
      case 'GetConstraints': return fx.constraints;
      case 'GetErrors': return { errors: [] };
      default: throw new Error(`unexpected call: ${method}`);
    }
  };
}

// --- parsers against live fixture -------------------------------------------

test('parseHashboards: live fixture (3 boards, only board 2 hashing)', () => {
  const boards = parseHashboards(fx.hashboards);
  assert.equal(boards.length, 3);

  const [b1, b2, b3] = boards;
  assert.deepEqual(b1, {
    id: '1', enabled: false, hashing: false, boardTempC: null, chipTempC: null, hashrateThs: 0,
  });
  assert.equal(b2.id, '2');
  assert.equal(b2.enabled, true);
  assert.equal(b2.hashing, true);
  assert.equal(b2.boardTempC, 50);
  assert.equal(b2.chipTempC, 65); // nested highest_chip_temp.temperature.degree_c
  assert.ok(Math.abs(b2.hashrateThs - 12.67690119710455) < 1e-9); // last_1m GH/s → TH/s
  assert.equal(b3.enabled, false);
  assert.equal(b3.hashing, false);
});

test('parseTunerState: live fixture (STABLE @ 944 W, watt arrives as string)', () => {
  assert.deepEqual(parseTunerState(fx.tunerState), { state: 'STABLE', targetW: 944 });
});

test('parseTunerState: unknown/missing states map to UNKNOWN, targetW 0', () => {
  assert.deepEqual(parseTunerState({ overall_tuner_state: 'TUNER_STATE_CONTINUOUS' }),
    { state: 'UNKNOWN', targetW: 0 });
  assert.deepEqual(parseTunerState(null), { state: 'UNKNOWN', targetW: 0 });
  assert.equal(parseTunerState({ overall_tuner_state: 'TUNER_STATE_TUNING' }).state, 'TUNING');
});

test('parseMinerStats: live fixture (wallW "475" string → 475 number)', () => {
  const s = parseMinerStats(fx.stats);
  assert.equal(s.wallW, 475);
  assert.equal(typeof s.wallW, 'number');
  assert.ok(Math.abs(s.hashrate.m1 - 12.664179294406807) < 1e-9);
  assert.ok(Math.abs(s.hashrate.m15 - 13.219597795823418) < 1e-9);
  assert.ok(Math.abs(s.hashrate.h1 - 12.992685584039413) < 1e-9);
  assert.ok(Math.abs(s.hashrate.h24 - 13.180950784567483) < 1e-9);
  assert.equal(s.poolStats.accepted, 12206);
  assert.equal(s.poolStats.rejected, 26);
  assert.ok(Math.abs(s.efficiencyJPerTh - 37.50582969063196) < 1e-9);
});

test('parseMinerStats: missing power_stats → wallW null', () => {
  const s = parseMinerStats({ miner_stats: fx.stats.miner_stats });
  assert.equal(s.wallW, null);
});

test('parseCooling: live fixture (4 fans, highest temp 65)', () => {
  const c = parseCooling(fx.cooling);
  assert.equal(c.fans.length, 4);
  assert.deepEqual(c.fans[0], { rpm: 3059, ratio: 1 });
  assert.deepEqual(c.fans[1], { rpm: 3029, ratio: 1 });
  assert.equal(c.highestTempC, 65);
});

test('parseConfiguration: live fixture (cooling under `temperature`, manual mode, DPS on)', () => {
  const conf = parseConfiguration(fx.configuration);
  assert.equal(conf.cooling.mode, 'manual');
  assert.equal(conf.cooling.hotC, 65);
  assert.equal(conf.cooling.dangerousC, 70);
  assert.equal(conf.cooling.targetC, null);
  assert.equal(conf.cooling.fanSpeedRatio, 0.2);
  assert.deepEqual(conf.dps, { enabled: true });
  assert.deepEqual(conf.tuner, { enabled: true, powerTargetW: 944 });
  assert.equal(conf.pools.length, 2);
  assert.equal(conf.pools[0].url, 'stratum+tcp://192.168.1.243:23334');
  assert.equal(conf.pools[1].url, 'stratum+tcp://mine.ocean.xyz:3334');
  assert.match(conf.pools[0].user, /^bc1q/);
});

test('parseConfiguration: mode inferred from populated oneof when indicator missing', () => {
  const raw = { temperature: { auto: { target_temperature: { degree_c: 60 } } } };
  const conf = parseConfiguration(raw);
  assert.equal(conf.cooling.mode, 'auto');
  assert.equal(conf.cooling.targetC, 60);
});

test('parseConstraints: live fixture (944–6435 W, default 3068)', () => {
  assert.deepEqual(parseConstraints(fx.constraints),
    { minTargetW: 944, maxTargetW: 6435, defaultTargetW: 3068 });
  assert.equal(parseConstraints({}), null);
});

test('parseMinerErrors: shapes structured errors', () => {
  const rows = parseMinerErrors({
    errors: [{ timestamp: 't0', message: 'board 3 dead', error_codes: [{ code: 'E123' }] }],
  });
  assert.deepEqual(rows, [{ timestamp: 't0', message: 'board 3 dead', codes: ['E123'] }]);
  assert.deepEqual(parseMinerErrors(null), []);
});

test('parseCgminerSummary / parseCgminerPools: live fixture', () => {
  const s = parseCgminerSummary(fx.cgminer_summary);
  assert.ok(Math.abs(s.hashrate.m1 - 12.657690809399838) < 1e-9);
  assert.ok(Math.abs(s.hashrate.m15 - 13.219126228007015) < 1e-9);
  assert.equal(s.hashrate.h1, null); // cgminer has no 1h window
  assert.ok(Math.abs(s.hashrate.h24 - 13.180945907773843) < 1e-9);

  const pools = parseCgminerPools(fx.cgminer_pools);
  assert.equal(pools.length, 2);
  assert.deepEqual(pools[0], {
    url: 'stratum+tcp://192.168.1.243:23334',
    user: 'bc1qlp3xkef7rn6mnvmd459sql46v2pk3yyptx6rxu.s19j4',
    active: true, accepted: 12206, rejected: 26,
  });
  assert.equal(pools[1].active, false);
});

test('parseOutOfRangeBounds: Some(min)/Some(max) format', () => {
  assert.deepEqual(
    parseOutOfRangeBounds('3 OUT_OF_RANGE: Power target out of range min: Some(944), max: Some(6435)'),
    { min: 944, max: 6435 });
  assert.equal(parseOutOfRangeBounds('some other error'), null);
  assert.equal(parseOutOfRangeBounds(null), null);
});

// --- getSnapshot -------------------------------------------------------------

test('getSnapshot: full fan-out assembles the contract shape from fixtures', async () => {
  const client = newClient();
  const calls = [];
  client._call = fixtureCall(calls);

  const snap = await client.getSnapshot();

  assert.ok(snap.ts);
  assert.equal(snap.online, true);
  assert.equal(snap.paused, false);
  assert.equal(snap.model, 'Antminer S19j Pro');
  assert.equal(snap.minerStatus, 'NORMAL');
  assert.equal(snap.boards.length, 3);
  assert.equal(snap.boardsEnabledCount, 1);
  assert.equal(snap.boardsHashingCount, 1);
  assert.deepEqual(snap.tuner, { state: 'STABLE', targetW: 944 });
  assert.equal(snap.wallW, 475);
  assert.equal(snap.cooling.mode, 'manual');
  assert.equal(snap.cooling.fans.length, 4);
  assert.equal(snap.cooling.highestTempC, 65);
  assert.equal(snap.pools.length, 2);
  assert.equal(snap.pools[0].active, true);
  assert.equal(snap.pools[0].accepted, 12206);
  assert.equal(snap.pools[1].active, false);
  assert.ok(Math.abs(snap.hashrate.m15 - 13.219597795823418) < 1e-9);
  assert.deepEqual(snap.dps, { enabled: true });
  assert.equal(snap.constraints.minTargetW, 944);
  assert.equal(snap.constraints.maxTargetW, 6435);
  assert.deepEqual(snap.errors, []);
  assert.deepEqual(snap.minerErrors, []);

  // First tick includes the 3 slow-cadence calls.
  assert.equal(calls.filter((m) => m === 'GetMinerConfiguration').length, 1);
  assert.equal(calls.length, 8);
});

test('getSnapshot: slow-cadence calls are cached between ticks', async () => {
  const client = newClient();
  const calls = [];
  client._call = fixtureCall(calls);

  await client.getSnapshot();
  const firstCount = calls.length;
  const snap2 = await client.getSnapshot();

  assert.equal(firstCount, 8);
  assert.equal(calls.length, 13); // second tick: only the 5 fast calls
  assert.ok(!calls.slice(firstCount).includes('GetMinerConfiguration'));
  assert.ok(!calls.slice(firstCount).includes('GetConstraints'));
  assert.ok(!calls.slice(firstCount).includes('GetErrors'));
  // Cached slow data still present in the second snapshot.
  assert.deepEqual(snap2.dps, { enabled: true });
  assert.equal(snap2.constraints.maxTargetW, 6435);
  assert.equal(snap2.cooling.mode, 'manual');
});

test('getSnapshot: slow-cadence failure is retried on the next tick', async () => {
  const client = newClient();
  const base = fixtureCall();
  let failConstraints = true;
  client._call = async (svc, method) => {
    if (method === 'GetConstraints' && failConstraints) throw new Error('UNAVAILABLE');
    return base(svc, method);
  };

  const snap1 = await client.getSnapshot();
  assert.equal(snap1.constraints, null);
  assert.ok(snap1.errors.some((e) => e.startsWith('GetConstraints:')));

  failConstraints = false;
  const snap2 = await client.getSnapshot(); // fetchedAt not advanced → slow set retried
  assert.equal(snap2.constraints.minTargetW, 944);
  assert.deepEqual(snap2.errors, []);
});

test('getSnapshot: GetMinerStats failure degrades to cgminer fallback', async () => {
  const client = newClient();
  const base = fixtureCall();
  client._call = async (svc, method) => {
    if (method === 'GetMinerStats') throw new Error('14 UNAVAILABLE');
    return base(svc, method);
  };
  client._cgminerCommand = async (command) => {
    if (command === 'summary') return fx.cgminer_summary;
    if (command === 'pools') return fx.cgminer_pools;
    throw new Error('unexpected cgminer command');
  };

  const snap = await client.getSnapshot();
  assert.equal(snap.online, true);
  assert.equal(snap.wallW, null); // no gRPC power stats, cgminer has none
  assert.ok(Math.abs(snap.hashrate.m1 - 12.657690809399838) < 1e-9); // from cgminer
  assert.equal(snap.pools[0].active, true); // true per-pool state from cgminer
  assert.equal(snap.pools[0].accepted, 12206);
  assert.ok(snap.errors.some((e) => e.startsWith('GetMinerStats:')));
});

test('getSnapshot: everything unreachable → online false, partial shape intact', async () => {
  const client = newClient();
  client._call = async (svc, method) => { throw new Error(`14 UNAVAILABLE: ${method}`); };
  client._cgminerCommand = async () => { throw new Error('ECONNREFUSED'); };

  const snap = await client.getSnapshot();
  assert.equal(snap.online, false);
  assert.equal(snap.paused, false);
  assert.equal(snap.minerStatus, 'UNKNOWN');
  assert.deepEqual(snap.boards, []);
  assert.deepEqual(snap.tuner, { state: 'UNKNOWN', targetW: 0 });
  assert.equal(snap.wallW, null);
  assert.equal(snap.constraints, null);
  assert.equal(snap.dps, null);
  assert.equal(snap.cooling.mode, 'unknown');
  assert.equal(snap.errors.length, 9); // 5 fast + 3 slow + cgminer fallback
});

test('getSnapshot: paused derived from GetMinerDetails.status', async () => {
  const client = newClient();
  const base = fixtureCall();
  client._call = async (svc, method) => {
    if (method === 'GetMinerDetails') return { ...fx.details, status: 'MINER_STATUS_PAUSED' };
    return base(svc, method);
  };
  const snap = await client.getSnapshot();
  assert.equal(snap.paused, true);
  assert.equal(snap.minerStatus, 'PAUSED');
});

// --- writes with read-back verification ---------------------------------------

test('setPowerTarget: OUT_OF_RANGE → parse bounds, clamp, retry once, verify', async () => {
  const client = newClient();
  const setCalls = [];
  client._call = async (svc, method, req) => {
    if (method === 'SetPowerTarget') {
      setCalls.push(Number(req.power_target.watt));
      assert.equal(req.save_action, 'SAVE_ACTION_SAVE_AND_APPLY');
      if (setCalls.length === 1) {
        const err = new Error('3 OUT_OF_RANGE: power target out of range');
        err.code = OUT_OF_RANGE;
        err.details = 'Power target out of range min: Some(944), max: Some(6435)';
        throw err;
      }
      return {};
    }
    if (method === 'GetTunerState') {
      return { overall_tuner_state: 'TUNER_STATE_TUNING', power_target_mode_state: { current_target: { watt: '944' } } };
    }
    throw new Error(`unexpected call: ${method}`);
  };

  const res = await client.setPowerTarget(500);
  assert.deepEqual(setCalls, [500, 944]); // clamped up to the miner-reported min
  assert.deepEqual(res, { targetW: 944, clamped: true, readBackW: 944 });
});

test('setPowerTarget: slow read-back converges via settle polling', async () => {
  const client = newClient();
  client._sleep = async () => {}; // no real waiting in tests
  let reads = 0;
  client._call = async (svc, method) => {
    if (method === 'SetPowerTarget') return { power_target: { watt: '3100' } };
    if (method === 'GetTunerState') {
      reads += 1; // SAVE_AND_APPLY reloads async: first read serves the OLD target
      const watt = reads >= 2 ? '3100' : '944';
      return { overall_tuner_state: 'TUNER_STATE_STABLE', power_target_mode_state: { current_target: { watt } } };
    }
    throw new Error(`unexpected call: ${method}`);
  };
  const res = await client.setPowerTarget(3100);
  assert.deepEqual(res, { targetW: 3100, clamped: false, readBackW: 3100 });
  assert.equal(reads, 2);
});

test('setPowerTarget: persistent read-back lag warns but does not throw (DPS may rescale)', async () => {
  const client = newClient();
  client._sleep = async () => {};
  client._call = async (svc, method) => {
    if (method === 'SetPowerTarget') return { power_target: { watt: '3100' } };
    if (method === 'GetTunerState') {
      return { overall_tuner_state: 'TUNER_STATE_STABLE', power_target_mode_state: { current_target: { watt: '944' } } };
    }
    throw new Error(`unexpected call: ${method}`);
  };
  const res = await client.setPowerTarget(3100);
  assert.equal(res.targetW, 3100);
  assert.equal(res.readBackW, 944); // surfaced to the caller, not fatal
});

test('setPowerTarget: non-range errors propagate without retry', async () => {
  const client = newClient();
  let attempts = 0;
  client._call = async (svc, method) => {
    if (method === 'SetPowerTarget') {
      attempts++;
      const err = new Error('14 UNAVAILABLE');
      err.code = 14;
      throw err;
    }
    throw new Error(`unexpected call: ${method}`);
  };
  await assert.rejects(client.setPowerTarget(3000), /UNAVAILABLE/);
  assert.equal(attempts, 1);
});

test('setBoards: verified via the RPC responses; runtime lag tolerated', async () => {
  const client = newClient();
  client._sleep = async () => {};
  const writes = [];
  client._call = async (svc, method, req) => {
    if (method === 'EnableHashboards' || method === 'DisableHashboards') {
      writes.push([method, req.hashboard_ids]);
      assert.equal(req.save_action, 'SAVE_ACTION_SAVE_AND_APPLY');
      const want = method === 'EnableHashboards';
      return { hashboards: req.hashboard_ids.map((id) => ({ id, is_enabled: want })) };
    }
    // Runtime state never converges within the poll window (hashchain restarting —
    // observed live): still a success, config was verified via the responses.
    if (method === 'GetHashboards') return fx.hashboards;
    throw new Error(`unexpected call: ${method}`);
  };

  const res = await client.setBoards(['1'], ['2']);
  assert.deepEqual(writes, [['EnableHashboards', ['1']], ['DisableHashboards', ['2']]]);
  assert.equal(res.converged, false);
});

test('setBoards: RPC response contradicting the request throws verifyFailed', async () => {
  const client = newClient();
  client._call = async (svc, method, req) => {
    if (method === 'EnableHashboards') {
      return { hashboards: req.hashboard_ids.map((id) => ({ id, is_enabled: false })) }; // refused
    }
    throw new Error(`unexpected call: ${method}`);
  };
  await assert.rejects(client.setBoards(['1'], []), (err) => err.verifyFailed === true);
});

test('pause/resume: verified against GetMinerDetails.status', async () => {
  const client = newClient();
  client._sleep = async () => {};
  let status = 'MINER_STATUS_NORMAL';
  client._call = async (svc, method) => {
    if (method === 'PauseMining') { status = 'MINER_STATUS_PAUSED'; return { already_paused: false }; }
    if (method === 'ResumeMining') { status = 'MINER_STATUS_NORMAL'; return { already_mining: false }; }
    if (method === 'GetMinerDetails') return { status };
    throw new Error(`unexpected call: ${method}`);
  };

  assert.deepEqual(await client.pause(), { paused: true });
  assert.deepEqual(await client.resume(), { paused: false });
});

test('pause: never-pausing miner exhausts polls and throws verifyFailed', async () => {
  const client = newClient();
  client._sleep = async () => {};
  let detailReads = 0;
  client._call = async (svc, method) => {
    if (method === 'PauseMining') return {};
    if (method === 'GetMinerDetails') { detailReads++; return { status: 'MINER_STATUS_NORMAL' }; }
    throw new Error(`unexpected call: ${method}`);
  };
  await assert.rejects(client.pause(), (err) => err.verifyFailed === true);
  assert.equal(detailReads, 3);
});

test('setDps: sends `enable` (not `enabled`) and verifies config read-back', async () => {
  const client = newClient();
  const reqs = [];
  client._call = async (svc, method, req) => {
    if (method === 'SetDPS') {
      reqs.push(req);
      return {};
    }
    if (method === 'GetMinerConfiguration') return fx.configuration; // dps.enabled: true
    throw new Error(`unexpected call: ${method}`);
  };

  const res = await client.setDps(true);
  assert.equal(reqs[0].enable, true);
  assert.ok(!('enabled' in reqs[0]), 'must not send the response field name `enabled`');
  assert.deepEqual(res.dps, { enabled: true });

  // Asking for false while the miner reads back true → verify failure.
  await assert.rejects(client.setDps(false), (err) => err.verifyFailed === true);
});

test('setCoolingMode: verified via GetMinerConfiguration().temperature', async () => {
  const client = newClient();
  const reqs = [];
  client._call = async (svc, method, req) => {
    if (method === 'SetCoolingMode') { reqs.push(req); return {}; }
    if (method === 'GetMinerConfiguration') return fx.configuration; // mode: manual
    throw new Error(`unexpected call: ${method}`);
  };

  const res = await client.setCoolingMode({ mode: 'manual', fanSpeedRatio: 0.2, hotC: 65, dangerousC: 70 });
  assert.deepEqual(reqs[0].manual, {
    fan_speed_ratio: 0.2,
    hot_temperature: { degree_c: 65 },
    dangerous_temperature: { degree_c: 70 },
  });
  assert.equal(res.cooling.mode, 'manual');

  // Requesting auto while miner reads back manual → verify failure.
  await assert.rejects(client.setCoolingMode({ mode: 'auto', targetC: 60 }),
    (err) => err.verifyFailed === true);
  // Auto request carries the DESIGN default temps.
  const autoReq = reqs.find((r) => r.auto);
  assert.deepEqual(autoReq.auto, {
    target_temperature: { degree_c: 60 },
    hot_temperature: { degree_c: 80 },
    dangerous_temperature: { degree_c: 90 },
  });
});

test('setCoolingMode: a temperature value that does not take is a verify failure', async () => {
  const client = newClient();
  client._call = async (svc, method) => {
    if (method === 'SetCoolingMode') return {};
    // read-back still shows the fixture's manual hot=65/dangerous=70
    if (method === 'GetMinerConfiguration') return fx.configuration;
    throw new Error(`unexpected call: ${method}`);
  };
  // request manual but with a DIFFERENT hot temp than the miner reports back
  await assert.rejects(
    client.setCoolingMode({ mode: 'manual', fanSpeedRatio: 0.2, hotC: 55, dangerousC: 70 }),
    (err) => err.verifyFailed === true && /cooling hotC/.test(err.message),
  );

  await assert.rejects(client.setCoolingMode({ mode: 'hydro' }), /unsupported cooling mode/);
});

test('listTunedProfiles: maps profiles to {targetW, hashrateThs, boardW, createdAt}', async () => {
  const client = newClient();
  client._call = async (svc, method) => {
    if (method === 'ListTargetProfiles') return fx.profiles;
    throw new Error(`unexpected call: ${method}`);
  };
  const profiles = await client.listTunedProfiles();
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].targetW, 943);
  assert.ok(Math.abs(profiles[0].hashrateThs - 13.172255116251) < 1e-9);
  assert.equal(profiles[0].boardW, 397);
  assert.equal(profiles[0].createdAt, new Date(1782742706000).toISOString());
});

// --- auth ---------------------------------------------------------------------

test('_getToken: caches token until expiry, single-flight, force refresh', async () => {
  const client = newClient();
  let logins = 0;
  client._clients.auth = {
    Login: (req, md, opts, cb) => {
      logins++;
      assert.deepEqual(req, { username: 'root', password: 'root' });
      cb(null, { token: `tok${logins}`, timeout_s: 3600 });
    },
  };

  const [t1, t2] = await Promise.all([client._getToken(), client._getToken()]);
  assert.equal(t1, 'tok1');
  assert.equal(t2, 'tok1'); // concurrent requests share one login
  assert.equal(await client._getToken(), 'tok1'); // cached
  assert.equal(logins, 1);

  assert.equal(await client._getToken(true), 'tok2'); // forced refresh
  assert.equal(logins, 2);
});

test('_call: UNAUTHENTICATED → refresh token once and retry', async () => {
  const client = newClient();
  const tokensUsed = [];
  let logins = 0;
  client._clients.auth = {
    Login: (req, md, opts, cb) => { logins++; cb(null, { token: `tok${logins}`, timeout_s: 3600 }); },
  };
  let attempts = 0;
  client._clients.perf = {
    GetTunerState: (req, md, opts, cb) => {
      attempts++;
      tokensUsed.push(md.get('authorization')[0]);
      assert.ok(opts.deadline instanceof Date);
      if (attempts === 1) {
        const err = new Error('16 UNAUTHENTICATED: invalid token');
        err.code = UNAUTHENTICATED;
        cb(err);
      } else {
        cb(null, fx.tunerState);
      }
    },
  };

  const res = await client._call('perf', 'GetTunerState', {});
  assert.equal(attempts, 2);
  assert.deepEqual(tokensUsed, ['tok1', 'tok2']); // fresh token on retry
  assert.equal(parseTunerState(res).targetW, 944);
});

test('_call: persistent UNAUTHENTICATED fails after a single retry', async () => {
  const client = newClient();
  let logins = 0;
  client._clients.auth = {
    Login: (req, md, opts, cb) => { logins++; cb(null, { token: `tok${logins}`, timeout_s: 3600 }); },
  };
  let attempts = 0;
  client._clients.perf = {
    GetTunerState: (req, md, opts, cb) => {
      attempts++;
      const err = new Error('16 UNAUTHENTICATED');
      err.code = UNAUTHENTICATED;
      cb(err);
    },
  };
  await assert.rejects(client._call('perf', 'GetTunerState', {}), /UNAUTHENTICATED/);
  assert.equal(attempts, 2); // exactly one retry, no loop
});
