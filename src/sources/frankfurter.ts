/**
 * Frankfurter — ECB reference exchange rates, free and unmetered.
 * Preferred over Yahoo for FX because it has no rate limit, but it only
 * covers the ~30 currencies the ECB publishes.
 */

import { getJson, UpstreamError } from "../http.js";

const BASE = "https://api.frankfurter.dev/v1";

export interface FxRate {
  base: string;
  quote: string;
  rate: number;
  date: string;
  previousRate: number | null;
  previousDate: string | null;
}

export async function getFxRate(base: string, quote: string): Promise<FxRate> {
  const from = base.toUpperCase();
  const to = quote.toUpperCase();

  // A 10-day window yields today's rate plus the prior session for the change.
  const start = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const data = await getJson<{
    base: string;
    rates: Record<string, Record<string, number>>;
  }>(`${BASE}/${start}..?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`, {
    source: "Frankfurter",
    ttlMs: 30 * 60 * 1000,
  });

  const dates = Object.keys(data.rates).sort();
  const latest = dates.at(-1);
  if (!latest || data.rates[latest]?.[to] == null) {
    throw new UpstreamError("Frankfurter", null, `No ECB rate published for ${from}/${to}`);
  }

  const prior = dates.at(-2);
  return {
    base: from,
    quote: to,
    rate: data.rates[latest][to],
    date: latest,
    previousRate: prior ? (data.rates[prior]?.[to] ?? null) : null,
    previousDate: prior ?? null,
  };
}

/** Currency codes Frankfurter/ECB publishes. */
export async function supportedCurrencies(): Promise<Set<string>> {
  const data = await getJson<Record<string, string>>(`${BASE}/currencies`, {
    source: "Frankfurter",
    ttlMs: 24 * 60 * 60 * 1000,
  });
  return new Set(Object.keys(data).map((c) => c.toUpperCase()));
}
