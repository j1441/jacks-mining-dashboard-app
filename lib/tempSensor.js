// tempSensor.js — external ambient temperature sensors (Tasmota over HTTP).
//
// Why this exists: without a sensor the room temp is inferred from hashboard
// inlet temps (see estimateRoomTempC / classifyRoomReading in controller.js).
// That estimate is contaminated by the miner's own heat, so it only counts
// during narrow windows — fans flushed for 10 min while hashing, or a fully
// cooled idle chassis — and is unusable in between. A real sensor in the room
// reads ambient directly, all the time, so when one is configured for a zone it
// supersedes the inlet estimate outright rather than being averaged with it.
//
// Transport: two paths, tried in order.
//
// 1. `/cm?cmnd=Status%2010` — the clean JSON command endpoint:
//    {"StatusSNS":{"Time":"...","AM2301":{"Temperature":21.4,"Humidity":38.2},"TempUnit":"C"}}
//    The sensor key varies by attachment (AM2301 / SI7021 / DS18B20), so the
//    parser walks StatusSNS for any object carrying a numeric Temperature
//    rather than hard-coding a key.
//
// 2. `/?m=1` — the status block the web UI polls, in Tasmota's own template
//    format: `{s}SI7021 Temperature{m}22.1 °C{e}{s}SI7021 Humidity{m}57.2 %{e}`
//    This is the fallback. It exists because on the live TH10 here every
//    dynamically-built endpoint (/cm, /in, /cs, /cn, /md) drops the connection
//    with no response while `/` and `/?m=1` serve fine — reproducibly, and
//    across a restart. Rather than depend on a device quirk being fixed, the
//    sensor negotiates: whichever transport answers is remembered and tried
//    first next time, so a healthy device costs one request per poll.
'use strict';

const DEFAULT_POLL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 1000;
// A reading older than this is not trusted; callers fall back to the inlet
// estimate. Matches the 5 min cross-miner cutoff in controller.zoneRoomTemp.
const STALE_MS = 5 * 60 * 1000;
// Plausibility band for an indoor ambient reading. A disconnected 1-wire sensor
// reports 0 or -127 rather than erroring, and those must not read as "freezing
// room" and drive the thermostat to full demand.
const MIN_PLAUSIBLE_C = -30;
const MAX_PLAUSIBLE_C = 60;
// Consecutive failures before an outage is announced once. Single misses are
// routine on WiFi and must not spam the event log.
const FAILURES_BEFORE_EVENT = 3;

const log = (...a) => console.log('[tempSensor]', ...a);
const r1 = (n) => Math.round(n * 10) / 10;

// Tasmota reports in whatever TempUnit the device is configured for.
function toCelsius(value, unit) {
  if (unit === 'F') return (value - 32) * (5 / 9);
  if (unit === 'K') return value - 273.15;
  return value;
}

// Pull {tempC, humidityPct} out of a Status 10 payload. Returns null when the
// body has no usable temperature.
function parseTasmotaStatus10(body) {
  const sns = body && body.StatusSNS;
  if (!sns || typeof sns !== 'object') return null;
  const unit = typeof sns.TempUnit === 'string' ? sns.TempUnit : 'C';
  for (const [key, entry] of Object.entries(sns)) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = Number(entry.Temperature);
    if (!Number.isFinite(raw)) continue;
    const tempC = toCelsius(raw, unit);
    if (tempC < MIN_PLAUSIBLE_C || tempC > MAX_PLAUSIBLE_C) continue;
    const hum = Number(entry.Humidity);
    return {
      tempC: r1(tempC),
      humidityPct: Number.isFinite(hum) ? r1(hum) : null,
      sensor: key,
    };
  }
  return null;
}

// Pull {tempC, humidityPct} out of the `/?m=1` status block. Tasmota emits rows
// as `{s}<label>{m}<value>{e}`; the web UI substitutes those braces for table
// markup client-side, so the raw response still carries them.
function parseTasmotaStatusPage(html) {
  if (typeof html !== 'string') return null;
  const strip = (s) => s.replace(/<[^>]*>/g, '').trim();
  const rows = [...html.matchAll(/\{s\}(.*?)\{m\}(.*?)\{e\}/g)]
    .map((m) => ({ label: strip(m[1]), value: strip(m[2]) }));
  if (!rows.length) return null;

  let tempC = null;
  let humidityPct = null;
  let sensor = null;
  for (const row of rows) {
    // "Dew point" also carries a °C value — match temperature explicitly so a
    // dew point reading can never be mistaken for the room temperature.
    if (tempC === null && /temperature/i.test(row.label)) {
      const m = row.value.match(/(-?\d+(?:\.\d+)?)\s*°?\s*([CFK])\b/i);
      if (m) {
        const t = toCelsius(Number(m[1]), m[2].toUpperCase());
        if (t >= MIN_PLAUSIBLE_C && t <= MAX_PLAUSIBLE_C) {
          tempC = r1(t);
          sensor = row.label.replace(/\s*temperature\s*$/i, '').trim() || null;
        }
      }
    }
    if (humidityPct === null && /humidity/i.test(row.label)) {
      const m = row.value.match(/(-?\d+(?:\.\d+)?)\s*%/);
      if (m) humidityPct = r1(Number(m[1]));
    }
  }
  if (tempC === null) return null;
  return { tempC, humidityPct, sensor: sensor || 'unknown' };
}

// One configured sensor. `host` is an IP or hostname, optionally with :port.
class TasmotaSensor {
  constructor({ zoneId, host, name }) {
    this.zoneId = zoneId;
    this.host = String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.name = name || host;
    this.reading = null;      // {tempC, humidityPct, sensor, ts}
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.outageAnnounced = false;
    this.transport = null;    // 'json' | 'page' — whichever last answered
  }

  get url() { return `http://${this.host}/cm?cmnd=Status%2010`; }
  get pageUrl() { return `http://${this.host}/?m=1`; }

  async _pollJson() {
    const res = await fetch(this.url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseTasmotaStatus10(await res.json());
    if (!parsed) throw new Error('no usable temperature in StatusSNS');
    return parsed;
  }

  async _pollPage() {
    const res = await fetch(this.pageUrl, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseTasmotaStatusPage(await res.text());
    if (!parsed) throw new Error('no usable temperature in status page');
    return parsed;
  }

  // Resolves to the parsed reading, or null on any failure. Never throws —
  // a dead sensor degrades to the inlet estimate, it does not break the tick.
  // Tries the transport that worked last time first, so the fallback costs an
  // extra request only while a device is actually misbehaving.
  async poll() {
    const order = this.transport === 'page' ? ['page', 'json'] : ['json', 'page'];
    const errors = [];
    for (const t of order) {
      try {
        const parsed = t === 'json' ? await this._pollJson() : await this._pollPage();
        this.transport = t;
        this.reading = { ...parsed, ts: Date.now() };
        this.consecutiveFailures = 0;
        this.lastError = null;
        this.outageAnnounced = false;
        return this.reading;
      } catch (e) {
        errors.push(`${t}: ${(e && e.message) || String(e)}`);
      }
    }
    this.consecutiveFailures += 1;
    this.lastError = errors.join('; ');
    return null;
  }

  // The reading if it is still fresh, else null. Stale readings are dropped
  // rather than held: an ambient sensor that stopped reporting says nothing
  // about the room now, and a wrong "cold" value would drive real heating.
  fresh(now = Date.now()) {
    const r = this.reading;
    if (!r || now - r.ts > STALE_MS) return null;
    return r;
  }

  status(now = Date.now()) {
    const fresh = this.fresh(now);
    return {
      zoneId: this.zoneId,
      host: this.host,
      name: this.name,
      online: !!fresh,
      tempC: fresh ? fresh.tempC : null,
      humidityPct: fresh ? fresh.humidityPct : null,
      sensor: fresh ? fresh.sensor : null,
      transport: this.transport,
      ageSeconds: this.reading ? Math.round((now - this.reading.ts) / 1000) : null,
      lastError: this.lastError,
    };
  }
}

// Owns every configured sensor and one shared poll timer. Rebuilt from config
// on demand so sensors can be added/removed without a restart.
class TempSensors {
  constructor({ configStore, onEvent = null, pollMs = DEFAULT_POLL_MS } = {}) {
    this.configStore = configStore;
    this.onEvent = onEvent;
    this.pollMs = pollMs;
    this.sensors = new Map(); // zoneId -> TasmotaSensor
    this.timer = null;
  }

  // (Re)build the sensor set from heating.zones[].tempSensor. Existing sensors
  // with unchanged host keep their reading so a config save does not blank the
  // thermostat input for a poll cycle.
  sync(cfg) {
    const zones = ((cfg || {}).heating || {}).zones || [];
    const next = new Map();
    for (const z of zones) {
      const s = z && z.tempSensor;
      if (!s || s.type !== 'tasmota' || !s.host) continue;
      const existing = this.sensors.get(z.id);
      if (existing && existing.host === String(s.host).replace(/^https?:\/\//, '').replace(/\/+$/, '')) {
        existing.name = s.name || existing.name;
        next.set(z.id, existing);
      } else {
        next.set(z.id, new TasmotaSensor({ zoneId: z.id, host: s.host, name: s.name }));
      }
    }
    this.sensors = next;
    return this.sensors.size;
  }

  async start() {
    this.sync(this.configStore ? this.configStore.config : null);
    if (this.sensors.size) {
      await this.pollAll();
      log(`polling ${this.sensors.size} sensor(s) every ${Math.round(this.pollMs / 1000)}s`);
    }
    this.timer = setInterval(() => {
      this.pollAll().catch((e) => log('poll cycle failed:', e.message));
    }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollAll() {
    this.sync(this.configStore ? this.configStore.config : null);
    if (!this.sensors.size) return;
    await Promise.all([...this.sensors.values()].map(async (s) => {
      const before = !!s.fresh();
      await s.poll();
      // Announce an outage once it is sustained, and announce the recovery so
      // the event log shows the thermostat went back onto the real sensor.
      if (!s.outageAnnounced && s.consecutiveFailures >= FAILURES_BEFORE_EVENT) {
        s.outageAnnounced = true;
        this._event('temp-sensor-unavailable', 'warn',
          `zone ${s.zoneId}: temperature sensor ${s.name} unreachable (${s.lastError}) — falling back to hashboard inlet estimate`);
      } else if (!before && s.fresh() && s.consecutiveFailures === 0 && s.reading) {
        this._event('temp-sensor-online', 'info',
          `zone ${s.zoneId}: temperature sensor ${s.name} reading ${s.reading.tempC} °C`);
      }
    }));
  }

  _event(type, severity, message) {
    if (typeof this.onEvent !== 'function') return;
    try { this.onEvent({ type, severity, message }); } catch (e) { log('event sink failed:', e.message); }
  }

  // Fresh ambient temperature for a zone, or null when there is no sensor or
  // its reading is stale. This is the value that supersedes the inlet estimate.
  tempC(zoneId, now = Date.now()) {
    const s = this.sensors.get(zoneId);
    if (!s) return null;
    const fresh = s.fresh(now);
    return fresh ? fresh.tempC : null;
  }

  reading(zoneId, now = Date.now()) {
    const s = this.sensors.get(zoneId);
    return s ? s.fresh(now) : null;
  }

  statuses(now = Date.now()) {
    return [...this.sensors.values()].map((s) => s.status(now));
  }
}

module.exports = {
  TempSensors,
  TasmotaSensor,
  parseTasmotaStatus10,
  parseTasmotaStatusPage,
  STALE_MS,
  DEFAULT_POLL_MS,
};
