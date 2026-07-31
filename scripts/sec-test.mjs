#!/usr/bin/env node
/**
 * Offline tests for the SEC EDGAR layer — CIK resolution and the XBRL
 * company-concept fallback chain.
 *
 * This is the most failure-prone code in the project: filers tag the same line
 * item differently, restate prior periods, and mix annual and quarterly facts in
 * one response. Getting any of it wrong returns plausible-looking but wrong
 * financial figures, so it is all pinned down here with stubbed responses.
 *
 * Run with:  node scripts/sec-test.mjs
 */
import assert from "node:assert/strict";

/** Routes are matched by URL substring; each returns [status, body]. */
let routes = {};
globalThis.fetch = async (url) => {
  const key = Object.keys(routes).find((k) => String(url).includes(k));
  if (!key) throw new Error(`offline test: unexpected fetch ${url}`);
  const [status, body] = routes[key];
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};

const TICKERS = [
  200,
  {
    0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
    1: { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORPORATION" },
  },
];

/** Build a companyconcept response with the given USD fact rows. */
const concept = (tag, rows, entityName = "Test Corp") => [
  200,
  { entityName, tag, label: `Label for ${tag}`, units: { USD: rows } },
];

const fact = (start, end, val, form, filed, fp) => ({ start, end, val, form, filed, fp });

const { getConcept, resolveCik, CONCEPT_ALIASES } = await import("../dist/sources/sec.js");

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

console.log("\nSEC EDGAR (offline fixtures)");

/* ------------------------------------------------------------ CIK resolution */

await test("resolveCik maps a ticker to a zero-padded CIK", async () => {
  routes = { "company_tickers.json": TICKERS };
  const { cik, title } = await resolveCik("aapl");
  assert.equal(cik, "0000320193");
  assert.equal(title, "Apple Inc.");
});

await test("resolveCik accepts a bare numeric CIK without a lookup", async () => {
  routes = {}; // any fetch would throw
  const { cik } = await resolveCik("320193");
  assert.equal(cik, "0000320193");
});

await test("resolveCik accepts the CIK0000320193 form", async () => {
  routes = {};
  const { cik } = await resolveCik("CIK0000320193");
  assert.equal(cik, "0000320193");
});

await test("resolveCik falls back to a company-name substring match", async () => {
  routes = { "company_tickers.json": TICKERS };
  const { cik } = await resolveCik("microsoft");
  assert.equal(cik, "0000789019");
});

await test("resolveCik rejects an unknown company", async () => {
  routes = { "company_tickers.json": TICKERS };
  await assert.rejects(() => resolveCik("nonexistent co"), /Could not resolve/);
});

/* -------------------------------------------------------- concept resolution */

await test("getConcept falls through to the next tag on 404", async () => {
  // Apple-style: the filer does not report `Revenues`, only the newer tag.
  const [first, second] = CONCEPT_ALIASES.revenue;
  routes = {
    [`CIK0000000101/us-gaap/${first}.json`]: [404, { error: "not found" }],
    [`CIK0000000101/us-gaap/${second}.json`]: concept(second, [
      fact("2024-01-01", "2024-12-31", 5_000, "10-K", "2025-02-01", "FY"),
    ]),
  };
  const r = await getConcept("0000000101", "revenue", "annual", 5);
  assert.equal(r.tag, second, "should have fallen through to the second candidate");
  assert.equal(r.points[0].value, 5_000);
});

await test("getConcept surfaces a non-404 failure instead of masking it", async () => {
  // A throttle or outage must not be mistaken for "this filer lacks the tag",
  // which would silently return a different metric than the caller asked for.
  const [first] = CONCEPT_ALIASES.revenue;
  routes = {
    [`CIK0000000102/us-gaap/${first}.json`]: [403, { error: "forbidden" }],
  };
  await assert.rejects(
    () => getConcept("0000000102", "revenue", "annual", 5),
    (err) => {
      assert.match(err.message, /403|rejected/i);
      assert.doesNotMatch(err.message, /No XBRL data found/);
      return true;
    },
  );
});

await test("getConcept reports every tag it tried when all 404", async () => {
  routes = Object.fromEntries(
    CONCEPT_ALIASES.revenue.map((t) => [`CIK0000000103/us-gaap/${t}.json`, [404, {}]]),
  );
  await assert.rejects(
    () => getConcept("0000000103", "revenue", "annual", 5),
    (err) => {
      assert.match(err.message, /No XBRL data found/);
      for (const t of CONCEPT_ALIASES.revenue) assert.ok(err.message.includes(t), `missing ${t}`);
      return true;
    },
  );
});

await test("getConcept accepts an exact us-gaap tag that is not an alias", async () => {
  routes = {
    "CIK0000000104/us-gaap/ResearchAndDevelopmentExpense.json": concept(
      "ResearchAndDevelopmentExpense",
      [fact("2024-01-01", "2024-12-31", 42, "10-K", "2025-02-01", "FY")],
    ),
  };
  const r = await getConcept("0000000104", "ResearchAndDevelopmentExpense", "annual", 5);
  assert.equal(r.points[0].value, 42);
});

/* ------------------------------------------------------ restatement handling */

await test("getConcept keeps the most recently filed value for a restated period", async () => {
  routes = {
    "CIK0000000105/us-gaap/Assets.json": concept("Assets", [
      fact(null, "2023-12-31", 1_000, "10-K", "2024-02-01", "FY"),
      // Same period, refiled a year later with a corrected figure.
      fact(null, "2023-12-31", 1_250, "10-K", "2025-02-01", "FY"),
    ]),
  };
  const r = await getConcept("0000000105", "assets", "annual", 5);
  assert.equal(r.points.length, 1, "the restated period must not appear twice");
  assert.equal(r.points[0].value, 1_250, "should keep the later filing");
  assert.equal(r.points[0].filed, "2025-02-01");
});

await test("getConcept sorts periods newest first and honours the limit", async () => {
  routes = {
    "CIK0000000106/us-gaap/Assets.json": concept("Assets", [
      fact(null, "2021-12-31", 1, "10-K", "2022-02-01", "FY"),
      fact(null, "2024-12-31", 4, "10-K", "2025-02-01", "FY"),
      fact(null, "2022-12-31", 2, "10-K", "2023-02-01", "FY"),
      fact(null, "2023-12-31", 3, "10-K", "2024-02-01", "FY"),
    ]),
  };
  const r = await getConcept("0000000106", "assets", "annual", 2);
  assert.deepEqual(
    r.points.map((p) => p.end),
    ["2024-12-31", "2023-12-31"],
  );
});

/* -------------------------------------------------------------- period filter */

await test("getConcept annual filter excludes quarterly facts", async () => {
  routes = {
    "CIK0000000107/us-gaap/Assets.json": concept("Assets", [
      fact(null, "2024-12-31", 100, "10-K", "2025-02-01", "FY"),
      fact(null, "2024-09-30", 90, "10-Q", "2024-10-25", "Q3"),
    ]),
  };
  const r = await getConcept("0000000107", "assets", "annual", 10);
  assert.equal(r.points.length, 1);
  assert.equal(r.points[0].form, "10-K");
});

await test("getConcept quarterly filter excludes annual facts", async () => {
  routes = {
    "CIK0000000108/us-gaap/Assets.json": concept("Assets", [
      fact(null, "2024-12-31", 100, "10-K", "2025-02-01", "FY"),
      fact(null, "2024-09-30", 90, "10-Q", "2024-10-25", "Q3"),
    ]),
  };
  const r = await getConcept("0000000108", "assets", "quarterly", 10);
  assert.equal(r.points.length, 1);
  assert.equal(r.points[0].form, "10-Q");
});

await test("getConcept treats an amended 10-K/A as annual", async () => {
  routes = {
    "CIK0000000109/us-gaap/Assets.json": concept("Assets", [
      fact(null, "2024-12-31", 100, "10-K/A", "2025-03-01", "FY"),
    ]),
  };
  const r = await getConcept("0000000109", "assets", "annual", 10);
  assert.equal(r.points.length, 1, "10-K/A must count as an annual filing");
});

await test("getConcept falls through when a tag exists but has no usable rows", async () => {
  // The filer reports the tag, but only for quarters — an annual request should
  // move on to the next candidate rather than returning an empty result.
  const [first, second] = CONCEPT_ALIASES.revenue;
  routes = {
    [`CIK0000000110/us-gaap/${first}.json`]: concept(first, [
      fact("2024-07-01", "2024-09-30", 10, "10-Q", "2024-10-25", "Q3"),
    ]),
    [`CIK0000000110/us-gaap/${second}.json`]: concept(second, [
      fact("2024-01-01", "2024-12-31", 40, "10-K", "2025-02-01", "FY"),
    ]),
  };
  const r = await getConcept("0000000110", "revenue", "annual", 5);
  assert.equal(r.tag, second);
  assert.equal(r.points[0].value, 40);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}\n`);
