// lib/alerts.js — single responsibility: alert rule evaluation (per controller tick),
// per-rule cooldowns, and dispatch to ntfy / Telegram / webhook channels. Every fired
// alert also lands in the events log. fetchImpl is injectable for tests.
'use strict';

const log = (...a) => console.log('[alerts]', ...a);

const COOLDOWN_MS = 30 * 60 * 1000;      // per ruleKey+minerId
const PERSIST_MS = 10 * 60 * 1000;       // hashrate-low / dead-board persistence window

class Alerts {
  constructor({ configStore, history, fetchImpl }) {
    this.configStore = configStore;
    this.history = history;
    this.fetch = fetchImpl || globalThis.fetch;
    this._lastFired = new Map();          // `${ruleKey}|${minerId}` -> ms epoch
    this._since = new Map();              // condition-tracking key -> ms epoch first seen
  }

  // Fire an alert (cooldown-gated). Returns true if dispatched, false if suppressed.
  async fire(ruleKey, { severity = 'warn', title, message, minerId }) {
    const key = `${ruleKey}|${minerId || ''}`;
    const now = Date.now();
    const last = this._lastFired.get(key);
    if (last !== undefined && now - last < COOLDOWN_MS) return false;
    this._lastFired.set(key, now);

    if (this.history) {
      try {
        await this.history.appendEvent({
          ts: new Date(now).toISOString(), id: minerId, type: 'alert', severity,
          message: `${title}: ${message}`, data: { ruleKey },
        });
      } catch (err) {
        log('event log append failed:', err.message);
      }
    }
    await this._dispatch({ ruleKey, severity, title, message, minerId });
    return true;
  }

  // Send a test message to every configured channel (no cooldown). Returns per-channel results.
  async test() {
    return this._dispatch({
      ruleKey: 'test', severity: 'info', title: 'Mining Heater test alert',
      message: 'If you can read this, alert delivery works.', minerId: null,
    });
  }

  async _dispatch({ ruleKey, severity, title, message, minerId }) {
    const cfg = this.configStore.get().alerts;
    const results = {};

    if (cfg.ntfy?.url && cfg.ntfy?.topic) {
      results.ntfy = await this._try('ntfy', () => this.fetch(
        `${cfg.ntfy.url.replace(/\/+$/, '')}/${encodeURIComponent(cfg.ntfy.topic)}`,
        {
          method: 'POST',
          headers: {
            Title: title,
            Priority: severity === 'critical' ? 'urgent' : severity === 'warn' ? 'high' : 'default',
          },
          body: message,
        },
      ));
    }
    if (cfg.telegram?.botToken && cfg.telegram?.chatId) {
      results.telegram = await this._try('telegram', () => this.fetch(
        `https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `${title}\n${message}` }),
        },
      ));
    }
    if (cfg.webhook?.url) {
      results.webhook = await this._try('webhook', () => this.fetch(cfg.webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleKey, severity, title, message, minerId, ts: new Date().toISOString() }),
      }));
    }
    return results;
  }

  async _try(channel, fn) {
    try {
      const res = await fn();
      const ok = !res || res.ok !== false;
      if (!ok) log(`${channel} dispatch failed: HTTP ${res.status}`);
      return { ok, status: res && res.status };
    } catch (err) {
      log(`${channel} dispatch failed:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  // ---- rule evaluation (DESIGN §4.5; safety / verify-failure / stalled are fired
  // directly by controller & watchdog via fire()) --------------------------------
  //
  // ctx: { minerId, now?, snapshot, engineState, market, tuningHold, expectedHashrateThs? }
  // Returns the ruleKeys that fired this evaluation (after cooldown gating).
  async evaluate(ctx) {
    const { minerId, snapshot, market, tuningHold } = ctx;
    const nowMs = ctx.now ? Date.parse(ctx.now) : Date.now();
    const rules = this.configStore.get().alerts.rules;
    const fired = [];
    const fireIf = async (ruleKey, opts) => {
      if (await this.fire(ruleKey, { minerId, ...opts })) fired.push(ruleKey);
    };

    // offline — after offlineAfterS of continuous unreachability
    if (snapshot && snapshot.online === false) {
      const since = this._track(`offline|${minerId}`, nowMs);
      if (nowMs - since >= rules.offlineAfterS * 1000) {
        await fireIf('offline', {
          severity: 'critical', title: 'Miner offline',
          message: `${minerId} unreachable for ${Math.round((nowMs - since) / 60000)} min`,
        });
      }
    } else {
      this._since.delete(`offline|${minerId}`);
    }

    if (snapshot && snapshot.online) {
      // hashrate low — < expected×(1−pct) for 10 min, outside TUNING hold
      const expected = ctx.expectedHashrateThs;
      const actual = snapshot.hashrate ? (snapshot.hashrate.m15 ?? snapshot.hashrate.m1) : null;
      const lowKey = `hashrate-low|${minerId}`;
      if (!tuningHold && typeof expected === 'number' && expected > 0 && typeof actual === 'number'
          && actual < expected * (1 - rules.hashrateLowPct / 100)) {
        const since = this._track(lowKey, nowMs);
        if (nowMs - since >= PERSIST_MS) {
          await fireIf('hashrate-low', {
            severity: 'warn', title: 'Hashrate low',
            message: `${minerId}: ${actual.toFixed(1)} TH/s vs ${expected.toFixed(1)} expected (>${rules.hashrateLowPct}% below for 10+ min)`,
          });
        }
      } else {
        this._since.delete(lowKey);
      }

      // dead board — enabled but not hashing for 10 min, outside TUNING hold
      for (const b of snapshot.boards || []) {
        const bKey = `dead-board-${b.id}|${minerId}`;
        if (!tuningHold && b.enabled && !b.hashing) {
          const since = this._track(bKey, nowMs);
          if (nowMs - since >= PERSIST_MS) {
            await fireIf(`dead-board-${b.id}`, {
              severity: 'critical', title: 'Dead hashboard',
              message: `${minerId}: board ${b.id} enabled but not hashing for 10+ min`,
            });
          }
        } else {
          this._since.delete(bKey);
        }
      }

      // failover pool active — primary pool inactive while a backup carries the work
      const pools = snapshot.pools || [];
      if (pools.length > 1 && pools[0] && !pools[0].active && pools.some((p) => p.active)) {
        const active = pools.find((p) => p.active);
        await fireIf('pool-failover', {
          severity: 'warn', title: 'Failover pool active',
          message: `${minerId}: primary pool down, mining on ${active.url}`,
        });
      }
    }

    // price horizon exhausted — controller is on the pessimistic fallback price
    if (market && market.horizonCoversNow === false) {
      await fireIf('price-horizon', {
        severity: 'warn', title: 'Price horizon exhausted',
        message: 'No day-ahead price for the current hour; using pessimistic fallback price.',
      });
    }

    return fired;
  }

  _track(key, nowMs) {
    let since = this._since.get(key);
    if (since === undefined) { since = nowMs; this._since.set(key, since); }
    return since;
  }
}

module.exports = { Alerts };
