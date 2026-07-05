// test/envelope.test.js — unit tests for lib/envelope.js (DESIGN §3.1, §7):
// predict (learned / interpolated / fallback), wallW ≠ targetW modeling, candidate
// clamps + duplicate dropping, EWMA learning, profile import tagging, atomic
// persistence and corrupt-file recovery.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Envelope } = require('../lib/envelope.js');
const fixture = require('./fixtures/live-s19jpro.json');

const LIMITS = { minTargetW: 944, maxTargetW: 3500 };
const mk = (opts = {}) => new Envelope({ minerId: 'test', dataDir: os.tmpdir(), ...opts });

test('fallback predict: wallW equals target when per-board power is unclamped', () => {
  const env = mk();
  const p = env.predict(1, 944); // boardW = (944-80)/1 = 864, inside [397, 996]
  assert.equal(p.wallW, 944);
  assert.ok(p.hashrateThs > 29 && p.hashrateThs < 31, `hashrate ${p.hashrateThs}`);
});

test('fallback predict: wallW != targetW when per-board power clamps high', () => {
  const env = mk();
  const p = env.predict(1, 3000); // boardW clamps to 996
  assert.equal(p.wallW, 1 * 996 + 80); // 1076, NOT 3000
  assert.ok(Math.abs(p.hashrateThs - 34.7) < 0.01);
});

test('fallback predict: wallW != targetW when per-board power clamps low', () => {
  const env = mk();
  const p = env.predict(3, 944); // boardW = (944-80)/3 = 288 -> clamps to 397
  assert.equal(p.wallW, 3 * 397 + 80); // 1271, above the 944 target
  assert.ok(Math.abs(p.hashrateThs - 3 * 13.17) < 0.01);
});

test('learned point wins over fallback (real S19j Pro shape: 944 W target -> 477 W wall)', () => {
  const env = mk();
  env.learn(1, 944, { hashrateThs: 13.15, wallW: 477 });
  assert.deepEqual(env.predict(1, 944), { hashrateThs: 13.15, wallW: 477 });
});

test('interpolation between learned points at the same board count', () => {
  const env = mk();
  env.learn(1, 1000, { hashrateThs: 10, wallW: 500 });
  env.learn(1, 2000, { hashrateThs: 20, wallW: 1000 });
  assert.deepEqual(env.predict(1, 1500), { hashrateThs: 15, wallW: 750 });
  // outside the learned range -> falls back to the formula
  const p = env.predict(1, 2600);
  assert.equal(p.wallW, 996 + 80);
  // different board count is not interpolated from 1-board points
  const p3 = env.predict(3, 1500);
  assert.equal(p3.wallW, Math.round(3 * ((1500 - 80) / 3) + 80)); // fallback formula
});

test('EWMA learn: alpha=0.3 merge, samples bumped', () => {
  const env = mk();
  env.learn(1, 944, { hashrateThs: 13.15, wallW: 477 });
  const pt = env.learn(1, 944, { hashrateThs: 14.15, wallW: 577 });
  assert.ok(Math.abs(pt.hashrateThs - (13.15 + 0.3 * 1.0)) < 1e-9, `hr ${pt.hashrateThs}`);
  assert.equal(pt.wallW, 477 + 0.3 * 100);
  assert.equal(pt.samples, 2);
  assert.equal(env.stats().learnedPoints, 1);
});

test('learn refines per-board bounds from live data', () => {
  const env = mk();
  env.learn(1, 3200, { hashrateThs: 36, wallW: 1150 }); // implied boardW 1070 > 996
  assert.equal(env.stats().perBoardMaxW, 1070);
  env.learn(1, 944, { hashrateThs: 10, wallW: 430 }); // implied boardW 350 < 397
  assert.equal(env.stats().perBoardMinW, 350);
});

test('learn ignores garbage samples', () => {
  const env = mk();
  assert.equal(env.learn(1, 944, { hashrateThs: NaN, wallW: 477 }), null);
  assert.equal(env.learn(1, 944, { hashrateThs: 13, wallW: 0 }), null);
  assert.equal(env.learn(0, 944, { hashrateThs: 13, wallW: 477 }), null);
  assert.equal(env.stats().learnedPoints, 0);
});

test('candidates: clamped ranges, 100 W grid, endpoints included', () => {
  const env = mk();
  const cands = env.candidates({ limits: LIMITS, thermalCeilingW: 3500, allowedBoardsCount: 3 });
  assert.ok(cands.length > 0);
  for (const c of cands) {
    const lo = Math.max(LIMITS.minTargetW, c.boards * 397 + 80);
    const hi = Math.min(LIMITS.maxTargetW, c.boards * 996 + 80);
    assert.ok(c.targetW >= lo && c.targetW <= hi, `${c.boards}b @ ${c.targetW}`);
    assert.ok(c.targetW % 100 === 0 || c.targetW === lo || c.targetW === hi,
      `off-grid non-endpoint target ${c.targetW}`);
    assert.ok(!c.off);
  }
  // 1-board range is [944, 1076]; endpoints must be present
  const b1 = cands.filter((c) => c.boards === 1).map((c) => c.targetW);
  assert.deepEqual(b1, [944, 1000, 1076]);
  // 3-board low end starts at 3*397+80 = 1271 (above minTargetW)
  const b3 = cands.filter((c) => c.boards === 3);
  assert.equal(b3[0].targetW, 1271);
  assert.equal(b3[b3.length - 1].targetW, Math.min(3500, 3 * 996 + 80));
});

test('candidates: duplicate predicted wallW dropped (no phantom moves)', () => {
  const env = mk();
  // learned flat region: same wall for three successive targets
  env.learn(1, 944, { hashrateThs: 13.1, wallW: 477 });
  env.learn(1, 1000, { hashrateThs: 13.2, wallW: 477 });
  env.learn(1, 1076, { hashrateThs: 13.2, wallW: 477 });
  const b1 = env.candidates({ limits: LIMITS, thermalCeilingW: 3500, allowedBoardsCount: 1 });
  assert.equal(b1.length, 1, `expected single deduped candidate, got ${JSON.stringify(b1)}`);
  assert.equal(b1[0].targetW, 944); // the lower-target neighbor is kept
  assert.equal(b1[0].wallW, 477);
});

test('candidates: thermal ceiling clamps everything, board counts can vanish', () => {
  const env = mk();
  const cands = env.candidates({ limits: LIMITS, thermalCeilingW: 1000, allowedBoardsCount: 3 });
  assert.ok(cands.length > 0);
  for (const c of cands) assert.ok(c.targetW <= 1000, `target ${c.targetW} above ceiling`);
  assert.ok(!cands.some((c) => c.boards === 3), '3-board floor (1271 W) is above the 1000 W ceiling');
});

test('candidates: allowedBoardsCount restricts counts', () => {
  const env = mk();
  const cands = env.candidates({ limits: LIMITS, thermalCeilingW: 3500, allowedBoardsCount: 1 });
  assert.ok(cands.every((c) => c.boards === 1));
});

test('importProfiles: raw BOS profiles tagged with active board count, wall = board power + overhead', () => {
  const env = mk();
  const n = env.importProfiles(fixture.profiles.power_target_profiles, 1);
  assert.equal(n, 2);
  const p = env.predict(1, 944);
  assert.equal(p.wallW, 397 + 80); // realized wall, not the 944 W target
  assert.ok(Math.abs(p.hashrateThs - 13.147) < 0.01);
  // tagged at 1 board: 3-board prediction still uses the fallback
  assert.equal(env.predict(3, 944).wallW, 3 * 397 + 80);
  // whole-response shape also accepted, merges into the same keys
  const n2 = env.importProfiles(fixture.profiles, 1);
  assert.equal(n2, 2);
  assert.equal(env.stats().learnedPoints, 2);
});

test('save/load round-trip is atomic and preserves refined bounds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-test-'));
  const env = new Envelope({ minerId: 'm1', dataDir: dir });
  env.learn(1, 944, { hashrateThs: 13.15, wallW: 477 });
  env.learn(1, 3200, { hashrateThs: 36, wallW: 1150 }); // widens perBoardMaxW to 1070
  await env.save();
  assert.ok(!fs.existsSync(path.join(dir, 'envelope-m1.json.tmp')), 'tmp file must not remain');
  const env2 = await new Envelope({ minerId: 'm1', dataDir: dir }).load();
  assert.deepEqual(env2.predict(1, 944), { hashrateThs: 13.15, wallW: 477 });
  assert.equal(env2.stats().learnedPoints, 2);
  assert.equal(env2.stats().perBoardMaxW, 1070);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load: missing file starts empty; corrupt file renamed aside and starts empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-test-'));
  const empty = await new Envelope({ minerId: 'nope', dataDir: dir }).load();
  assert.equal(empty.stats().learnedPoints, 0);

  const file = path.join(dir, 'envelope-bad.json');
  fs.writeFileSync(file, '{ not json !!!');
  const env = await new Envelope({ minerId: 'bad', dataDir: dir }).load();
  assert.equal(env.stats().learnedPoints, 0);
  assert.ok(!fs.existsSync(file), 'corrupt file should be renamed aside');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('envelope-bad.json.corrupt-')));
  // still usable afterwards
  env.learn(1, 944, { hashrateThs: 13, wallW: 477 });
  await env.save();
  assert.equal((await new Envelope({ minerId: 'bad', dataDir: dir }).load()).stats().learnedPoints, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('load: wrong-shape JSON treated as corrupt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-test-'));
  fs.writeFileSync(path.join(dir, 'envelope-shape.json'), JSON.stringify([1, 2, 3]));
  const env = await new Envelope({ minerId: 'shape', dataDir: dir }).load();
  assert.equal(env.stats().learnedPoints, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
