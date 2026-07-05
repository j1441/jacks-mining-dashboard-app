'use strict';
/**
 * market.js — market data + the Norwegian marginal electricity price model.
 *
 * Single responsibility (DESIGN §4.2): know what the NEXT miner-kWh costs and
 * what a hash is worth, and keep that knowledge fresh.
 *  - Hourly spot prices from hvakosterstrommen.no (today always; tomorrow
 *    attempted once the local hour in cfg.electricity.timezone is >= 13).
 *    Refreshed every 30 min, with jittered exponential backoff on failure.
 *  - BTC price (NOK/USD) from coingecko every 5 min; network hashrate from
 *    api.blockchain.info/stats every 10 min →
 *    hashpriceNokPerThDay = blockReward(3.125) × 144 / networkThs × btcNok.
 *  - computeMarginalPrice(): PURE Norwegian model — spot (+25% VAT, NO4 exempt)
 *    → strømstøtte (state covers 90% of the inc-VAT spot above 0.9375 kr/kWh,
 *    v1 semantics) or Norgespris (flat 0.50 kr/kWh) — but subsidy/flat apply
 *    only while household consumption (householdBaseKWhMonth pro-rated by
 *    day-of-month, plus metered miner kWh) is under, and not projected past,
 *    subsidyCapKWhMonth. Over the cap the marginal price is raw spot(+VAT).
 *    Time-of-day/weekend grid fee is added in every regime.
 *  - householdPrice(): the always-subsidised rate (the alt heater's kWh sit
 *    below the cap) for the alt-heat comparison.
 *  - Failure policy: prices are valid while the hour lies inside the published
 *    horizon; only when the horizon is exhausted does fallbackPrice (max
 *    marginal over the trailing 48 h of known data) substitute.
 *
 * All hour/weekday/date derivations use Intl.DateTimeFormat with the configured
 * timezone (container runs UTC). All fetches go through an injectable fetchImpl
 * so tests never touch the network.
 */

const https = require('https');

const log = (...a) => console.log('[market]', ...a);

// Economic constants
const BLOCK_REWARD_BTC = 3.125;            // post-2024-halving block subsidy
const BLOCKS_PER_DAY = 144;
const STROMSTOTTE_THRESHOLD_EX_VAT_NOK = 0.75;  // kr/kWh ex VAT (0.9375 inc 25% VAT; no uplift in NO4)
const STROMSTOTTE_COVERAGE = 0.90;         // state covers 90% of the excess
const NORGESPRIS_NOK = 0.50;               // flat rate while under the cap
const VAT_RATE = 0.25;
const VAT_EXEMPT_ZONES = new Set(['NO4']); // Nord-Norge: no VAT on electricity

// Cadence / policy
const PRICES_REFRESH_MS = 30 * 60 * 1000;
const BTC_REFRESH_MS = 5 * 60 * 1000;
const NETWORK_REFRESH_MS = 10 * 60 * 1000;
const BACKOFF_BASE_MS = 60 * 1000;
const TOMORROW_GATE_HOUR = 13;             // tomorrow published ~13:00 local
const FALLBACK_WINDOW_MS = 48 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

const PRICES_URL = (yyyy, mm, dd, zone) =>
  `https://www.hvakosterstrommen.no/api/v1/prices/${yyyy}/${mm}-${dd}_${zone}.json`;
const BTC_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,nok';
const NETWORK_URL = 'https://api.blockchain.info/stats';

// ---------------------------------------------------------------------------
// Timezone helpers (exported) — never bare getHours(): the process runs UTC.
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map();

function partsInTz(dateIso, tz) {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, fmt);
  }
  const out = {};
  for (const p of fmt.formatToParts(new Date(dateIso))) out[p.type] = p.value;
  return out;
}

/** Hour of day (0–23) at the given instant in tz. */
function hourInTz(dateIso, tz) {
  return Number(partsInTz(dateIso, tz).hour) % 24;
}

/** Weekday at the given instant in tz; 0=Sunday … 6=Saturday (Date#getDay convention). */
function weekdayInTz(dateIso, tz) {
  return WEEKDAY_INDEX[partsInTz(dateIso, tz).weekday];
}

/** Calendar date "YYYY-MM-DD" at the given instant in tz. */
function yyyymmddInTz(dateIso, tz) {
  const p = partsInTz(dateIso, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "YYYY-MM-DD" + n days (pure calendar arithmetic, DST-immune). */
function plusDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Pure price model
// ---------------------------------------------------------------------------

/** Time-of-day/weekend grid fee at an instant, windows evaluated in cfg timezone. */
function gridFeeAt(dateIso, electricity) {
  const tz = electricity.timezone || 'Europe/Oslo';
  const gf = electricity.gridFee || {};
  const dayStart = gf.dayStartHour ?? 6;
  const nightStart = gf.nightStartHour ?? 22;
  const hour = hourInTz(dateIso, tz);
  const wd = weekdayInTz(dateIso, tz);
  const isWeekend = wd === 0 || wd === 6;
  const isNight = hour < dayStart || hour >= nightStart;
  return (isWeekend || isNight) ? (gf.nightWeekend ?? 0.30) : (gf.dayWeekday ?? 0.50);
}

/**
 * Subsidy regime for the month containing dateIso (evaluated in cfg timezone).
 * Household baseline is pro-rated by day-of-month; the miner's metered month
 * kWh are added; over-cap when consumption so far reaches the cap OR the
 * month-end projection at the current rate exceeds it (errs pessimistic).
 */
function computeRegime(dateIso, electricity, monthMinerKWh) {
  const tz = electricity.timezone || 'Europe/Oslo';
  const [y, m, d] = yyyymmddInTz(dateIso, tz).split('-').map(Number);
  const fractionElapsed = d / daysInMonth(y, m);
  const cap = electricity.subsidyCapKWhMonth ?? 5000;
  const householdBase = electricity.householdBaseKWhMonth ?? 0;
  const miner = Number(monthMinerKWh) || 0;
  const soFar = householdBase * fractionElapsed + miner;
  const projectedMonthEnd = householdBase + miner / fractionElapsed;
  return (soFar >= cap || projectedMonthEnd > cap) ? 'over-cap' : 'subsidised';
}

/**
 * THE CORE (pure, unit-tested): price of the next miner-kWh at an instant.
 *
 * @param {object} args
 * @param {string} args.dateIso        instant the kWh is consumed
 * @param {number} args.spotExVatNok   raw spot price ex VAT (NOK/kWh, may be negative)
 * @param {object} args.electricity    cfg.electricity (zone, timezone, priceMode, gridFee, caps)
 * @param {number} [args.monthMinerKWh=0]  metered miner kWh so far this month
 * @returns {{marginalPrice:number, householdPrice:number, regime:'subsidised'|'over-cap',
 *            components:{spot:number, vat:number, subsidy:number, gridFee:number, regime:string}}}
 *          Identity: spot + vat − subsidy + gridFee === marginalPrice.
 */
function computeMarginalPrice({ dateIso, spotExVatNok, electricity, monthMinerKWh = 0 }) {
  const vatRate = VAT_EXEMPT_ZONES.has(electricity.zone) ? 0 : VAT_RATE;
  const spotIncVat = spotExVatNok * (1 + vatRate);
  const gridFee = gridFeeAt(dateIso, electricity);
  const regime = computeRegime(dateIso, electricity, monthMinerKWh);

  // Subsidised base price (what a below-cap household kWh costs before grid fee)
  let subsidisedBase;
  if (electricity.priceMode === 'norgespris') {
    subsidisedBase = NORGESPRIS_NOK;
  } else if (electricity.priceMode === 'spot') {
    // Raw spot: no support scheme on this metering point (cabins, business meters)
    subsidisedBase = spotIncVat;
  } else {
    // strømstøtte: threshold is 0.75 kr ex VAT (= 0.9375 inc 25% VAT); in the
    // VAT-exempt zone NO4 the threshold applies without the VAT uplift.
    const threshold = STROMSTOTTE_THRESHOLD_EX_VAT_NOK * (1 + vatRate);
    const excess = spotIncVat - threshold;
    subsidisedBase = excess > 0 ? spotIncVat - excess * STROMSTOTTE_COVERAGE : spotIncVat;
  }

  const marginalBase = regime === 'over-cap' ? spotIncVat : subsidisedBase;
  return {
    marginalPrice: marginalBase + gridFee,
    householdPrice: subsidisedBase + gridFee, // household kWh always sit below the cap
    regime,
    components: {
      spot: spotExVatNok,
      vat: spotIncVat - spotExVatNok,
      subsidy: spotIncVat - marginalBase, // 0 when over-cap; negative if Norgespris > spot
      gridFee,
      regime,
    },
  };
}

// ---------------------------------------------------------------------------
// Default fetch: plain node https GET returning parsed JSON
// ---------------------------------------------------------------------------

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { accept: 'application/json', 'user-agent': 'jacks-mining-dashboard/2.0' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`invalid JSON from ${url}: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

class Market {
  /**
   * @param {object} deps
   * @param {object} deps.configStore  provides get() → config (electricity + miners)
   * @param {object} [deps.history]    provides minerKWhThisMonth(id) for the cap regime
   * @param {function} [deps.fetchImpl] async (url) → parsed JSON (default: node https)
   * @param {function} [deps.nowFn]    () → Date, injectable for tests (default: real clock)
   */
  constructor({ configStore, history, fetchImpl, nowFn } = {}) {
    this.configStore = configStore;
    this.history = history;
    this._fetch = fetchImpl || httpsGetJson;
    this._now = nowFn || (() => new Date());

    this._days = new Map();       // 'YYYY-MM-DD' (in cfg tz) → [{startMs, endMs, spotExVat}]
    this._hours = [];             // flat sorted view of _days
    this._btc = { nok: null, usd: null };
    this._networkThs = null;
    this._fetchedAt = null;       // last successful prices fetch (ISO)
    this._monthMinerKWh = 0;      // last known metered miner kWh this month
    this._errors = { prices: null, tomorrow: null, btc: null, network: null };
    this._failures = { prices: 0, btc: 0, network: 0 };
    this._timers = {};
    this._stopped = true;
  }

  /** Kick off all refresh loops; resolves after the first fetch round settles. */
  async start() {
    this._stopped = false;
    await Promise.allSettled([
      this._loop('prices', () => this._pricesTick(), PRICES_REFRESH_MS),
      this._loop('btc', () => this.refreshBtc(), BTC_REFRESH_MS),
      this._loop('network', () => this.refreshNetwork(), NETWORK_REFRESH_MS),
    ]);
  }

  stop() {
    this._stopped = true;
    for (const t of Object.values(this._timers)) clearTimeout(t);
    this._timers = {};
  }

  // -- refreshers -----------------------------------------------------------

  /** Fetch today's prices (and tomorrow's once past the 13:00 local gate). */
  async refreshPrices() {
    const el = this._electricity();
    const tz = el.timezone || 'Europe/Oslo';
    const zone = el.zone || 'NO5';
    const nowIso = this._now().toISOString();
    const todayStr = yyyymmddInTz(nowIso, tz);

    this._days.set(todayStr, await this._fetchDay(todayStr, zone)); // throws on failure

    if (hourInTz(nowIso, tz) >= TOMORROW_GATE_HOUR) {
      const tomorrowStr = plusDays(todayStr, 1);
      if (this._days.has(tomorrowStr)) {
        this._errors.tomorrow = null;
      } else {
        try {
          this._days.set(tomorrowStr, await this._fetchDay(tomorrowStr, zone));
          this._errors.tomorrow = null;
        } catch (e) {
          // Soft failure: tomorrow may simply not be published yet; the normal
          // 30-min cycle retries. Recorded, but no backoff escalation.
          this._errors.tomorrow = `tomorrow prices (${tomorrowStr}): ${e.message}`;
        }
      }
    } else {
      this._errors.tomorrow = null; // before the gate, absence is expected
    }

    // Keep two past days for the trailing-48h fallback; prune older.
    const keepFrom = plusDays(todayStr, -2);
    for (const key of this._days.keys()) if (key < keepFrom) this._days.delete(key);

    this._rebuildHours();
    this._fetchedAt = nowIso;
  }

  /** BTC spot price in USD and NOK (coingecko). */
  async refreshBtc() {
    const j = await this._fetch(BTC_URL);
    const b = j && j.bitcoin;
    if (!b || !Number.isFinite(Number(b.nok))) throw new Error('unexpected coingecko response');
    this._btc = { nok: Number(b.nok), usd: Number.isFinite(Number(b.usd)) ? Number(b.usd) : null };
  }

  /** Network hashrate (blockchain.info stats; hash_rate is GH/s). */
  async refreshNetwork() {
    const j = await this._fetch(NETWORK_URL);
    const ghs = Number(j && j.hash_rate);
    if (!Number.isFinite(ghs) || ghs <= 0) throw new Error('unexpected blockchain.info response');
    this._networkThs = ghs / 1000;
  }

  // -- prices API -----------------------------------------------------------

  /**
   * Marginal price (NOK/kWh) of the next miner-kWh at dateIso. Pure given
   * loaded price data. When the hour lies outside the published horizon,
   * returns the pessimistic fallbackPrice (null if no data is known at all).
   */
  marginalPrice(dateIso, monthMinerKWh) {
    this._noteMonthKWh(monthMinerKWh);
    const h = this._findHour(Date.parse(dateIso));
    if (!h) return this.fallbackPrice(this._monthMinerKWh);
    return this._compute(dateIso, h.spotExVat).marginalPrice;
  }

  /** Always-subsidised household rate (NOK/kWh) for the alt-heat comparison. */
  householdPrice(dateIso) {
    const h = this._findHour(Date.parse(dateIso));
    if (!h) {
      const past = this._trailingKnown(Date.parse(dateIso));
      if (!past.length) return null;
      return Math.max(...past.map((p) =>
        this._compute(new Date(p.startMs).toISOString(), p.spotExVat).householdPrice));
    }
    return this._compute(dateIso, h.spotExVat).householdPrice;
  }

  /** Price decomposition for UI/trace. spot/vat/subsidy are null off-horizon. */
  effectiveComponents(dateIso) {
    const el = this._electricity();
    const h = this._findHour(Date.parse(dateIso));
    if (!h) {
      return {
        spot: null, vat: null, subsidy: null,
        gridFee: gridFeeAt(dateIso, el),
        regime: computeRegime(dateIso, el, this._monthMinerKWh),
      };
    }
    return this._compute(dateIso, h.spotExVat).components;
  }

  /**
   * Pessimistic substitute when the horizon is exhausted: max marginal price
   * over the trailing 48 h of known data (last 48 known hours if the data is
   * older than that). Null when nothing is known.
   */
  fallbackPrice(monthMinerKWh) {
    this._noteMonthKWh(monthMinerKWh);
    const past = this._trailingKnown(this._now().getTime());
    if (!past.length) return null;
    return Math.max(...past.map((p) =>
      this._compute(new Date(p.startMs).toISOString(), p.spotExVat).marginalPrice));
  }

  /** Known horizon from the current hour onward, for plan + switch integral. */
  priceHours(monthMinerKWh) {
    this._noteMonthKWh(monthMinerKWh);
    const nowMs = this._now().getTime();
    return this._hours
      .filter((h) => h.endMs > nowMs)
      .map((h) => {
        const iso = new Date(h.startMs).toISOString();
        const r = this._compute(iso, h.spotExVat);
        return {
          hourStartIso: iso,
          marginalPrice: r.marginalPrice,
          householdPrice: r.householdPrice,
          regime: r.regime,
        };
      });
  }

  /** Full market snapshot for the API/engine (contract shape + fallback extras). */
  state() {
    const el = this._electricity();
    const tz = el.timezone || 'Europe/Oslo';
    const now = this._now();
    const nowIso = now.toISOString();
    const todayStr = yyyymmddInTz(nowIso, tz);
    const tomorrowStr = plusDays(todayStr, 1);

    const toRows = (rows) => rows.map((h) => ({
      hourStartIso: new Date(h.startMs).toISOString(),
      spotNok: h.spotExVat, // raw spot ex VAT, as published
    }));
    const today = this._days.has(todayStr) ? toRows(this._days.get(todayStr)) : [];
    const tomorrow = this._days.has(tomorrowStr) ? toRows(this._days.get(tomorrowStr)) : null;

    const horizonEndsAt = this._hours.length
      ? new Date(this._hours[this._hours.length - 1].endMs).toISOString()
      : null;
    const horizonCoversNow = !!this._findHour(now.getTime());

    const current = this._findHour(now.getTime());
    let currentMarginal = null;
    let currentHousehold = null;
    if (current) {
      const r = this._compute(nowIso, current.spotExVat);
      currentMarginal = r.marginalPrice;
      currentHousehold = r.householdPrice;
    } else {
      currentMarginal = this.fallbackPrice(this._monthMinerKWh);
      currentHousehold = this.householdPrice(nowIso);
    }

    return {
      today,
      tomorrow,
      horizonEndsAt,
      horizonCoversNow,
      currentMarginal,
      currentHousehold,
      regime: computeRegime(nowIso, el, this._monthMinerKWh),
      btcNok: this._btc.nok,
      btcUsd: this._btc.usd,
      hashpriceNokPerThDay: this.hashpriceNokPerThDay(),
      networkThs: this._networkThs,
      fallbackPrice: this.fallbackPrice(this._monthMinerKWh),
      fetchedAt: this._fetchedAt,
      errors: Object.values(this._errors).filter(Boolean),
    };
  }

  /** NOK per TH/s per day: blockReward × 144 / networkThs × btcNok. */
  hashpriceNokPerThDay() {
    if (!this._networkThs || !this._btc.nok) return null;
    return BLOCK_REWARD_BTC * BLOCKS_PER_DAY / this._networkThs * this._btc.nok;
  }

  // -- internals ------------------------------------------------------------

  _electricity() {
    const cfg = this.configStore && typeof this.configStore.get === 'function'
      ? this.configStore.get() : null;
    return (cfg && cfg.electricity) || { zone: 'NO5', timezone: 'Europe/Oslo' };
  }

  _compute(dateIso, spotExVat) {
    const el = this._electricity();
    // Hours in a future month start a fresh subsidy allowance — projecting the
    // current month's miner kWh into them would misprice all of next month as
    // over-cap every month-end.
    const tz = el.timezone || 'Europe/Oslo';
    const sameMonth = yyyymmddInTz(dateIso, tz).slice(0, 7)
      === yyyymmddInTz(this._now().toISOString(), tz).slice(0, 7);
    return computeMarginalPrice({
      dateIso,
      spotExVatNok: spotExVat,
      electricity: el,
      monthMinerKWh: sameMonth ? this._monthMinerKWh : 0,
    });
  }

  _noteMonthKWh(kwh) {
    if (typeof kwh === 'number' && Number.isFinite(kwh)) this._monthMinerKWh = kwh;
  }

  _findHour(tMs) {
    if (!Number.isFinite(tMs)) return null;
    return this._hours.find((h) => h.startMs <= tMs && tMs < h.endMs) || null;
  }

  /** Known hours starting within the trailing 48 h window (or the last 48 known). */
  _trailingKnown(nowMs) {
    const past = this._hours.filter((h) => h.startMs <= nowMs);
    const windowed = past.filter((h) => h.startMs > nowMs - FALLBACK_WINDOW_MS);
    if (windowed.length) return windowed;
    return past.slice(-48);
  }

  _rebuildHours() {
    this._hours = [...this._days.values()].flat().sort((a, b) => a.startMs - b.startMs);
  }

  async _fetchDay(dateStr, zone) {
    const [y, m, d] = dateStr.split('-');
    const raw = await this._fetch(PRICES_URL(y, m, d, zone));
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`unexpected price response for ${dateStr}`);
    }
    const rows = raw.map((p) => {
      const startMs = Date.parse(p.time_start);
      const endMs = p.time_end ? Date.parse(p.time_end) : startMs + HOUR_MS;
      const spotExVat = Number(p.NOK_per_kWh);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(spotExVat)) {
        throw new Error(`malformed price entry for ${dateStr}`);
      }
      return { startMs, endMs, spotExVat };
    });
    rows.sort((a, b) => a.startMs - b.startMs);
    return rows;
  }

  async _pricesTick() {
    await this.refreshPrices();
    await this._refreshMonthKWh();
  }

  /** Cache metered miner kWh this month (for state()/regime between controller ticks). */
  async _refreshMonthKWh() {
    if (!this.history || typeof this.history.minerKWhThisMonth !== 'function') return;
    try {
      const cfg = this.configStore && typeof this.configStore.get === 'function'
        ? this.configStore.get() : null;
      const miners = (cfg && cfg.miners) || [];
      let total = 0;
      for (const m of miners) total += Number(await this.history.minerKWhThisMonth(m.id)) || 0;
      this._monthMinerKWh = total;
    } catch (e) {
      log('month-kWh refresh failed:', e.message);
    }
  }

  /** Run fn now, then reschedule: normal cadence on success, jittered backoff on failure. */
  async _loop(name, fn, normalMs) {
    const run = async () => {
      if (this._stopped) return;
      try {
        await fn();
        this._failures[name] = 0;
        this._errors[name] = null;
      } catch (e) {
        this._failures[name] += 1;
        this._errors[name] = `${name}: ${e.message}`;
        log(`${name} refresh failed (attempt ${this._failures[name]}):`, e.message);
      }
      if (this._stopped) return;
      const delay = this._failures[name] === 0
        ? normalMs
        : this._backoffMs(this._failures[name], normalMs);
      const t = setTimeout(run, delay);
      if (typeof t.unref === 'function') t.unref();
      this._timers[name] = t;
    };
    await run();
  }

  /** Exponential backoff from 1 min, capped at the loop's normal cadence, ±50% jitter. */
  _backoffMs(failures, capMs) {
    const base = Math.min(capMs, BACKOFF_BASE_MS * 2 ** (failures - 1));
    return Math.round(base * (0.5 + Math.random()));
  }
}

module.exports = { Market, computeMarginalPrice, hourInTz, weekdayInTz, yyyymmddInTz };
