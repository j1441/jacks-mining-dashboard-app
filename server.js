// server.js — entry point: loads config, wires modules (per CONTRACTS wire order),
// serves HTTP/WS + static UI, runs the process-level watchdog (DESIGN §3.5) and
// handles graceful shutdown. All domain logic lives in lib/.
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');

const configStoreMod = require('./lib/configStore');
const stateStoreMod = require('./lib/stateStore');
const { History } = require('./lib/history');
const { Alerts } = require('./lib/alerts');
const { Market } = require('./lib/market');
const { Envelope } = require('./lib/envelope');
const { MinerClient } = require('./lib/minerClient');
const { Controller } = require('./lib/controller');
const { createApi, buildStateSnapshot } = require('./lib/api');
const { createWsHub } = require('./lib/wsHub');
const engine = require('./lib/engine');

const ConfigStore = configStoreMod.ConfigStore;
const StateStore = stateStoreMod.StateStore || configStoreMod.StateStore;

const log = (...a) => console.log('[server]', ...a);

const PORT = parseInt(process.env.PORT, 10) || 3456;
const DATA_DIR = process.env.DATA_DIR || '/data';
const VERSION = require('./package.json').version;

const WATCHDOG_INTERVAL_MS = 60 * 1000;
const STALL_MS = 5 * 60 * 1000;
const ALERT_DISPATCH_TIMEOUT_MS = 5 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1. Config
  const configStore = new ConfigStore({ dataDir: DATA_DIR });
  const cfg = await configStore.load();

  // 2. History, alerts, market
  const history = new History({ dataDir: DATA_DIR });
  const alerts = new Alerts({ configStore, history });
  const market = new Market({ configStore, history });
  await market.start();

  // 3. Per-miner wiring. Controllers get a lazy WS proxy: any per-tick broadcast
  //    triggers a full /api/state snapshot broadcast once the hub is attached below.
  const stateStore = new StateStore({ dataDir: DATA_DIR });
  let broadcastState = null;
  let wsHub = null;
  const hubProxy = {
    broadcast: () => { if (broadcastState) broadcastState(); },
    clientCount: () => (wsHub ? wsHub.clientCount() : 0),
  };

  const controllers = [];
  const clients = [];
  for (const minerCfg of cfg.miners || []) {
    const client = new MinerClient({
      id: minerCfg.id,
      ip: minerCfg.ip,
      username: minerCfg.username,
      password: minerCfg.password,
    });
    clients.push(client);
    const envelope = new Envelope({ minerId: minerCfg.id, dataDir: DATA_DIR });
    await envelope.load();
    controllers.push(new Controller({
      minerCfg, client, envelope, market, engine,
      stateStore, history, alerts, wsHub: hubProxy, configStore,
    }));
  }
  for (const c of controllers) await c.start();

  // 4. HTTP API + static UI + WS hub
  const app = express();
  app.use(createApi({ configStore, controllers, market, history, alerts, version: VERSION }));
  app.use(express.static(path.join(__dirname, 'public')));

  const server = http.createServer(app);
  wsHub = createWsHub(server);

  const snapCtx = { configStore, controllers, market, history, alerts, version: VERSION };
  let broadcasting = false;
  broadcastState = () => {
    if (broadcasting || wsHub.clientCount() === 0) return;
    broadcasting = true;
    buildStateSnapshot(snapCtx)
      .then((snap) => wsHub.broadcast(snap))
      .catch((e) => log('ws snapshot build failed:', e.message))
      .finally(() => { broadcasting = false; });
  };

  await new Promise((resolve) => server.listen(PORT, resolve));

  // 5. Process-level watchdog (DESIGN §3.5): a controller stalled > 5 min means the
  //    loop is wedged — event + direct alert, then exit(1) so Docker restarts us.
  const watchdog = setInterval(async () => {
    for (const c of controllers) {
      if (!c.running) continue;
      const t = c.lastTickAt ? Date.parse(c.lastTickAt) : NaN;
      const ageMs = Number.isFinite(t) ? Date.now() - t : Infinity;
      if (ageMs <= STALL_MS) continue;
      const message = `controller ${c.id} stalled: last completed tick ${c.lastTickAt || 'never'}`;
      try {
        await history.appendEvent({
          ts: new Date().toISOString(), id: c.id, type: 'controller-stalled',
          severity: 'critical', message,
        });
      } catch (_e) { /* exiting anyway */ }
      try {
        await Promise.race([
          alerts.fire('controller-stalled', {
            severity: 'critical', title: 'Controller stalled', message, minerId: c.id,
          }),
          sleep(ALERT_DISPATCH_TIMEOUT_MS),
        ]);
      } catch (_e) { /* exiting anyway */ }
      log('FATAL:', message, '— exiting for supervisor restart');
      process.exit(1);
    }
  }, WATCHDOG_INTERVAL_MS);
  if (watchdog.unref) watchdog.unref();

  // 6. Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — shutting down`);
    clearInterval(watchdog);
    try { await Promise.all(controllers.map((c) => c.stop())); } catch (e) { log('controller stop failed:', e.message); }
    try { await market.stop(); } catch (e) { log('market stop failed:', e.message); }
    try { if (typeof stateStore.flush === 'function') await stateStore.flush(); } catch (e) { log('state flush failed:', e.message); }
    for (const client of clients) {
      try { await client.close(); } catch (_e) { /* best effort */ }
    }
    try { wsHub.close(); } catch (_e) { /* best effort */ }
    await new Promise((r) => server.close(r));
    log('shutdown complete');
    process.exit(0);
  }
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });

  const minerSummary = (cfg.miners || [])
    .map((m) => `${m.id}@${m.ip} (${m.mode}${m.dryRun ? ', DRY RUN' : ''})`)
    .join(', ') || 'none';
  log(`mining-heater v${VERSION} listening on :${PORT}`);
  log(`data dir ${DATA_DIR} | poll ${cfg.pollSeconds || 10}s | miners: ${minerSummary}`);
}

process.on('unhandledRejection', (e) => {
  log('unhandled rejection:', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
  console.error('[server] uncaught exception — exiting for supervisor restart', e);
  process.exit(1);
});

main().catch((e) => {
  console.error('[server] fatal startup error', e);
  process.exit(1);
});
