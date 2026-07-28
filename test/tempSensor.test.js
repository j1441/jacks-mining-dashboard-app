// test/tempSensor.test.js — Tasmota Status 10 parsing, staleness, and the rule
// that a fresh external sensor reading supersedes the hashboard inlet estimate.
// The HTTP layer is exercised against a real ephemeral express server.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  TempSensors, TasmotaSensor, parseTasmotaStatus10, parseTasmotaStatusPage, STALE_MS,
} = require('../lib/tempSensor');
const { zoneRoomTemp } = require('../lib/controller');

// ---------- Status 10 parsing ------------------------------------------------------

test('parses an AM2301 payload', () => {
  const r = parseTasmotaStatus10({
    StatusSNS: { Time: '2026-07-28T10:00:00', AM2301: { Temperature: 21.4, Humidity: 38.2 }, TempUnit: 'C' },
  });
  assert.deepEqual(r, { tempC: 21.4, humidityPct: 38.2, sensor: 'AM2301' });
});

test('parses an SI7021 payload — the key varies by attachment', () => {
  const r = parseTasmotaStatus10({
    StatusSNS: { Time: '...', SI7021: { Temperature: 19.8, Humidity: 41 }, TempUnit: 'C' },
  });
  assert.equal(r.tempC, 19.8);
  assert.equal(r.sensor, 'SI7021');
});

test('parses a DS18B20 payload with no humidity', () => {
  const r = parseTasmotaStatus10({
    StatusSNS: { DS18B20: { Id: '01212F5A', Temperature: 20.1 }, TempUnit: 'C' },
  });
  assert.equal(r.tempC, 20.1);
  assert.equal(r.humidityPct, null);
});

test('converts Fahrenheit when the device is configured for it', () => {
  const r = parseTasmotaStatus10({
    StatusSNS: { AM2301: { Temperature: 70.0 }, TempUnit: 'F' },
  });
  assert.equal(r.tempC, 21.1); // (70-32)*5/9 = 21.11 → 21.1
});

test('rejects implausible values — a disconnected 1-wire sensor reports -127', () => {
  assert.equal(parseTasmotaStatus10({ StatusSNS: { DS18B20: { Temperature: -127 }, TempUnit: 'C' } }), null);
  assert.equal(parseTasmotaStatus10({ StatusSNS: { AM2301: { Temperature: 999 }, TempUnit: 'C' } }), null);
});

test('returns null for payloads with no sensor block', () => {
  assert.equal(parseTasmotaStatus10({ StatusSNS: { Time: '...', TempUnit: 'C' } }), null);
  assert.equal(parseTasmotaStatus10({}), null);
  assert.equal(parseTasmotaStatus10(null), null);
});

// ---------- /?m=1 status page fallback ---------------------------------------------

// Captured verbatim from the live TH10 at 192.168.1.59 (Tasmota 15.5.0), whose
// /cm endpoint drops the connection while /?m=1 serves fine.
const LIVE_PAGE = "<img style='display:none;' src onerror=\"eb('o1').style.background='var(--c_btnoff)';\">"
  + "<div style='font-size:9px;'></div>{t}"
  + '{s}SI7021 Temperature{m}22.1 °C{e}'
  + '{s}SI7021 Humidity{m}57.2 %{e}'
  + '{s}SI7021 Dew point{m}13.2 °C{e}'
  + "<tr><td colspan=2 style='font-size:2px'><hr></td></tr></table>";

test('parses the live device status page', () => {
  assert.deepEqual(parseTasmotaStatusPage(LIVE_PAGE), {
    tempC: 22.1, humidityPct: 57.2, sensor: 'SI7021',
  });
});

test('dew point is never mistaken for room temperature', () => {
  // Dew point also carries a °C value and appears in the same row format.
  const r = parseTasmotaStatusPage('{t}{s}SI7021 Dew point{m}13.2 °C{e}{s}SI7021 Temperature{m}22.1 °C{e}');
  assert.equal(r.tempC, 22.1, 'must pick the temperature row, not the dew point');
});

test('status page in Fahrenheit converts', () => {
  const r = parseTasmotaStatusPage('{t}{s}AM2301 Temperature{m}70.0 °F{e}');
  assert.equal(r.tempC, 21.1);
});

test('status page with no sensor rows returns null', () => {
  // A relay-only device (module misconfigured) reports power state and nothing else.
  const noSensor = "{t}</table>{t}<tr><td style='font-size:62px'>OFF</td></tr></table>";
  assert.equal(parseTasmotaStatusPage(noSensor), null);
  assert.equal(parseTasmotaStatusPage(''), null);
  assert.equal(parseTasmotaStatusPage(null), null);
});

test('status page rejects implausible temperatures', () => {
  assert.equal(parseTasmotaStatusPage('{t}{s}DS18B20 Temperature{m}-127.0 °C{e}'), null);
});

// ---------- HTTP polling -----------------------------------------------------------

function fakeTasmota(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      host: `127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

test('polls a Tasmota device and records a fresh reading', async () => {
  const dev = await fakeTasmota((req, res) => {
    assert.match(req.url, /cmnd=Status(%20|\+)10/i);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ StatusSNS: { AM2301: { Temperature: 21.4, Humidity: 38.2 }, TempUnit: 'C' } }));
  });
  try {
    const s = new TasmotaSensor({ zoneId: 'home', host: dev.host, name: 'Loft' });
    const reading = await s.poll();
    assert.equal(reading.tempC, 21.4);
    assert.equal(s.fresh().humidityPct, 38.2);
    assert.equal(s.status().online, true);
  } finally { await dev.close(); }
});

test('falls back to /?m=1 when /cm drops the connection (the live TH10 case)', async () => {
  let cmHits = 0;
  let pageHits = 0;
  const dev = await fakeTasmota((req, res) => {
    if (req.url.startsWith('/cm')) { cmHits += 1; req.socket.destroy(); return; } // no response at all
    pageHits += 1;
    res.setHeader('content-type', 'text/html');
    res.end(LIVE_PAGE);
  });
  try {
    const s = new TasmotaSensor({ zoneId: 'home', host: dev.host, name: 'Upstairs' });
    const r1 = await s.poll();
    assert.equal(r1.tempC, 22.1);
    assert.equal(r1.humidityPct, 57.2);
    assert.equal(s.transport, 'page');
    assert.equal(cmHits, 1, 'JSON endpoint tried first');

    // Having learned the transport, the next poll must not re-try the dead
    // endpoint — one request per poll on a device that only serves the page.
    await s.poll();
    assert.equal(cmHits, 1, 'dead endpoint not retried once transport is known');
    assert.equal(pageHits, 2);
    assert.equal(s.status().transport, 'page');
  } finally { await dev.close(); }
});

test('prefers JSON when both endpoints work', async () => {
  let pageHits = 0;
  const dev = await fakeTasmota((req, res) => {
    if (req.url.startsWith('/cm')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ StatusSNS: { SI7021: { Temperature: 19.4, Humidity: 50 }, TempUnit: 'C' } }));
      return;
    }
    pageHits += 1;
    res.end(LIVE_PAGE);
  });
  try {
    const s = new TasmotaSensor({ zoneId: 'home', host: dev.host });
    const r = await s.poll();
    assert.equal(r.tempC, 19.4);
    assert.equal(s.transport, 'json');
    assert.equal(pageHits, 0, 'page must not be fetched when JSON answers');
  } finally { await dev.close(); }
});

test('both transports dead reports both errors', async () => {
  const dev = await fakeTasmota((req, res) => { res.statusCode = 500; res.end('boom'); });
  try {
    const s = new TasmotaSensor({ zoneId: 'home', host: dev.host });
    assert.equal(await s.poll(), null);
    assert.match(s.lastError, /json:.*HTTP 500/);
    assert.match(s.lastError, /page:.*HTTP 500/);
  } finally { await dev.close(); }
});

test('a failing device yields null and never throws — the tick must survive', async () => {
  const dev = await fakeTasmota((req, res) => { res.statusCode = 500; res.end('boom'); });
  try {
    const s = new TasmotaSensor({ zoneId: 'home', host: dev.host });
    assert.equal(await s.poll(), null);
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.status().online, false);
    assert.match(s.lastError, /HTTP 500/);
  } finally { await dev.close(); }
});

test('an unreachable host yields null rather than rejecting', async () => {
  // 127.0.0.1:1 — nothing listens there; connection is refused immediately.
  const s = new TasmotaSensor({ zoneId: 'home', host: '127.0.0.1:1' });
  assert.equal(await s.poll(), null);
  assert.equal(s.status().online, false);
});

test('stale readings are dropped, not held — a silent sensor says nothing about now', () => {
  const s = new TasmotaSensor({ zoneId: 'home', host: '10.0.0.1' });
  s.reading = { tempC: 21.4, humidityPct: 40, sensor: 'AM2301', ts: Date.now() };
  assert.ok(s.fresh());
  s.reading.ts = Date.now() - STALE_MS - 1;
  assert.equal(s.fresh(), null);
  assert.equal(s.status().online, false);
});

test('host accepts a scheme and trailing slash', () => {
  const s = new TasmotaSensor({ zoneId: 'home', host: 'http://192.168.1.50/' });
  assert.equal(s.host, '192.168.1.50');
  assert.equal(s.url, 'http://192.168.1.50/cm?cmnd=Status%2010');
});

// ---------- sync from config -------------------------------------------------------

const cfgWith = (tempSensor) => ({ heating: { zones: [{ id: 'home', name: 'Home', tempSensor }] } });

test('sync builds sensors only for zones configured with type tasmota', () => {
  const t = new TempSensors({ configStore: null });
  assert.equal(t.sync(cfgWith({ type: 'tasmota', host: '192.168.1.50' })), 1);
  assert.equal(t.sync(cfgWith({ type: 'none', host: '' })), 0);
  assert.equal(t.sync(cfgWith(undefined)), 0);
  assert.equal(t.sync({}), 0);
});

test('sync preserves the reading when the host is unchanged', () => {
  const t = new TempSensors({ configStore: null });
  t.sync(cfgWith({ type: 'tasmota', host: '192.168.1.50' }));
  t.sensors.get('home').reading = { tempC: 21.4, humidityPct: null, sensor: 'AM2301', ts: Date.now() };
  t.sync(cfgWith({ type: 'tasmota', host: '192.168.1.50', name: 'Loft' }));
  assert.equal(t.tempC('home'), 21.4, 'a config save must not blank the thermostat input');
  // A changed host is a different device — the old reading must not carry over.
  t.sync(cfgWith({ type: 'tasmota', host: '192.168.1.51' }));
  assert.equal(t.tempC('home'), null);
});

test('tempC is null for an unknown zone or a stale reading', () => {
  const t = new TempSensors({ configStore: null });
  t.sync(cfgWith({ type: 'tasmota', host: '192.168.1.50' }));
  assert.equal(t.tempC('garage'), null);
  t.sensors.get('home').reading = { tempC: 21.4, humidityPct: null, sensor: 'AM2301', ts: Date.now() - STALE_MS - 1 };
  assert.equal(t.tempC('home'), null);
});

// ---------- precedence over the inlet estimate -------------------------------------

test('a fresh sensor reading supersedes the miner-derived estimate', () => {
  const roomTemps = new Map([['s19j', { zoneId: 'home', tempC: 26.0, ts: Date.now() }]]);
  // Without a sensor: coolest miner estimate wins.
  assert.equal(zoneRoomTemp(roomTemps, 'home', 28.0), 26.0);
  // With one: the thermometer wins outright, even though it reads warmer than
  // the inlet estimate — it is not min'd in.
  assert.equal(zoneRoomTemp(roomTemps, 'home', 28.0, 21.4), 21.4);
  // ...and even when it reads colder.
  assert.equal(zoneRoomTemp(roomTemps, 'home', 28.0, 30.0), 30.0);
});

test('a stale/absent sensor falls back to the inlet estimate rather than to no reading', () => {
  const roomTemps = new Map([['s19j', { zoneId: 'home', tempC: 26.0, ts: Date.now() }]]);
  assert.equal(zoneRoomTemp(roomTemps, 'home', null, null), 26.0);
  assert.equal(zoneRoomTemp(roomTemps, 'home', null, undefined), 26.0);
  // Nothing at all → null, so resolveHeatDemand holds demand at 0 (never heat blind).
  assert.equal(zoneRoomTemp(new Map(), 'home', null, null), null);
});
