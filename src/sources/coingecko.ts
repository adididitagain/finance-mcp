/** CoinGecko public API — crypto spot prices and market rankings. */

import { getJson, UpstreamError } from "../http.js";

const BASE = "https://api.coingecko.com/api/v3";

/** Tickers people actually type, mapped to CoinGecko ids. */
const SYMBOL_ALIASES: Record<string, string> = {
  btc: "bitcoin",
  xbt: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  xrp: "ripple",
  ada: "cardano",
  doge: "dogecoin",
  dot: "polkadot",
  matic: "matic-network",
  pol: "polygon-ecosystem-token",
  avax: "avalanche-2",
  link: "chainlink",
  ltc: "litecoin",
  bch: "bitcoin-cash",
  bnb: "binancecoin",
  trx: "tron",
  atom: "cosmos",
  near: "near",
  apt: "aptos",
  arb: "arbitrum",
  op: "optimism",
  sui: "sui",
  ton: "the-open-network",
  shib: "shiba-inu",
  usdt: "tether",
  usdc: "usd-coin",
  dai: "dai",
  xlm: "stellar",
  algo: "algorand",
  fil: "filecoin",
  hbar: "hedera-hashgraph",
  icp: "internet-computer",
  etc: "ethereum-classic",
  uni: "uniswap",
  aave: "aave",
  mkr: "maker",
  inj: "injective-protocol",
  tia: "celestia",
  sei: "sei-network",
  pepe: "pepe",
  wif: "dogwifcoin",
  bonk: "bonk",
};

export function resolveCoinId(input: string): string {
  const key = input.trim().toLowerCase();
  return SYMBOL_ALIASES[key] ?? key.replace(/\s+/g, "-");
}

export interface CryptoPrice {
  id: string;
  vsCurrency: string;
  price: number | null;
  change24hPct: number | null;
  marketCap: number | null;
  volume24h: number | null;
  lastUpdated: number | null;
}

export async function getCryptoPrices(
  ids: string[],
  vsCurrency: string,
): Promise<CryptoPrice[]> {
  const vs = vsCurrency.toLowerCase();
  const url =
    `${BASE}/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
    `&vs_currencies=${encodeURIComponent(vs)}` +
    `&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true`;

  const data = await getJson<Record<string, Record<string, number>>>(url, {
    source: "CoinGecko",
    ttlMs: 30_000,
  });

  const found = ids.filter((id) => data[id]);
  if (found.length === 0) {
    throw new UpstreamError(
      "CoinGecko",
      null,
      `No CoinGecko coin matched: ${ids.join(", ")}. ` +
        `Use the full coin id (e.g. "bitcoin", "matic-network"), not the exchange ticker.`,
    );
  }

  return found.map((id) => {
    const row = data[id];
    return {
      id,
      vsCurrency: vs,
      price: row[vs] ?? null,
      change24hPct: row[`${vs}_24h_change`] ?? null,
      marketCap: row[`${vs}_market_cap`] ?? null,
      volume24h: row[`${vs}_24h_vol`] ?? null,
      lastUpdated: row.last_updated_at ?? null,
    };
  });
}

export interface CoinMarketRow {
  rank: number | null;
  id: string;
  symbol: string;
  name: string;
  price: number | null;
  change24hPct: number | null;
  change7dPct: number | null;
  marketCap: number | null;
  volume24h: number | null;
}

export async function getTopCoins(limit: number, vsCurrency: string): Promise<CoinMarketRow[]> {
  const vs = vsCurrency.toLowerCase();
  const url =
    `${BASE}/coins/markets?vs_currency=${encodeURIComponent(vs)}` +
    `&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false` +
    `&price_change_percentage=24h,7d`;

  const data = await getJson<
    {
      market_cap_rank: number | null;
      id: string;
      symbol: string;
      name: string;
      current_price: number | null;
      price_change_percentage_24h_in_currency?: number | null;
      price_change_percentage_7d_in_currency?: number | null;
      market_cap: number | null;
      total_volume: number | null;
    }[]
  >(url, { source: "CoinGecko", ttlMs: 60_000 });

  return data.map((c) => ({
    rank: c.market_cap_rank,
    id: c.id,
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    price: c.current_price,
    change24hPct: c.price_change_percentage_24h_in_currency ?? null,
    change7dPct: c.price_change_percentage_7d_in_currency ?? null,
    marketCap: c.market_cap,
    volume24h: c.total_volume,
  }));
}
