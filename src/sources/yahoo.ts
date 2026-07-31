/** Yahoo Finance public chart/search endpoints — equities, ETFs, indices, FX. */

import { getJson, UpstreamError } from "../http.js";

/** Yahoo throttles per host, so a 429 on one is worth retrying on the other. */
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

async function getYahoo<T>(path: string, ttlMs: number): Promise<T> {
  let lastError: unknown;
  for (const host of HOSTS) {
    try {
      // Retries are kept low per host because the fallback host doubles them;
      // hammering a throttled bucket only keeps it empty.
      return await getJson<T>(`${host}${path}`, { source: "Yahoo Finance", ttlMs, retries: 1 });
    } catch (err) {
      lastError = err;
      if (!(err instanceof UpstreamError) || err.status !== 429) throw err;
    }
  }
  throw lastError;
}

interface ChartResponse {
  chart: {
    error: { code: string; description: string } | null;
    result:
      | {
          meta: {
            currency?: string;
            symbol: string;
            fullExchangeName?: string;
            instrumentType?: string;
            regularMarketPrice?: number;
            regularMarketTime?: number;
            regularMarketDayHigh?: number;
            regularMarketDayLow?: number;
            regularMarketVolume?: number;
            fiftyTwoWeekHigh?: number;
            fiftyTwoWeekLow?: number;
            longName?: string;
            shortName?: string;
            chartPreviousClose?: number;
            exchangeTimezoneName?: string;
          };
          timestamp?: number[];
          indicators: {
            quote: {
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }[];
            adjclose?: { adjclose?: (number | null)[] }[];
          };
        }[]
      | null;
  };
}

export interface Candle {
  date: string;
  timestamp: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  adjClose: number | null;
  volume: number | null;
}

export interface Quote {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  instrumentType: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  marketTime: number | null;
  timezone: string;
}

export interface PriceHistory {
  symbol: string;
  name: string;
  currency: string;
  range: string;
  interval: string;
  candles: Candle[];
}

async function chart(symbol: string, range: string, interval: string) {
  const path =
    `/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  // Intraday data moves fast; a short cache still absorbs repeated agent calls.
  const data = await getYahoo<ChartResponse>(path, 30_000);

  if (data.chart.error) {
    throw new UpstreamError("Yahoo Finance", null, `${symbol}: ${data.chart.error.description}`);
  }
  const result = data.chart.result?.[0];
  if (!result) {
    throw new UpstreamError("Yahoo Finance", null, `No data returned for symbol "${symbol}"`);
  }
  return result;
}

function toCandles(result: Awaited<ReturnType<typeof chart>>): Candle[] {
  const timestamps = result.timestamp ?? [];
  const q = result.indicators.quote[0] ?? {};
  const adj = result.indicators.adjclose?.[0]?.adjclose;
  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    timestamp: ts,
    open: q.open?.[i] ?? null,
    high: q.high?.[i] ?? null,
    low: q.low?.[i] ?? null,
    close: q.close?.[i] ?? null,
    adjClose: adj?.[i] ?? null,
    volume: q.volume?.[i] ?? null,
  }));
}

export async function getQuote(symbol: string): Promise<Quote> {
  // 5 daily bars is the cheapest window that also yields a real previous close.
  const result = await chart(symbol, "5d", "1d");
  const m = result.meta;
  const closes = toCandles(result)
    .map((c) => c.close)
    .filter((c): c is number => c != null);

  const price = m.regularMarketPrice ?? closes.at(-1) ?? null;

  // The last daily candle is the current session — the same one regularMarketPrice
  // reflects — so the prior close is the candle before it. Don't try to match the
  // two by value: Yahoo returns candle closes float32-rounded (333.4300079... for
  // a 333.43 quote), so an equality check silently reports a 0.00% daily change.
  // chartPreviousClose is the close before the whole window, so it's only a
  // last resort when the series is too short.
  const previousClose =
    closes.length >= 2 ? closes.at(-2)! : (m.chartPreviousClose ?? closes.at(-1) ?? null);

  const change = price != null && previousClose != null ? price - previousClose : null;

  return {
    symbol: m.symbol,
    name: m.longName ?? m.shortName ?? m.symbol,
    currency: m.currency ?? "USD",
    exchange: m.fullExchangeName ?? "n/a",
    instrumentType: m.instrumentType ?? "n/a",
    price,
    previousClose,
    change,
    changePercent:
      change != null && previousClose ? (change / previousClose) * 100 : null,
    dayHigh: m.regularMarketDayHigh ?? null,
    dayLow: m.regularMarketDayLow ?? null,
    volume: m.regularMarketVolume ?? null,
    fiftyTwoWeekHigh: m.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: m.fiftyTwoWeekLow ?? null,
    marketTime: m.regularMarketTime ?? null,
    timezone: m.exchangeTimezoneName ?? "UTC",
  };
}

export async function getPriceHistory(
  symbol: string,
  range: string,
  interval: string,
): Promise<PriceHistory> {
  const result = await chart(symbol, range, interval);
  return {
    symbol: result.meta.symbol,
    name: result.meta.longName ?? result.meta.shortName ?? result.meta.symbol,
    currency: result.meta.currency ?? "USD",
    range,
    interval,
    candles: toCandles(result).filter((c) => c.close != null),
  };
}

export interface SymbolMatch {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
  sector: string | null;
  industry: string | null;
}

export async function searchSymbols(query: string, limit: number): Promise<SymbolMatch[]> {
  const path =
    `/v1/finance/search?q=${encodeURIComponent(query)}` +
    `&quotesCount=${limit}&newsCount=0&listsCount=0`;
  const data = await getYahoo<{
    quotes?: {
      symbol?: string;
      shortname?: string;
      longname?: string;
      typeDisp?: string;
      quoteType?: string;
      exchDisp?: string;
      sectorDisp?: string;
      industryDisp?: string;
    }[];
  }>(path, 6 * 60 * 60 * 1000);

  return (data.quotes ?? [])
    .filter((q) => q.symbol)
    .slice(0, limit)
    .map((q) => ({
      symbol: q.symbol!,
      name: q.longname ?? q.shortname ?? q.symbol!,
      type: q.typeDisp ?? q.quoteType ?? "n/a",
      exchange: q.exchDisp ?? "n/a",
      sector: q.sectorDisp ?? null,
      industry: q.industryDisp ?? null,
    }));
}
