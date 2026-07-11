'use strict';
/**
 * market.test.js — unit tests for lib/market.js (node:test, no network).
 * Runs with TZ=UTC to prove all local-time derivations go through
 * Intl.DateTimeFormat with the configured timezone, not the process clock.
 */

process.env.TZ = 'UTC';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Market, computeMarginalPrice, hourInTz, weekdayInTz, yyyymmddInTz,
} = require('../lib/market.js');

const TZ = 'Europe/Oslo';
const HOUR_MS = 3600 * 1000;

function approx(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, msg || `${actual} !~ ${expected}`);
}

function baseEl(overrides = {}) {
  return {
    country: 'norway', zone: 'NO5', timezone: TZ, priceMode: 'spot_stromstotte',
    gridFee: { dayWeekday: 0.50, nightWeekend: 0.30, dayStartHour: 6, nightStartHour: 22 },
    householdBaseKWhMonth: 1500, subsidyCapKWhMonth: 5000,
    ...overrides,
  };
}

// -- synthetic hvakosterstrommen day (23/24/25 entries fall out of the tz math)

function localMidnightMs(dateStr) {
  for (const off of ['+01:00', '+02:00']) {
    const ms = Date.parse(`${dateStr}T00:00:00${off}`);
    const iso = new Date(ms).toISOString();
    if (yyyymmddInTz(iso, TZ) === dateStr && hourInTz(iso, TZ) === 0) return ms;
  }
  throw new Error(`no local midnight found for ${dateStr}`);
}

function dayPrices(dateStr, spotFn = () => 0.5) {
  const out = [];
  let ms = localMidnightMs(dateStr);
  let i = 0;
  while (yyyymmddInTz(new Date(ms).toISOString(), TZ) === dateStr) {
    out.push({
      NOK_per_kWh: spotFn(i, ms), EUR_per_kWh: 0.05, EXR: 11.5,
      time_start: new Date(ms).toISOString(),
      time_end: new Date(ms + HOUR_MS).toISOString(),
    });
    ms += HOUR_MS;
    i += 1;
  }
  return out;
}

function makeFetch(days) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const m = url.match(/\/prices\/(\d{4})\/(\d{2})-(\d{2})_(\w+)\.json$/);
    if (m) {
      const dateStr = `${m[1]}-${m[2]}-${m[3]}`;
      const spec = days[dateStr];
      if (!spec) throw new Error('HTTP 404');
      return typeof spec === 'function' ? dayPrices(dateStr, spec) : spec;
    }
    if (url.includes('coingecko')) return { bitcoin: { usd: 100000, nok: 1000000 } };
    if (url.includes('blockchain.info')) return { hash_rate: 8.0e11 }; // GH/s = 8e8 TH/s
    throw new Error(`HTTP 404 ${url}`);
  };
  fn.calls = calls;
  fn.priceCalls = () => calls.filter((u) => u.includes('hvakosterstrommen'));
  return fn;
}

function makeMarket({ days = {}, electricity = baseEl(), start = '2026-01-05T10:00:00Z' } = {}) {
  const clock = { now: new Date(start) };
  const fetchImpl = makeFetch(days);
  const market = new Market({
    configStore: { get: () => ({ electricity, miners: [] }) },
    fetchImpl,
    nowFn: () => clock.now,
  });
  return { market, clock, fetchImpl };
}

// ---------------------------------------------------------------------------
// Timezone helpers (process runs UTC; all answers must be Oslo-local)
// ---------------------------------------------------------------------------

test('tz helpers derive Oslo local time from a UTC process', () => {
  // 23:30Z on Jan 5 = 00:30 Jan 6 in Oslo (CET, +1)
  assert.equal(hourInTz('2026-01-05T23:30:00Z', TZ), 0);
  assert.equal(yyyymmddInTz('2026-01-05T23:30:00Z', TZ), '2026-01-06');
  // Sunday 23:30Z = Monday 00:30 Oslo
  assert.equal(weekdayInTz('2026-01-04T23:30:00Z', TZ), 1);
  assert.equal(weekdayInTz('2026-01-10T12:00:00Z', TZ), 6); // Saturday
  // Summer (CEST, +2): 22:30Z Jul 1 = 00:30 Jul 2
  assert.equal(hourInTz('2026-07-01T22:30:00Z', TZ), 0);
  assert.equal(yyyymmddInTz('2026-07-01T22:30:00Z', TZ), '2026-07-02');
});

// ---------------------------------------------------------------------------
// computeMarginalPrice — the core Norwegian model
// ---------------------------------------------------------------------------

// Jan 31 2026 is a Saturday; day 31/31 → month fraction 1 (projection = actuals).
const SAT_EOM = '2026-01-31T10:00:00Z'; // 11:00 Oslo, weekend fee 0.30

test('stromstotte subsidy below the cap (NO5, 25% VAT)', () => {
  const r = computeMarginalPrice({
    dateIso: SAT_EOM, spotExVatNok: 2.0, electricity: baseEl(), monthMinerKWh: 0,
  });
  // incVat 2.5; subsidy 0.9*(2.5-0.9375)=1.40625; base 1.09375; +0.30 weekend fee
  assert.equal(r.regime, 'subsidised');
  approx(r.marginalPrice, 1.09375 + 0.30);
  approx(r.householdPrice, 1.09375 + 0.30);
  approx(r.components.vat, 0.5);
  approx(r.components.subsidy, 1.40625);
  approx(r.components.gridFee, 0.30);
  // identity: spot + vat - subsidy + gridFee = marginal
  approx(r.components.spot + r.components.vat - r.components.subsidy + r.components.gridFee,
    r.marginalPrice);
});

test('marginal vs household across the cap boundary', () => {
  const el = baseEl(); // household base 1500, cap 5000; fraction 1 on Jan 31
  const under = computeMarginalPrice({ dateIso: SAT_EOM, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 3400 });
  assert.equal(under.regime, 'subsidised'); // 1500+3400=4900 < 5000
  approx(under.marginalPrice, 1.09375 + 0.30);

  const over = computeMarginalPrice({ dateIso: SAT_EOM, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 3500 });
  assert.equal(over.regime, 'over-cap'); // 1500+3500=5000 >= cap
  approx(over.marginalPrice, 2.5 + 0.30); // raw spot inc VAT + fee, no subsidy
  approx(over.householdPrice, 1.09375 + 0.30); // household stays subsidised
  approx(over.components.subsidy, 0);
});

test('over-cap by month-end projection at current rate', () => {
  // Jan 15: day 15/31 elapsed. Projection = 1500 + minerKWh * 31/15.
  const midMonth = '2026-01-15T10:00:00Z'; // Thursday 11:00 Oslo, day fee 0.50
  const el = baseEl();
  const under = computeMarginalPrice({ dateIso: midMonth, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 1690 });
  assert.equal(under.regime, 'subsidised'); // projected ~4992.7 <= 5000
  const over = computeMarginalPrice({ dateIso: midMonth, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 1700 });
  assert.equal(over.regime, 'over-cap'); // projected ~5013.3 > 5000, though soFar ~2426
  approx(over.marginalPrice, 2.5 + 0.50);
});

test('norgespris: flat 0.50 under the cap, raw spot(+VAT) over it', () => {
  const el = baseEl({ priceMode: 'norgespris' });
  const t = '2026-01-15T10:00:00Z'; // day fee 0.50
  const under = computeMarginalPrice({ dateIso: t, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 0 });
  assert.equal(under.regime, 'subsidised');
  approx(under.marginalPrice, 0.50 + 0.50);
  approx(under.householdPrice, 0.50 + 0.50);
  // flat rate applies both ways: cheap spot still costs 0.50
  const cheap = computeMarginalPrice({ dateIso: t, spotExVatNok: 0.2, electricity: el, monthMinerKWh: 0 });
  approx(cheap.marginalPrice, 0.50 + 0.50);
  assert.ok(cheap.components.subsidy < 0);
  const over = computeMarginalPrice({ dateIso: t, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 6000 });
  assert.equal(over.regime, 'over-cap');
  approx(over.marginalPrice, 2.5 + 0.50); // no flat rate over the cap
});

test('NO4 is VAT exempt; the 0.75 ex-VAT threshold applies without VAT uplift', () => {
  const el = baseEl({ zone: 'NO4' });
  const r = computeMarginalPrice({ dateIso: SAT_EOM, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 0 });
  approx(r.components.vat, 0);
  // threshold 0.75 (no VAT in NO4); subsidy 0.9*(2.0-0.75)=1.125; base 0.875
  approx(r.marginalPrice, 0.875 + 0.30);
  const over = computeMarginalPrice({ dateIso: SAT_EOM, spotExVatNok: 2.0, electricity: el, monthMinerKWh: 9000 });
  approx(over.marginalPrice, 2.0 + 0.30);
});

test('negative spot prices are legal inputs', () => {
  const r = computeMarginalPrice({
    dateIso: '2026-01-15T10:00:00Z', spotExVatNok: -0.10, electricity: baseEl(), monthMinerKWh: 0,
  });
  // incVat -0.125, below threshold so no subsidy; + day fee 0.50
  assert.equal(r.regime, 'subsidised');
  approx(r.marginalPrice, -0.125 + 0.50);
  approx(r.components.subsidy, 0);
});

test('grid-fee day/night/weekend windows are Oslo-local, not UTC', () => {
  const fee = (iso) => computeMarginalPrice({
    dateIso: iso, spotExVatNok: 0.5, electricity: baseEl(), monthMinerKWh: 0,
  }).components.gridFee;

  // Winter (CET = UTC+1). Mon Jan 5 2026:
  approx(fee('2026-01-05T05:30:00Z'), 0.50); // 06:30 Oslo → day (05:30 UTC would be night)
  approx(fee('2026-01-05T04:30:00Z'), 0.30); // 05:30 Oslo → night
  approx(fee('2026-01-05T05:00:00Z'), 0.50); // 06:00 Oslo boundary → day
  approx(fee('2026-01-05T20:30:00Z'), 0.50); // 21:30 Oslo → still day
  approx(fee('2026-01-05T21:00:00Z'), 0.30); // 22:00 Oslo boundary → night
  approx(fee('2026-01-05T21:30:00Z'), 0.30); // 22:30 Oslo → night
  // Weekend, regardless of hour:
  approx(fee('2026-01-10T11:00:00Z'), 0.30); // Saturday midday
  approx(fee('2026-01-04T11:00:00Z'), 0.30); // Sunday midday
  // Fri 23:30Z = Sat 00:30 Oslo → weekend+night
  approx(fee('2026-01-09T23:30:00Z'), 0.30);
  // Summer (CEST = UTC+2). Wed Jul 1 2026:
  approx(fee('2026-07-01T04:30:00Z'), 0.50); // 06:30 Oslo → day
  approx(fee('2026-07-01T20:15:00Z'), 0.30); // 22:15 Oslo → night
});

// ---------------------------------------------------------------------------
// Market: tomorrow gate (>= 13:00 Oslo)
// ---------------------------------------------------------------------------

test('tomorrow is not attempted before 13:00 Oslo', async () => {
  const { market, fetchImpl } = makeMarket({
    days: { '2026-01-05': () => 0.5, '2026-01-06': () => 0.5 },
    start: '2026-01-05T11:30:00Z', // 12:30 Oslo
  });
  await market.refreshPrices();
  assert.equal(fetchImpl.priceCalls().length, 1);
  assert.match(fetchImpl.priceCalls()[0], /\/2026\/01-05_NO5\.json$/);
  const s = market.state();
  assert.equal(s.today.length, 24);
  assert.equal(s.tomorrow, null);
  assert.equal(s.horizonEndsAt, '2026-01-05T23:00:00.000Z'); // end of Jan 5 Oslo
  assert.deepEqual(s.errors, []); // absence of tomorrow is expected before the gate
});

test('tomorrow is fetched from 13:00 Oslo onward', async () => {
  const { market, clock, fetchImpl } = makeMarket({
    days: { '2026-01-05': () => 0.5, '2026-01-06': () => 0.5 },
    start: '2026-01-05T12:00:00Z', // exactly 13:00 Oslo
  });
  await market.refreshPrices();
  assert.equal(fetchImpl.priceCalls().length, 2);
  assert.match(fetchImpl.priceCalls()[1], /\/2026\/01-06_NO5\.json$/);
  const s = market.state();
  assert.equal(s.tomorrow.length, 24);
  assert.equal(s.horizonEndsAt, '2026-01-06T23:00:00.000Z');

  // Already-fetched tomorrow is not re-fetched on the next cycle
  clock.now = new Date('2026-01-05T13:00:00Z');
  await market.refreshPrices();
  assert.equal(fetchImpl.priceCalls().filter((u) => u.includes('01-06')).length, 1);
});

test('unpublished tomorrow is a soft failure: recorded, today still fresh', async () => {
  const { market } = makeMarket({
    days: { '2026-01-05': () => 0.5 }, // no tomorrow available
    start: '2026-01-05T13:30:00Z', // 14:30 Oslo
  });
  await market.refreshPrices(); // must not throw
  const s = market.state();
  assert.equal(s.today.length, 24);
  assert.equal(s.tomorrow, null);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /tomorrow/);
});

// ---------------------------------------------------------------------------
// Market: DST transition days
// ---------------------------------------------------------------------------

test('spring-forward day has 23 hourly entries and correct horizon', async () => {
  const { market } = makeMarket({
    days: { '2026-03-29': () => 0.5 }, // last Sunday of March 2026
    start: '2026-03-29T10:00:00Z',
  });
  await market.refreshPrices();
  const s = market.state();
  assert.equal(s.today.length, 23);
  // Local day 00:00 CET → 00:00 CEST next day = 2026-03-28T23:00Z … 2026-03-29T22:00Z
  assert.equal(s.today[0].hourStartIso, '2026-03-28T23:00:00.000Z');
  assert.equal(s.horizonEndsAt, '2026-03-29T22:00:00.000Z');
  // Lookup after the skipped hour still resolves (Sunday → weekend fee 0.30)
  approx(market.marginalPrice('2026-03-29T20:30:00Z', 0), 0.625 + 0.30);
});

test('fall-back day has 25 hourly entries; the repeated local hour resolves', async () => {
  const { market } = makeMarket({
    days: { '2026-10-25': (i) => 0.4 + i * 0.01 }, // last Sunday of October 2026
    start: '2026-10-25T10:00:00Z',
  });
  await market.refreshPrices();
  const s = market.state();
  assert.equal(s.today.length, 25);
  assert.equal(s.today[0].hourStartIso, '2026-10-24T22:00:00.000Z');
  assert.equal(s.horizonEndsAt, '2026-10-25T23:00:00.000Z');
  // 02:xx local occurs twice (00:xxZ CEST and 01:xxZ CET) — distinct spot entries
  const a = market.marginalPrice('2026-10-25T00:30:00Z', 0);
  const b = market.marginalPrice('2026-10-25T01:30:00Z', 0);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// Market: horizon, fallback, priceHours, regime plumbing
// ---------------------------------------------------------------------------

async function loadTwoDays() {
  // Jan 4 flat 0.5; Jan 5 has a spike at 17:00 Oslo (subsidised marginal 1.71875)
  const ctx = makeMarket({
    days: { '2026-01-04': () => 0.5, '2026-01-05': (i) => (i === 17 ? 3.0 : 0.5) },
    start: '2026-01-04T10:00:00Z', // before 13:00 Oslo → no tomorrow attempt
  });
  await ctx.market.refreshPrices();
  ctx.clock.now = new Date('2026-01-05T10:00:00Z');
  await ctx.market.refreshPrices();
  return ctx;
}

test('fallbackPrice = max marginal over trailing 48h once horizon is exhausted', async () => {
  const { market, clock } = await loadTwoDays();
  clock.now = new Date('2026-01-06T10:00:00Z'); // Jan 6 never fetched
  const s = market.state();
  assert.equal(s.horizonEndsAt, '2026-01-05T23:00:00.000Z');
  assert.equal(s.horizonCoversNow, false);
  // Spike hour: incVat 3.75 → base 3.75-0.9*(3.75-0.9375)=1.21875; +0.50 day fee
  approx(s.fallbackPrice, 1.71875);
  approx(s.currentMarginal, 1.71875); // substitute when off-horizon
  approx(market.marginalPrice(clock.now.toISOString(), 0), 1.71875);
});

test('within the horizon the fetch age is irrelevant: hour lookup just works', async () => {
  const { market } = await loadTwoDays();
  const s = market.state();
  assert.equal(s.horizonCoversNow, true);
  approx(s.currentMarginal, 0.625 + 0.50); // 11:00 Oslo Monday, flat 0.5 spot
  assert.equal(s.regime, 'subsidised');
});

test('priceHours covers current hour onward and carries per-hour regime', async () => {
  const { market } = await loadTwoDays();
  const rows = market.priceHours(0);
  assert.equal(rows.length, 13); // Oslo hours 11..23 on Jan 5
  assert.equal(rows[0].hourStartIso, '2026-01-05T10:00:00.000Z');
  assert.ok(rows.every((r) => r.regime === 'subsidised'));
  const spike = rows.find((r) => r.hourStartIso === '2026-01-05T16:00:00.000Z');
  approx(spike.marginalPrice, 1.71875);
  approx(spike.householdPrice, 1.71875);

  const overRows = market.priceHours(6000);
  assert.ok(overRows.every((r) => r.regime === 'over-cap'));
  const overSpike = overRows.find((r) => r.hourStartIso === '2026-01-05T16:00:00.000Z');
  approx(overSpike.marginalPrice, 3.75 + 0.50); // raw inc-VAT spot + fee
  approx(overSpike.householdPrice, 1.71875);    // household always subsidised
});

test('marginalPrice diverges from householdPrice only over the cap', async () => {
  const { market } = await loadTwoDays();
  const spikeIso = '2026-01-05T16:30:00Z';
  approx(market.marginalPrice(spikeIso, 0), 1.71875);
  approx(market.householdPrice(spikeIso), 1.71875);
  approx(market.marginalPrice(spikeIso, 6000), 3.75 + 0.50);
  approx(market.householdPrice(spikeIso), 1.71875);
  assert.equal(market.state().regime, 'over-cap'); // cached month kWh feeds state()
});

test('effectiveComponents decomposition matches the marginal price', async () => {
  const { market } = await loadTwoDays();
  const iso = '2026-01-05T16:30:00Z';
  market.marginalPrice(iso, 0);
  const c = market.effectiveComponents(iso);
  assert.equal(c.regime, 'subsidised');
  approx(c.spot + c.vat - c.subsidy + c.gridFee, market.marginalPrice(iso, 0));
});

// ---------------------------------------------------------------------------
// Market: refresh loops, BTC / network / hashprice, failure policy
// ---------------------------------------------------------------------------

test('start() populates btc, network stats and hashprice; stop() is clean', async () => {
  const { market } = makeMarket({
    days: { '2026-01-05': () => 0.5 },
    start: '2026-01-05T10:00:00Z',
  });
  await market.start();
  const s = market.state();
  assert.equal(s.btcNok, 1000000);
  assert.equal(s.btcUsd, 100000);
  assert.equal(s.networkThs, 8.0e8);
  // 3.125 * 144 / 8e8 * 1e6 = 0.5625 NOK/TH/day
  approx(s.hashpriceNokPerThDay, 0.5625);
  assert.equal(s.today.length, 24);
  assert.deepEqual(s.errors, []);
  market.stop();
});

test('fetch failures never throw out of start(); they land in state().errors', async () => {
  const { market } = makeMarket({ days: {}, start: '2026-01-05T10:00:00Z' }); // all price fetches 404
  await market.start(); // must resolve despite failure
  const s = market.state();
  assert.ok(s.errors.some((e) => e.startsWith('prices:')));
  assert.equal(s.today.length, 0);
  assert.equal(s.horizonEndsAt, null);
  assert.equal(s.fallbackPrice, null); // nothing known at all
  assert.equal(s.currentMarginal, null);
  market.stop();
});

test('fallback uses the CURRENT hour grid fee, not the trailing spike hour fee', async () => {
  // Spike at 02:00 Oslo (night fee 0.30); current hour 11:00 Oslo (day fee 0.50).
  const { market, clock } = makeMarket({
    days: { '2026-01-04': () => 0.5, '2026-01-05': (i) => (i === 1 ? 3.0 : 0.5) },
    start: '2026-01-04T10:00:00Z',
  });
  await market.refreshPrices();
  clock.now = new Date('2026-01-05T10:00:00Z');
  await market.refreshPrices();
  clock.now = new Date('2026-01-06T10:00:00Z'); // 11:00 Oslo, weekday day, Jan 6 never fetched
  const s = market.state();
  assert.equal(s.horizonCoversNow, false);
  // base at the 02:00 spike = 3.75 - 0.9*(3.75-0.9375) = 1.21875; + current day fee 0.50
  approx(s.fallbackPrice, 1.21875 + 0.50);
});
