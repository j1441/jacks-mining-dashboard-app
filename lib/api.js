// lib/api.js — REST routes (DESIGN §5) + the shared /api/state snapshot builder that
// the WS hub broadcasts every tick. Redaction is delegated to configStore; controller
// actions are delegated to Controller.userAction. Static files are served by server.js.
'use strict';

const express = require('express');
const { resolveHeatDemand, altHeatPrice, estimateRoomTempC } = require('./controller');

const log = (...a) => console.log('[api]', ...a);

function findController(controllers, id) {
  return (controllers || []).find((c) => c.id === id) || null;
}

async function buildStateSnapshot({ configStore, controllers, market, history, version }) {
  const cfg = configStore.get();
  const ts = new Date().toISOString();

  let marketState = { errors: ['market unavailable'] };
  try { marketState = market.state() || marketState; }
  catch (e) { log('market.state failed:', e.message); }

  const householdPrice = Number.isFinite(marketState.currentHousehold) ? marketState.currentHousehold : 0;
  const alt = ((cfg.heating || {}).alt) || {};
  // House-level room temp: coolest estimate across online miners (conservative —
  // a colder reading can only increase heat demand, never suppress it).
  const thermo = (cfg.heating || {}).thermostat;
  const roomTemps = (controllers || [])
    .map((c) => estimateRoomTempC(c.lastSnapshot, thermo))
    .filter((t) => t !== null);
  const roomTempC = roomTemps.length ? Math.min(...roomTemps) : null;
  const heating = {
    demandKW: resolveHeatDemand(cfg, ts, roomTempC),
    altType: alt.type || 'none',
    altPricePerKWh: altHeatPrice(cfg, householdPrice),
    roomTempC,
    demandSource: (cfg.heating || {}).demandSource || 'off',
    thermostat: thermo ? { targetC: thermo.targetC, bandC: thermo.bandC, maxKW: thermo.maxKW } : null,
  };

  const miners = [];
  for (const c of controllers || []) {
    try { miners.push(c.snapshotForApi()); }
    catch (e) { log(`snapshotForApi(${c.id}) failed:`, e.message); }
  }

  let events = [];
  try { events = (await history.queryEvents({ limit: 50 })) || []; }
  catch (e) { log('queryEvents failed:', e.message); }
  const alertsRecent = events
    .filter((e) => e.type === 'alert' || e.severity === 'critical' || e.severity === 'warn')
    .slice(0, 10);

  return {
    ts,
    version,
    market: { ...marketState, regime: marketState.regime || 'subsidised' },
    heating,
    miners,
    alerts: alertsRecent,
    events: events.slice(0, 20),
  };
}

function createApi({ configStore, controllers, market, history, alerts, version }) {
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  const ctx = { configStore, controllers, market, history, version };

  router.get('/api/state', async (req, res) => {
    try { res.json(await buildStateSnapshot(ctx)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/config', (req, res) => {
    try { res.json(configStore.redacted()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Deep-merge partial update; configStore ignores redaction-sentinel values so a
  // round-tripped GET body never clobbers stored secrets.
  router.put('/api/config', async (req, res) => {
    try {
      await configStore.update(req.body || {});
      res.json(configStore.redacted());
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.get('/api/miners/:id/plan', (req, res) => {
    const c = findController(controllers, req.params.id);
    if (!c) return res.status(404).json({ error: `unknown miner: ${req.params.id}` });
    res.json(c.plan || []);
  });

  router.get('/api/miners/:id/trace', (req, res) => {
    const c = findController(controllers, req.params.id);
    if (!c) return res.status(404).json({ error: `unknown miner: ${req.params.id}` });
    res.json(c.traces || []);
  });

  router.get('/api/miners/:id/envelope', (req, res) => {
    const c = findController(controllers, req.params.id);
    if (!c) return res.status(404).json({ error: `unknown miner: ${req.params.id}` });
    try { res.json(c.envelopeForApi()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/miners/:id/action', async (req, res) => {
    const c = findController(controllers, req.params.id);
    if (!c) return res.status(404).json({ error: `unknown miner: ${req.params.id}` });
    const body = req.body || {};
    const allowed = ['pause', 'resume', 'setPower', 'setBoards', 'goLive', 'dryRun'];
    if (!allowed.includes(body.type)) {
      return res.status(400).json({ error: `action type must be one of: ${allowed.join('|')}` });
    }
    try { res.json(await c.userAction(body)); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.get('/api/history', async (req, res) => {
    try {
      const rows = await history.querySamples({
        fromIso: req.query.from || new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        toIso: req.query.to || new Date().toISOString(),
        id: req.query.id,
        res: req.query.res === 'hour' ? 'hour' : 'raw',
      });
      res.json(rows || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/events', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 100));
      const rows = await history.queryEvents({ limit, severity: req.query.severity || undefined });
      res.json(rows || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/alerts/test', async (req, res) => {
    try { res.json((await alerts.test()) || { ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 200 only if every enabled controller ticked within max(60 s, 5 × pollSeconds).
  router.get('/health', (req, res) => {
    let pollSeconds = 10;
    try { pollSeconds = Number(configStore.get().pollSeconds) || 10; }
    catch (_e) { /* keep default */ }
    const maxAgeMs = Math.max(60 * 1000, 5 * pollSeconds * 1000);
    const now = Date.now();
    const report = (controllers || [])
      .filter((c) => c.running !== false)
      .map((c) => {
        const t = c.lastTickAt ? Date.parse(c.lastTickAt) : NaN;
        const ageMs = Number.isFinite(t) ? now - t : null;
        return { id: c.id, lastTickAt: c.lastTickAt || null, ageMs, stale: ageMs === null || ageMs > maxAgeMs };
      });
    const ok = report.every((r) => !r.stale);
    res.status(ok ? 200 : 503).json({ ok, maxAgeMs, controllers: report });
  });

  return router;
}

module.exports = { createApi, buildStateSnapshot };
