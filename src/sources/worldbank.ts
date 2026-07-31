/** World Bank Open Data — macroeconomic indicators, no key required. */

import { getJson, UpstreamError } from "../http.js";

const BASE = "https://api.worldbank.org/v2";

/** Friendly names mapped to World Bank indicator codes. */
export const INDICATORS: Record<string, { code: string; label: string }> = {
  gdp: { code: "NY.GDP.MKTP.CD", label: "GDP (current US$)" },
  gdp_growth: { code: "NY.GDP.MKTP.KD.ZG", label: "GDP growth (annual %)" },
  gdp_per_capita: { code: "NY.GDP.PCAP.CD", label: "GDP per capita (current US$)" },
  inflation: { code: "FP.CPI.TOTL.ZG", label: "Inflation, consumer prices (annual %)" },
  unemployment: { code: "SL.UEM.TOTL.ZS", label: "Unemployment (% of labor force)" },
  population: { code: "SP.POP.TOTL", label: "Population, total" },
  interest_rate: { code: "FR.INR.RINR", label: "Real interest rate (%)" },
  government_debt: { code: "GC.DOD.TOTL.GD.ZS", label: "Central government debt (% of GDP)" },
  exports: { code: "NE.EXP.GNFS.CD", label: "Exports of goods and services (current US$)" },
  imports: { code: "NE.IMP.GNFS.CD", label: "Imports of goods and services (current US$)" },
  current_account: { code: "BN.CAB.XOKA.CD", label: "Current account balance (current US$)" },
  fdi: { code: "BX.KLT.DINV.CD.WD", label: "Foreign direct investment, net inflows (US$)" },
  life_expectancy: { code: "SP.DYN.LE00.IN", label: "Life expectancy at birth (years)" },
  co2: { code: "EN.GHG.CO2.MT.CE.AR5", label: "CO2 emissions (Mt)" },
};

export interface IndicatorSeries {
  country: string;
  countryCode: string;
  indicator: string;
  indicatorCode: string;
  points: { year: string; value: number }[];
}

export async function getIndicator(
  country: string,
  indicator: string,
  limit: number,
): Promise<IndicatorSeries> {
  const known = INDICATORS[indicator.toLowerCase()];
  const code = known?.code ?? indicator.toUpperCase();
  const url =
    `${BASE}/country/${encodeURIComponent(country)}/indicator/${encodeURIComponent(code)}` +
    `?format=json&per_page=${Math.max(limit * 3, 60)}`;

  const body = await getJson<unknown>(url, { source: "World Bank", ttlMs: 12 * 60 * 60 * 1000 });

  if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[1])) {
    const message =
      Array.isArray(body) && typeof body[0] === "object" && body[0] !== null
        ? JSON.stringify(body[0]).slice(0, 200)
        : "no data";
    throw new UpstreamError(
      "World Bank",
      null,
      `No data for country "${country}" / indicator "${indicator}" (${message}). ` +
        `Use an ISO country code (US, IN, CN, EU, WLD) and one of: ${Object.keys(INDICATORS).join(", ")}.`,
    );
  }

  const rows = body[1] as {
    indicator: { id: string; value: string };
    country: { id: string; value: string };
    date: string;
    value: number | null;
  }[];

  const withValues = rows.filter((r) => r.value != null);
  if (withValues.length === 0) {
    throw new UpstreamError(
      "World Bank",
      null,
      `"${indicator}" has no reported values for "${country}".`,
    );
  }

  return {
    country: withValues[0].country.value,
    countryCode: withValues[0].country.id,
    indicator: known?.label ?? withValues[0].indicator.value,
    indicatorCode: code,
    points: withValues.slice(0, limit).map((r) => ({ year: r.date, value: r.value! })),
  };
}
