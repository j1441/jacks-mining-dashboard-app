// test/stores.test.js — unit tests for configStore (v1 migration, corruption recovery,
// atomic saves, redaction round-trip), stateStore (debounce/flush), history (rollups,
// kWh integration, retention) and alerts (cooldowns, channel dispatch payloads).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { ConfigStore, DEFAULT_CONFIG, migrateV1, REDACT_SENTINEL } = require('../lib/configStore');
const { StateStore, DEFAULT_ENGINE_STATE } = require('../lib/stateStore');
const { History } = require('../lib/history');
const { Alerts } = require('../lib/alerts');

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mining-v2-test-'));
}

// Realistic v1 config, reconstructed from v1-grpc-price-fixes:server.js
// (loadConfig ENOENT defaults + getDefaultAutoControlSettings + per-miner fields).
const V1_CONFIG = {
  miners: [{
    ip: '192.168.1.89',
    name: 'S19j Pro',
    username: 'root',
    password: 'hunter2',
    powerProfile: 'medium',
    autoControl: {
      enabled: true,
      safety: { maxChipTemp: 95 },
      thermal: { maxBoardTemp: 72, maxFanSpeed: 6000, minBoardTemp: 20,
                 cooldownSeconds: 60, recoveryDelaySeconds: 300 },
      power: { maxPower: 3400, minPower: 1500, powerStepDown: 200, powerStepUp: 100 },
      price: { enabled: true, cheapPrice: 0.60, expensivePrice: 1.20,
               pauseWhenExpensive: false, minDwellMinutes: 20, deadbandWatts: 150 },
      economics: { scopThreshold: 2.0, minSCOPForMaxPower: 3.0, efficiencyOverride: null,
                   economicPowerStep: 100, economicPauseEnabled: false },
      alerts: { minHashrate: 100, minActiveBoards: 3 },
    },
  }],
  alerts: {
    enabled: true,
    highTemp: { enabled: true, threshold: 80 },
    lowHashrate: { enabled: true, threshold: 80 },
    minerOffline: { enabled: true },
    highRejectRate: { enabled: true, threshold: 5 },
    cooldownMinutes: 15,
  },
  country: 'norway',
  electricityZone: 'NO3',
  gridFeeWeekdayDay: 0.55,
  gridFeeWeekendNight: 0.35,
  priceMode: 'stromstotteavtale',
  historySampleInterval: 5,
};

// ---------------------------------------------------------------------------
// configStore
// ---------------------------------------------------------------------------

test('configStore: v1 file migrates to v2 with dryRun, backup, _v1 and MIGRATION event', async () => {
  const dir = await tmpDir();
  const raw = JSON.stringify(V1_CONFIG, null, 2);
  await fs.writeFile(path.join(dir, 'config.json'), raw);

  const store = new ConfigStore({ dataDir: dir });
  const cfg = await store.load();

  assert.equal(cfg.version, 2);
  assert.equal(store.migrated, true);

  // MIGRATION event surfaced for the caller to log
  const mig = store.loadEvents.find((e) => e.type === 'MIGRATION');
  assert.ok(mig, 'MIGRATION event returned');
  assert.equal(mig.severity, 'info');
  assert.equal(mig.data.minerCount, 1);

  // backup preserves the original v1 file byte-for-byte
  const backup = await fs.readFile(path.join(dir, 'config.v1.backup.json'), 'utf8');
  assert.equal(backup, raw);

  // miner mapping
  const m = cfg.miners[0];
  assert.equal(m.ip, '192.168.1.89');
  assert.equal(m.name, 'S19j Pro');
  assert.equal(m.username, 'root');
  assert.equal(m.password, 'hunter2');
  assert.equal(m.mode, 'auto', 'autoControl.price.enabled → auto');
  assert.equal(m.dryRun, true, 'migrated miners ALWAYS start in dry-run');
  assert.equal(m.limits.minTargetW, 1500);
  assert.equal(m.limits.maxTargetW, 3400);
  assert.equal(m.safety.pauseChipTemp, 95);
  assert.equal(m.safety.maxBoardTemp, 72);
  assert.equal(m.safety.maxFanRpm, 6000);
  assert.equal(m.safety.safetyStepW, 200);
  assert.equal(m.dwell.powerMin, 20);
  assert.equal(m.dwell.deadbandW, 150);
  assert.ok(m.safety.derateChipTemp < m.safety.pauseChipTemp);

  // electricity + alert-rule mapping
  assert.equal(cfg.electricity.zone, 'NO3');
  assert.equal(cfg.electricity.priceMode, 'spot_stromstotte');
  assert.equal(cfg.electricity.gridFee.dayWeekday, 0.55);
  assert.equal(cfg.electricity.gridFee.nightWeekend, 0.35);
  assert.equal(cfg.alerts.rules.hashrateLowPct, 20, '100 − v1 lowHashrate.threshold');

  // unknown v1 keys preserved
  assert.deepEqual(cfg._v1, V1_CONFIG);

  // persisted file is valid v2 and reloads without re-migrating
  const store2 = new ConfigStore({ dataDir: dir });
  const cfg2 = await store2.load();
  assert.equal(cfg2.version, 2);
  assert.equal(store2.migrated, false);
  assert.equal(cfg2.miners[0].password, 'hunter2');
});

test('configStore: v1 price control disabled migrates to manual mode', () => {
  const v1 = JSON.parse(JSON.stringify(V1_CONFIG));
  v1.miners[0].autoControl.price.enabled = false;
  const cfg = migrateV1(v1);
  assert.equal(cfg.miners[0].mode, 'manual');
  assert.equal(cfg.miners[0].dryRun, true);
});

test('configStore: corrupt file is renamed aside and defaults are used', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'config.json'), '{ this is not json !!!');

  const store = new ConfigStore({ dataDir: dir });
  const cfg = await store.load();

  assert.deepEqual(cfg, DEFAULT_CONFIG);
  assert.ok(store.corruptFile, 'corrupt path flagged');
  assert.match(path.basename(store.corruptFile), /^config\.corrupt-\d+\.json$/);
  const preserved = await fs.readFile(store.corruptFile, 'utf8');
  assert.equal(preserved, '{ this is not json !!!');
  assert.ok(store.loadEvents.some((e) => e.type === 'CONFIG_CORRUPT'));

  // a fresh, valid config.json was written
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.version, 2);
});

test('configStore: saves are atomic (no .tmp left behind) and serialized', async () => {
  const dir = await tmpDir();
  const store = new ConfigStore({ dataDir: dir });
  await store.load();

  // fire several updates concurrently through the save queue
  await Promise.all([
    store.update({ pollSeconds: 12 }),
    store.update({ ui: { currency: 'EUR' } }),
    store.update({ pollSeconds: 15 }),
  ]);

  await assert.rejects(fs.stat(path.join(dir, 'config.json.tmp')), /ENOENT/);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.pollSeconds, 15);
  assert.equal(onDisk.ui.currency, 'EUR');
});

test('configStore: redaction masks secrets and PUT round-trip ignores sentinels', async () => {
  const dir = await tmpDir();
  const store = new ConfigStore({ dataDir: dir });
  await store.load();
  await store.update({
    miners: [{ id: 's19j4', password: 'supersecret' }],
    alerts: {
      telegram: { botToken: '123:ABC', chatId: '42' },
      ntfy: { url: 'https://user:pw@ntfy.example.com/base', topic: 'mining' },
    },
  });

  const red = store.redacted();
  assert.equal(red.miners[0].password, REDACT_SENTINEL);
  assert.equal(red.alerts.telegram.botToken, REDACT_SENTINEL);
  assert.ok(!red.alerts.ntfy.url.includes('pw'), 'ntfy URL credentials masked');
  assert.ok(red.alerts.ntfy.url.includes(REDACT_SENTINEL));
  assert.ok(red.alerts.ntfy.url.includes('ntfy.example.com'), 'host survives redaction');
  // secrets untouched in the real config
  assert.equal(store.get().miners[0].password, 'supersecret');

  // PUT the redacted config straight back (the UI round-trip) — secrets must survive
  const after = await store.update(red);
  assert.equal(after.miners[0].password, 'supersecret');
  assert.equal(after.alerts.telegram.botToken, '123:ABC');
  assert.equal(after.alerts.ntfy.url, 'https://user:pw@ntfy.example.com/base');

  // but a genuinely new secret is accepted
  const after2 = await store.update({ miners: [{ id: 's19j4', password: 'newpw' }] });
  assert.equal(after2.miners[0].password, 'newpw');
});

test('configStore: update validates types/ranges and rejects unknown top-level keys', async () => {
  const dir = await tmpDir();
  const store = new ConfigStore({ dataDir: dir });
  await store.load();

  await assert.rejects(store.update({ bogusKey: 1 }), /unknown top-level key/);
  await assert.rejects(store.update({ pollSeconds: 'fast' }), /must be a number/);
  await assert.rejects(store.update({ pollSeconds: 0 }), /out of range/);
  await assert.rejects(
    store.update({ miners: [{ id: 's19j4', mode: 'turbo' }] }),
    /mode must be one of/,
  );
  await assert.rejects(
    store.update({ miners: [{ id: 's19j4', limits: { minTargetW: 4000 } }] }),
    /minTargetW > maxTargetW/,
  );
  // failed update leaves config untouched
  assert.equal(store.get().pollSeconds, DEFAULT_CONFIG.pollSeconds);
});

// ---------------------------------------------------------------------------
// stateStore
// ---------------------------------------------------------------------------

test('stateStore: defaults for missing file, round-trip, corrupt recovery', async () => {
  const dir = await tmpDir();
  const store = new StateStore({ dataDir: dir });

  assert.deepEqual(await store.load('m1'), DEFAULT_ENGINE_STATE);

  const state = { ...DEFAULT_ENGINE_STATE, lastOnAt: '2026-07-05T10:00:00.000Z', thermalCeilingW: 3200 };
  await store.save('m1', state);
  await store.flush();
  assert.deepEqual(await store.load('m1'), state);

  await fs.writeFile(path.join(dir, 'state-m1.json'), 'garbage%%%');
  assert.deepEqual(await store.load('m1'), DEFAULT_ENGINE_STATE, 'corrupt → defaults');
});

test('stateStore: writes are debounced to ≤1/5s; flush persists the latest state', async () => {
  const dir = await tmpDir();
  const store = new StateStore({ dataDir: dir });
  const file = path.join(dir, 'state-m1.json');

  const s1 = { ...DEFAULT_ENGINE_STATE, dryRunActionCount: 1 };
  const s2 = { ...DEFAULT_ENGINE_STATE, dryRunActionCount: 2 };
  const s3 = { ...DEFAULT_ENGINE_STATE, dryRunActionCount: 3 };

  await store.save('m1', s1); // first save writes immediately
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).dryRunActionCount, 1);

  await store.save('m1', s2); // within 5s → deferred
  await store.save('m1', s3); // coalesces with the pending write
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).dryRunActionCount, 1,
    'no second write within the debounce window');

  await store.flush(); // shutdown path: latest state lands now
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).dryRunActionCount, 3);
  await assert.rejects(fs.stat(`${file}.tmp`), /ENOENT/, 'atomic write leaves no tmp file');
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

function isoAt(base, minutes) { return new Date(base + minutes * 60000).toISOString(); }

test('history: hourly rollup averages wallW/hr/price and keeps last targetW/boards', async () => {
  const dir = await tmpDir();
  const h = new History({ dataDir: dir });
  const base = Date.parse('2026-03-10T10:00:00.000Z');

  const mk = (min, wallW, hr, price, targetW, boards) => ({
    ts: isoAt(base, min), id: 'm1', hr, wallW, targetW, boards,
    chipT: 65, priceMarginal: price, regime: 'subsidised', netNokH: 1.0,
  });
  for (const s of [
    mk(0, 1000, 10, 0.5, 2000, 1),
    mk(20, 2000, 20, 1.0, 2500, 2),
    mk(40, 3000, 30, 1.5, 3000, 3),   // hour 10: avg 2000 W / 20 TH / 1.0 kr; last 3000 W, 3 boards
    mk(70, 600, 6, 0.9, 944, 1),      // hour 11
  ]) await h.appendSample(s);

  const raw = await h.querySamples({
    fromIso: isoAt(base, -5), toIso: isoAt(base, 120), id: 'm1', res: 'raw',
  });
  assert.equal(raw.length, 4);

  const hourly = await h.querySamples({
    fromIso: isoAt(base, -5), toIso: isoAt(base, 120), id: 'm1', res: 'hour',
  });
  assert.equal(hourly.length, 2);
  const [h10, h11] = hourly;
  assert.equal(h10.ts, '2026-03-10T10:00:00.000Z');
  assert.equal(h10.samples, 3);
  assert.equal(h10.wallW, 2000);
  assert.equal(h10.hr, 20);
  assert.equal(h10.priceMarginal, 1.0);
  assert.equal(h10.targetW, 3000, 'last targetW of the hour');
  assert.equal(h10.boards, 3, 'last boards of the hour');
  assert.equal(h11.ts, '2026-03-10T11:00:00.000Z');
  assert.equal(h11.wallW, 600);
});

test('history: minerKWhThisMonth integrates wallW with gaps capped at 5 min', async () => {
  const dir = await tmpDir();
  const h = new History({ dataDir: dir });
  // Anchor to the start of the current UTC month so the samples are "this month".
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0);

  // 13 samples 5 min apart at 1200 W → 12 × (1200 W × 1/12 h) = 1.2 kWh
  for (let i = 0; i <= 12; i++) {
    await h.appendSample({ ts: isoAt(base, i * 5), id: 'm1', wallW: 1200, hr: 20 });
  }
  // 30-min gap, then one more sample: gap capped at 5 min → +1200 × 1/12 = 0.1 kWh
  await h.appendSample({ ts: isoAt(base, 90), id: 'm1', wallW: 1200, hr: 20 });
  // another miner's samples must not count
  await h.appendSample({ ts: isoAt(base, 10), id: 'other', wallW: 99999, hr: 20 });

  const kwh = await h.minerKWhThisMonth('m1');
  assert.ok(Math.abs(kwh - 1.3) < 1e-9, `expected 1.3 kWh, got ${kwh}`);
  assert.equal(await h.minerKWhThisMonth('nope'), 0);
});

test('history: prune removes month files older than retentionMonths', async () => {
  const dir = await tmpDir();
  const h = new History({ dataDir: dir, retentionMonths: 12 });

  await h.appendSample({ ts: '2024-01-15T12:00:00.000Z', id: 'm1', wallW: 1000 });
  await h.appendEvent({ ts: '2024-01-15T12:00:00.000Z', type: 'action', severity: 'info', message: 'old' });
  await h.appendSample({ ts: '2026-06-15T12:00:00.000Z', id: 'm1', wallW: 1000 });
  await h.appendEvent({ ts: '2026-06-20T12:00:00.000Z', type: 'action', severity: 'info', message: 'recent' });

  await h.prune('2026-07-05T00:00:00.000Z');

  const files = (await fs.readdir(path.join(dir, 'history'))).sort();
  assert.deepEqual(files, ['events-2026-06.ndjson', 'samples-2026-06.ndjson']);
});

test('history: queryEvents returns newest first with severity filter', async () => {
  const dir = await tmpDir();
  const h = new History({ dataDir: dir });
  await h.appendEvent({ ts: '2026-06-01T00:00:00.000Z', type: 'action', severity: 'info', message: 'a' });
  await h.appendEvent({ ts: '2026-07-01T00:00:00.000Z', type: 'alert', severity: 'critical', message: 'b' });
  await h.appendEvent({ ts: '2026-07-02T00:00:00.000Z', type: 'action', severity: 'info', message: 'c' });

  const all = await h.queryEvents({ limit: 10 });
  assert.deepEqual(all.map((e) => e.message), ['c', 'b', 'a']);
  const crit = await h.queryEvents({ limit: 10, severity: 'critical' });
  assert.deepEqual(crit.map((e) => e.message), ['b']);
  const limited = await h.queryEvents({ limit: 2 });
  assert.equal(limited.length, 2);
});

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

function fakeConfigStore(alertsCfg) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(cfg.alerts, alertsCfg);
  return { get: () => cfg };
}

function captureFetch(calls) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  };
}

test('alerts: fire dispatches correct payloads to ntfy, telegram and webhook', async () => {
  const calls = [];
  const events = [];
  const alerts = new Alerts({
    configStore: fakeConfigStore({
      ntfy: { url: 'https://ntfy.sh/', topic: 'my mining' },
      telegram: { botToken: 'TOK123', chatId: '42' },
      webhook: { url: 'https://hooks.example.com/x' },
    }),
    history: { appendEvent: async (e) => events.push(e) },
    fetchImpl: captureFetch(calls),
  });

  const fired = await alerts.fire('offline', {
    severity: 'critical', title: 'Miner offline', message: 'm1 unreachable', minerId: 'm1',
  });
  assert.equal(fired, true);
  assert.equal(calls.length, 3);

  const ntfy = calls.find((c) => c.url.startsWith('https://ntfy.sh'));
  assert.equal(ntfy.url, 'https://ntfy.sh/my%20mining');
  assert.equal(ntfy.opts.method, 'POST');
  assert.equal(ntfy.opts.headers.Title, 'Miner offline');
  assert.equal(ntfy.opts.headers.Priority, 'urgent');
  assert.equal(ntfy.opts.body, 'm1 unreachable');

  const tg = calls.find((c) => c.url.includes('api.telegram.org'));
  assert.equal(tg.url, 'https://api.telegram.org/botTOK123/sendMessage');
  assert.deepEqual(JSON.parse(tg.opts.body), { chat_id: '42', text: 'Miner offline\nm1 unreachable' });

  const wh = calls.find((c) => c.url.includes('hooks.example.com'));
  const whBody = JSON.parse(wh.opts.body);
  assert.equal(whBody.ruleKey, 'offline');
  assert.equal(whBody.severity, 'critical');
  assert.equal(whBody.minerId, 'm1');

  // alert also landed in the events log
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'alert');
  assert.equal(events[0].data.ruleKey, 'offline');
});

test('alerts: 30-min cooldown per ruleKey+minerId', async () => {
  const calls = [];
  const alerts = new Alerts({
    configStore: fakeConfigStore({ ntfy: { url: 'https://ntfy.sh', topic: 't' } }),
    history: null,
    fetchImpl: captureFetch(calls),
  });

  assert.equal(await alerts.fire('offline', { title: 'x', message: 'y', minerId: 'm1' }), true);
  assert.equal(await alerts.fire('offline', { title: 'x', message: 'y', minerId: 'm1' }), false,
    'same rule+miner suppressed inside cooldown');
  assert.equal(await alerts.fire('offline', { title: 'x', message: 'y', minerId: 'm2' }), true,
    'different miner is a different cooldown bucket');
  assert.equal(await alerts.fire('hashrate-low', { title: 'x', message: 'y', minerId: 'm1' }), true,
    'different rule is a different cooldown bucket');
  assert.equal(calls.length, 3);

  // expire the cooldown and it fires again
  alerts._lastFired.set('offline|m1', Date.now() - 31 * 60 * 1000);
  assert.equal(await alerts.fire('offline', { title: 'x', message: 'y', minerId: 'm1' }), true);
});

test('alerts: evaluate implements offline / dead-board / failover / horizon rules', async () => {
  const calls = [];
  const alerts = new Alerts({
    configStore: fakeConfigStore({ ntfy: { url: 'https://ntfy.sh', topic: 't' } }),
    history: null,
    fetchImpl: captureFetch(calls),
  });
  const t0 = Date.parse('2026-07-05T12:00:00.000Z');
  const snapOnline = {
    online: true,
    boards: [{ id: '2', enabled: true, hashing: false }],
    pools: [
      { url: 'stratum+tcp://primary', active: false },
      { url: 'stratum+tcp://backup', active: true },
    ],
    hashrate: { m15: 5 },
  };
  const ctx = (over) => ({
    minerId: 'm1', tuningHold: false,
    market: { horizonCoversNow: true },
    engineState: {}, ...over,
  });

  // offline: needs offlineAfterS (300 s) of persistence
  let fired = await alerts.evaluate(ctx({ now: new Date(t0).toISOString(), snapshot: { online: false } }));
  assert.deepEqual(fired, []);
  fired = await alerts.evaluate(ctx({ now: new Date(t0 + 301000).toISOString(), snapshot: { online: false } }));
  assert.deepEqual(fired, ['offline']);

  // dead board + hashrate low: need 10 min persistence, suppressed during tuning hold
  fired = await alerts.evaluate(ctx({
    now: new Date(t0).toISOString(), snapshot: snapOnline, expectedHashrateThs: 30,
  }));
  assert.deepEqual(fired, ['pool-failover'], 'failover fires immediately; timed rules pending');
  fired = await alerts.evaluate(ctx({
    now: new Date(t0 + 11 * 60000).toISOString(), snapshot: snapOnline, expectedHashrateThs: 30,
    tuningHold: true,
  }));
  assert.deepEqual(fired, [], 'tuning hold suppresses hashrate-low and dead-board');
  // hold cleared the trackers; condition must persist 10 min again from here
  fired = await alerts.evaluate(ctx({
    now: new Date(t0 + 12 * 60000).toISOString(), snapshot: snapOnline, expectedHashrateThs: 30,
  }));
  assert.deepEqual(fired, []);
  fired = await alerts.evaluate(ctx({
    now: new Date(t0 + 23 * 60000).toISOString(), snapshot: snapOnline, expectedHashrateThs: 30,
  }));
  assert.deepEqual(fired.sort(), ['dead-board-2', 'hashrate-low']);

  // price horizon exhausted
  fired = await alerts.evaluate(ctx({
    now: new Date(t0).toISOString(),
    snapshot: { online: true, boards: [], pools: [], hashrate: {} },
    market: { horizonCoversNow: false },
  }));
  assert.deepEqual(fired, ['price-horizon']);
});

test('alerts: test() sends to every configured channel and skips unconfigured ones', async () => {
  const calls = [];
  const alerts = new Alerts({
    configStore: fakeConfigStore({
      ntfy: { url: 'https://ntfy.sh', topic: 'mining' },
      telegram: { botToken: '', chatId: '' },        // unconfigured → skipped
      webhook: { url: 'https://hooks.example.com/x' },
    }),
    history: null,
    fetchImpl: captureFetch(calls),
  });

  const results = await alerts.test();
  assert.equal(calls.length, 2);
  assert.equal(results.ntfy.ok, true);
  assert.equal(results.webhook.ok, true);
  assert.equal(results.telegram, undefined);
});

// --- regression: review round 2 fixes (2026-07-11) --------------------------

test('alerts: credentialed ntfy/webhook URLs move userinfo to Authorization header', async () => {
  const calls = [];
  const alerts = new Alerts({
    configStore: fakeConfigStore({
      ntfy: { url: 'https://user:p@ss@ntfy.example.com/', topic: 'mine' },
      webhook: { url: 'https://hook:key@hooks.example.com/x' },
    }),
    history: { appendEvent: async () => {} },
    fetchImpl: captureFetch(calls),
  });
  await alerts.fire('offline', { severity: 'warn', title: 't', message: 'm', minerId: 'm1' });
  const ntfy = calls.find((c) => c.url.includes('ntfy.example.com'));
  assert.ok(!ntfy.url.includes('@'), 'no userinfo left in ntfy URL (undici would throw)');
  assert.equal(ntfy.url, 'https://ntfy.example.com/mine');
  assert.equal(ntfy.opts.headers.Authorization, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  const wh = calls.find((c) => c.url.includes('hooks.example.com'));
  assert.ok(!wh.url.includes('@'));
  assert.equal(wh.opts.headers.Authorization, `Basic ${Buffer.from('hook:key').toString('base64')}`);
});

test('config: telegram bot token without a chatId is rejected', async () => {
  const dir = await tmpDir();
  const store = new ConfigStore({ dataDir: dir });
  await store.load();
  await assert.rejects(
    store.update({ alerts: { telegram: { botToken: '123:ABC', chatId: '' } } }),
    /chatId is required/,
  );
  // a valid chatId (number or string) is accepted
  const ok = await store.update({ alerts: { telegram: { botToken: '123:ABC', chatId: 42 } } });
  assert.equal(ok.alerts.telegram.chatId, 42);
});
