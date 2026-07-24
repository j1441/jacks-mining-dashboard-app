// lib/engine.js — PURE decision engine (DESIGN §3).
// Single responsibility: given EngineInputs (snapshot, candidates, market, heat,
// settings, persisted EngineState) return a Decision — action (or null), state
// updates, a plain-language statusLine and a full trace. No I/O, no Date.now(),
// no randomness: decide() and buildPlan() are deterministic functions of inputs.
// Pipeline: safety > mode > tuning-hold > economics (hysteresis, dwells, one-time
// board-switch cost integral, heat-demand emergency for alt=none, dry-run overlay).
'use strict';

const PREFERRED_BOARD_ORDER = ['2', '1', '3']; // DESIGN §3.1 canonical order
const OFF_CANDIDATE = Object.freeze({ off: true, boards: 0, targetW: 0, hashrateThs: 0, wallW: 0 });
const SAFETY_RESUME_MARGIN_C = 5;   // resume below derateChipTemp - 5 (DESIGN §3.5)
const SAFETY_RESUME_HOLD_MIN = 5;   // ... held for >= 5 min
const CEILING_RAISE_EVERY_MIN = 30; // thermal ceiling rises at most once per 30 min
const HOUR_MS = 3600000;
const EPS = 1e-9;

// ---- small pure helpers ----------------------------------------------------

const fmt2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '?');
const fmt1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '?');
const plural = (n) => (n === 1 ? '' : 's');
const isoHHMM = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : String(iso));

function minutesBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return (b - a) / 60000;
}
// Minutes elapsed since `iso` at `nowIso`; a missing timestamp means "long ago".
const minutesSince = (iso, nowIso) => (iso ? minutesBetween(iso, nowIso) : Infinity);

// ---- statusLine template catalog (DESIGN §3.7) ------------------------------
// Plain language only: raw identifiers (dwell, deadband, envelope) never appear.

const STATUS_TEMPLATES = {
  'offline': {
    severity: 'warn',
    render: () => 'Miner unreachable — waiting for it to respond; no control actions until it does.',
  },
  'safety-pause': {
    severity: 'critical',
    render: (p) => `SAFETY: chip ${fmt1(p.chipTempC)} °C — paused. Resumes once it stays below ${p.resumeBelowC} °C.`,
  },
  'safety-derate': {
    severity: 'warn',
    render: (p) => `SAFETY: ${p.what} — power capped at ${p.targetW} W to cool things down.`,
  },
  'thermal-ceiling': {
    severity: 'warn',
    render: (p) => `Running capped at ${p.ceilingW} W — it got too hot earlier; the cap lifts gradually while temperatures stay low.`,
  },
  'tuner-tuning': {
    severity: 'ok',
    render: () => 'Tuner is optimising after the last change — holding steady until it settles.',
  },
  'tuner-error': {
    severity: 'warn',
    render: () => 'Tuner reported an error — holding steady; check the miner.',
  },
  'mode-manual': {
    severity: 'ok',
    render: (p) => (p.paused
      ? 'Manual mode — miner is paused; you are in control.'
      : `Manual mode — you are in control (${p.boards} board${plural(p.boards)} @ ${p.targetW} W).`),
  },
  'mode-off': {
    severity: 'ok',
    render: () => 'Off mode — miner is kept paused until you change mode.',
  },
  'paused-user': {
    severity: 'ok',
    render: () => 'Paused by you — automatic control will not restart it until you resume.',
  },
  'off-unprofitable': {
    severity: 'ok',
    render: (p) => `Off — mining unprofitable (price ${fmt2(p.price)} kr/kWh)`
      + (p.heatKW > 0 && p.altName
        ? `; your ${p.altName} covers the ${fmt1(p.heatKW)} kW of heat more cheaply.`
        : ' and no heat needed.')
      + (p.nextStartHour ? ` Next planned start: ${p.nextStartHour} (${fmt2(p.nextStartPrice)} kr/kWh).` : ''),
  },
  'off-dwell': {
    severity: 'ok',
    render: () => 'Off — just stopped; waiting briefly before restarting to avoid rapid on/off cycling.',
  },
  'starting': {
    severity: 'ok',
    render: (p) => `Starting — mining pays at ${fmt2(p.price)} kr/kWh; bringing up ${p.boards} board${plural(p.boards)} @ ${p.targetW} W.`,
  },
  'running': {
    severity: 'ok',
    render: (p) => `Mining with ${p.boards} board${plural(p.boards)} @ ${p.targetW} W — about ${fmt2(p.netNokH)} kr/h net`
      + (p.heatKW > 0 ? `, covering ${fmt1(p.heatKW)} kW of heat.` : '.'),
  },
  'keeping-on-margin': {
    severity: 'ok',
    render: (p) => `Running at a small loss (${fmt2(p.netNokH)} kr/h) — cheaper to ride it out than to stop and restart.`,
  },
  'holding-dwell': {
    severity: 'ok',
    render: (p) => `Holding ${p.boards} board${plural(p.boards)} @ ${p.targetW} W — recent change; letting things settle before adjusting again.`,
  },
  'holding-board-switch': {
    severity: 'ok',
    render: (p) => `Holding ${p.boards} board${plural(p.boards)} @ ${p.targetW} W — a board switch would cost more than it gains today.`,
  },
  'switching-boards': {
    severity: 'ok',
    render: (p) => `Changing to ${p.boards} board${plural(p.boards)} @ ${p.targetW} W — worth it for the hours ahead.`,
  },
  'heat-emergency': {
    severity: 'warn',
    render: (p) => `Heating override — no other heat source; running ${p.boards} board${plural(p.boards)} @ ${p.targetW} W to deliver ${fmt1(p.heatKW)} kW of heat.`,
  },
  'price-horizon-exhausted': {
    severity: 'warn',
    render: (p) => `Electricity prices for the coming hours are not published yet — assuming a high ${fmt2(p.price)} kr/kWh until they arrive.`,
  },
  'dry-run': {
    severity: 'ok',
    render: (p) => `Dry run: observing only — would have: ${p.wouldHave}.`,
  },
};

// statusLine(stateKey, params) -> string  (internal; exported for tests)
function statusLine(stateKey, params = {}) {
  const t = STATUS_TEMPLATES[stateKey];
  if (!t) return stateKey;
  return t.render(params);
}

// ---- objective (DESIGN §3.2) ------------------------------------------------

// scoreCandidate(c, {marginalPrice, hashpriceNokPerThDay, poolFeePct, heat}) -> ScoredCandidate
function scoreCandidate(c, { marginalPrice, hashpriceNokPerThDay, poolFeePct = 0, heat }) {
  const demandKW = heat ? (Number(heat.demandKW) || 0) : 0;
  const altPrice = heat ? (Number(heat.altPricePerKWh) || 0) : 0;
  const revenueNokH = (c.hashrateThs * (hashpriceNokPerThDay || 0) * (1 - poolFeePct)) / 24;
  const costNokH = (c.wallW / 1000) * marginalPrice;
  const heatValueNokH = Math.min(c.wallW / 1000, demandKW) * altPrice;
  return { ...c, revenueNokH, costNokH, heatValueNokH, scoreNokH: revenueNokH + heatValueNokH - costNokH };
}

function scoreAll(candidates, price, ctx) {
  const args = { marginalPrice: price, hashpriceNokPerThDay: ctx.hashpriceNokPerThDay, poolFeePct: ctx.poolFeePct, heat: ctx.heat };
  const scored = candidates.map((c) => scoreCandidate(c, args));
  scored.push(scoreCandidate(OFF_CANDIDATE, args));
  scored.sort((a, b) => b.scoreNokH - a.scoreNokH);
  return scored;
}

const onOnly = (scored) => scored.filter((c) => !c.off);
const bestAtCount = (scored, boards) => onOnly(scored).find((c) => c.boards === boards) || null; // list already sorted desc

// ---- board-switch one-time cost test (DESIGN §3.3) ---------------------------

// Advantage of running at `diffCount` instead of `sameCount`, integrated hour-by-hour
// over the remaining known day-ahead prices (current hour only if the horizon is
// short/empty). OFF (score 0) is a floor on both sides so hours where the miner
// would be off contribute nothing.
function boardSwitchAdvantage({ candidates, hours, currentPrice, diffCount, sameCount, ctx }) {
  const prices = (hours && hours.length) ? hours.map((h) => h.marginalPrice) : [currentPrice];
  let adv = 0;
  for (const p of prices) {
    const scored = scoreAll(candidates, p, ctx);
    const d = bestAtCount(scored, diffCount);
    const s = bestAtCount(scored, sameCount);
    adv += Math.max(0, d ? d.scoreNokH : 0) - Math.max(0, s ? s.scoreNokH : 0);
  }
  return adv;
}

// switchCostNok = (retuneMin/60) × max(0, incumbentScore − retuneScore) + wearNok,
// where retuneScore assumes zero hashing but full power draw (heat still credited).
function boardSwitchCost({ diffCand, incumbentScore, currentPrice, econ, ctx }) {
  const retune = scoreCandidate({ ...diffCand, hashrateThs: 0 }, {
    marginalPrice: currentPrice,
    hashpriceNokPerThDay: ctx.hashpriceNokPerThDay,
    poolFeePct: ctx.poolFeePct,
    heat: ctx.heat,
  }).scoreNokH;
  const bs = econ.boardSwitch || { retuneMin: 45, wearNok: 2 };
  return (bs.retuneMin / 60) * Math.max(0, incumbentScore - retune) + bs.wearNok;
}

// ---- board id selection ------------------------------------------------------

// Choose which board ids should be enabled for `wantCount`, preserving currently
// enabled boards first (no needless churn), then the canonical preferred order.
function desiredBoardIds(snapshot, settings, wantCount) {
  const allowed = (settings.limits && settings.limits.allowedBoards) || PREFERRED_BOARD_ORDER;
  const known = (snapshot.boards || []).map((b) => String(b.id));
  const enabled = (snapshot.boards || []).filter((b) => b.enabled).map((b) => String(b.id));
  const pref = PREFERRED_BOARD_ORDER.concat(known.filter((id) => !PREFERRED_BOARD_ORDER.includes(id)));
  const ranked = [
    ...pref.filter((id) => enabled.includes(id) && allowed.includes(id)),
    ...pref.filter((id) => !enabled.includes(id) && allowed.includes(id) && known.includes(id)),
  ];
  const desired = ranked.slice(0, wantCount);
  return {
    enableIds: desired.filter((id) => !enabled.includes(id)),
    disableIds: enabled.filter((id) => !desired.includes(id)),
  };
}

function describeAction(a) {
  if (!a) return 'no action';
  switch (a.type) {
    case 'PAUSE': return 'pause mining';
    case 'RESUME': return a.targetW ? `resume mining (heading for ${a.targetW} W)` : 'resume mining';
    case 'SET_POWER': return `set power target to ${a.targetW} W`;
    case 'SET_BOARDS': {
      const parts = [];
      if (a.enableIds && a.enableIds.length) parts.push(`enable board${plural(a.enableIds.length)} ${a.enableIds.join(',')}`);
      if (a.disableIds && a.disableIds.length) parts.push(`disable board${plural(a.disableIds.length)} ${a.disableIds.join(',')}`);
      if (a.targetW) parts.push(`set ${a.targetW} W`);
      return parts.join(' and ') || 'change boards';
    }
    default: return a.type;
  }
}

// ---- snapshot digest ----------------------------------------------------------

function readSnapshot(snapshot) {
  const boards = snapshot.boards || [];
  const maxOf = (vals) => {
    const xs = vals.filter((v) => Number.isFinite(v));
    return xs.length ? Math.max(...xs) : null;
  };
  const chipT = maxOf([
    ...boards.map((b) => b.chipTempC),
    snapshot.cooling && snapshot.cooling.highestTempC,
  ].map(Number));
  const boardT = maxOf(boards.map((b) => Number(b.boardTempC)));
  const fanMax = maxOf(((snapshot.cooling && snapshot.cooling.fans) || []).map((f) => Number(f.rpm)));
  const boardsOn = Number.isFinite(snapshot.boardsEnabledCount)
    ? snapshot.boardsEnabledCount
    : boards.filter((b) => b.enabled).length;
  const curTarget = (snapshot.tuner && Number(snapshot.tuner.targetW)) || 0;
  const paused = !!snapshot.paused;
  return {
    paused,
    boardsOn,
    curTarget,
    running: !paused && boardsOn > 0,
    chipT,
    boardT,
    fanMax,
    curWallW: Number.isFinite(Number(snapshot.wallW)) && snapshot.wallW !== null ? Number(snapshot.wallW) : null,
    tunerState: (snapshot.tuner && snapshot.tuner.state) || 'UNKNOWN',
  };
}

// Next hour in the known horizon where starting would clear the start margin.
function nextPlannedStart(inputs, ctx, econ) {
  const nowMs = Date.parse(inputs.now);
  for (const h of inputs.priceHours || []) {
    const t = Date.parse(h.hourStartIso);
    if (!Number.isFinite(t) || t <= nowMs) continue;
    const best = onOnly(scoreAll(inputs.candidates, h.marginalPrice, ctx))[0];
    if (best && best.scoreNokH > econ.startMarginNokH) {
      return { hour: isoHHMM(h.hourStartIso), price: h.marginalPrice };
    }
  }
  return null;
}

// ---- decide (DESIGN §3.2–§3.7) -------------------------------------------------

function decide(inputs) {
  const { now, snapshot, settings, state, market, heat } = inputs;
  const econ = settings.economics;
  const dwell = settings.dwell;
  const safety = settings.safety;
  const limits = settings.limits;

  const blockedBy = [];
  const reasons = [];
  const stateUpdates = {};

  // Effective price: within the published horizon use the marginal price; once the
  // horizon is exhausted substitute the pessimistic fallback (DESIGN §4.2).
  const horizonExhausted = !market.horizonCoversNow && market.fallbackPrice !== null && market.fallbackPrice !== undefined;
  const price = horizonExhausted ? market.fallbackPrice : market.marginalPrice;
  if (horizonExhausted) reasons.push(`price horizon exhausted — using pessimistic fallback ${fmt2(price)} kr/kWh`);

  const ctx = {
    hashpriceNokPerThDay: market.hashpriceNokPerThDay,
    poolFeePct: econ.poolFeePct || 0,
    heat,
  };
  const scored = scoreAll(inputs.candidates, price, ctx);
  const s = readSnapshot(snapshot);
  const curChosen = s.running ? { boards: s.boardsOn, targetW: s.curTarget } : { off: true };

  const trace = {
    ts: now,
    marginalPrice: price,
    regime: market.regime,
    hashpriceNokPerThDay: market.hashpriceNokPerThDay,
    heatDemandKW: heat.demandKW,
    candidatesTop: scored.slice(0, 6),
    chosen: curChosen,
    blockedBy,
    reasons,
  };

  const SEV = { info: 'ok', warn: 'warn', critical: 'critical' };
  const finish = (action, statusKey, statusParams, chosen) => {
    trace.chosen = chosen || curChosen;
    let key = statusKey;
    let params = statusParams || {};
    let updates = stateUpdates;
    let severity = (STATUS_TEMPLATES[key] || { severity: 'ok' }).severity;
    if (action && settings.dryRun) {
      // Never actuate in dry run: report the would-have action instead.
      const wouldHave = describeAction(action);
      reasons.push(`dry run: suppressed ${action.type} — would have: ${wouldHave}`);
      // Drop actuation-coupled state updates (nothing actually changed).
      updates = {};
      for (const [k, v] of Object.entries(stateUpdates)) {
        if (['thermalCeilingW', 'thermalCeilingRaisedAt', 'tuningHoldSince', 'safetyPauseClearSince'].includes(k)) updates[k] = v;
      }
      updates.dryRunActionCount = (state.dryRunActionCount || 0) + 1;
      severity = SEV[action.severity] || 'ok';
      key = 'dry-run';
      params = { wouldHave };
      action = null;
    }
    return {
      action,
      stateUpdates: updates,
      statusLine: statusLine(key, params),
      statusSeverity: severity,
      trace,
    };
  };

  // ---- 0) offline: never actuate blind -------------------------------------
  if (!snapshot.online) {
    blockedBy.push('miner offline');
    return finish(null, 'offline', {}, curChosen);
  }

  // ---- 1) safety (priority 0, all modes) ------------------------------------
  if (s.chipT !== null && s.chipT >= safety.pauseChipTemp && !s.paused) {
    stateUpdates.pausedBy = 'safety';
    stateUpdates.lastOffAt = now;
    stateUpdates.safetyPauseClearSince = null;
    reasons.push(`chip ${fmt1(s.chipT)} °C ≥ pause threshold ${safety.pauseChipTemp} °C`);
    return finish(
      { type: 'PAUSE', reason: `SAFETY: chip ${fmt1(s.chipT)} °C ≥ ${safety.pauseChipTemp} °C`, severity: 'critical' },
      'safety-pause',
      { chipTempC: s.chipT, resumeBelowC: safety.derateChipTemp - SAFETY_RESUME_MARGIN_C },
      { off: true },
    );
  }

  let pausedBy = state.pausedBy || null;
  if (s.paused && pausedBy === 'safety') {
    const cool = s.chipT !== null && s.chipT < safety.derateChipTemp - SAFETY_RESUME_MARGIN_C;
    const params = { chipTempC: s.chipT, resumeBelowC: safety.derateChipTemp - SAFETY_RESUME_MARGIN_C };
    if (!cool) {
      if (state.safetyPauseClearSince) stateUpdates.safetyPauseClearSince = null;
      blockedBy.push('safety pause');
      return finish(null, 'safety-pause', params, { off: true });
    }
    if (!state.safetyPauseClearSince) {
      stateUpdates.safetyPauseClearSince = now;
      blockedBy.push('safety pause');
      return finish(null, 'safety-pause', params, { off: true });
    }
    if (minutesBetween(state.safetyPauseClearSince, now) < SAFETY_RESUME_HOLD_MIN) {
      blockedBy.push('safety pause');
      return finish(null, 'safety-pause', params, { off: true });
    }
    // Cooled long enough: clear the safety pause; economics below decides restart.
    stateUpdates.pausedBy = null;
    stateUpdates.safetyPauseClearSince = null;
    pausedBy = null;
    reasons.push('safety pause cleared — chip cool for 5 min');
  }

  const hotChip = s.chipT !== null && s.chipT >= safety.derateChipTemp;
  const hotBoard = s.boardT !== null && s.boardT >= safety.maxBoardTemp;
  const hotFans = s.fanMax !== null && safety.maxFanRpm && s.fanMax >= safety.maxFanRpm;
  const hot = s.running && (hotChip || hotBoard || hotFans);
  const ceilNow = Number.isFinite(state.thermalCeilingW) ? state.thermalCeilingW : limits.maxTargetW;

  if (hot && !(s.curTarget > 0)) {
    // Tuner target unreadable this tick — a derate step computed from 0 would slam
    // the thermal ceiling to minimum. Hold; the pause path above still protects.
    blockedBy.push('hot but tuner target unknown — derate deferred');
    return finish(null, 'safety-derate', { what: 'tuner target unknown', targetW: null }, curChosen);
  }
  if (hot) {
    const what = hotChip ? `chip ${fmt1(s.chipT)} °C` : hotBoard ? `board ${fmt1(s.boardT)} °C` : 'fans at maximum';
    const newTarget = Math.max(limits.minTargetW, s.curTarget - safety.safetyStepW);
    const newCeil = Math.min(ceilNow, newTarget);
    stateUpdates.thermalCeilingW = newCeil; // latch: economics can't re-raise into a sawtooth
    stateUpdates.thermalCeilingRaisedAt = now; // first raise waits the full 30 min
    reasons.push(`safety derate: ${what}`);
    if (newTarget < s.curTarget) {
      stateUpdates.lastPowerChangeAt = now; // bypasses dwell but restarts it
      return finish(
        { type: 'SET_POWER', targetW: newTarget, reason: `SAFETY derate: ${what}`, severity: 'warn' },
        'safety-derate',
        { what, targetW: newTarget },
        { boards: s.boardsOn, targetW: newTarget },
      );
    }
    blockedBy.push('already at minimum power');
    return finish(null, 'safety-derate', { what, targetW: s.curTarget }, curChosen);
  }

  // Thermal ceiling recovery: +safetyStepW at most once per 30 min, only while
  // measurably cool and fans below max; clears at limits.maxTargetW.
  if (ceilNow < limits.maxTargetW) {
    const coolEnough = s.chipT !== null && s.chipT < safety.derateChipTemp - SAFETY_RESUME_MARGIN_C;
    const fansOk = !(s.fanMax !== null && safety.maxFanRpm && s.fanMax >= safety.maxFanRpm);
    if (coolEnough && fansOk && minutesSince(state.thermalCeilingRaisedAt, now) >= CEILING_RAISE_EVERY_MIN) {
      const next = Math.min(limits.maxTargetW, ceilNow + safety.safetyStepW);
      stateUpdates.thermalCeilingW = next;
      stateUpdates.thermalCeilingRaisedAt = next >= limits.maxTargetW ? null : now;
      reasons.push(`thermal ceiling raised to ${next} W`);
    } else {
      blockedBy.push(`thermalCeiling ${ceilNow}`);
    }
  }

  // ---- 2) mode ---------------------------------------------------------------
  if (settings.mode === 'off') {
    if (!s.paused) {
      // 'engine', not 'user': switching Off→Auto must let the optimizer resume
      // by itself, and only an explicit user pause blocks auto mode.
      stateUpdates.pausedBy = 'engine';
      stateUpdates.lastOffAt = now;
      return finish({ type: 'PAUSE', reason: 'mode is Off', severity: 'info' }, 'mode-off', {}, { off: true });
    }
    return finish(null, 'mode-off', {}, { off: true });
  }
  if (settings.mode === 'manual') {
    return finish(null, 'mode-manual', { paused: s.paused, boards: s.boardsOn, targetW: s.curTarget }, curChosen);
  }

  // auto mode: respect an explicit user pause
  if (s.paused && pausedBy === 'user') {
    blockedBy.push('paused by user');
    return finish(null, 'paused-user', {}, { off: true });
  }

  // ---- 3) tuning hold ----------------------------------------------------------
  // Only while actually running: a paused miner cannot be tuning — BOSer keeps
  // reporting a stale TUNING/PREHEAT indefinitely when a pause interrupts a
  // re-tune, which would deadlock auto control here (seen live 2026-07-24).
  // The hold defers *adjustments* (a change mid-tune restarts the tune) and
  // starts, but never a shutdown: with no reason to run, waiting out a 45-min
  // re-tune just burns power (also seen live 2026-07-24). The stop decision
  // falls through to economics below, guarded by `tuningHold`.
  let tuningHold = false;
  if (!s.paused && (s.tunerState === 'TUNING' || s.tunerState === 'PREHEAT')) {
    tuningHold = true;
    if (!state.tuningHoldSince) stateUpdates.tuningHoldSince = now;
    blockedBy.push('tuner tuning');
    if (!s.running) return finish(null, 'tuner-tuning', {}, curChosen); // never start mid-tune
  } else if (state.tuningHoldSince) stateUpdates.tuningHoldSince = null;
  if (s.tunerState === 'ERROR') {
    blockedBy.push('tuner error');
    return finish(null, 'tuner-error', {}, curChosen);
  }

  // ---- 4) economics --------------------------------------------------------------
  const onCands = onOnly(scored);
  const bestOn = onCands[0] || null;
  const demandKW = Number(heat.demandKW) || 0;
  const emergencyEligible = demandKW > 0 && heat.altType === 'none' && onCands.length > 0;

  // Heat-demand hard constraint (alt=none): cheapest-net ON candidate with
  // wallW/1000 >= min(demandKW, envelope max) — never compared against OFF.
  let emergencyPick = null;
  let requiredKW = 0;
  if (emergencyEligible) {
    const maxWallKW = Math.max(...onCands.map((c) => c.wallW)) / 1000;
    requiredKW = Math.min(demandKW, maxWallKW);
    const eligible = onCands.filter((c) => c.wallW / 1000 >= requiredKW - EPS);
    emergencyPick = eligible[0] || onCands.reduce((a, b) => (b.wallW > a.wallW ? b : a), onCands[0]);
  }

  // No usable price at all (fresh install with the feed down): never treat
  // electricity as free — hold current state, safety above still supervises.
  if (!Number.isFinite(price)) {
    blockedBy.push('no price data');
    return finish(null, 'price-horizon-exhausted', { price: null }, curChosen);
  }

  const offStatusKey = horizonExhausted ? 'price-horizon-exhausted' : 'off-unprofitable';
  const offStatusParams = () => {
    const next = nextPlannedStart(inputs, ctx, econ);
    const altName = heat.altType === 'heatpump' ? 'heat pump'
      : heat.altType === 'resistive' ? 'panel oven' : null;
    return {
      price, nextStartHour: next && next.hour, nextStartPrice: next && next.price,
      heatKW: demandKW, altName,
    };
  };

  if (!s.running) {
    // -- currently OFF ----------------------------------------------------------
    // Never (re)start a hot miner — covers a restart that lost the safety-pause
    // state while the chip is still above the resume threshold.
    if (s.chipT !== null && s.chipT >= safety.derateChipTemp - SAFETY_RESUME_MARGIN_C) {
      blockedBy.push(`chip ${fmt1(s.chipT)} °C too hot to start`);
      return finish(null, 'safety-pause',
        { chipTempC: s.chipT, resumeBelowC: safety.derateChipTemp - SAFETY_RESUME_MARGIN_C }, { off: true });
    }
    const startOk = bestOn && bestOn.scoreNokH > econ.startMarginNokH;
    const offDwellOk = minutesSince(state.lastOffAt, now) >= dwell.offMin;

    const startAction = (pick) => {
      stateUpdates.lastOnAt = now;
      stateUpdates.pausedBy = null;
      if (s.paused) {
        return { type: 'RESUME', targetW: pick.targetW, reason: `start: ${fmt2(pick.scoreNokH)} kr/h at ${pick.boards} board(s) @ ${pick.targetW} W`, severity: 'info' };
      }
      // online, not paused, but zero boards enabled: enable boards instead
      const ids = desiredBoardIds(snapshot, settings, pick.boards);
      stateUpdates.lastBoardsChangeAt = now;
      return { type: 'SET_BOARDS', boards: pick.boards, ...ids, targetW: pick.targetW, reason: `start: enable ${pick.boards} board(s) @ ${pick.targetW} W`, severity: 'info' };
    };

    if (emergencyEligible && !(startOk && offDwellOk)) {
      // would otherwise stay off/blocked -> heat-demand emergency start
      reasons.push('heat-demand emergency: heat needed and no alternative heat source');
      if (!offDwellOk) reasons.push('off-dwell overridden by heat emergency');
      const heatKW = Math.min(emergencyPick.wallW / 1000, demandKW);
      return finish(startAction(emergencyPick), 'heat-emergency',
        { boards: emergencyPick.boards, targetW: emergencyPick.targetW, heatKW },
        { boards: emergencyPick.boards, targetW: emergencyPick.targetW });
    }
    if (startOk && offDwellOk) {
      const pick = emergencyEligible ? emergencyPick : bestOn;
      reasons.push(`best candidate ${fmt2(pick.scoreNokH)} kr/h > start margin ${fmt2(econ.startMarginNokH)} kr/h`);
      return finish(startAction(pick), 'starting', { price, boards: pick.boards, targetW: pick.targetW },
        { boards: pick.boards, targetW: pick.targetW });
    }
    if (startOk && !offDwellOk) {
      blockedBy.push('off dwell');
      return finish(null, 'off-dwell', {}, { off: true });
    }
    reasons.push(bestOn
      ? `best candidate ${fmt2(bestOn.scoreNokH)} kr/h ≤ start margin ${fmt2(econ.startMarginNokH)} kr/h`
      : 'no viable operating point');
    return finish(null, offStatusKey, offStatusParams(), { off: true });
  }

  // -- currently ON ---------------------------------------------------------------
  const wantStop = !bestOn || bestOn.scoreNokH < -econ.keepMarginNokH;

  if (wantStop && !emergencyEligible) {
    stateUpdates.lastOffAt = now;
    stateUpdates.pausedBy = 'engine';
    if (tuningHold) reasons.push('shutdown allowed through tuning hold — nothing to wait for');
    reasons.push(bestOn
      ? `best candidate ${fmt2(bestOn.scoreNokH)} kr/h < keep margin −${fmt2(econ.keepMarginNokH)} kr/h`
      : 'no viable operating point');
    return finish(
      { type: 'PAUSE', reason: `stop: mining unprofitable at ${fmt2(price)} kr/kWh`, severity: 'info' },
      offStatusKey, offStatusParams(), { off: true },
    );
  }

  // Staying on and the tuner is mid-tune: defer any adjustment until it settles.
  if (tuningHold) return finish(null, 'tuner-tuning', {}, curChosen);

  // stay on: pick the operating point
  const emergencyForced = emergencyEligible && wantStop;
  if (emergencyForced) reasons.push('heat-demand emergency: staying on — no alternative heat source');

  let pick;
  let switching = false;
  const sameBest = bestAtCount(scored, s.boardsOn);
  if (emergencyEligible) {
    pick = emergencyPick;
    if (pick.boards !== s.boardsOn) {
      const sameEligible = onCands.filter((c) => c.boards === s.boardsOn && c.wallW / 1000 >= requiredKW - EPS);
      const boardsDwellOk = minutesSince(state.lastBoardsChangeAt, now) >= dwell.boardsMin;
      let allowSwitch = boardsDwellOk;
      if (allowSwitch && sameEligible.length && sameBest) {
        // both counts can meet demand: the switch must still pay for itself
        const adv = boardSwitchAdvantage({ candidates: inputs.candidates, hours: futureHours(inputs), currentPrice: price, diffCount: pick.boards, sameCount: s.boardsOn, ctx });
        const cost = boardSwitchCost({ diffCand: pick, incumbentScore: sameEligible[0].scoreNokH, currentPrice: price, econ, ctx });
        if (adv <= cost) {
          allowSwitch = false;
          blockedBy.push(`board switch advantage ${fmt2(adv)} kr ≤ cost ${fmt2(cost)} kr`);
        }
      } else if (!boardsDwellOk) {
        blockedBy.push('boards dwell');
      }
      if (allowSwitch) switching = true;
      // Fall back to the current board count; if it has no viable candidate at all,
      // hold (pick=null) — never SET_POWER with a different count's target.
      else pick = sameEligible[0] || (sameBest ? onCands.filter((c) => c.boards === s.boardsOn).reduce((a, b) => (b.wallW > a.wallW ? b : a)) : null);
    }
  } else {
    pick = sameBest;
    const diffBest = onCands.find((c) => c.boards !== s.boardsOn) || null;
    if (diffBest && (!sameBest || diffBest.scoreNokH > (sameBest ? sameBest.scoreNokH : -Infinity) + EPS)) {
      const boardsDwellOk = minutesSince(state.lastBoardsChangeAt, now) >= dwell.boardsMin;
      if (!sameBest) {
        // current count has no viable candidate (e.g. thermal ceiling) — must switch
        if (boardsDwellOk) { pick = diffBest; switching = true; } else { blockedBy.push('boards dwell'); pick = null; }
      } else {
        const adv = boardSwitchAdvantage({ candidates: inputs.candidates, hours: futureHours(inputs), currentPrice: price, diffCount: diffBest.boards, sameCount: s.boardsOn, ctx });
        const cost = boardSwitchCost({ diffCand: diffBest, incumbentScore: sameBest.scoreNokH, currentPrice: price, econ, ctx });
        if (adv <= cost) {
          blockedBy.push(`board switch advantage ${fmt2(adv)} kr ≤ cost ${fmt2(cost)} kr`);
        } else if (!boardsDwellOk) {
          blockedBy.push('boards dwell');
        } else {
          pick = diffBest;
          switching = true;
        }
      }
    }
  }

  if (!pick) {
    // nothing actionable at current count right now — hold as-is
    return finish(null, 'holding-dwell', { boards: s.boardsOn, targetW: s.curTarget }, curChosen);
  }

  const chosen = { boards: pick.boards, targetW: pick.targetW };
  const heatKW = Math.min(pick.wallW / 1000, demandKW);

  if (switching) {
    const ids = desiredBoardIds(snapshot, settings, pick.boards);
    stateUpdates.lastBoardsChangeAt = now;
    stateUpdates.lastPowerChangeAt = now;
    reasons.push(`board switch to ${pick.boards} passes one-time cost test`);
    const statusKey = emergencyForced ? 'heat-emergency' : 'switching-boards';
    return finish(
      { type: 'SET_BOARDS', boards: pick.boards, ...ids, targetW: pick.targetW, reason: `switch to ${pick.boards} board(s) @ ${pick.targetW} W`, severity: 'info' },
      statusKey, { boards: pick.boards, targetW: pick.targetW, heatKW }, chosen,
    );
  }

  const deltaW = Math.abs(pick.targetW - s.curTarget);
  if (deltaW >= dwell.deadbandW) {
    const powerDwellOk = minutesSince(state.lastPowerChangeAt, now) >= dwell.powerMin;
    const underDelivering = emergencyEligible && s.curWallW !== null && s.curWallW / 1000 + EPS < requiredKW;
    if (powerDwellOk || underDelivering) {
      if (!powerDwellOk && underDelivering) reasons.push('power dwell overridden by heat emergency (under-delivering heat)');
      stateUpdates.lastPowerChangeAt = now;
      const statusKey = emergencyForced ? 'heat-emergency' : 'running';
      return finish(
        { type: 'SET_POWER', targetW: pick.targetW, reason: `adjust to ${pick.targetW} W (${fmt2(pick.scoreNokH)} kr/h)`, severity: 'info' },
        statusKey, { boards: pick.boards, targetW: pick.targetW, netNokH: pick.scoreNokH, heatKW }, chosen,
      );
    }
    blockedBy.push('power dwell');
    return finish(null, 'holding-dwell', { boards: s.boardsOn, targetW: s.curTarget }, curChosen);
  }

  // steady state: no change needed
  const held = { boards: s.boardsOn, targetW: s.curTarget };
  if (emergencyForced) {
    return finish(null, 'heat-emergency', { boards: s.boardsOn, targetW: s.curTarget, heatKW }, held);
  }
  if (blockedBy.some((b) => b.startsWith('board switch advantage'))) {
    return finish(null, 'holding-board-switch', { boards: s.boardsOn, targetW: s.curTarget }, held);
  }
  const effCeil = ('thermalCeilingW' in stateUpdates) ? stateUpdates.thermalCeilingW : ceilNow;
  if (effCeil < limits.maxTargetW) {
    const maxSameCount = Math.max(...onCands.filter((c) => c.boards === s.boardsOn).map((c) => c.targetW));
    if (pick.targetW >= maxSameCount) {
      return finish(null, 'thermal-ceiling', { ceilingW: effCeil }, held);
    }
  }
  if (pick.scoreNokH < 0) {
    return finish(null, 'keeping-on-margin', { netNokH: pick.scoreNokH }, held);
  }
  return finish(null, 'running', { boards: s.boardsOn, targetW: s.curTarget, netNokH: pick.scoreNokH, heatKW }, held);
}

// Hours of the known horizon that are still ahead (incl. the in-progress hour).
function futureHours(inputs) {
  const nowMs = Date.parse(inputs.now);
  return (inputs.priceHours || []).filter((h) => {
    const t = Date.parse(h.hourStartIso);
    return Number.isFinite(t) && t + HOUR_MS > nowMs;
  });
}

// ---- buildPlan (DESIGN §3.4) ---------------------------------------------------
// Evaluates each known future hour with the same scorer, threading simulated
// dwell/switch state hour-to-hour so the plan never promises switch patterns the
// live loop would block. Display + input to the board-switch integral.

function buildPlan(inputs) {
  const { snapshot, settings, state, heat, market, now } = inputs;
  const econ = settings.economics;
  const dwell = settings.dwell;
  const ctx = { hashpriceNokPerThDay: market.hashpriceNokPerThDay, poolFeePct: econ.poolFeePct || 0, heat };
  const cands = inputs.candidates;
  const hours = futureHours(inputs);
  const s = readSnapshot(snapshot);
  const demandKW = Number(heat.demandKW) || 0;
  const emergency = demandKW > 0 && heat.altType === 'none' && cands.length > 0;

  const sim = {
    off: !s.running,
    boards: s.running ? s.boardsOn : 0,
    targetW: s.running ? s.curTarget : 0,
    minsBoards: minutesSince(state.lastBoardsChangeAt, now),
    minsOff: s.running ? Infinity : minutesSince(state.lastOffAt, now),
    minsPower: minutesSince(state.lastPowerChangeAt, now),
  };

  // nearest candidate at a board count to a held target (for scoring held points)
  const resolvePoint = (scoredOn, boards, targetW) => {
    const atCount = scoredOn.filter((c) => c.boards === boards);
    if (!atCount.length) return null;
    return atCount.reduce((a, b) => (Math.abs(b.targetW - targetW) < Math.abs(a.targetW - targetW) ? b : a));
  };

  const rows = [];
  for (let i = 0; i < hours.length; i++) {
    const h = hours[i];
    const price = h.marginalPrice;
    const scored = scoreAll(cands, price, ctx);
    const on = onOnly(scored);
    const bestOnH = on[0] || null;

    const trySwitch = (pick) => {
      // board-count change inside the plan obeys the rate limiter + cost test
      if (pick.boards === sim.boards) return pick;
      if (sim.minsBoards < dwell.boardsMin) return bestAtCount(scored, sim.boards) || pick;
      const sameB = bestAtCount(scored, sim.boards);
      if (sameB) {
        const adv = boardSwitchAdvantage({ candidates: cands, hours: hours.slice(i), currentPrice: price, diffCount: pick.boards, sameCount: sim.boards, ctx });
        const cost = boardSwitchCost({ diffCand: pick, incumbentScore: sameB.scoreNokH, currentPrice: price, econ, ctx });
        if (adv <= cost) return sameB;
      }
      sim.minsBoards = 0;
      return pick;
    };

    if (emergency) {
      const maxWallKW = Math.max(...on.map((c) => c.wallW)) / 1000;
      const requiredKW = Math.min(demandKW, maxWallKW);
      const eligible = on.filter((c) => c.wallW / 1000 >= requiredKW - EPS);
      let pick = eligible[0] || on.reduce((a, b) => (b.wallW > a.wallW ? b : a), on[0]);
      if (sim.off) {
        sim.off = false;
        if (pick.boards !== sim.boards) sim.minsBoards = 0;
      } else {
        pick = trySwitch(pick);
      }
      sim.boards = pick.boards;
      sim.targetW = pick.targetW;
    } else if (sim.off) {
      if (bestOnH && bestOnH.scoreNokH > econ.startMarginNokH && sim.minsOff >= dwell.offMin) {
        sim.off = false;
        if (bestOnH.boards !== sim.boards) sim.minsBoards = 0;
        sim.boards = bestOnH.boards;
        sim.targetW = bestOnH.targetW;
      }
    } else {
      if (!bestOnH || bestOnH.scoreNokH < -econ.keepMarginNokH) {
        sim.off = true;
        sim.minsOff = 0;
        sim.boards = 0;
        sim.targetW = 0;
      } else {
        let pick = bestAtCount(scored, sim.boards);
        const diffBetter = bestOnH.boards !== sim.boards && (!pick || bestOnH.scoreNokH > pick.scoreNokH + EPS);
        if (diffBetter) pick = trySwitch(bestOnH);
        if (pick) {
          // hour steps always satisfy the power dwell; deadband still applies
          if (Math.abs(pick.targetW - sim.targetW) >= dwell.deadbandW || pick.boards !== sim.boards) {
            sim.boards = pick.boards;
            sim.targetW = pick.targetW;
          }
        }
      }
    }

    let row;
    if (sim.off) {
      row = { boards: 0, targetW: 0, off: true, expScoreNokH: 0, expNetNokH: 0, expHeatKW: 0 };
    } else {
      const pt = resolvePoint(on, sim.boards, sim.targetW) || bestOnH;
      row = {
        boards: sim.boards,
        targetW: sim.targetW,
        off: false,
        expScoreNokH: pt ? pt.scoreNokH : 0,
        expNetNokH: pt ? pt.revenueNokH - pt.costNokH : 0,
        expHeatKW: pt ? Math.min(pt.wallW / 1000, demandKW) : 0,
      };
    }
    rows.push({ hourStartIso: h.hourStartIso, marginalPrice: price, regime: h.regime, ...row });

    sim.minsBoards += 60;
    if (sim.off) sim.minsOff += 60;
  }
  return rows;
}

module.exports = { decide, buildPlan, scoreCandidate, STATUS_TEMPLATES, statusLine };
