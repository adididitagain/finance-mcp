#!/usr/bin/env node
/**
 * Offline tests for the remaining upstream adapters: CoinGecko, World Bank,
 * Frankfurter/ECB, and EDGAR full-text search.
 *
 * These are mostly field mapping rather than branching logic, so the value here
 * is pinning down the shapes each upstream actually returns — partial results,
 * null-heavy series, and the id/URL derivations that are easy to get subtly
 * wrong and hard to notice.
 *
 * Run with:  node scripts/sources-test.mjs
 */
import assert from "node:assert/strict";

let routes = {};
globalThis.fetch = async (url) => {
  const key = Object.keys(routes).find((k) => String(url).includes(k));
  if (!key) throw new Error(`offline test: unexpected fetch ${url}`);
  const [status, body] = routes[key];
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};

const { resolveCoinId, getCryptoPrices, getTopCoins } = await import("../dist/sources/coingecko.js");
const { getIndicator, INDICATORS } = await import("../dist/sources/worldbank.js");
const { getFxRate, supportedCurrencies } = await import("../dist/sources/frankfurter.js");
const { fullTextSearch } = await import("../dist/sources/sec.js");

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
}

/* ----------------------------------------------------------------- CoinGecko */

console.log("\nCoinGecko (offline fixtures)");

await test("resolveCoinId maps tickers to CoinGecko ids", async () => {
  assert.equal(resolveCoinId("btc"), "bitcoin");
  assert.equal(resolveCoinId("BTC"), "bitcoin", "must be case-insensitive");
  assert.equal(resolveCoinId("  eth  "), "ethereum", "must tolerate whitespace");
  assert.equal(resolveCoinId("matic"), "matic-network");
});

await test("resolveCoinId passes through ids and slugifies free text", async () => {
  assert.equal(resolveCoinId("bitcoin"), "bitcoin");
  assert.equal(resolveCoinId("the open network"), "the-open-network");
});

await test("getCryptoPrices maps the vs-currency keyed fields", async () => {
  routes = {
    "ids=bitcoin": [
      200,
      {
        bitcoin: {
          usd: 65000,
          usd_24h_change: 2.5,
          usd_market_cap: 1.3e12,
          usd_24h_vol: 2.6e10,
          last_updated_at: 1785441601,
        },
      },
    ],
  };
  const [p] = await getCryptoPrices(["bitcoin"], "usd");
  assert.equal(p.price, 65000);
  assert.equal(p.change24hPct, 2.5);
  assert.equal(p.marketCap, 1.3e12);
  assert.equal(p.volume24h, 2.6e10);
  assert.equal(p.lastUpdated, 1785441601);
});

await test("getCryptoPrices honours a non-USD quote currency", async () => {
  routes = {
    "ids=ethereum": [200, { ethereum: { eur: 1700, eur_24h_change: -1.2 } }],
  };
  const [p] = await getCryptoPrices(["ethereum"], "EUR");
  assert.equal(p.vsCurrency, "eur", "currency should be normalised to lowercase");
  assert.equal(p.price, 1700);
  assert.equal(p.change24hPct, -1.2);
});

await test("getCryptoPrices returns the coins it found and drops the rest", async () => {
  // Note the encoded comma: the id list is URL-encoded, so "a,b" arrives as "a%2Cb".
  routes = { "ids=solana%2Cnotacoin": [200, { solana: { usd: 140 } }] };
  const out = await getCryptoPrices(["solana", "notacoin"], "usd");
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "solana");
});

await test("getCryptoPrices throws when nothing matched", async () => {
  routes = { "ids=notacoin": [200, {}] };
  await assert.rejects(() => getCryptoPrices(["notacoin"], "usd"), /No CoinGecko coin matched/);
});

await test("getTopCoins uppercases symbols and maps both change windows", async () => {
  routes = {
    "coins/markets": [
      200,
      [
        {
          market_cap_rank: 1,
          id: "bitcoin",
          symbol: "btc",
          name: "Bitcoin",
          current_price: 65000,
          price_change_percentage_24h_in_currency: 1.1,
          price_change_percentage_7d_in_currency: -0.6,
          market_cap: 1.3e12,
          total_volume: 2.6e10,
        },
      ],
    ],
  };
  const [c] = await getTopCoins(1, "usd");
  assert.equal(c.symbol, "BTC");
  assert.equal(c.change24hPct, 1.1);
  assert.equal(c.change7dPct, -0.6);
});

/* ---------------------------------------------------------------- World Bank */

console.log("\nWorld Bank (offline fixtures)");

const wbRow = (year, value, country = "India", iso = "IN") => ({
  indicator: { id: "NY.GDP.MKTP.KD.ZG", value: "GDP growth (annual %)" },
  country: { id: iso, value: country },
  date: String(year),
  value,
});

await test("getIndicator resolves a friendly alias to its indicator code", async () => {
  routes = { [INDICATORS.gdp_growth.code]: [200, [{ page: 1 }, [wbRow(2024, 7.1)]]] };
  const s = await getIndicator("IN", "gdp_growth", 10);
  assert.equal(s.indicatorCode, INDICATORS.gdp_growth.code);
  assert.equal(s.indicator, INDICATORS.gdp_growth.label, "should use our label, not the API's");
  assert.equal(s.country, "India");
});

await test("getIndicator accepts a raw World Bank code", async () => {
  routes = { "SP.POP.TOTL": [200, [{ page: 1 }, [wbRow(2024, 1_400_000_000)]]] };
  const s = await getIndicator("IN", "sp.pop.totl", 5);
  assert.equal(s.indicatorCode, "SP.POP.TOTL", "should be uppercased");
  assert.equal(s.points[0].value, 1_400_000_000);
});

await test("getIndicator drops unreported years but keeps reported ones", async () => {
  // The most recent year or two are routinely null in World Bank series.
  routes = {
    "FP.CPI.TOTL.ZG": [
      200,
      [{ page: 1 }, [wbRow(2026, null), wbRow(2025, null), wbRow(2024, 4.2), wbRow(2023, 5.1)]],
    ],
  };
  const s = await getIndicator("IN", "inflation", 10);
  assert.equal(s.points.length, 2);
  assert.deepEqual(
    s.points.map((p) => p.year),
    ["2024", "2023"],
  );
});

await test("getIndicator honours the limit", async () => {
  routes = {
    "NE.EXP.GNFS.CD": [
      200,
      [{ page: 1 }, [wbRow(2024, 4), wbRow(2023, 3), wbRow(2022, 2), wbRow(2021, 1)]],
    ],
  };
  const s = await getIndicator("IN", "exports", 2);
  assert.equal(s.points.length, 2);
});

await test("getIndicator surfaces the API's error envelope", async () => {
  // World Bank answers a bad code with 200 and a message object, not an error status.
  routes = { "BOGUS.CODE": [200, [{ message: [{ key: "Invalid value", value: "indicator" }] }]] };
  await assert.rejects(() => getIndicator("IN", "bogus.code", 5), /No data for country/);
});

await test("getIndicator rejects a series with no reported values at all", async () => {
  routes = { "GC.DOD.TOTL.GD.ZS": [200, [{ page: 1 }, [wbRow(2024, null), wbRow(2023, null)]]] };
  await assert.rejects(() => getIndicator("IN", "government_debt", 5), /no reported values/);
});

/* --------------------------------------------------------- Frankfurter / ECB */

console.log("\nFrankfurter / ECB (offline fixtures)");

await test("getFxRate takes the latest session and the one before it", async () => {
  routes = {
    "base=USD&symbols=INR": [
      200,
      {
        base: "USD",
        rates: { "2026-07-28": { INR: 95.1 }, "2026-07-29": { INR: 95.65 }, "2026-07-30": { INR: 95.69 } },
      },
    ],
  };
  const r = await getFxRate("usd", "inr");
  assert.equal(r.base, "USD", "codes should be uppercased");
  assert.equal(r.rate, 95.69);
  assert.equal(r.date, "2026-07-30");
  assert.equal(r.previousRate, 95.65, "must be the prior session, not the window start");
  assert.equal(r.previousDate, "2026-07-29");
});

await test("getFxRate handles a single published session", async () => {
  routes = { "base=USD&symbols=CHF": [200, { base: "USD", rates: { "2026-07-30": { CHF: 0.8 } } }] };
  const r = await getFxRate("USD", "CHF");
  assert.equal(r.rate, 0.8);
  assert.equal(r.previousRate, null);
  assert.equal(r.previousDate, null);
});

await test("getFxRate rejects a pair the ECB does not publish", async () => {
  routes = { "base=USD&symbols=XYZ": [200, { base: "USD", rates: {} }] };
  await assert.rejects(() => getFxRate("USD", "XYZ"), /No ECB rate published/);
});

await test("supportedCurrencies returns uppercase codes", async () => {
  routes = { "/currencies": [200, { usd: "US Dollar", eur: "Euro", inr: "Indian Rupee" }] };
  const set = await supportedCurrencies();
  assert.ok(set.has("USD") && set.has("EUR") && set.has("INR"));
  assert.ok(!set.has("usd"), "lowercase should not be present");
});

/* -------------------------------------------------- EDGAR full-text search */

console.log("\nEDGAR full-text search (offline fixtures)");

const ftsBody = (hits, total = hits.length, relation) => [
  200,
  { hits: { total: { value: total, ...(relation ? { relation } : {}) }, hits } },
];

await test("fullTextSearch builds the document URL from the accession and filename", async () => {
  routes = {
    "search-index": ftsBody([
      {
        _id: "0000320193-24-000123:aapl-20240928.htm",
        _source: {
          ciks: ["0000320193"],
          display_names: ["Apple Inc. (AAPL)"],
          form: "10-K",
          file_date: "2024-11-01",
          file_description: "FORM 10-K",
        },
      },
    ]),
  };
  const r = await fullTextSearch("test", undefined, 10);
  const hit = r.hits[0];
  // CIK loses its leading zeros; the accession loses its dashes to form the folder.
  assert.equal(
    hit.url,
    "https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
  );
  assert.equal(hit.cik, "320193");
  assert.equal(hit.form, "10-K");
  assert.equal(hit.company, "Apple Inc. (AAPL)");
});

await test("fullTextSearch flags a capped total as approximate", async () => {
  routes = { "search-index": ftsBody([], 10000, "gte") };
  const r = await fullTextSearch("common phrase", undefined, 10);
  assert.equal(r.approximate, true);
  assert.equal(r.total, 10000);
});

await test("fullTextSearch reports an exact total when not capped", async () => {
  routes = { "search-index": ftsBody([], 7, "eq") };
  const r = await fullTextSearch("rare phrase", undefined, 10);
  assert.equal(r.approximate, false);
  assert.equal(r.total, 7);
});

await test("fullTextSearch falls back to root_forms and tolerates a missing description", async () => {
  routes = {
    "search-index": ftsBody([
      { _id: "0001-24-1:doc.htm", _source: { ciks: ["0000000001"], root_forms: ["8-K"] } },
    ]),
  };
  const r = await fullTextSearch("x", undefined, 5);
  assert.equal(r.hits[0].form, "8-K");
  assert.equal(r.hits[0].description, null);
  assert.equal(r.hits[0].company, "n/a");
});

await test("fullTextSearch caps returned hits at the requested limit", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    _id: `000${i}-24-1:d${i}.htm`,
    _source: { ciks: ["0000000009"], form: "10-K", file_date: "2024-01-01" },
  }));
  routes = { "search-index": ftsBody(many) };
  const r = await fullTextSearch("y", ["10-K"], 3);
  assert.equal(r.hits.length, 3);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}\n`);
