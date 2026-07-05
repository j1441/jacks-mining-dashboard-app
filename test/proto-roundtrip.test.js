// test/proto-roundtrip.test.js — serialize→deserialize round trips for every
// request message minerClient sends, using the loaded proto definitions only
// (no network). @grpc/proto-loader silently DROPS unknown request keys, so a
// misspelled field (the `enable` vs `enabled` SetDPSRequest trap) vanishes
// without error; these tests assert every key we set survives the round trip.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadProtos } = require('../lib/minerClient.js');

const pkg = loadProtos().braiins.bos.v1;

// Serialize a request payload with a method's request serializer and decode it back.
function roundTrip(serviceCtor, methodName, payload) {
  const method = serviceCtor.service[methodName];
  assert.ok(method, `method ${methodName} not found on service`);
  return method.requestDeserialize(method.requestSerialize(payload));
}

// Primitive comparison tolerant of proto number representations
// (uint64 stays a string with longs:String; doubles stay numbers).
function valuesMatch(a, b) {
  if (a === b) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') return false;
  const na = Number(a);
  const nb = Number(b);
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
}

// Assert every key set in `input` exists in `output` with the same value
// (output may contain extra keys: defaults and oneof indicators).
function assertSurvives(input, output, path = 'request') {
  for (const [key, value] of Object.entries(input)) {
    const outPath = `${path}.${key}`;
    assert.ok(output !== null && output !== undefined && key in output,
      `${outPath} was silently dropped by proto serialization`);
    const out = output[key];
    if (Array.isArray(value)) {
      assert.ok(Array.isArray(out), `${outPath} should round-trip as an array`);
      assert.equal(out.length, value.length, `${outPath} length changed`);
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') assertSurvives(v, out[i], `${outPath}[${i}]`);
        else assert.ok(valuesMatch(v, out[i]), `${outPath}[${i}]: sent ${v}, got ${out[i]}`);
      });
    } else if (value !== null && typeof value === 'object') {
      assertSurvives(value, out, outPath);
    } else {
      assert.ok(valuesMatch(value, out), `${outPath}: sent ${JSON.stringify(value)}, got ${JSON.stringify(out)}`);
    }
  }
}

function checkRoundTrip(serviceCtor, methodName, payload) {
  const out = roundTrip(serviceCtor, methodName, payload);
  assertSurvives(payload, out);
  return out;
}

test('LoginRequest round-trips (AuthenticationService.Login)', () => {
  checkRoundTrip(pkg.AuthenticationService, 'Login', { username: 'root', password: 'root' });
});

test('SetPowerTargetRequest round-trips incl. uint64 watt as string', () => {
  const out = checkRoundTrip(pkg.PerformanceService, 'SetPowerTarget', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    power_target: { watt: '3100' },
  });
  assert.equal(out.save_action, 'SAVE_ACTION_SAVE_AND_APPLY');
  assert.equal(out.power_target.watt, '3100'); // longs: String
});

test('EnableHashboardsRequest round-trips hashboard_ids', () => {
  const out = checkRoundTrip(pkg.MinerService, 'EnableHashboards', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    hashboard_ids: ['1', '3'],
  });
  assert.deepEqual(out.hashboard_ids, ['1', '3']);
});

test('DisableHashboardsRequest round-trips hashboard_ids', () => {
  checkRoundTrip(pkg.MinerService, 'DisableHashboards', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    hashboard_ids: ['2'],
  });
});

test('SetDPSRequest: the field is `enable` — it survives; `enabled` is dropped', () => {
  // What minerClient sends:
  const out = checkRoundTrip(pkg.PerformanceService, 'SetDPS', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    enable: true,
  });
  assert.equal(out.enable, true);

  // The v1 trap: the RESPONSE field name `enabled` is not a request field and
  // is silently dropped — the flag never reaches the miner.
  const trap = roundTrip(pkg.PerformanceService, 'SetDPS', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    enabled: true,
  });
  assert.notEqual(trap.enabled, true, 'unknown key `enabled` must not survive');
  assert.notEqual(trap.enable, true, 'misspelled flag must not silently set `enable`');

  // false must also survive (explicit disable, not just default omission).
  const off = roundTrip(pkg.PerformanceService, 'SetDPS', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    enable: false,
  });
  assert.equal(off.enable, false);
});

test('PauseMiningRequest / ResumeMiningRequest round-trip (empty messages)', () => {
  const paused = roundTrip(pkg.ActionsService, 'PauseMining', {});
  assert.equal(typeof paused, 'object');
  const resumed = roundTrip(pkg.ActionsService, 'ResumeMining', {});
  assert.equal(typeof resumed, 'object');
});

test('SetCoolingModeRequest (auto) round-trips temps and picks the auto oneof', () => {
  const out = checkRoundTrip(pkg.CoolingService, 'SetCoolingMode', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    auto: {
      target_temperature: { degree_c: 60 },
      hot_temperature: { degree_c: 80 },
      dangerous_temperature: { degree_c: 90 },
    },
  });
  assert.equal(out.mode, 'auto'); // oneof indicator
  assert.equal(out.auto.target_temperature.degree_c, 60);
});

test('SetCoolingModeRequest (manual) round-trips fan_speed_ratio', () => {
  const out = checkRoundTrip(pkg.CoolingService, 'SetCoolingMode', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    manual: {
      fan_speed_ratio: 0.2,
      hot_temperature: { degree_c: 65 },
      dangerous_temperature: { degree_c: 70 },
    },
  });
  assert.equal(out.mode, 'manual');
  assert.equal(out.manual.fan_speed_ratio, 0.2);
});

test('SetCoolingModeRequest (immersion) round-trips', () => {
  const out = checkRoundTrip(pkg.CoolingService, 'SetCoolingMode', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    immersion: {
      hot_temperature: { degree_c: 80 },
      dangerous_temperature: { degree_c: 90 },
      target_temperature: { degree_c: 60 },
    },
  });
  assert.equal(out.mode, 'immersion');
});

test('read-only request messages round-trip (empty requests)', () => {
  for (const [svc, method] of [
    [pkg.MinerService, 'GetHashboards'],
    [pkg.MinerService, 'GetMinerDetails'],
    [pkg.MinerService, 'GetMinerStats'],
    [pkg.MinerService, 'GetErrors'],
    [pkg.PerformanceService, 'GetTunerState'],
    [pkg.PerformanceService, 'ListTargetProfiles'],
    [pkg.CoolingService, 'GetCoolingState'],
    [pkg.ConfigurationService, 'GetMinerConfiguration'],
    [pkg.ConfigurationService, 'GetConstraints'],
  ]) {
    assert.equal(typeof roundTrip(svc, method, {}), 'object', `${method} request`);
  }
});

test('SAVE_ACTION enum value is a real enum member (not silently zeroed)', () => {
  const out = roundTrip(pkg.PerformanceService, 'SetPowerTarget', {
    save_action: 'SAVE_ACTION_SAVE_AND_APPLY',
    power_target: { watt: '944' },
  });
  assert.equal(out.save_action, 'SAVE_ACTION_SAVE_AND_APPLY');
  assert.notEqual(out.save_action, 'SAVE_ACTION_UNSPECIFIED');
});
