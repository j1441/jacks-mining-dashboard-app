# Mining Heater v2 — Design (rev B, post design-review)

A ground-up rebuild of Jack's Mining Dashboard. One idea drives everything:

> **The miner is a heater that pays you. Every hour, run it at the operating point that
> maximises (mining revenue + value of useful heat − marginal electricity cost), or turn
> it off if nothing beats zero.**

The controller must be able to *fully* control the miner — power target **and hashboard
count** (hashboards only tune down so far, so board count is what extends the true power
range) — and always be able to explain *why* it did what it did, in plain language.

Rev B incorporates a 26-agent design review (40 findings, 22 confirmed). Key corrections
vs rev A are marked ⚠ inline.

## 0. Ground truth (verified live 2026-07-05 against the real miner)

- Antminer S19j Pro, Braiins OS+ 25.11, gRPC `:50051` (login `root`/`root`),
  cgminer-compatible TCP `:4028` (reads only; `ascset` unsupported — v1's fatal flaw).
- Tuner constraints (from `ConfigurationService.GetConstraints`, read at startup — never
  hardcode): power target min **944 W**, max **6435 W**, default 3068 W. These are
  miner-level; the tuner distributes across enabled boards.
- ⚠ **Power target ≠ wall power.** Measured: target 944 W with 1 board → ~397 W board
  power, ~477 W wall. The envelope must model realized wall power as a learned function
  of (boards, targetW); never assume identity.
- Hashboards: 3 × BHB42601 (BM1362), toggled via `MinerService.EnableHashboards` /
  `DisableHashboards` (`{save_action: 'SAVE_ACTION_SAVE_AND_APPLY', hashboard_ids: ["1"]}`).
  Boards 1 & 3 are currently off (owner's summer heat management).
- Live wall-power approximation: `MinerService.GetMinerStats` →
  `power_stats.approximated_consumption.watt` (⚠ NOT GetTunerState, which only has the
  loaded profile's static estimate).
- Tuned profiles via `PerformanceService.ListTargetProfiles` (measured points:
  944 W target → 13.15 TH/s @ 397 W board). `GetMinerEfficiencyProfile` is UNIMPLEMENTED
  on this firmware. ⚠ Profiles carry no board-count field — tag imports with the board
  count active at import time.
- Cooling: miner is presently in MANUAL cooling mode with hot=65 °C, which pins fans at
  100 % (chip idles at 66 °C). v2 surfaces cooling mode; AUTO (target 60/hot 80/dangerous
  90) is the sane default for new setups. ⚠ In `GetMinerConfigurationResponse` the cooling
  config lives under field name `temperature`.
- DPS (firmware dynamic power scaling) is enabled (10 W step). It's a firmware-side safety
  backstop. ⚠ `SetDPSRequest`'s flag field is `enable` — not `enabled` like the response —
  and @grpc/proto-loader silently drops unknown request keys; **verify every write by
  reading back** (`GetMinerConfiguration().dps.enabled`).
- ⚠ Unit traps: `Power.watt` is uint64 (arrives as string with `longs: String`); hashrates
  are `gigahash_per_second` in most responses but TH/s in hashrate targets; chip temp is
  nested (`highest_chip_temp.temperature.degree_c`).
- `GetMinerStatus` is server-streaming — don't use it; derive `paused` from
  `GetMinerDetails.status` (`MINER_STATUS_PAUSED`/`NORMAL`/…).
- `MinerService.GetErrors` provides structured miner errors — feed alerts and dead-board
  detection.
- Electricity: hvakosterstrommen.no (hourly, per NO zone; tomorrow published ~13:00 Oslo).
- Test fixtures captured from the live miner: `test/fixtures/live-s19jpro.json`
  (all 8 gRPC calls + 5 cgminer commands).

## 1. Why rebuild (v1 post-mortem, keep these lessons)

1. Power control was silently broken for v1's entire life (`ascset` → "Invalid command",
   error swallowed, success reported). **Every actuation must be verified by read-back,
   and every failure surfaced.**
2. Three overlapping control systems, two config formats, 5,600-line server.js.
   **One control loop, one config schema, small modules.**
3. The controller couldn't touch hashboards → tiny real operating range.
4. No forecast execution, no decision transparency, no push alerts.

## 2. Architecture

Node 22 LTS (Docker `node:22-alpine`; Node 18 is EOL), CommonJS,
`"engines": {"node": ">=22"}`. **No new runtime dependencies** (express, ws,
@grpc/grpc-js, @grpc/proto-loader — already vendored). ⚠ React 18 + ReactDOM +
babel-standalone are **vendored into `public/vendor/`** and referenced relatively —
no CDN, UI loads with no internet (service workers can't cache CDN assets on the
insecure http://umbrel.local origin anyway).

⚠ PWA surface preserved: `public/manifest.json`, `public/icons/*`, apple-touch links
carry over so the phone-home-screen install keeps working. `public/sw.js` is replaced by
a ~10-line **kill-switch service worker** (install → skipWaiting; activate → unregister,
delete all caches, reload clients) so v1's cache-first worker can never serve the stale
v1 shell against the v2 API. v2 does no offline caching.

```
server.js              entry: config, module wiring, HTTP/WS, loops, watchdog
lib/
  minerClient.js       per-miner Braiins gRPC wrapper + cgminer TCP fallback reads
  market.js            prices (today+tomorrow), MARGINAL effective price (subsidy cap),
                       BTC price, network hashprice; refresh loops with backoff
  envelope.js          operating-envelope model (learned + fallback), candidates()
  engine.js            PURE decision logic (no I/O): decide(), buildPlan(), statusLine()
  controller.js        per-miner loop: snapshot → engine → actuate (verify!) → log
  configStore.js       atomic config.json load/save/validate; v1→v2 migration
  stateStore.js        per-miner runtime state persistence (dwells, ceilings, pausedBy)
  history.js           NDJSON samples + events (rotated), rollups, range queries
  alerts.js            rules, ntfy/Telegram/webhook dispatch, cooldowns
  api.js               REST routes + snapshot builder (redaction on GET and PUT)
  wsHub.js             WebSocket broadcast (same-origin URL derivation in client)
public/
  index.html           shell (PWA links preserved), loads vendor/ + app/*.js
  vendor/              react, react-dom, babel-standalone (vendored)
  app/                 app.js, ui.js, overview.js, control.js, history.js, settings.js
  sw.js                kill-switch worker;  manifest.json + icons/ carried from v1
test/
  engine.test.js, envelope.test.js, market.test.js, proto-roundtrip.test.js
  simulate.js          scenario simulator (see §7)
  fixtures/            live-s19jpro.json (captured), synthetic price days
proto/bos/v1/*.proto   full vendored set
```

Old `server.js`/`public/index.html` are replaced (git keeps v1 on its own branch).
Dockerfile: `node:22-alpine`, adds `COPY lib ./lib` and `COPY test ./test` (excluded from
image? no — keep image lean: tests run in CI, not shipped; only lib+public+proto+server.js).
Port stays 3456; same Umbrel app id (drop-in image swap).

## 3. The control engine

### 3.1 Operating envelope

Operating point = `(boards, targetW)`; `boards` = count (with a canonical preferred-ID
order, default [2,1,3] since board 2 is the currently-proven one) — plus the special
candidate **OFF**.

⚠ `envelope.predict(boards, targetW) → {hashrateThs, wallW}` models realized wall power:

1. **Learned points win** — `DATA_DIR/envelope-<minerId>.json`, keyed `${boards}:${targetW}`,
   `{hashrateThs, wallW, samples, updatedAt}`, EWMA-merged live samples + imports from
   `ListTargetProfiles` tagged with the board count active at import.
2. **Interpolation** between learned points at the same board count.
3. **Fallback:** `boardW = clamp((targetW − overheadW) / boards, perBoardMinW, perBoardMaxW)`,
   `wallW = boards × boardW + overheadW`; per-board hashrate linear between anchors
   (397 W → 13.17 TH measured; 996 W → 34.7 TH sticker), `overheadW = 80`,
   `perBoardMinW` seeded 397, `perBoardMaxW` seeded 996 — all refined from live data.

⚠ `envelope.candidates()` clamps targetW to
`[max(minTargetW, boards × perBoardMinW + overheadW), min(maxTargetW, boards × perBoardMaxW + overheadW)]`
(100 W grid), **drops candidates whose predicted wallW duplicates a lower-target
neighbor's** (no phantom moves), and clamps everything to the active `thermalCeilingW`
(§3.5).

**Learning gate** ⚠: samples are fed to `envelope.learn()` only when the tuner is in a
steady state (`TUNER_STATE_STABLE`) *and* no controller actuation happened for ≥ 10 min.
After every actuation the controller compares realized wall vs predicted and surfaces
> 15 % divergence in the trace and events log (v1's lesson: verify).

### 3.2 Objective

For each candidate `c` at **marginal** electricity price `p` (§4.2):

```
revenue(c)   = c.hashrateThs × hashpriceNokPerThDay × (1 − poolFeePct) / 24   [NOK/h]
cost(c)      = c.wallW / 1000 × p                                             [NOK/h]
usefulHeatKW = min(c.wallW / 1000, heatDemandKW)
heatValue(c) = usefulHeatKW × altHeatPricePerKWh                              [NOK/h]
score(c)     = revenue(c) + heatValue(c) − cost(c)                            [NOK/h]
score(OFF)   = 0
```

- `hashpriceNokPerThDay = blockReward × 144 / networkHashrateThs × btcPriceNok`.
- `altHeatPricePerKWh`: heat pump → `p_household / SCOP`; resistive → `p_household`.
  (`p_household` is the *subsidised* rate — the alt heater's kWh sit below the cap.)
- ⚠ `alt.type: "none"` means **no substitute heat source exists**, not "heat is
  worthless": when `heatDemandKW > 0` and alt is `none`, heat delivery is a **hard
  constraint** — the engine picks the cheapest-net ON candidate with
  `wallW/1000 ≥ min(heatDemandKW, envelope max)` instead of comparing against OFF.
  This is the explicit **heat-demand-emergency** state (enter: demand > 0 ∧ alt none ∧
  would otherwise be OFF/blocked; it overrides start hysteresis and off-dwell; exit:
  demand = 0 or alt/mode change; safety still wins). Surfaced in trace reasons.
- `heatDemandKW` from `heating.demand`: `off` (0), `manual` (fixed kW), or `schedule`
  (168-slot week grid, edited via presets — §6). External sensor source is a designed-in
  v2.1 hook.
- Negative price hours (real in Norway) are legal inputs: score just gets cheaper —
  covered by unit test.

Behaviors that fall out: cheap + profitable ⇒ full throttle; expensive + no heat need ⇒
OFF; heat needed ⇒ run sized to demand at lowest net cost, preferring the board count
whose efficient range brackets the demand.

### 3.3 Hysteresis, dwell, switch costs

- **Start/stop hysteresis:** if OFF, start only when `best.score > startMarginNokH` (0.50).
  If ON, stop only when best ON score `< −keepMarginNokH` (−0.20).
- **Power dwell:** `≥ powerDwellMin` (15) since last change and `|Δtarget| ≥ deadbandW` (100).
- ⚠ **Board switches use a one-time cost test, not a per-hour margin:**
  `switchCostNok = (retuneMin/60) × max(0, incumbentScore − retuneScore) + wearNok`
  with `economics.boardSwitch = {retuneMin: 45, wearNok: 2}`; `retuneScore` assumes zero
  hashing but full power draw (heat still credited) during re-tune. A board-count change
  is allowed only when the different-count candidate's advantage over the best same-count
  candidate, integrated hour-by-hour over the remaining known day-ahead prices (current
  hour only if the horizon is short), exceeds `switchCostNok`. The 120-min `boardsDwellMin`
  remains purely as a rate limiter.
- **Off dwell:** after going OFF, stay off `≥ offDwellMin` (20) — overridden only by the
  heat-demand emergency (§3.2) and never by economics.
- ⚠ **TUNING hold:** whenever `tuner.state` is TUNING or PREHEAT (automatic after any
  board/power actuation): envelope learning frozen, hashrate-low + dead-board alerts
  suppressed, economic actuation deferred (safety still runs every tick). Trace shows
  `blockedBy: "tuner tuning"`; alert if the hold exceeds 45 min or tuner reports ERROR.

⚠ **Runtime state** `{lastPowerChangeAt, lastBoardsChangeAt, lastOffAt, lastOnAt,
pausedBy, thermalCeilingW, tuningHoldSince}` is persisted in `DATA_DIR/state-<minerId>.json`
(via stateStore, atomic writes), **not** in config.json.

⚠ **Crash recovery:** on startup the miner is the source of truth — read boards/target/
paused via getSnapshot before any actuation; missing/implausible dwell timestamps
initialize to `now` (err toward longer dwell); the intended action is appended to
events.ndjson *before* each actuation so observed miner state is always explainable.
`pausedBy: 'safety'` is never trusted across restarts — safety state re-derives from
live temps.

### 3.4 Plan

`engine.buildPlan(pricesByHour, inputs)` evaluates each future hour with the same
candidate scorer, ⚠ threading simulated dwell/switch state hour-to-hour so the plan
doesn't promise switch patterns the live loop would block. The live tick still decides
from current data; plan is display + the input to the board-switch integral (§3.3).

### 3.5 Safety (priority 0, always wins)

- `chipTemp ≥ pauseChipTemp` (90) → PauseMining, CRITICAL alert.
  Resume only when `chipTemp < derateChipTemp − 5` for ≥ 5 min.
- `chipTemp ≥ derateChipTemp` (80) ∨ `boardTemp ≥ maxBoardTemp` (75) ∨ fan ≥ max →
  immediate step down by `safetyStepW` (250), bypassing dwell.
- ⚠ **Thermal ceiling latch:** each derate lowers per-miner `thermalCeilingW`
  (init `limits.maxTargetW`); all candidates clamp to it, so economics can't re-raise
  into a sawtooth. The ceiling rises by `safetyStepW` at most once per 30 min, only while
  `chipTemp < derateChipTemp − 5` and fans below max; clears at `limits.maxTargetW`.
  Active ceiling appears as `blockedBy: "thermalCeiling <W>"`.
- Miner unreachable → no actuation; alert after `offlineAfterS`.
- Board enabled but not hashing > 10 min (outside TUNING hold) → dead-board alert
  (also consult `MinerService.GetErrors`).
- ⚠ **Watchdog (process-level):** independent 60 s timer checks each controller's
  last-completed-tick heartbeat (a tick that finds the miner offline still counts);
  if > 5 min stalled → CRITICAL `controller-stalled` event, direct alert dispatch,
  `process.exit(1)` → docker `restart: on-failure` restarts the app. This is the real
  recovery path; Docker HEALTHCHECK is only `docker ps` cosmetics.

### 3.6 Modes & dry run

Per miner `mode: "auto" | "manual" | "off"`; `manual` exposes board toggles + target
slider (with envelope-predicted hashrate/heat readout) and quick presets mapping to v1's
Low/Medium/High watt values; safety still supervises all modes.

`dryRun` (default **true** for new installs *and* ⚠ for migrated v1 users — v2's engine
is new and must be observed first): controller logs full decisions/traces but performs no
actuation. ⚠ The Overview banner becomes an explicit dry-run state — "Dry run: observing
only — would have: enable boards 1,3 and set 3100 W", with a count of would-have actions,
and a **"Go live"** button that shows the first action the controller will take and
requires confirmation before clearing dryRun. Re-enter dry-run any time from Control.

### 3.7 Decision trace & status line

Each evaluation returns a trace (top candidates with revenue/cost/heatValue/score,
chosen, blockedBy, applied, priceRegime, reasons). Last 50 kept per miner; latest in
every snapshot; actions logged permanently with reasons.

⚠ Two layers of explanation:
- **statusLine** (server-built, plain language, fixed template catalog keyed by state,
  severity ok/warn/critical): e.g. "Off — mining unprofitable (price 1.86 kr/kWh) and no
  heat needed. Next planned start: 23:00 (0.62 kr/kWh)." / "Holding 1 board @ 944 W —
  board switch would cost more than it gains today." / "SAFETY: chip 91 °C — paused."
  Raw identifiers (dwell, deadband, envelope) never appear here.
- **"Why?" expander**: the full candidate table + blockedBy internals, for the curious.

## 4. Data & integrations

### 4.1 minerClient.js

```js
class MinerClient {
  constructor({id, ip, username, password, grpcPort=50051, cgminerPort=4028})
  async getSnapshot()   // {online, paused, details, boards:[{id, enabled, hashing, boardTempC,
                        //  chipTempC, hashrateThs}], tuner:{state, targetW}, wallW,  // ← GetMinerStats power_stats
                        //  cooling:{fans:[{rpm,ratio}], mode, highestTempC}, pools:[{url,user,active,accepted,rejected}],
                        //  hashrate:{m1,m15,h1,h24}, errors:[], constraints:{minTargetW,maxTargetW}}
  async setPowerTarget(watts)           // clamp via miner-reported range on OUT_OF_RANGE; read back
  async pause() / resume()
  async setBoards(enableIds, disableIds) // Enable/DisableHashboards SAVE_AND_APPLY; read back
  async listTunedProfiles()
  async setCoolingMode(cfg)              // read back via GetMinerConfiguration().temperature
  async setDps(enabled)                  // ⚠ request field is `enable`; read back .dps.enabled
  async close()
}
```

- gRPC per-tick fan-out: GetHashboards, GetTunerState, GetMinerStats, GetCoolingState,
  GetMinerDetails; GetMinerConfiguration + GetErrors on slow cadence (60 s).
  cgminer TCP only as fallback for hashrate/pools if gRPC degrades.
- Auth token cached; on UNAUTHENTICATED refresh **token only** — ⚠ clients/channels are
  created once per miner and reused for process lifetime (v1 leaked channels by
  recreating clients without close()); `close()` only on miner removal/shutdown.
- 10 s deadlines; snapshot degrades gracefully (partial + `errors[]`).
- ⚠ Every write verified by read-back; mismatch → actuation-failure event + alert.

### 4.2 market.js

```js
refreshPrices() / refreshBtc() / refreshNetwork()
marginalPrice(date, cfg, monthKWhSoFar)   // pure, unit-tested — the price the NEXT miner-kWh costs
householdPrice(date, cfg)                 // subsidised rate (for altHeatPrice)
state()  // {today[], tomorrow[]|null, horizonEndsAt, currentMarginal, currentHousehold,
         //  regime: 'subsidised'|'over-cap', btc, hashpriceNokPerThDay, fetchedAt}
```

⚠ **Marginal price with subsidy caps** (review blocker): strømstøtte and Norgespris only
subsidise the first `electricity.subsidyCapKWhMonth` (default 5000) kWh/month of household
consumption. market.js projects cumulative month consumption = configured
`electricity.householdBaseKWhMonth` (pro-rated) + metered miner kWh from history; when the
month is at/projected past the cap, **miner kWh price = raw spot(+VAT) + grid fee, no
subsidy**. Active regime goes into trace + plan rows. Both regimes unit-tested.
(Capacity tariffs / effekttrinn are v2.1; mitigation today = `limits.maxTargetW`.)

⚠ **Timezone:** all hour-of-day / weekday derivations (grid-fee windows, 7×24 schedule
index, the ≥13:00 tomorrow gate) computed via `Intl.DateTimeFormat` with configured
`electricity.timezone` (default "Europe/Oslo") — never bare `getHours()` (container runs
UTC). Tests cover CET↔CEST DST days incl. 23/25-entry price arrays.

⚠ **Failure policy — horizon, not fetch age:** a price is valid for the current hour iff
the hour lies within the published day-ahead horizon, regardless of fetch age; fetch
failures only alert. Only when the horizon is exhausted does `staleAction` apply:
default = substitute a pessimistic fallback (max effective price over trailing 48 h)
into the normal objective — heat-driven operation continues, pure-profit mining
naturally pauses. No blanket forbid-start.

### 4.3 configStore.js — config schema v2

```json
{
  "version": 2,
  "electricity": {"country": "norway", "zone": "NO5", "timezone": "Europe/Oslo",
    "priceMode": "spot_stromstotte",
    "gridFee": {"dayWeekday": 0.50, "nightWeekend": 0.30, "dayStartHour": 6, "nightStartHour": 22},
    "householdBaseKWhMonth": 1500, "subsidyCapKWhMonth": 5000},
  "heating": {"demandSource": "off", "manualKW": 0, "schedule": null,
    "presets": [{"name": "Off", "kw": 0}, {"name": "Eco", "kw": 1.0}, {"name": "Comfort", "kw": 2.5}],
    "alt": {"type": "heatpump", "scop": 3.0}},
  "economics": {"poolFeePct": 0, "startMarginNokH": 0.5, "keepMarginNokH": 0.2,
                "boardSwitch": {"retuneMin": 45, "wearNok": 2}},
  "alerts": {"ntfy": {"url": "", "topic": ""}, "telegram": {"botToken": "", "chatId": ""},
             "rules": {"offlineAfterS": 300, "hashrateLowPct": 25}},
  "miners": [{
    "id": "s19j4", "ip": "192.168.1.89", "name": "S19j Pro",
    "username": "root", "password": "root",
    "mode": "auto", "dryRun": true,
    "manual": {"boards": 1, "targetW": 944},
    "limits": {"minTargetW": 944, "maxTargetW": 3500, "allowedBoards": ["1", "2", "3"]},
    "dwell": {"powerMin": 15, "boardsMin": 120, "offMin": 20, "deadbandW": 100},
    "safety": {"derateChipTemp": 80, "pauseChipTemp": 90, "maxBoardTemp": 75,
               "maxFanRpm": 6100, "safetyStepW": 250},
    "cooling": {"manage": false, "mode": "auto", "targetC": 60},
    "dpsManage": "leave"
  }],
  "ui": {"currency": "NOK"},
  "pollSeconds": 10
}
```

⚠ **Atomicity & corruption:** in-memory config is the source of truth; saves serialize
through one queue; write `config.json.tmp` then atomic rename. On boot, unparseable
config → rename to `config.corrupt-<ts>.json`, alert, start with defaults in dryRun —
never overwrite the original. Runtime state lives in stateStore, so config.json changes
only on user edits.

**Migration (v1 → v2):** file without `version` = v1. Copy miners (ip/name/creds), zone/
country/gridFee/priceMode; v1 `autoControl.price.enabled` → mode `auto`, else `manual`
(current target); map safety numbers. ⚠ Migrated miners always get `dryRun: true`; a
MIGRATION event is logged and the Overview banner shows a persistent notice ("v2 has a
new control engine; it is planning but NOT adjusting your miner — review, then Go live")
until dryRun is first disabled. Backup written to `config.v1.backup.json`. Unknown keys
preserved under `_v1`.

### 4.4 history.js

- `DATA_DIR/history/samples-YYYY-MM.ndjson` — ≤ 1 line/min/miner:
  `{ts, id, hr, wallW, targetW, boards, chipT, priceMarginal, regime, netNokH}`.
- `DATA_DIR/history/events-YYYY-MM.ndjson` ⚠ (monthly files, not one unbounded file) —
  actions (with reasons), alerts, config changes, migrations.
- Rollups on demand; months pruned after `retentionMonths` (12).

### 4.5 alerts.js

Rules (evaluated in controller tick except watchdog): offline, hashrate < expected×(1−pct)
for 10 min outside TUNING hold, dead board, safety events, failover pool active, price
horizon exhausted, actuation verify-failure, controller stalled (from watchdog, direct
dispatch). Channels: ntfy POST, Telegram sendMessage, webhook. Per-rule cooldown 30 min.
All alerts also land in events + UI bell.

## 5. HTTP/WS API

```
GET  /api/state            snapshot: market(+regime), heating, miners[{hw, power, hashrate,
                           pool, economics{revenue,cost,heatValue,net}, controller{mode,dryRun,
                           statusLine,severity,trace,wouldHave}, plan}], alerts, events tail
WS   /ws                   same snapshot every tick (client uses same-origin URL derivation)
GET  /api/config           redacted (passwords/tokens → "•••")
PUT  /api/config           deep-merge partial; ⚠ fields matching the redaction sentinel are
                           ignored (no clobbering secrets on round-trip); validate; persist
GET  /api/miners/:id/plan
GET  /api/miners/:id/trace
GET  /api/miners/:id/envelope
POST /api/miners/:id/action    {type: pause|resume|setPower|setBoards|goLive|dryRun}
                               (user events; auto mode blocks manual power/board unless force)
GET  /api/history?from&to&res=hour|raw&id=
GET  /api/events?limit&severity
POST /api/alerts/test
GET  /health               ⚠ 200 only if every enabled controller ticked within
                           max(60s, 5×pollSeconds); else 503 (Dockerfile HEALTHCHECK target)
```

## 6. Frontend — 4 tabs (Plan folds into Overview)

1. **Overview** — statusLine banner (severity-colored; dry-run state with would-have
   action + count + **Go live** button; migration notice); hero stats (hashrate, wall W
   = heat output, net NOK/day, marginal price now + regime chip); 48 h price strip with
   plan overlay, expandable to the full plan table (price, boards, target, expected net —
   totals row); miner card with 3 board slots (green hashing / grey off / red fault),
   temps, fans, pool + failover badge; effective-SCOP stat (v1 feature kept: heat cost vs
   heat pump).
2. **Control** — mode selector (Auto/Manual/Off, confirmation on change); heat demand
   editor (off / manual kW / weekly schedule — ⚠ paint-based: user defines ≤ 4 named kW
   presets, paints the 7×24 grid, copy-day + weekday/weekend shortcuts; persisted as the
   plain 168-slot array); manual panel (board toggles + power slider with predicted
   hashrate/heat readout + Low/Med/High presets); dry-run toggle.
3. **History** — range picker; charts (hashrate, power vs price, net NOK/h — inline SVG,
   no chart lib); events feed with severity filter.
4. **Settings** — miner connection + test; electricity (zone/mode/fees/timezone/household
   baseline + cap); alerts (+ test button); data retention; ⚠ collapsed **Advanced
   tuning** section (economics margins, board-switch cost, pool fee, alt-heat + SCOP,
   cooling mode, DPS policy, dwells/deadband, safety temps) with defaults shown beside
   each field and one-click reset.

WS client auto-reconnects; disconnected ⇒ grey "reconnecting…" banner (distinct from
miner-offline).

## 7. Testing

- `engine.test.js` — objective math (incl. negative prices), hysteresis transitions,
  dwell blocking, one-time board-switch cost test, heat-demand emergency (alt none),
  thermal-ceiling latch (no sawtooth), TUNING hold, stale-horizon fallback, plan/live
  consistency (threaded state).
- `envelope.test.js` — predict (learned/interp/fallback), wallW≠target modeling,
  candidate clamps + duplicate dropping, EWMA learn, profile import tagging.
- `market.test.js` — marginal vs household price across the subsidy cap; Norgespris;
  grid-fee windows in Europe/Oslo from a UTC process; DST days (23/25-hour arrays);
  tomorrow-gate at 13:00 Oslo.
- `proto-roundtrip.test.js` ⚠ — serialize each minerClient request against loaded protos
  and assert every key survives (catches `enable` vs `enabled` traps).
- `simulate.js` — scenarios: (a) summer profit day (cheap night full throttle, expensive
  evening off), (b) winter heating week with schedule, (c) volatile prices → < 6
  actions/day, (d) price-feed outage, (e) heat demand + unprofitable mining (sized to
  demand), (f) winter spike with alt=none (never off while demand > 0), (g) hot-room
  derate (no sawtooth). Prints timelines, asserts, runs via `npm test`.
- Live verification: dry-run against the real miner; then a short real actuation window
  (power ±100 W, board 3 enable→disable) with automatic restore.

## 8. Delivery

Version 2.0.0 on branch `v2`. Dockerfile → node:22-alpine + lib/. README rewritten
(what it does, the objective function in plain language, config reference, migration
notes, deploy steps). Umbrel release notes describe automatic migration + dry-run start.
