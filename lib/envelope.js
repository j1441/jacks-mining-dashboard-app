// lib/envelope.js — operating-envelope model for one miner.
// Single responsibility: predict realized {hashrateThs, wallW} for an operating point
// (boards, targetW) from learned data (EWMA-merged live samples + imported tuned
// profiles), interpolation, or the seeded fallback formula (DESIGN §3.1); and generate
// the clamped, deduplicated ON-candidate grid for the engine. Persisted per miner as
// DATA_DIR/envelope-<minerId>.json with atomic tmp+rename writes; a corrupt file is
// renamed aside and the envelope starts empty.
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const GRID_W = 100; // candidate target grid (DESIGN §3.1)
const EWMA_ALPHA = 0.3; // weight of the newest sample when merging (CONTRACTS)

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (v) => Math.round(v * 1000) / 1000;

class Envelope {
  constructor({
    minerId,
    dataDir,
    overheadW = 80,
    perBoardMinW = 397,
    perBoardMaxW = 996,
    anchors = [{ boardW: 397, ths: 13.17 }, { boardW: 996, ths: 34.7 }],
  } = {}) {
    this.minerId = minerId;
    this.dataDir = dataDir || '.';
    this.overheadW = overheadW;
    this.perBoardMinW = perBoardMinW;
    this.perBoardMaxW = perBoardMaxW;
    this.anchors = anchors.slice().sort((a, b) => a.boardW - b.boardW);
    // learned points keyed `${boards}:${targetW}` -> {hashrateThs, wallW, samples, updatedAt}
    this.points = {};
  }

  get filePath() {
    return path.join(this.dataDir, `envelope-${this.minerId}.json`);
  }

  // ---- persistence -------------------------------------------------------

  async load() {
    let raw;
    try {
      raw = await fsp.readFile(this.filePath, 'utf8');
    } catch (err) {
      return this; // missing (or unreadable) file → start empty
    }
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || typeof data.points !== 'object') {
        throw new Error('bad shape');
      }
      const pts = {};
      for (const [key, p] of Object.entries(data.points || {})) {
        const hashrateThs = toNum(p && p.hashrateThs);
        const wallW = toNum(p && p.wallW);
        if (hashrateThs === null || wallW === null) continue;
        pts[key] = {
          hashrateThs,
          wallW,
          samples: toNum(p.samples) || 1,
          updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : null,
        };
      }
      this.points = pts;
      // restore refined bounds (only trust sane numbers)
      const minW = toNum(data.perBoardMinW);
      const maxW = toNum(data.perBoardMaxW);
      if (minW !== null && minW > 0) this.perBoardMinW = minW;
      if (maxW !== null && maxW >= this.perBoardMinW) this.perBoardMaxW = maxW;
    } catch (err) {
      // corrupt file: move it aside (best effort) and start empty
      try {
        await fsp.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch (_) { /* best effort */ }
      this.points = {};
    }
    return this;
  }

  async save() {
    const tmp = `${this.filePath}.tmp`;
    const body = JSON.stringify({
      version: 1,
      minerId: this.minerId,
      overheadW: this.overheadW,
      perBoardMinW: this.perBoardMinW,
      perBoardMaxW: this.perBoardMaxW,
      points: this.points,
    }, null, 1);
    await fsp.mkdir(this.dataDir, { recursive: true });
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, this.filePath);
  }

  // ---- prediction --------------------------------------------------------

  // Per-board hashrate: linear through the two anchors (extends linearly at the
  // edges; boardW is normally already clamped to [perBoardMinW, perBoardMaxW]).
  _boardThs(boardW) {
    const [a, b] = [this.anchors[0], this.anchors[this.anchors.length - 1]];
    if (b.boardW === a.boardW) return a.ths;
    const slope = (b.ths - a.ths) / (b.boardW - a.boardW);
    return Math.max(0, a.ths + (boardW - a.boardW) * slope);
  }

  _fallback(boards, targetW) {
    const boardW = clamp((targetW - this.overheadW) / boards, this.perBoardMinW, this.perBoardMaxW);
    return {
      hashrateThs: round3(boards * this._boardThs(boardW)),
      wallW: Math.round(boards * boardW + this.overheadW),
    };
  }

  _learnedAtCount(boards) {
    const prefix = `${boards}:`;
    const rows = [];
    for (const [key, p] of Object.entries(this.points)) {
      if (!key.startsWith(prefix)) continue;
      const targetW = toNum(key.slice(prefix.length));
      if (targetW === null) continue;
      rows.push({ targetW, ...p });
    }
    rows.sort((a, b) => a.targetW - b.targetW);
    return rows;
  }

  // predict(boards, targetW) -> {hashrateThs, wallW}
  // 1) exact learned point  2) linear interpolation between learned points at the
  // same board count  3) fallback formula (DESIGN §3.1).
  predict(boards, targetW) {
    const exact = this.points[`${boards}:${targetW}`];
    if (exact) return { hashrateThs: round3(exact.hashrateThs), wallW: Math.round(exact.wallW) };

    const rows = this._learnedAtCount(boards);
    if (rows.length >= 2) {
      let lo = null;
      let hi = null;
      for (const r of rows) {
        if (r.targetW <= targetW) lo = r;
        if (r.targetW >= targetW && hi === null) hi = r;
      }
      if (lo && hi && lo.targetW !== hi.targetW) {
        const f = (targetW - lo.targetW) / (hi.targetW - lo.targetW);
        return {
          hashrateThs: round3(lo.hashrateThs + f * (hi.hashrateThs - lo.hashrateThs)),
          wallW: Math.round(lo.wallW + f * (hi.wallW - lo.wallW)),
        };
      }
    }
    return this._fallback(boards, targetW);
  }

  // ---- candidate grid ----------------------------------------------------

  // candidates({limits, thermalCeilingW, allowedBoardsCount}) -> [Candidate]
  // For each board count 1..allowedBoardsCount, targetW clamped to
  // [max(minTargetW, boards*perBoardMinW+overheadW), min(maxTargetW, boards*perBoardMaxW+overheadW)]
  // and to the active thermalCeilingW, on a 100 W grid; candidates whose predicted
  // wallW duplicates a lower-target neighbor's are dropped (no phantom moves).
  // The OFF candidate is NOT included — the engine adds it itself.
  candidates({ limits, thermalCeilingW, allowedBoardsCount } = {}) {
    const minT = toNum(limits && limits.minTargetW) ?? 0;
    const maxT = toNum(limits && limits.maxTargetW) ?? Infinity;
    const ceil = (toNum(thermalCeilingW) !== null && thermalCeilingW > 0) ? thermalCeilingW : Infinity;
    const maxBoards = Math.max(1, Math.floor(toNum(allowedBoardsCount) ?? 1));
    const out = [];
    for (let b = 1; b <= maxBoards; b++) {
      const lo = Math.round(Math.max(minT, b * this.perBoardMinW + this.overheadW));
      const hi = Math.floor(Math.min(maxT, b * this.perBoardMaxW + this.overheadW, ceil));
      if (lo > hi) continue;
      const targets = [lo];
      for (let w = Math.ceil(lo / GRID_W) * GRID_W; w <= hi; w += GRID_W) {
        if (w !== lo) targets.push(w);
      }
      if (!targets.includes(hi)) targets.push(hi);
      targets.sort((x, y) => x - y);
      let prevWall = null;
      for (const t of targets) {
        const p = this.predict(b, t);
        const w = Math.round(p.wallW);
        if (prevWall !== null && w === prevWall) continue; // duplicate of lower-target neighbor
        prevWall = w;
        out.push({ boards: b, targetW: t, hashrateThs: p.hashrateThs, wallW: p.wallW });
      }
    }
    return out;
  }

  // ---- learning ----------------------------------------------------------

  _merge(key, hashrateThs, wallW) {
    const cur = this.points[key];
    if (cur) {
      cur.hashrateThs = round3(cur.hashrateThs + EWMA_ALPHA * (hashrateThs - cur.hashrateThs));
      cur.wallW = Math.round(cur.wallW + EWMA_ALPHA * (wallW - cur.wallW));
      cur.samples += 1;
      cur.updatedAt = new Date().toISOString();
      return cur;
    }
    const p = { hashrateThs: round3(hashrateThs), wallW: Math.round(wallW), samples: 1, updatedAt: new Date().toISOString() };
    this.points[key] = p;
    return p;
  }

  _refineBounds(boards, wallW) {
    const boardW = (wallW - this.overheadW) / boards;
    if (!Number.isFinite(boardW) || boardW <= 0) return;
    if (boardW < this.perBoardMinW) this.perBoardMinW = Math.round(boardW);
    if (boardW > this.perBoardMaxW) this.perBoardMaxW = Math.round(boardW);
  }

  // learn(boards, targetW, {hashrateThs, wallW}) — EWMA α=0.3, bumps samples.
  learn(boards, targetW, sample) {
    const b = toNum(boards);
    const t = toNum(targetW);
    const hr = toNum(sample && sample.hashrateThs);
    const w = toNum(sample && sample.wallW);
    if (b === null || b < 1 || t === null || hr === null || w === null || w <= 0) return null;
    this._refineBounds(b, w);
    return this._merge(`${Math.round(b)}:${Math.round(t)}`, hr, w);
  }

  // importProfiles(profiles, boardsActive) — from minerClient.listTunedProfiles().
  // Accepts normalized {targetW, hashrateThs, wallW} entries or raw BOS gRPC
  // power-target-profile entries (target.watt, measured_hashrate.gigahash_per_second,
  // estimated_power_consumption.watt = board power, so wall = est + overheadW).
  // Profiles carry no board-count field — every import is tagged with boardsActive.
  importProfiles(profiles, boardsActive) {
    const list = Array.isArray(profiles) ? profiles
      : (profiles && Array.isArray(profiles.power_target_profiles)) ? profiles.power_target_profiles
        : [];
    const b = Math.round(toNum(boardsActive) ?? 0);
    if (b < 1) return 0;
    let imported = 0;
    for (const p of list) {
      if (!p) continue;
      const targetW = toNum(p.targetW) ?? toNum(p.target && p.target.watt);
      const ghs = toNum(p.measured_hashrate && p.measured_hashrate.gigahash_per_second);
      const hashrateThs = toNum(p.hashrateThs) ?? (ghs !== null ? ghs / 1000 : null);
      const estW = toNum(p.estimatedW) ?? toNum(p.boardW)
        ?? toNum(p.estimated_power_consumption && p.estimated_power_consumption.watt);
      const wallW = toNum(p.wallW) ?? (estW !== null ? estW + this.overheadW : null);
      if (targetW === null || targetW <= 0 || hashrateThs === null || wallW === null || wallW <= 0) continue;
      this._merge(`${b}:${Math.round(targetW)}`, hashrateThs, wallW);
      imported += 1;
    }
    return imported;
  }

  stats() {
    return {
      learnedPoints: Object.keys(this.points).length,
      perBoardMinW: this.perBoardMinW,
      perBoardMaxW: this.perBoardMaxW,
      overheadW: this.overheadW,
    };
  }
}

module.exports = { Envelope };
