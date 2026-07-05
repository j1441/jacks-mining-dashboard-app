# Mining Heater

Runs a Braiins OS Antminer as a **home heater that pays you**. Every poll tick the
controller evaluates every operating point the miner supports — each hashboard count ×
power target, plus OFF — and picks the one that maximises:

```
mining revenue  +  value of useful heat  −  marginal electricity cost     [NOK/h]
```

- **Mining revenue** comes from live network hashprice (difficulty + BTC price in NOK).
- **Value of useful heat** is what the heat would have cost from your alternative
  (heat pump at your SCOP, resistive, or "none" — in which case heat demand becomes a
  hard constraint and the miner never turns off while heat is needed).
- **Marginal electricity cost** is the real Norwegian price for the *next* kWh:
  hourly spot (+VAT except NO4) with strømstøtte or Norgespris — including the monthly
  subsidy cap: once your household passes ~5000 kWh in a month, miner-kWh are priced at
  full spot, and the controller knows it.

So: cheap night + profitable ⇒ full throttle on all boards. Expensive evening, no heat
needed ⇒ off. Cold house ⇒ heat output sized to demand at the lowest net cost, using
hashboard on/off to reach power levels the tuner alone can't (boards only tune down so
far — board count is what really extends the range).

## Why you can trust it

- **Dry run first.** New installs and v1 upgrades start in dry-run: the controller logs
  every decision and what it *would have* done, but touches nothing until you press
  **Go live** (which shows you the first action it will take).
- **Every decision is explained.** The dashboard banner is a plain-language status
  ("Off — mining unprofitable (1.86 kr/kWh); next planned start 23:00"); the "Why?"
  expander shows the full scored candidate table.
- **Every actuation is verified** by reading the miner back. v1 spent its whole life
  sending a power command the firmware silently rejected; v2 alerts on the first failure.
- **Safety beats economics, always**: chip-temp pause (90 °C) and derate (80 °C) with a
  latched thermal ceiling so the optimizer can't re-trip an overheat; firmware DPS stays
  as the hardware backstop; a process watchdog restarts the app if a control loop wedges.
- **Anti-flapping**: start/stop margins, power deadband + dwell, and board switches only
  when the projected gain over the remaining day-ahead horizon beats the one-time
  re-tune cost.

## How it learns your miner

Predicted hashrate/wall-power per operating point starts from the miner's own tuned
profiles (`ListTargetProfiles`) plus a conservative model, then self-calibrates from
live measurements whenever the tuner is stable. Predicted-vs-realized divergence > 15 %
is surfaced in the events log.

## UI

Four tabs: **Overview** (status banner, hero stats, 48 h price strip with the plan
overlaid, board slots, effective SCOP), **Control** (Auto/Manual/Off, heat demand —
off / fixed kW / paintable weekly schedule, manual board+power panel, dry-run),
**History** (charts + events), **Settings** (miner, electricity incl. household
baseline & subsidy cap, alerts via ntfy/Telegram/webhook, collapsed Advanced tuning).
Installable as a PWA; no internet needed to load (all assets vendored).

## Run

```
npm start                      # PORT=3456, DATA_DIR=/data
npm test                       # unit + scenario-simulation tests
node test/simulate.js          # printable hour-by-hour controller timelines
```

Deployed as an Umbrel community app (Docker `node:22-alpine`, port 3456). v1 configs
are migrated automatically (original backed up to `config.v1.backup.json`) and come up
in dry-run mode with a migration notice.

## Architecture

Small CommonJS modules, no runtime deps beyond express/ws/grpc-js:

```
server.js          wiring, watchdog, graceful shutdown
lib/engine.js      PURE decision logic — decide()/buildPlan(), fully unit-tested
lib/envelope.js    operating-envelope model (learned + fallback)
lib/controller.js  tick loop: snapshot → decide → actuate (verify) → log
lib/minerClient.js Braiins gRPC (power target, hashboards, cooling, DPS, pause/resume)
lib/market.js      spot prices (today+tomorrow), marginal-price model, BTC, hashprice
lib/configStore.js atomic config + v1 migration    lib/stateStore.js  runtime state
lib/history.js     NDJSON samples/events + rollups lib/alerts.js      ntfy/Telegram
lib/api.js + lib/wsHub.js                          public/app/        React UI
```

Design rationale and the full spec live in `DESIGN.md`; module contracts in
`CONTRACTS.md`.
