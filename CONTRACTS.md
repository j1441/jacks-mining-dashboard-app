# v2 Module Contracts (binding for implementation)

Read DESIGN.md first. This file pins the exact exported signatures and shared object
shapes. CommonJS (`module.exports`). Node 22. No new npm dependencies — only
`express`, `ws`, `@grpc/grpc-js`, `@grpc/proto-loader`, and Node builtins.
All timestamps ISO-8601 strings. All money NOK. All power watts. Hashrate TH/s.

## Shared shapes

```js
// MinerSnapshot (from minerClient.getSnapshot())
{
  ts, online: bool, paused: bool,             // paused from GetMinerDetails.status
  model: 'Antminer S19j Pro', minerStatus: 'NORMAL'|'PAUSED'|'…',
  boards: [{ id: '1', enabled: bool, hashing: bool, boardTempC: num|null,
             chipTempC: num|null, hashrateThs: num }],
  boardsEnabledCount: int, boardsHashingCount: int,
  tuner: { state: 'STABLE'|'TUNING'|'PREHEAT'|'ERROR'|'DISABLED'|'UNKNOWN', targetW: int },
  wallW: num|null,                            // GetMinerStats power_stats.approximated_consumption.watt
  cooling: { mode: 'auto'|'manual'|'immersion'|'unknown', fans: [{rpm, ratio}], highestTempC },
  pools: [{ url, user, active: bool, accepted, rejected }],
  hashrate: { m1, m15, h1, h24 },             // TH/s
  dps: { enabled: bool }|null,                // slow cadence, else last known
  constraints: { minTargetW: int, maxTargetW: int }|null,
  errors: [string],                           // transport/partial-read errors this tick
}

// Candidate (from envelope.candidates()) — also used inside traces
{ boards: int, targetW: int, hashrateThs: num, wallW: num }
// plus the OFF candidate: { off: true, boards: 0, targetW: 0, hashrateThs: 0, wallW: 0 }

// ScoredCandidate = Candidate + { revenueNokH, costNokH, heatValueNokH, scoreNokH }

// EngineInputs
{
  now,                                        // ISO string
  snapshot: MinerSnapshot,
  candidates: [Candidate],                    // already clamped incl. thermalCeilingW
  market: { marginalPrice: num, householdPrice: num, regime: 'subsidised'|'over-cap',
            hashpriceNokPerThDay: num, horizonCoversNow: bool,
            fallbackPrice: num|null },        // used when !horizonCoversNow
  priceHours: [{ hourStartIso, marginalPrice, householdPrice, regime }], // known horizon, for plan+switch integral
  heat: { demandKW: num, altType: 'heatpump'|'resistive'|'none', altPricePerKWh: num },
  settings: { mode, dryRun, economics: {poolFeePct, startMarginNokH, keepMarginNokH,
              boardSwitch: {retuneMin, wearNok}}, dwell: {powerMin, boardsMin, offMin, deadbandW},
              safety: {derateChipTemp, pauseChipTemp, maxBoardTemp, maxFanRpm, safetyStepW},
              limits: {minTargetW, maxTargetW, allowedBoards}, manual: {boards, targetW} },
  state: EngineState,
}

// EngineState (persisted via stateStore; engine treats as immutable input, returns updates)
{ lastPowerChangeAt: iso|null, lastBoardsChangeAt: iso|null, lastOffAt: iso|null,
  lastOnAt: iso|null, pausedBy: 'user'|'engine'|'safety'|null,
  thermalCeilingW: int, thermalCeilingRaisedAt: iso|null, tuningHoldSince: iso|null,
  safetyPauseClearSince: iso|null, dryRunActionCount: int }

// Decision (engine.decide return)
{
  action: null | { type: 'PAUSE'|'RESUME'|'SET_POWER'|'SET_BOARDS',
                   targetW?: int, boards?: int, enableIds?: [string], disableIds?: [string],
                   reason: string, severity: 'info'|'warn'|'critical' },
  stateUpdates: partial EngineState,      // controller merges + persists AFTER actuation succeeds
  statusLine: string, statusSeverity: 'ok'|'warn'|'critical',
  trace: { ts, marginalPrice, regime, hashpriceNokPerThDay, heatDemandKW,
           candidatesTop: [ScoredCandidate&{off?}] /* ≤6, sorted by score desc */,
           chosen: {boards,targetW}|{off:true}, blockedBy: [string], reasons: [string] },
}
```

## lib/envelope.js

```js
class Envelope {
  constructor({ minerId, dataDir, overheadW=80, perBoardMinW=397, perBoardMaxW=996,
                anchors=[{boardW:397, ths:13.17},{boardW:996, ths:34.7}] })
  async load() / async save()                     // envelope-<minerId>.json, atomic write
  predict(boards, targetW) -> {hashrateThs, wallW}
  candidates({limits, thermalCeilingW, allowedBoardsCount}) -> [Candidate] // grid 100W, clamps per DESIGN §3.1, dedup by wallW, + OFF appended by caller? NO: engine adds OFF itself
  learn(boards, targetW, {hashrateThs, wallW})    // EWMA α=0.3, bumps samples
  importProfiles(profiles, boardsActive)          // from listTunedProfiles
  stats() -> {learnedPoints:int, perBoardMinW, perBoardMaxW, overheadW}
}
module.exports = { Envelope }
```

## lib/engine.js  (PURE — no I/O, no Date.now(); everything from inputs)

```js
decide(inputs) -> Decision                        // full pipeline: safety > mode > tuning-hold > economics
buildPlan(inputs) -> [{ hourStartIso, marginalPrice, regime, boards, targetW, off: bool,
                        expScoreNokH, expNetNokH, expHeatKW }]   // threads dwell/switch state
scoreCandidate(c, {marginalPrice, hashpriceNokPerThDay, poolFeePct, heat}) -> ScoredCandidate
statusLine(...)  // internal; exported for tests: (stateKey, params) -> string
module.exports = { decide, buildPlan, scoreCandidate, STATUS_TEMPLATES }
```

Safety rules run even in manual/off modes. decide() must never return an action when
`settings.dryRun` — instead statusLine reflects "would have" and stateUpdates increments
`dryRunActionCount`. (Controller enforces too — defense in depth.)

## lib/market.js

```js
class Market {
  constructor({ configStore, history, fetchImpl })   // fetchImpl injectable for tests (default https)
  async start() / stop()                              // refresh loops: prices 30min, btc 5min, network 10min
  marginalPrice(dateIso, monthMinerKWh) -> num        // pure given loaded price data
  householdPrice(dateIso) -> num
  effectiveComponents(dateIso) -> {spot, vat, subsidy, gridFee, regime} // for UI/trace
  state() -> { today:[{hourStartIso, spotNok}], tomorrow:[...]|null, horizonEndsAt,
               currentMarginal, currentHousehold, regime, btcNok, btcUsd,
               hashpriceNokPerThDay, networkThs, fetchedAt, errors:[] }
  priceHours(monthMinerKWh) -> [{hourStartIso, marginalPrice, householdPrice, regime}]
}
module.exports = { Market, computeMarginalPrice /* pure fn exported for tests */ }
```

Timezone: use `Intl.DateTimeFormat(..., {timeZone: cfg.electricity.timezone})` helpers —
put `hourInTz(dateIso, tz)`, `weekdayInTz(dateIso, tz)`, `yyyymmddInTz` in market.js and
export them (frontend-independent). hvakosterstrommen URL:
`https://www.hvakosterstrommen.no/api/v1/prices/{YYYY}/{MM}-{DD}_{zone}.json`.
BTC: coingecko simple/price (usd,nok). Network: api.blockchain.info/stats.

## lib/minerClient.js

Signatures per DESIGN §4.1. Constructor loads protos once (module-level cache across
instances). Export `{ MinerClient, loadProtos }`. gRPC call pattern:
`client.Method(req, metadata, {deadline}, cb)`. Login via AuthenticationService.Login
`{username, password}` → token in `authorization` metadata. Read-back verification on
every write per DESIGN. Field-name traps documented in DESIGN §0 — follow exactly.
Use `test/fixtures/live-s19jpro.json` to shape parsing + unit-test parsers
(`parseHashboards`, `parseTunerState`, `parseMinerStats`, `parseCooling`,
`parseConfiguration` exported as pure functions taking raw gRPC JSON).

## lib/configStore.js / lib/stateStore.js

```js
class ConfigStore {
  constructor({dataDir}); async load() -> config    // migrate v1 per DESIGN §4.3; atomic saves; queue
  get() -> config; async update(partial) -> config  // deep-merge; validate; REDACT_SENTINEL='•••' fields ignored
  redacted() -> config                               // passwords/tokens replaced by REDACT_SENTINEL
  defaults() -> config
}
class StateStore {
  constructor({dataDir}); async load(minerId) -> EngineState (defaults if missing/corrupt)
  async save(minerId, state)                         // atomic, debounced ≤1 write/5s
}
module.exports = { ConfigStore, StateStore, DEFAULT_CONFIG, migrateV1, REDACT_SENTINEL }
```

## lib/controller.js

```js
class Controller {
  constructor({ minerCfg, client, envelope, market, engine, stateStore, history, alerts, wsHub, configStore })
  async start() / stop()               // tick every cfg.pollSeconds
  lastTickAt                            // heartbeat for watchdog + /health
  snapshotForApi() -> per-miner API object (see api shape)
  async userAction({type, ...})         // pause|resume|setPower|setBoards|goLive|dryRun
}
```

Tick: getSnapshot → build inputs (envelope.candidates with thermalCeilingW from state;
market.priceHours with month miner kWh from history) → engine.decide → if action and
!dryRun: append intent event FIRST, actuate, verify read-back, then merge+persist
stateUpdates; on verify failure → alert + event, do NOT persist dwell timestamps.
Feed envelope.learn when tuner STABLE && no actuation ≥10 min. Evaluate alert rules.
Push snapshot to wsHub every tick. Sample to history ≤1/min.

## lib/history.js

```js
class History {
  constructor({dataDir, retentionMonths=12})
  async appendSample(s) / appendEvent(e)             // events: {ts,id,type,severity,message,data?}
  async querySamples({fromIso,toIso,id,res:'raw'|'hour'}) -> rows
  async queryEvents({limit=100, severity?}) -> rows (newest first)
  async minerKWhThisMonth(id) -> num                 // integrate samples (wallW dt)
}
```

## lib/alerts.js

```js
class Alerts {
  constructor({configStore, history})
  async fire(ruleKey, {severity,title,message,minerId?})  // cooldown 30min per ruleKey+minerId
  async test()
  evaluate(controllerCtx)               // called per tick with snapshot/state/market
}
```

## lib/api.js / lib/wsHub.js

```js
createApi({configStore, controllers, market, history, alerts, version}) -> express.Router
// implements every route in DESIGN §5 exactly; /health checks controllers' lastTickAt
createWsHub(httpServer) -> { broadcast(obj), clientCount() }   // path /ws
```

Snapshot API object per miner:
```js
{ id, name, ip, online, mode, dryRun, statusLine, statusSeverity,
  hw: { model, boards, fans, chipTempMax, coolingMode, tunerState },
  power: { targetW, wallW }, roomTempC, hashrate, pool: { url, user, failoverActive, rejectRatePct },
  economics: { revenueNokH, costNokH, heatValueNokH, netNokH, netNokDay, effJPerTh, effectiveScop },
  controller: { trace, wouldHave: string|null, dryRunActionCount, migrationNotice: bool },
  plan: [...] }
```
Boards carry `inletTempC`/`outletTempC` (BOS `lowest_inlet_temp`/`highest_outlet_temp`);
`roomTempC` = min inlet across reporting boards, minus `heating.thermostat.idleOffsetC`
when every fan is stopped (see `estimateRoomTempC` in controller.js). Null when offline
or no board reports an inlet temp.

Top-level: `{ ts, version, market: market.state()+{regime},
heating: {demandKW, altType, altPricePerKWh, roomTempC, demandSource, thermostat:{targetC,bandC,maxKW}|null},
miners: [...], alerts: recent, events: tail(20) }` — top-level roomTempC is the min across
online miners. With demandSource 'thermostat', demandKW = clamp(maxKW·(targetC−roomTempC)/bandC, 0, maxKW),
and 0 whenever roomTempC is null (never heat blind; controller emits one
`thermostat-sensor-unavailable` warn event per outage).

## server.js

Wire order: configStore.load → history → market.start → per-miner (client, envelope.load,
stateStore.load, controller.start) → api + static + wsHub → watchdog (60s: any controller
lastTickAt older than 5min → CRITICAL event + direct alert + process.exit(1)) → SIGTERM
graceful stop. PORT env (default 3456), DATA_DIR env (default /data).

## public/ (frontend)

- `index.html`: keep v1's PWA head block (manifest, icons, apple-touch); load
  `vendor/react.production.min.js`, `vendor/react-dom.production.min.js`,
  `vendor/babel.min.js`, then `app/*.js` as `<script type="text/babel" data-presets="react">`.
- `vendor/`: download React 18.2.0 UMD prod, ReactDOM 18.2.0 UMD prod,
  babel-standalone 7.23.x from unpkg/cdnjs at build time (vendored into git).
- `sw.js`: kill-switch worker per DESIGN §2.
- `app/app.js`: root, tab router (Overview/Control/History/Settings), WS client
  (`(location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'`), reconnect w/
  backoff, `window.API` fetch helpers. State via React context.
- `app/ui.js`: Card, Stat, Badge, Toggle, NumberField, Select, Button, Section,
  Sparkline + BarStrip + LineChart (inline SVG, no libs), Modal, useApi hook.
- `app/overview.js`, `app/control.js`, `app/history.js`, `app/settings.js` per DESIGN §6.
- Visual language: dark (#0f1115 bg, #171a21 cards), accent #f7931a (bitcoin orange),
  ok #4ade80 / warn #fbbf24 / crit #f87171, system font stack, 8px radius, mobile-first
  single column that widens to grid ≥900px.

## Conventions

- Every module: header comment stating its single responsibility.
- No console.log spam: use small `log = (...a) => console.log('[module]', ...a)`.
- All fs writes atomic (tmp+rename). All JSON parse wrapped (corrupt → rename + defaults).
- Errors never crash the tick loop; they land in snapshot.errors / events.
- Tests use `node:test` + `node:assert/strict`; run with `npm test` (`node --test test/`).
- DO NOT touch: package.json, Dockerfile, umbrel-app.yaml, .github/ (owner: integrator).
```
