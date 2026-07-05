// lib/stateStore.js — single responsibility: persist per-miner EngineState runtime data
// (dwell timestamps, ceilings, pausedBy) to DATA_DIR/state-<minerId>.json with atomic,
// debounced writes (≤1 write per 5 s per miner) and a flush() for shutdown/tests.
'use strict';

const fs = require('fs/promises');
const path = require('path');

const log = (...a) => console.log('[stateStore]', ...a);

const DEBOUNCE_MS = 5000;

// EngineState defaults (CONTRACTS.md). thermalCeilingW is null until the controller
// initializes it to the miner's limits.maxTargetW (stateStore has no access to limits).
const DEFAULT_ENGINE_STATE = {
  lastPowerChangeAt: null,
  lastBoardsChangeAt: null,
  lastOffAt: null,
  lastOnAt: null,
  pausedBy: null,
  thermalCeilingW: null,
  thermalCeilingRaisedAt: null,
  tuningHoldSince: null,
  safetyPauseClearSince: null,
  dryRunActionCount: 0,
};

class StateStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    // per-miner: { pending: state|null, timer, lastWriteAt, queue: Promise }
    this._miners = new Map();
  }

  _file(minerId) { return path.join(this.dataDir, `state-${minerId}.json`); }

  _entry(minerId) {
    let e = this._miners.get(minerId);
    if (!e) {
      e = { pending: null, timer: null, lastWriteAt: 0, queue: Promise.resolve() };
      this._miners.set(minerId, e);
    }
    return e;
  }

  async load(minerId) {
    let raw;
    try {
      raw = await fs.readFile(this._file(minerId), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { ...DEFAULT_ENGINE_STATE };
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('state root is not an object');
      }
      return { ...DEFAULT_ENGINE_STATE, ...parsed };
    } catch (err) {
      const corrupt = `${this._file(minerId)}.corrupt-${Date.now()}`;
      await fs.rename(this._file(minerId), corrupt).catch(() => {});
      log(`corrupt state for ${minerId} (${err.message}); preserved as ${path.basename(corrupt)}, using defaults`);
      return { ...DEFAULT_ENGINE_STATE };
    }
  }

  // Debounced: at most one disk write per 5 s per miner; the latest state always wins.
  async save(minerId, state) {
    const e = this._entry(minerId);
    e.pending = JSON.parse(JSON.stringify(state));
    if (e.timer) return; // a write is already scheduled; it will pick up e.pending
    const wait = e.lastWriteAt + DEBOUNCE_MS - Date.now();
    if (wait <= 0) {
      await this._write(minerId, e);
    } else {
      e.timer = setTimeout(() => {
        e.timer = null;
        this._write(minerId, e).catch((err) => log(`deferred save failed for ${minerId}:`, err.message));
      }, wait);
      if (e.timer.unref) e.timer.unref();
    }
  }

  // Write all pending states immediately (shutdown / tests).
  async flush() {
    const writes = [];
    for (const [minerId, e] of this._miners) {
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      if (e.pending !== null) writes.push(this._write(minerId, e));
    }
    await Promise.all(writes);
  }

  _write(minerId, e) {
    e.queue = e.queue.then(async () => {
      const state = e.pending;
      if (state === null) return;
      e.pending = null;
      e.lastWriteAt = Date.now();
      const file = this._file(minerId);
      await fs.mkdir(this.dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state, null, 2));
      await fs.rename(tmp, file);
    });
    const result = e.queue;
    e.queue = e.queue.catch(() => {}); // keep the queue alive after a failure
    return result;
  }
}

module.exports = { StateStore, DEFAULT_ENGINE_STATE };
