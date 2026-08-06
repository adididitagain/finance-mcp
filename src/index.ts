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
import { getInsiderActivity } from "./sources/insider.js";

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

/**
 * Every tool here only reads from public APIs: nothing mutates state, and all
 * of them reach hosts outside the client's control. Declaring that up front
 * lets clients skip confirmation prompts and lets agents reason about retries.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

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
      "Latest price and daily change for one or more stocks, ETFs, or indices, from Yahoo Finance. " +
      "Use Yahoo-style symbols: AAPL, MSFT, VOO, ^GSPC (S&P 500), ^IXIC (Nasdaq), " +
      "RELIANCE.NS (India), 7203.T (Japan). Call search_symbols first if you only have a company name. " +
      "Returns a single point in time — use get_price_history for a series or a period return, " +
      "and get_crypto_price for cryptocurrencies, which are not on Yahoo symbols. " +
      "Prices may be delayed up to ~15 minutes and are not exchange-official, so do not treat them " +
      "as execution prices. Symbols are looked up independently: one bad symbol does not fail the rest.",
    annotations: READ_ONLY,
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

      // Every symbol failing is a tool failure, not a result worth reporting.
      if (results.every((r) => r.status === "rejected")) {
        const reasons = results.map(
          (r, i) => `${symbols[i]}: ${(r as PromiseRejectedResult).reason?.message ?? "lookup failed"}`,
        );
        throw new Error(reasons.join("\n"));
      }

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
      "Historical OHLCV candles for a stock, ETF, index, or FX pair from Yahoo Finance, plus the " +
      "period return and a high/low/average summary. Use this for 'how has NVDA done this year?' " +
      "or any question about change over time; use get_stock_quote when you only need the current price. " +
      "Does not cover cryptocurrencies. Intraday intervals (1m–1h) are only retained by Yahoo for short " +
      "ranges — pair them with 1d/5d/1mo, and use 1d or coarser for 1y and beyond, or the response " +
      "comes back empty. Candles with no trade are omitted, so gaps in the series are expected.",
    annotations: READ_ONLY,
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
      "Resolve a company or fund name to a ticker symbol using Yahoo Finance search. " +
      'Call this first whenever you have a name rather than a symbol — "Apple" → AAPL — then pass the ' +
      "symbol to get_stock_quote or get_price_history. Covers equities, ETFs, and indices across global " +
      "exchanges, so the same company may return several listings; prefer the one whose exchange matches " +
      "the market you want. For US-listed companies you need SEC data on, get_sec_filings accepts a " +
      "company name directly and needs no symbol lookup.",
    annotations: READ_ONLY,
    inputSchema: {
      query: z.string().min(1).describe('Company or fund name, e.g. "Vanguard S&P 500"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(8)
        .describe("Maximum matches to return, best match first. Raise it for ambiguous names."),
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
    description:
      "Convert between two currencies at the latest published reference rate, with the change since the " +
      "prior session. Returns both the rate and, when `amount` is given, the converted total. " +
      "Major currencies come from the European Central Bank (published once per business day, so the rate " +
      "is a daily fix rather than a live tick); pairs outside the ECB's ~30 currencies fall back to Yahoo. " +
      "Use get_crypto_price for crypto — BTC and ETH are not currencies here. " +
      "These are indicative mid-market rates, not dealable quotes, so they will not match what a bank charges.",
    annotations: READ_ONLY,
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
      "Spot price, 24h change, market cap, and 24h volume for specific cryptocurrencies you name, " +
      "from CoinGecko. Use this when you know which coins you want; use get_crypto_market instead to " +
      "rank the market or discover the largest coins. " +
      'Accepts common tickers ("btc", "eth", "sol") or CoinGecko ids ("bitcoin", "matic-network"); ' +
      "unknown names are reported back rather than failing the whole call, so a typo returns the other " +
      "coins. Prices are near-real-time but not exchange-official. Stocks and FX are not available here — " +
      "use get_stock_quote and get_fx_rate.",
    annotations: READ_ONLY,
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
      "Ranked table of the largest cryptocurrencies by market cap, with 24h and 7d performance, " +
      "from CoinGecko. Use this to survey or discover the market — 'what are the biggest coins', " +
      "'what moved this week'. When you already know which coins you care about, use get_crypto_price " +
      "instead: it takes explicit names and avoids pulling a whole ranking. " +
      "Always returns the top N by market cap starting at rank 1; there is no paging or filtering, " +
      "so a coin outside the top `limit` will not appear no matter how it performed.",
    annotations: READ_ONLY,
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(15)
        .describe("How many coins to return, ranked from #1 by market cap. Max 100."),
      vs_currency: z
        .string()
        .default("usd")
        .describe(
          "Currency that prices, market caps and volumes are denominated in: usd, eur, inr, jpy, " +
            "or a crypto like btc. Does not filter which coins are returned.",
        ),
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
      "Recent SEC EDGAR filings for one US-listed company, newest first, with direct document URLs " +
      "you can cite or fetch. Filter by form type (10-K annual report, 10-Q quarterly, 8-K material " +
      "event, 4 insider trade, S-1 IPO, 13F fund holdings, DEF 14A proxy); an amended form such as " +
      "10-K/A is returned when you ask for its base form. " +
      "Use this to find documents for a company you can already name. Use search_sec_filings instead to " +
      "search filing text across all companies, and get_sec_financials to read reported numbers rather " +
      "than locate documents. US SEC registrants only — non-US listings do not file with EDGAR.",
    annotations: READ_ONLY,
    inputSchema: {
      company: z.string().describe('Ticker ("AAPL"), CIK ("320193"), or company name'),
      forms: z
        .array(z.string())
        .optional()
        .describe('Form types to keep, e.g. ["10-K", "8-K"]. Omit for all forms.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum filings to return, newest first. Applied after the form filter."),
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
      "Reported financial line items straight from a US company's XBRL filings — revenue, net income, " +
      "EPS, assets, cash, operating cash flow and more — as an annual or quarterly time series. " +
      "These are as-filed audited figures, not analyst estimates or forecasts, so prefer this over any " +
      "market-data tool for fundamentals. Use get_sec_filings instead when you want the documents rather " +
      "than the numbers. " +
      "Each row is labelled by the period it covers; where a later filing restated a period, the most " +
      "recently filed value is returned. Filers tag the same concept differently, so a concept alias is " +
      "tried against several us-gaap tags and the response names the tag actually used — expect the tag " +
      "to differ between companies. US SEC registrants only.",
    annotations: READ_ONLY,
    inputSchema: {
      company: z.string().describe('Ticker ("AAPL"), CIK, or company name'),
      concept: z
        .string()
        .default("revenue")
        .describe(
          `One of: ${Object.keys(CONCEPT_ALIASES).join(", ")} — or an exact us-gaap tag like "NetIncomeLoss".`,
        ),
      period: z
        .enum(["annual", "quarterly", "all"])
        .default("annual")
        .describe(
          '"annual" returns full-year figures from 10-Ks, "quarterly" returns 10-Q periods, ' +
            '"all" returns both interleaved. Annual is the right default for trend questions.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(40)
        .default(8)
        .describe("Maximum periods to return, most recent first. 8 annual periods ≈ 8 fiscal years."),
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
      "Search the full text of every SEC filing since 2001 to find which companies discuss a topic — " +
      'e.g. "AI data center capex" in 10-Ks. Wrap a phrase in double quotes for exact matching; ' +
      "unquoted terms match loosely and return far more noise. " +
      "Use this for discovery across companies. When you already know the company, get_sec_filings is " +
      "more direct. " +
      "Results are ranked by EDGAR's own relevance, which favours companies with your query in their " +
      "*name* — a search for a common term may surface a company called after it ahead of substantive " +
      "discussion. Totals above 10,000 are reported as approximate. Filings before 2001 are not indexed.",
    annotations: READ_ONLY,
    inputSchema: {
      query: z.string().min(2).describe('Search text; wrap in quotes for an exact phrase'),
      forms: z.array(z.string()).optional().describe('Restrict to form types, e.g. ["10-K"]'),
      date_from: z.string().optional().describe("Earliest filing date, YYYY-MM-DD"),
      date_to: z.string().optional().describe("Latest filing date, YYYY-MM-DD"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum matching documents to return, by EDGAR relevance rank."),
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

server.registerTool(
  "get_insider_activity",
  {
    title: "Get insider trading activity",
    description:
      "What a company's own officers, directors and 10% owners have been buying and selling in its " +
      "stock, from their SEC Form 4 filings. Insiders must report within two business days, so this is " +
      "the freshest disclosed signal about a company available anywhere. " +
      "Crucially, it separates **open-market trades** — where someone actively chose to buy or sell — " +
      "from **mechanical** activity like options vesting and shares withheld to pay the tax on that " +
      "vesting. Most reported 'insider selling' is mechanical and means nothing; headlines routinely " +
      "conflate the two. Read the open-market numbers, and treat the mechanical count as noise. " +
      "US SEC registrants only. This reports what was disclosed and does not interpret it — insider " +
      "buying and selling both have innocent explanations, and neither predicts the share price.",
    annotations: READ_ONLY,
    inputSchema: {
      company: z.string().describe('Ticker ("AAPL"), CIK, or company name'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(40)
        .default(15)
        .describe(
          "How many Form 4 filings to read, newest first. Each is a separate SEC request, so keep " +
            "this modest — 15 typically covers a few months at a large company.",
        ),
      since: z
        .string()
        .optional()
        .describe('Only include filings on or after this date, YYYY-MM-DD (e.g. "2026-01-01")'),
    },
  },
  async ({ company, limit, since }) =>
    guard(async () => {
      const { cik } = await resolveCik(company);
      const a = await getInsiderActivity(cik, limit, since);

      if (a.filings.length === 0) {
        return ok(
          `${a.company} (CIK ${cik}) has no Form 4 filings${since ? ` on or after ${since}` : ""}.`,
        );
      }

      const s = a.summary;
      const header = [
        `${a.company} — insider activity`,
        `${a.filings.length} Form 4 filing(s) from ${s.people.length} insider(s), ${s.from} → ${s.to}` +
          (a.omitted ? `  (${a.omitted} older filing(s) not read; raise limit)` : ""),
        "",
        "OPEN-MARKET (a deliberate decision to trade)",
        `  Bought: ${s.buys.filings} filing(s)   ${compact(s.buys.shares)} shares` +
          (s.buys.value > 0 ? `   ≈ ${money(s.buys.value)}` : ""),
        `  Sold:   ${s.sells.filings} filing(s)   ${compact(s.sells.shares)} shares` +
          (s.sells.value > 0 ? `   ≈ ${money(s.sells.value)}` : ""),
        `  Net:    ${signed(s.netOpenMarketShares, 0)} shares`,
        "",
        `MECHANICAL (vesting, option exercises, tax withholding — no decision): ${s.mechanicalFilings} filing(s)`,
      ].join("\n");

      const body = a.filings
        .map((f) => {
          const who = `${f.owner}${f.roles.length ? ` — ${f.roles.join(", ")}` : ""}`;
          const rows = f.transactions.map((t) => {
            const dir = t.direction === "acquired" ? "+" : t.direction === "disposed" ? "−" : " ";
            const flag = t.klass === "open-market" ? "★" : " ";
            return (
              `    ${flag} ${t.date ?? f.filedAt}  ${dir}${compact(t.shares)} @ ` +
              `${t.pricePerShare ? money(t.pricePerShare) : "—"}  ${t.label}` +
              (t.sharesOwnedAfter != null ? `  (holds ${compact(t.sharesOwnedAfter)})` : "")
            );
          });
          return `  ${who}\n    filed ${f.filedAt} · ${f.url}\n${rows.join("\n")}`;
        })
        .join("\n\n");

      return ok(
        `${header}\n\n★ = open-market trade\n\n${body}\n\n` +
          "Source: SEC EDGAR Form 4. Figures are as filed by the insider.",
      );
    }),
);

/* ------------------------------------------------------------------- macro */

server.registerTool(
  "get_economic_indicator",
  {
    title: "Get economic indicator",
    description:
      "Macroeconomic time series by country from the World Bank — GDP, GDP growth, inflation, " +
      "unemployment, population, government debt, trade balance and more — returned newest year first " +
      "with year-over-year change. Use this for country-level economics; it says nothing about any " +
      "individual company or security, which is what the market-data and SEC tools cover. " +
      "Data is **annual only**, so it cannot answer questions about this month or this quarter, and " +
      "reporting lags: the last one or two years are frequently unreported and are omitted rather than " +
      "returned as zero. Coverage varies by country and indicator, so a valid pairing can still be empty.",
    annotations: READ_ONLY,
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
