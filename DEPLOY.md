# Deploying v2 to the Umbrel

v2 lives on branch `v2` (this repo). 165 tests pass; the CI runs them before building.

## The pipeline (unchanged from v1)
`.github/workflows/docker-build-push.yml`: on push to `main` (or manual dispatch) →
runs `npm test` → builds `j73642/mining-dashboard-app` → pushes to Docker Hub →
updates the community store's `docker-compose.yml` + `umbrel-app.yml` (repo
`j1441/Jack-s-Community-Store`, folder `jacks-mining-dashboard`) with the new image+digest.
The Umbrel then shows an update for the app.

## Recommended: PR → merge → dispatch 2.0.0
1. Get the `v2` branch onto `j1441/jacks-mining-dashboard-app` (PR or direct push).
2. Merge to `main`. (This auto-triggers a build tagged as the store's next patch,
   e.g. 1.2.88 — harmless; it's the v2 code, just mislabeled. Don't install it.)
3. Run the **Build, Push and Update App Store** workflow via *Run workflow* with
   `version = 2.0.0` (the auto-increment can't jump 1.2.x → 2.0.0 on its own).
4. On the Umbrel, open the Mining Dashboard app → **Update** (or reinstall).

## What happens on update
- The existing app is replaced in place; the app id is unchanged so its data volume
  (with your v1 `config.json`) carries over.
- On first boot v2 **migrates** the v1 config, writes `config.v1.backup.json`, and comes
  up in **dry-run** with a migration notice — it plans but does not touch the miner until
  you press **Go live**.
- Verify: app loads, miner shows online at 192.168.1.89, the 48h plan and decision look
  right, `/health` is green. Watch its "would-have" decisions for a bit, then Go live.

## Notes
- Node bumped to 22 (Dockerfile `node:22-alpine`); all runtime deps are pure-JS
  (grpc-js/proto-loader/express/ws), no native build; `sharp` is dev-only and skipped.
- If the miner is unreachable at boot, v2 reconciles from the miner before any action and
  starts safe.
