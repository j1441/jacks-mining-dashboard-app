# Deploying v2 to the Umbrel

v2 lives on branch `v2` (this repo). 201 tests pass; the CI runs them before building.

## The pipeline (unchanged from v1)
`.github/workflows/docker-build-push.yml`: on push to `main` (or manual dispatch) →
runs `npm test` → builds `j73642/mining-dashboard-app` → pushes to Docker Hub →
updates the community store's `docker-compose.yml` + `umbrel-app.yml` (repo
`j1441/Jack-s-Community-Store`, folder `jacks-mining-dashboard`) with the new image+digest.
The Umbrel then shows an update for the app.

## Deploying now: merge to main, that's it
1. Get the branch onto `j1441/jacks-mining-dashboard-app` (PR or direct push).
2. Merge to `main`. The push auto-triggers the build, which runs the tests, pushes
   the image and updates the store at the next patch version.
3. On the Umbrel, open the Mining Dashboard app → **Update** (or reinstall).

**Do NOT dispatch `version = 2.0.0`.** That instruction was for the one-off 1.2.x → 2.0.0
transition and is now a *downgrade* — the store passed 2.0.0 long ago (2.4.1 as of
2026-07-28). Auto-increment handles 2.x correctly on its own; only pass an explicit
`version` to jump a major, and check the store's current version first:
```
gh api repos/j1441/Jack-s-Community-Store/contents/jacks-mining-dashboard/umbrel-app.yml \
  --jq '.content' | base64 -d | grep '^version'
```

**Gotcha — `APP_STORE_PAT` expiry.** The workflow's first real step checks out the
community store using `secrets.APP_STORE_PAT`. When that token expires the run fails at
that step with `Bad credentials`, and *every* later step — tests, Docker build, store
update — is skipped. The run looks like a deploy but produces nothing. This silently
broke deploys between 2026-07-26 and 2026-07-28. If a run fails fast (~30 s), check the
token first: `gh secret list --repo j1441/jacks-mining-dashboard-app`.

## What happens on update
- The existing app is replaced in place; the app id is unchanged so its data volume
  (with your v1 `config.json`) carries over.
- On first boot v2 **migrates** the v1 config, writes `config.v1.backup.json`, and comes
  up in **dry-run** with a migration notice — it plans but does not touch the miner until
  you press **Go live**.
- Verify: app loads, miner shows online at 192.168.1.89, the 48h plan and decision look
  right, `/health` is green. Watch its "would-have" decisions for a bit, then Go live.

## Enabling the room temperature sensor (after the update)
The `upstairs` zone has a Sonoff TH10 running Tasmota 15.5.0 at `192.168.1.59`
(SI7021 probe on GPIO14). Add to that zone in `config.json`:
```json
"tempSensor": { "type": "tasmota", "host": "192.168.1.59", "name": "Upstairs TH10" }
```
While the reading is fresh (≤5 min) it supersedes the hashboard-inlet estimate for
that zone; if the sensor goes unreachable the zone falls back to the inlet estimate
automatically (one `temp-sensor-unavailable` warn event per outage). Zones without a
`tempSensor` — currently `garage` — are unaffected and keep using the inlet estimate.

Note: this device serves `/?m=1` but its `/cm` JSON endpoint drops the connection
(reproducible, survives a restart). The poller negotiates transports and falls back to
parsing `/?m=1`, so both work; `tempSensor.transport` in the zone summary shows which
one is in use.

## Notes
- Node bumped to 22 (Dockerfile `node:22-alpine`); all runtime deps are pure-JS
  (grpc-js/proto-loader/express/ws), no native build; `sharp` is dev-only and skipped.
- If the miner is unreachable at boot, v2 reconciles from the miner before any action and
  starts safe.
