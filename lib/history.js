// lib/history.js — single responsibility: NDJSON persistence of samples and events in
// monthly files under DATA_DIR/history/, with range queries, hourly rollups, month-kWh
// integration for the subsidy cap, and daily retention pruning.
'use strict';

const fs = require('fs/promises');
const path = require('path');

const log = (...a) => console.log('[history]', ...a);

const MAX_GAP_MS = 5 * 60 * 1000; // cap kWh-integration gaps at 5 minutes
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function monthKey(iso) { return iso.slice(0, 7); } // "YYYY-MM" (ISO timestamps are UTC)
function monthIndex(key) {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
}
function hourStartIso(iso) {
  const d = new Date(iso);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}
// Month keys spanning [fromIso, toIso], inclusive.
function monthKeysInRange(fromIso, toIso) {
  const keys = [];
  for (let i = monthIndex(monthKey(fromIso)); i <= monthIndex(monthKey(toIso)); i++) {
    const y = Math.floor(i / 12);
    const m = (i % 12) + 1;
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return keys;
}

class History {
  constructor({ dataDir, retentionMonths = 12 }) {
    this.dir = path.join(dataDir, 'history');
    this.retentionMonths = retentionMonths;
    this._pruneTimer = null;
    this._dirReady = null;
  }

  async _ensureDir() {
    if (!this._dirReady) this._dirReady = fs.mkdir(this.dir, { recursive: true });
    await this._dirReady;
  }

  _file(kind, key) { return path.join(this.dir, `${kind}-${key}.ndjson`); }

  async _append(kind, row) {
    if (!row || typeof row.ts !== 'string') throw new Error(`${kind} row needs an ISO ts`);
    await this._ensureDir();
    await fs.appendFile(this._file(kind, monthKey(row.ts)), `${JSON.stringify(row)}\n`);
  }

  // s: {ts, id, hr, wallW, targetW, boards, chipT, priceMarginal, regime, netNokH}
  async appendSample(s) { await this._append('samples', s); }

  // e: {ts, id?, type, severity, message, data?}
  async appendEvent(e) { await this._append('events', e); }

  async _readMonth(kind, key) {
    let raw;
    try {
      raw = await fs.readFile(this._file(kind, key), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip torn/partial last line */ }
    }
    return rows;
  }

  async querySamples({ fromIso, toIso, id, res = 'raw' }) {
    const rows = [];
    for (const key of monthKeysInRange(fromIso, toIso)) {
      for (const r of await this._readMonth('samples', key)) {
        if (r.ts < fromIso || r.ts > toIso) continue;
        if (id && r.id !== id) continue;
        rows.push(r);
      }
    }
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    if (res !== 'hour') return rows;

    // Hourly rollup per miner: avg wallW/hr/priceMarginal/netNokH, last targetW/boards.
    const buckets = new Map();
    for (const r of rows) {
      const hour = hourStartIso(r.ts);
      const k = `${r.id}|${hour}`;
      let b = buckets.get(k);
      if (!b) {
        b = { ts: hour, id: r.id, samples: 0,
              _wallW: 0, _wallN: 0, _hr: 0, _hrN: 0, _price: 0, _priceN: 0, _net: 0, _netN: 0,
              targetW: null, boards: null, regime: null };
        buckets.set(k, b);
      }
      b.samples += 1;
      if (typeof r.wallW === 'number') { b._wallW += r.wallW; b._wallN += 1; }
      if (typeof r.hr === 'number') { b._hr += r.hr; b._hrN += 1; }
      if (typeof r.priceMarginal === 'number') { b._price += r.priceMarginal; b._priceN += 1; }
      if (typeof r.netNokH === 'number') { b._net += r.netNokH; b._netN += 1; }
      if (r.targetW !== undefined) b.targetW = r.targetW; // rows are ts-sorted → last wins
      if (r.boards !== undefined) b.boards = r.boards;
      if (r.regime !== undefined) b.regime = r.regime;
    }
    return [...buckets.values()]
      .map((b) => ({
        ts: b.ts, id: b.id, samples: b.samples,
        wallW: b._wallN ? b._wallW / b._wallN : null,
        hr: b._hrN ? b._hr / b._hrN : null,
        priceMarginal: b._priceN ? b._price / b._priceN : null,
        netNokH: b._netN ? b._net / b._netN : null,
        targetW: b.targetW, boards: b.boards, regime: b.regime,
      }))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
  }

  // Newest first, scanning month files backwards until `limit` rows are collected.
  async queryEvents({ limit = 100, severity } = {}) {
    await this._ensureDir();
    const files = (await fs.readdir(this.dir))
      .map((f) => f.match(/^events-(\d{4}-\d{2})\.ndjson$/))
      .filter(Boolean)
      .map((m) => m[1])
      .sort()
      .reverse();
    const out = [];
    for (const key of files) {
      const rows = await this._readMonth('events', key);
      rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
      for (const r of rows) {
        if (severity && r.severity !== severity) continue;
        out.push(r);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  // Integrate wall power over sample intervals for the current (UTC) month, capping
  // each inter-sample gap at 5 minutes so outages don't inflate consumption.
  async minerKWhThisMonth(id) {
    const key = monthKey(new Date().toISOString());
    const rows = (await this._readMonth('samples', key))
      .filter((r) => r.id === id && typeof r.wallW === 'number')
      .sort((a, b) => (a.ts < b.ts ? -1 : 1));
    let wh = 0;
    for (let i = 1; i < rows.length; i++) {
      const dtMs = Math.min(Date.parse(rows[i].ts) - Date.parse(rows[i - 1].ts), MAX_GAP_MS);
      if (dtMs <= 0) continue;
      wh += rows[i - 1].wallW * (dtMs / 3600000);
    }
    return wh / 1000;
  }

  async prune(nowIso = new Date().toISOString()) {
    await this._ensureDir();
    const nowIdx = monthIndex(monthKey(nowIso));
    const files = await fs.readdir(this.dir);
    for (const f of files) {
      const m = f.match(/^(samples|events)-(\d{4}-\d{2})\.ndjson$/);
      if (!m) continue;
      if (nowIdx - monthIndex(m[2]) >= this.retentionMonths) {
        await fs.unlink(path.join(this.dir, f));
        log('pruned', f);
      }
    }
  }

  start() {
    if (this._pruneTimer) return;
    this.prune().catch((err) => log('prune failed:', err.message));
    this._pruneTimer = setInterval(
      () => this.prune().catch((err) => log('prune failed:', err.message)),
      PRUNE_INTERVAL_MS,
    );
    if (this._pruneTimer.unref) this._pruneTimer.unref();
  }

  stop() {
    if (this._pruneTimer) { clearInterval(this._pruneTimer); this._pruneTimer = null; }
  }
}

module.exports = { History };
