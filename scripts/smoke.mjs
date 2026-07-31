#!/usr/bin/env node
/**
 * Smoke test: spins up the server over stdio, lists tools, and calls each one.
 * Run with:  node scripts/smoke.mjs
 * Hits live public APIs, so a failure may just mean an upstream is rate-limiting.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const CALLS = [
  ["get_stock_quote", { symbols: ["AAPL", "^GSPC"] }],
  ["get_price_history", { symbol: "NVDA", range: "1mo", interval: "1d", max_rows: 6 }],
  ["search_symbols", { query: "vanguard s&p 500", limit: 3 }],
  ["get_fx_rate", { from: "USD", to: "INR", amount: 100 }],
  ["get_crypto_price", { coins: ["btc", "eth"], vs_currency: "usd" }],
  ["get_crypto_market", { limit: 5 }],
  ["get_sec_filings", { company: "AAPL", forms: ["10-K"], limit: 3 }],
  ["get_sec_financials", { company: "MSFT", concept: "revenue", period: "annual", limit: 4 }],
  ["search_sec_filings", { query: '"artificial intelligence"', forms: ["10-K"], limit: 3 }],
  ["get_economic_indicator", { country: "IN", indicator: "gdp_growth", limit: 5 }],
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  stderr: "inherit",
  // The SDK sanitizes the child env, so SEC_USER_AGENT has to be passed through
  // explicitly — without it EDGAR answers every request with 403.
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SEC_USER_AGENT: process.env.SEC_USER_AGENT ?? "finance-mcp smoke test you@example.com",
  },
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\n=== ${tools.length} tools registered ===`);
for (const t of tools) console.log(`  ${t.name}`);

let failures = 0;
for (const [name, args] of CALLS) {
  const label = `${name}(${JSON.stringify(args)})`;
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text ?? "").join("\n");
    if (res.isError) {
      failures++;
      console.log(`\n--- FAIL ${label}\n${text}`);
    } else {
      console.log(`\n--- OK ${label}\n${text.slice(0, 900)}`);
    }
  } catch (err) {
    failures++;
    console.log(`\n--- THREW ${label}\n${err?.message ?? err}`);
  }
}

await client.close();
console.log(`\n=== ${CALLS.length - failures}/${CALLS.length} tool calls succeeded ===`);
process.exit(failures ? 1 : 0);
