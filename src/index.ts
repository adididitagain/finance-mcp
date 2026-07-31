#!/usr/bin/env node
/**
 * finance-mcp — an MCP server that gives any LLM agent live financial data.
 *
 * Sources (all free, none require an API key):
 *   Yahoo Finance   equities, ETFs, indices, FX
 *   CoinGecko       crypto spot prices and market rankings
 *   SEC EDGAR       filings + XBRL company financials
 *   World Bank      macroeconomic indicators
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { UpstreamError } from "./http.js";
import { compact, isoDate, isoDateTime, money, num, pct, signed, table } from "./format.js";
import { getPriceHistory, getQuote, searchSymbols } from "./sources/yahoo.js";
import { getCryptoPrices, getTopCoins, resolveCoinId } from "./sources/coingecko.js";
import { getFxRate, supportedCurrencies } from "./sources/frankfurter.js";
import { CONCEPT_ALIASES, fullTextSearch, getConcept, getFilings, resolveCik } from "./sources/sec.js";
import { getIndicator, INDICATORS } from "./sources/worldbank.js";

const server = new McpServer(
  { name: "finance-mcp", version: "0.1.0" },
  {
    instructions:
      "Live financial data: stock/ETF/index quotes and history, FX rates, crypto prices, " +
      "SEC filings and XBRL financials, and World Bank macro indicators. " +
      "All figures come from public sources and are informational only — never present them as investment advice.",
  },
);

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): TextResult => ({ content: [{ type: "text", text }] });

/** Turn thrown errors into a readable tool error instead of a protocol failure. */
async function guard(fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    const message =
      err instanceof UpstreamError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

/* ------------------------------------------------------------------ stocks */

server.registerTool(
  "get_stock_quote",
  {
    title: "Get stock quote",
    description:
      "Current price and daily change for one or more stocks, ETFs, or indices. " +
      "Use Yahoo-style symbols: AAPL, MSFT, VOO, ^GSPC (S&P 500), ^IXIC (Nasdaq), " +
      "RELIANCE.NS (India), 7203.T (Japan). Call search_symbols first if unsure.",
    inputSchema: {
      symbols: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe('Ticker symbols, e.g. ["AAPL", "NVDA", "^GSPC"]'),
    },
  },
  async ({ symbols }) =>
    guard(async () => {
      const results = await Promise.allSettled(symbols.map((s) => getQuote(s)));
      const lines: string[] = [];

      results.forEach((r, i) => {
        if (r.status === "rejected") {
          lines.push(`${symbols[i]}: ${r.reason?.message ?? "lookup failed"}`);
          return;
        }
        const q = r.value;
        lines.push(
          [
            `${q.symbol} — ${q.name}`,
            `  Price:      ${money(q.price, q.currency)}  (${signed(q.change)} / ${pct(q.changePercent)})`,
            `  Prev close: ${money(q.previousClose, q.currency)}`,
            `  Day range:  ${money(q.dayLow, q.currency)} – ${money(q.dayHigh, q.currency)}`,
            `  52w range:  ${money(q.fiftyTwoWeekLow, q.currency)} – ${money(q.fiftyTwoWeekHigh, q.currency)}`,
            `  Volume:     ${compact(q.volume)}`,
            `  Exchange:   ${q.exchange} (${q.instrumentType})`,
            `  As of:      ${isoDateTime(q.marketTime)} UTC`,
          ].join("\n"),
        );
      });

      return ok(lines.join("\n\n") + "\n\nSource: Yahoo Finance. Quotes may be delayed up to 15 minutes.");
    }),
);

server.registerTool(
  "get_price_history",
  {
    title: "Get price history",
    description:
      "Historical OHLCV candles for a stock, ETF, index, or FX pair, plus period return " +
      "and high/low summary. Good for questions like 'how has NVDA done this year?'.",
    inputSchema: {
      symbol: z.string().describe("Ticker symbol, e.g. AAPL"),
      range: z
        .enum(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"])
        .default("6mo")
        .describe("Lookback window"),
      interval: z
        .enum(["1m", "5m", "15m", "30m", "1h", "1d", "1wk", "1mo"])
        .default("1d")
        .describe("Candle size. Intraday intervals only work for short ranges."),
      max_rows: z
        .number()
        .int()
        .min(5)
        .max(400)
        .default(60)
        .describe("Cap on candles returned; the series is downsampled evenly if longer."),
    },
  },
  async ({ symbol, range, interval, max_rows }) =>
    guard(async () => {
      const h = await getPriceHistory(symbol, range, interval);
      if (h.candles.length === 0) {
        return ok(`No candles returned for ${symbol} at range=${range}, interval=${interval}.`);
      }

      const step = Math.ceil(h.candles.length / max_rows);
      const shown = h.candles.filter((_, i) => i % step === 0 || i === h.candles.length - 1);

      const first = h.candles[0].close!;
      const last = h.candles.at(-1)!.close!;
      const closes = h.candles.map((c) => c.close!);
      const high = Math.max(...h.candles.map((c) => c.high ?? c.close!));
      const low = Math.min(...h.candles.map((c) => c.low ?? c.close!));

      const rows = shown.map((c) => [
        interval.endsWith("m") || interval === "1h" ? isoDateTime(c.timestamp) : c.date,
        num(c.open, 4),
        num(c.high, 4),
        num(c.low, 4),
        num(c.close, 4),
        compact(c.volume),
      ]);

      return ok(
        [
          `${h.symbol} — ${h.name}  (${range}, ${interval}, ${h.currency})`,
          "",
          `Period return: ${pct(((last - first) / first) * 100)}  (${money(first, h.currency)} → ${money(last, h.currency)})`,
          `Period high:   ${money(high, h.currency)}`,
          `Period low:    ${money(low, h.currency)}`,
          `Average close: ${money(closes.reduce((a, b) => a + b, 0) / closes.length, h.currency)}`,
          `Candles:       ${h.candles.length}${step > 1 ? ` (showing every ${step}th)` : ""}`,
          "",
          table(["Date", "Open", "High", "Low", "Close", "Volume"], rows),
          "",
          "Source: Yahoo Finance.",
        ].join("\n"),
      );
    }),
);

server.registerTool(
  "search_symbols",
  {
    title: "Search ticker symbols",
    description:
      "Look up ticker symbols by company name or partial text. Use this to resolve " +
      '"Apple" → AAPL before calling the quote or history tools.',
    inputSchema: {
      query: z.string().min(1).describe('Company or fund name, e.g. "Vanguard S&P 500"'),
      limit: z.number().int().min(1).max(20).default(8),
    },
  },
  async ({ query, limit }) =>
    guard(async () => {
      const matches = await searchSymbols(query, limit);
      if (matches.length === 0) return ok(`No symbols matched "${query}".`);
      return ok(
        table(
          ["Symbol", "Name", "Type", "Exchange", "Sector"],
          matches.map((m) => [m.symbol, m.name, m.type, m.exchange, m.sector ?? "—"]),
        ) + "\n\nSource: Yahoo Finance.",
      );
    }),
);

server.registerTool(
  "get_fx_rate",
  {
    title: "Get FX rate",
    description: "Current exchange rate between two currencies, with the day's change.",
    inputSchema: {
      from: z.string().length(3).describe("Base currency code, e.g. USD"),
      to: z.string().length(3).describe("Quote currency code, e.g. INR"),
      amount: z.number().positive().default(1).describe("Amount of the base currency to convert"),
    },
  },
  async ({ from, to, amount }) =>
    guard(async () => {
      const base = from.toUpperCase();
      const quote = to.toUpperCase();

      // ECB rates first — unmetered and authoritative — then Yahoo for pairs
      // outside the ECB's ~30 published currencies.
      const ecb = await supportedCurrencies().catch(() => new Set<string>());
      if (ecb.has(base) && ecb.has(quote)) {
        const r = await getFxRate(base, quote);
        const change = r.previousRate != null ? r.rate - r.previousRate : null;
        const changePct = r.previousRate ? (change! / r.previousRate) * 100 : null;
        return ok(
          [
            `${base}/${quote} = ${num(r.rate, 6)}` +
              (change != null ? `  (${signed(change, 6)} / ${pct(changePct)} vs ${r.previousDate})` : ""),
            `${num(amount)} ${base} = ${num(amount * r.rate, 4)} ${quote}`,
            `Rate date: ${r.date}`,
            "",
            "Source: European Central Bank via Frankfurter. Reference rate, not a dealable quote.",
          ].join("\n"),
        );
      }

      const q = await getQuote(`${base}${quote}=X`);
      if (q.price == null) throw new UpstreamError("Yahoo Finance", null, `No rate for ${base}/${quote}`);
      return ok(
        [
          `${base}/${quote} = ${num(q.price, 6)}  (${signed(q.change, 6)} / ${pct(q.changePercent)} today)`,
          `${num(amount)} ${base} = ${num(amount * q.price, 4)} ${quote}`,
          `Day range: ${num(q.dayLow, 6)} – ${num(q.dayHigh, 6)}`,
          `52w range: ${num(q.fiftyTwoWeekLow, 6)} – ${num(q.fiftyTwoWeekHigh, 6)}`,
          `As of: ${isoDateTime(q.marketTime)} UTC`,
          "",
          "Source: Yahoo Finance. Indicative mid-market rate, not a dealable quote.",
        ].join("\n"),
      );
    }),
);

/* ------------------------------------------------------------------ crypto */

server.registerTool(
  "get_crypto_price",
  {
    title: "Get crypto price",
    description:
      "Spot price, 24h change, market cap, and 24h volume for one or more cryptocurrencies. " +
      'Accepts common tickers ("btc", "eth", "sol") or CoinGecko ids ("bitcoin", "matic-network").',
    inputSchema: {
      coins: z.array(z.string()).min(1).max(25).describe('e.g. ["btc", "eth", "solana"]'),
      vs_currency: z.string().default("usd").describe("Quote currency: usd, eur, inr, jpy, btc, …"),
    },
  },
  async ({ coins, vs_currency }) =>
    guard(async () => {
      const ids = [...new Set(coins.map(resolveCoinId))];
      const prices = await getCryptoPrices(ids, vs_currency);
      const vs = vs_currency.toUpperCase();

      const missing = ids.filter((id) => !prices.some((p) => p.id === id));
      const body = prices
        .map((p) =>
          [
            `${p.id}`,
            `  Price:      ${money(p.price, vs)}`,
            `  24h change: ${pct(p.change24hPct)}`,
            `  Market cap: ${compact(p.marketCap)} ${vs}`,
            `  24h volume: ${compact(p.volume24h)} ${vs}`,
            `  As of:      ${isoDateTime(p.lastUpdated)} UTC`,
          ].join("\n"),
        )
        .join("\n\n");

      return ok(
        body +
          (missing.length ? `\n\nNot found on CoinGecko: ${missing.join(", ")}` : "") +
          "\n\nSource: CoinGecko.",
      );
    }),
);

server.registerTool(
  "get_crypto_market",
  {
    title: "Get top crypto by market cap",
    description:
      "Ranked table of the largest cryptocurrencies by market cap, with 24h and 7d performance.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(15),
      vs_currency: z.string().default("usd"),
    },
  },
  async ({ limit, vs_currency }) =>
    guard(async () => {
      const coins = await getTopCoins(limit, vs_currency);
      const vs = vs_currency.toUpperCase();
      return ok(
        table(
          ["#", "Symbol", "Name", `Price (${vs})`, "24h", "7d", "Mkt cap", "24h vol"],
          coins.map((c) => [
            c.rank ?? "—",
            c.symbol,
            c.name,
            num(c.price, c.price != null && c.price < 1 ? 6 : 2),
            pct(c.change24hPct),
            pct(c.change7dPct),
            compact(c.marketCap),
            compact(c.volume24h),
          ]),
        ) + "\n\nSource: CoinGecko.",
      );
    }),
);

/* --------------------------------------------------------------------- SEC */

server.registerTool(
  "get_sec_filings",
  {
    title: "Get SEC filings",
    description:
      "Recent SEC EDGAR filings for a US-listed company, with direct document URLs. " +
      "Filter by form type (10-K annual report, 10-Q quarterly, 8-K material event, " +
      "4 insider trade, S-1 IPO, 13F fund holdings, DEF 14A proxy).",
    inputSchema: {
      company: z.string().describe('Ticker ("AAPL"), CIK ("320193"), or company name'),
      forms: z
        .array(z.string())
        .optional()
        .describe('Form types to keep, e.g. ["10-K", "8-K"]. Omit for all forms.'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ company, forms, limit }) =>
    guard(async () => {
      const { cik } = await resolveCik(company);
      const result = await getFilings(cik, forms, limit);

      if (result.filings.length === 0) {
        return ok(
          `${result.name} (CIK ${cik}) has no recent filings matching ${forms?.join(", ") ?? "any form"}.`,
        );
      }

      const header = [
        `${result.name}${result.tickers.length ? ` (${result.tickers.join(", ")})` : ""}`,
        `CIK ${cik}${result.sic ? ` · ${result.sic}` : ""}`,
        `EDGAR profile: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`,
      ].join("\n");

      const body = result.filings
        .map(
          (f) =>
            `${f.form}  filed ${f.filingDate}${f.reportDate ? ` (period ${f.reportDate})` : ""}\n` +
            `  ${f.description ?? f.primaryDocument}\n` +
            `  ${f.url}`,
        )
        .join("\n\n");

      return ok(`${header}\n\n${body}\n\nSource: SEC EDGAR.`);
    }),
);

server.registerTool(
  "get_sec_financials",
  {
    title: "Get SEC XBRL financials",
    description:
      "Reported financial line items straight from a company's XBRL filings — revenue, " +
      "net income, EPS, assets, cash, operating cash flow and more, as an annual or " +
      "quarterly time series. These are as-filed figures, not estimates.",
    inputSchema: {
      company: z.string().describe('Ticker ("AAPL"), CIK, or company name'),
      concept: z
        .string()
        .default("revenue")
        .describe(
          `One of: ${Object.keys(CONCEPT_ALIASES).join(", ")} — or an exact us-gaap tag like "NetIncomeLoss".`,
        ),
      period: z.enum(["annual", "quarterly", "all"]).default("annual"),
      limit: z.number().int().min(1).max(40).default(8),
    },
  },
  async ({ company, concept, period, limit }) =>
    guard(async () => {
      const { cik } = await resolveCik(company);
      const result = await getConcept(cik, concept, period, limit);
      const isMoney = result.unit === "USD";

      const rows = result.points.map((p) => [
        p.start ? `${p.start} → ${p.end}` : p.end,
        // EDGAR's fy/fp describe the filing the fact appeared in, not the fact's
        // own period, so a prior-year comparative in a 10-K carries the current
        // year's fy. Label from the period end instead.
        p.end.slice(0, 4),
        isMoney ? compact(p.value) : num(p.value, 4),
        p.form,
        p.filed,
      ]);

      return ok(
        [
          `${result.entityName} — ${result.label}`,
          `XBRL tag: us-gaap:${result.tag} · unit: ${result.unit} · ${period}`,
          "",
          table(["Period", "Yr end", `Value (${result.unit})`, "Form", "Filed"], rows),
          "",
          "Source: SEC EDGAR XBRL company facts. Values are as reported in the named filing;",
          '"Filed" is the filing they were read from, which may restate an earlier figure.',
        ].join("\n"),
      );
    }),
);

server.registerTool(
  "search_sec_filings",
  {
    title: "Full-text search SEC filings",
    description:
      "Search the full text of SEC filings since 2001. Use it to find which companies " +
      'discuss a topic — e.g. "AI data center capex" in 10-Ks. Quote a phrase for exact matching.',
    inputSchema: {
      query: z.string().min(2).describe('Search text; wrap in quotes for an exact phrase'),
      forms: z.array(z.string()).optional().describe('Restrict to form types, e.g. ["10-K"]'),
      date_from: z.string().optional().describe("Earliest filing date, YYYY-MM-DD"),
      date_to: z.string().optional().describe("Latest filing date, YYYY-MM-DD"),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, forms, date_from, date_to, limit }) =>
    guard(async () => {
      const result = await fullTextSearch(query, forms, limit, date_from, date_to);
      if (result.hits.length === 0) return ok(`No filings matched ${query}.`);

      const body = result.hits
        .map(
          (h) =>
            `${h.form}  ${h.filedAt}  ${h.company}\n` +
            `  ${h.description ?? "(primary document)"}\n  ${h.url}`,
        )
        .join("\n\n");

      return ok(
        `${result.approximate ? "≥" : ""}${num(result.total, 0)} matching documents; showing ${result.hits.length}.\n\n` +
          `${body}\n\nSource: SEC EDGAR full-text search.`,
      );
    }),
);

/* ------------------------------------------------------------------- macro */

server.registerTool(
  "get_economic_indicator",
  {
    title: "Get economic indicator",
    description:
      "Macroeconomic time series by country from the World Bank — GDP, GDP growth, " +
      "inflation, unemployment, population, debt, trade balance and more. " +
      "Annual data; the most recent year or two may not be reported yet.",
    inputSchema: {
      country: z
        .string()
        .default("US")
        .describe('ISO code: US, IN, CN, GB, JP, DE — or "WLD" (world), "EUU" (EU)'),
      indicator: z
        .string()
        .default("gdp")
        .describe(`One of: ${Object.keys(INDICATORS).join(", ")} — or a World Bank indicator code.`),
      limit: z.number().int().min(1).max(60).default(10).describe("Number of years, most recent first"),
    },
  },
  async ({ country, indicator, limit }) =>
    guard(async () => {
      const s = await getIndicator(country, indicator, limit);
      const big = s.points.some((p) => Math.abs(p.value) >= 1e6);

      const rows = s.points.map((p, i) => {
        const prev = s.points[i + 1];
        const yoy = prev && prev.value !== 0 ? ((p.value - prev.value) / Math.abs(prev.value)) * 100 : null;
        return [p.year, big ? compact(p.value) : num(p.value, 3), yoy == null ? "—" : pct(yoy, 1)];
      });

      return ok(
        [
          `${s.country} — ${s.indicator}`,
          `Indicator code: ${s.indicatorCode}`,
          "",
          table(["Year", "Value", "YoY"], rows),
          "",
          "Source: World Bank Open Data.",
        ].join("\n"),
      );
    }),
);

/* -------------------------------------------------------------------- main */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout carries the protocol; anything human-readable must go to stderr.
  console.error("finance-mcp running on stdio");
}

main().catch((err) => {
  console.error("finance-mcp failed to start:", err);
  process.exit(1);
});
