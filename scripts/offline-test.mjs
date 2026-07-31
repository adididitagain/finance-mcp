#!/usr/bin/env node
/**
 * Offline tests for the Yahoo Finance parsing layer.
 *
 * Yahoo rate-limits aggressively by IP, so the live smoke test can't be relied
 * on in CI. This stubs global fetch with recorded-shape responses and drives the
 * real code path, checking the derived fields (previous close, change, returns).
 *
 * Run with:  node scripts/offline-test.mjs
 */
import assert from "node:assert/strict";

// A 5-day daily chart response, matching the live v8/finance/chart shape.
const CHART_AAPL = {
  chart: {
    error: null,
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "AAPL",
          exchangeName: "NMS",
          fullExchangeName: "NasdaqGS",
          instrumentType: "EQUITY",
          regularMarketTime: 1785441601,
          regularMarketPrice: 333.43,
          fiftyTwoWeekHigh: 344.57,
          fiftyTwoWeekLow: 201.5,
          regularMarketDayHigh: 334.75,
          regularMarketDayLow: 329.59,
          regularMarketVolume: 55501839,
          longName: "Apple Inc.",
          shortName: "Apple Inc.",
          chartPreviousClose: 310.0,
          exchangeTimezoneName: "America/New_York",
        },
        timestamp: [1785009601, 1785096001, 1785182401, 1785355201, 1785441601],
        indicators: {
          quote: [
            {
              open: [312.5, 315.0, 318.2, 322.0, 330.1],
              high: [316.0, 319.4, 321.0, 325.5, 334.75],
              low: [311.0, 313.8, 316.9, 320.4, 329.59],
              close: [315.2, 318.1, 320.9, 321.66, 333.43],
              volume: [41000000, 38500000, 44200000, 50100000, 55501839],
            },
          ],
          adjclose: [{ adjclose: [315.2, 318.1, 320.9, 321.66, 333.43] }],
        },
      },
    ],
  },
};

// Yahoo returns nulls for halted or non-trading intervals.
// Note the distinct symbol: responses are cached by URL, so reusing AAPL here
// would just replay the fixture above.
const CHART_WITH_GAPS = structuredClone(CHART_AAPL);
CHART_WITH_GAPS.chart.result[0].meta.symbol = "GAPS";
CHART_WITH_GAPS.chart.result[0].indicators.quote[0].close = [315.2, null, 320.9, 321.66, 333.43];
CHART_WITH_GAPS.chart.result[0].indicators.quote[0].volume = [41000000, null, 44200000, 50100000, 55501839];

const SEARCH_APPLE = {
  quotes: [
    {
      symbol: "AAPL",
      shortname: "Apple Inc.",
      longname: "Apple Inc.",
      quoteType: "EQUITY",
      typeDisp: "Equity",
      exchDisp: "NASDAQ",
      sectorDisp: "Technology",
      industryDisp: "Consumer Electronics",
    },
    { symbol: "APC.DE", shortname: "Apple Inc. R", quoteType: "EQUITY", typeDisp: "Equity", exchDisp: "XETRA" },
  ],
};

let routes = {};
globalThis.fetch = async (url) => {
  const key = Object.keys(routes).find((k) => String(url).includes(k));
  if (!key) throw new Error(`offline test: unexpected fetch ${url}`);
  const body = routes[key];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const { getQuote, getPriceHistory, searchSymbols } = await import("../dist/sources/yahoo.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\nYahoo parsing (offline fixtures)");

await test("getQuote derives previous close from the prior candle", async () => {
  routes = { "/v8/finance/chart/AAPL": CHART_AAPL };
  const q = await getQuote("AAPL");
  assert.equal(q.symbol, "AAPL");
  assert.equal(q.name, "Apple Inc.");
  assert.equal(q.price, 333.43);
  // Not chartPreviousClose (310.0) — the candle before the latest one.
  assert.equal(q.previousClose, 321.66);
  assert.ok(Math.abs(q.change - 11.77) < 0.001, `change was ${q.change}`);
  assert.ok(Math.abs(q.changePercent - 3.6591) < 0.01, `pct was ${q.changePercent}`);
  assert.equal(q.currency, "USD");
  assert.equal(q.exchange, "NasdaqGS");
});

await test("getQuote tolerates null closes", async () => {
  routes = { "/v8/finance/chart/GAPS": CHART_WITH_GAPS };
  const q = await getQuote("GAPS");
  assert.equal(q.price, 333.43);
  assert.equal(q.previousClose, 321.66);
});

// Yahoo returns candle closes as float32, so the last close rarely matches
// regularMarketPrice exactly even when they are the same trade.
const CHART_FLOAT32 = structuredClone(CHART_AAPL);
CHART_FLOAT32.chart.result[0].meta.symbol = "F32";
CHART_FLOAT32.chart.result[0].indicators.quote[0].close = [
  315.2, 318.1, 320.9, 321.66, 333.4300079345703,
];

await test("getQuote computes a real change despite float32 closes", async () => {
  routes = { "/v8/finance/chart/F32": CHART_FLOAT32 };
  const q = await getQuote("F32");
  assert.equal(q.price, 333.43);
  assert.equal(q.previousClose, 321.66, "must not fall back to today's own close");
  assert.ok(q.change > 11 && q.change < 12, `change was ${q.change}`);
  assert.ok(q.changePercent > 3, `pct was ${q.changePercent}`);
});

await test("getQuote falls back to chartPreviousClose on a 1-candle series", async () => {
  const single = structuredClone(CHART_AAPL);
  single.chart.result[0].meta.symbol = "ONE";
  single.chart.result[0].timestamp = [1785441601];
  single.chart.result[0].indicators.quote[0] = {
    open: [330.1], high: [334.75], low: [329.59], close: [333.43], volume: [55501839],
  };
  single.chart.result[0].indicators.adjclose = [{ adjclose: [333.43] }];
  routes = { "/v8/finance/chart/ONE": single };
  const q = await getQuote("ONE");
  assert.equal(q.previousClose, 310.0);
});

await test("getQuote rejects an error payload", async () => {
  routes = {
    "/v8/finance/chart/BOGUS": {
      chart: { error: { code: "Not Found", description: "No data found, symbol may be delisted" }, result: null },
    },
  };
  await assert.rejects(() => getQuote("BOGUS"), /symbol may be delisted/);
});

await test("getPriceHistory returns candles and drops null closes", async () => {
  routes = { "/v8/finance/chart/GAPS": CHART_WITH_GAPS };
  const h = await getPriceHistory("GAPS", "5d", "1d");
  assert.equal(h.candles.length, 4, "the null close should be filtered out");
  assert.equal(h.candles[0].date, "2026-07-25");
  assert.equal(h.candles.at(-1).close, 333.43);
  assert.equal(h.currency, "USD");
});

await test("getPriceHistory keeps chronological order for return math", async () => {
  routes = { "/v8/finance/chart/AAPL": CHART_AAPL };
  const h = await getPriceHistory("AAPL", "5d", "1d");
  const first = h.candles[0].close;
  const last = h.candles.at(-1).close;
  assert.ok(last > first, "last candle must be the most recent");
  assert.ok(Math.abs(((last - first) / first) * 100 - 5.784) < 0.01);
});

await test("searchSymbols maps result fields", async () => {
  routes = { "/v1/finance/search": SEARCH_APPLE };
  const matches = await searchSymbols("apple", 5);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].symbol, "AAPL");
  assert.equal(matches[0].sector, "Technology");
  assert.equal(matches[1].sector, null);
});

await test("searchSymbols honours the limit", async () => {
  routes = { "/v1/finance/search": SEARCH_APPLE };
  const matches = await searchSymbols("apple", 1);
  assert.equal(matches.length, 1);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}\n`);
