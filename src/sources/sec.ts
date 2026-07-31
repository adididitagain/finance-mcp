/** SEC EDGAR — company filings and XBRL "company concept" financial facts. */

import { getSecJson, UpstreamError } from "../http.js";

const DATA = "https://data.sec.gov";
const DAY = 24 * 60 * 60 * 1000;

/**
 * Plain-English metric names mapped to candidate us-gaap XBRL tags.
 * Filers use different tags for the same line item, so each alias lists
 * fallbacks and we take the first one the company actually reports.
 */
export const CONCEPT_ALIASES: Record<string, string[]> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
  ],
  net_income: ["NetIncomeLoss", "ProfitLoss"],
  gross_profit: ["GrossProfit"],
  operating_income: ["OperatingIncomeLoss"],
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  operating_cash_flow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment"],
  rd_expense: ["ResearchAndDevelopmentExpense"],
  long_term_debt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  shares_outstanding: ["CommonStockSharesOutstanding", "EntityCommonStockSharesOutstanding"],
};

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

let tickerIndex: Map<string, { cik: string; title: string }> | null = null;

async function loadTickerIndex() {
  if (tickerIndex) return tickerIndex;
  const rows = await getSecJson<Record<string, TickerRow>>(
    "https://www.sec.gov/files/company_tickers.json",
    { ttlMs: DAY },
  );
  const index = new Map<string, { cik: string; title: string }>();
  for (const row of Object.values(rows)) {
    index.set(row.ticker.toUpperCase(), {
      cik: String(row.cik_str).padStart(10, "0"),
      title: row.title,
    });
  }
  tickerIndex = index;
  return index;
}

/** Accepts a ticker ("AAPL"), a bare CIK ("320193") or a padded CIK ("CIK0000320193"). */
export async function resolveCik(input: string): Promise<{ cik: string; title: string }> {
  const raw = input.trim();
  const digits = raw.replace(/^CIK/i, "").replace(/\D/g, "");
  if (digits.length > 0 && /^(CIK)?\d[\d-]*$/i.test(raw)) {
    return { cik: digits.padStart(10, "0"), title: raw.toUpperCase() };
  }

  const index = await loadTickerIndex();
  const hit = index.get(raw.toUpperCase());
  if (hit) return hit;

  const needle = raw.toLowerCase();
  for (const [ticker, entry] of index) {
    if (entry.title.toLowerCase().includes(needle)) return { ...entry, title: `${entry.title} (${ticker})` };
  }
  throw new UpstreamError(
    "SEC EDGAR",
    null,
    `Could not resolve "${input}" to a CIK. Try an exact ticker (e.g. AAPL) or a CIK number.`,
  );
}

export interface Filing {
  form: string;
  filingDate: string;
  reportDate: string | null;
  accessionNumber: string;
  primaryDocument: string;
  description: string | null;
  url: string;
  filingIndexUrl: string;
}

interface SubmissionsResponse {
  cik: string;
  name: string;
  tickers?: string[];
  sicDescription?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

export async function getFilings(
  cik: string,
  forms: string[] | undefined,
  limit: number,
): Promise<{ name: string; tickers: string[]; sic: string | null; filings: Filing[] }> {
  const data = await getSecJson<SubmissionsResponse>(`${DATA}/submissions/CIK${cik}.json`, {
    ttlMs: 15 * 60 * 1000,
  });

  const r = data.filings.recent;
  const wanted = forms?.map((f) => f.toUpperCase().trim());
  const bareCik = String(Number(cik));
  const out: Filing[] = [];

  for (let i = 0; i < r.accessionNumber.length && out.length < limit; i++) {
    const form = r.form[i];
    if (wanted && !wanted.some((w) => form.toUpperCase() === w || form.toUpperCase().startsWith(`${w}/`))) {
      continue;
    }
    const accession = r.accessionNumber[i];
    const folder = accession.replace(/-/g, "");
    const base = `https://www.sec.gov/Archives/edgar/data/${bareCik}/${folder}`;
    out.push({
      form,
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i] || null,
      accessionNumber: accession,
      primaryDocument: r.primaryDocument[i],
      description: r.primaryDocDescription[i] || null,
      url: r.primaryDocument[i] ? `${base}/${r.primaryDocument[i]}` : `${base}/`,
      filingIndexUrl: `${base}/${accession}-index.htm`,
    });
  }

  return {
    name: data.name,
    tickers: data.tickers ?? [],
    sic: data.sicDescription ?? null,
    filings: out,
  };
}

export interface FactPoint {
  end: string;
  start: string | null;
  value: number;
  unit: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  form: string;
  filed: string;
}

export interface ConceptResult {
  entityName: string;
  tag: string;
  label: string;
  unit: string;
  points: FactPoint[];
}

interface ConceptResponse {
  entityName: string;
  tag: string;
  label?: string;
  units: Record<
    string,
    { start?: string; end: string; val: number; fy?: number; fp?: string; form: string; filed: string }[]
  >;
}

export async function getConcept(
  cik: string,
  concept: string,
  period: "annual" | "quarterly" | "all",
  limit: number,
): Promise<ConceptResult> {
  const candidates = CONCEPT_ALIASES[concept.toLowerCase()] ?? [concept];
  const errors: string[] = [];

  for (const tag of candidates) {
    let data: ConceptResponse;
    try {
      data = await getSecJson<ConceptResponse>(
        `${DATA}/api/xbrl/companyconcept/CIK${cik}/us-gaap/${encodeURIComponent(tag)}.json`,
        { ttlMs: 6 * 60 * 60 * 1000, retries: 1 },
      );
    } catch (err) {
      // 404 just means this filer doesn't use that tag — try the next candidate.
      // Anything else (throttling, outage) is a real failure worth surfacing.
      if (err instanceof UpstreamError && err.status === 404) {
        errors.push(tag);
        continue;
      }
      throw err;
    }

    const unit = Object.keys(data.units)[0];
    if (!unit) {
      errors.push(tag);
      continue;
    }

    // Multiple filings restate the same period; keep the most recently filed one.
    const byPeriod = new Map<string, (typeof data.units)[string][number]>();
    for (const point of data.units[unit]) {
      const isAnnual = point.form.startsWith("10-K") || point.fp === "FY";
      if (period === "annual" && !isAnnual) continue;
      if (period === "quarterly" && isAnnual) continue;
      const key = `${point.start ?? ""}|${point.end}`;
      const existing = byPeriod.get(key);
      if (!existing || existing.filed < point.filed) byPeriod.set(key, point);
    }

    const points = [...byPeriod.values()]
      .sort((a, b) => (a.end < b.end ? 1 : -1))
      .slice(0, limit)
      .map<FactPoint>((p) => ({
        end: p.end,
        start: p.start ?? null,
        value: p.val,
        unit,
        fiscalYear: p.fy ?? null,
        fiscalPeriod: p.fp ?? null,
        form: p.form,
        filed: p.filed,
      }));

    if (points.length > 0) {
      return {
        entityName: data.entityName,
        tag: data.tag,
        label: data.label ?? data.tag,
        unit,
        points,
      };
    }
    errors.push(tag);
  }

  throw new UpstreamError(
    "SEC EDGAR",
    null,
    `No XBRL data found for "${concept}" (tried: ${errors.join(", ")}). ` +
      `Pass an exact us-gaap tag, or one of: ${Object.keys(CONCEPT_ALIASES).join(", ")}.`,
  );
}

export interface FullTextHit {
  company: string;
  cik: string;
  form: string;
  filedAt: string;
  description: string | null;
  url: string;
}

/**
 * EDGAR full-text search (the engine behind efts.sec.gov/LATEST/search-index).
 * Covers filing documents from 2001 onward.
 */
export async function fullTextSearch(
  query: string,
  forms: string[] | undefined,
  limit: number,
  dateFrom?: string,
  dateTo?: string,
) {
  const params = new URLSearchParams({ q: query, from: "0", size: String(Math.min(limit, 100)) });
  if (forms?.length) params.set("forms", forms.join(","));
  if (dateFrom || dateTo) {
    params.set("dateRange", "custom");
    if (dateFrom) params.set("startdt", dateFrom);
    if (dateTo) params.set("enddt", dateTo);
  }

  const data = await getSecJson<{
    hits: {
      total: { value: number; relation?: string };
      hits: {
        _id: string;
        _source: {
          display_names?: string[];
          ciks?: string[];
          form?: string;
          root_forms?: string[];
          file_date?: string;
          file_description?: string;
        };
      }[];
    };
  }>(`https://efts.sec.gov/LATEST/search-index?${params}`, { ttlMs: 10 * 60 * 1000 });

  const hits = data.hits.hits.slice(0, limit).map<FullTextHit>((h) => {
    // _id looks like "0000320193-24-000123:aapl-20240928.htm"
    const [accession, doc] = h._id.split(":");
    const cik = (h._source.ciks?.[0] ?? "").replace(/^0+/, "");
    const folder = accession.replace(/-/g, "");
    return {
      company: (h._source.display_names ?? []).join(", ") || "n/a",
      cik,
      form: h._source.form ?? h._source.root_forms?.[0] ?? "n/a",
      filedAt: h._source.file_date ?? "n/a",
      description: h._source.file_description ?? null,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${folder}/${doc ?? ""}`,
    };
  });

  return {
    total: data.hits.total.value,
    approximate: data.hits.total.relation === "gte",
    hits,
  };
}
