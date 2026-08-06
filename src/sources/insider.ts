/**
 * SEC Form 4 — insider transactions.
 *
 * Officers, directors and 10% owners must report trades in their own company's
 * stock within two business days. The filings are public, structured XML, and
 * almost nobody reads them.
 *
 * The important distinction this module makes: most Form 4 activity is
 * *mechanical* — options vesting, shares withheld to cover the tax bill on that
 * vesting — and reflects no decision at all. Headlines routinely report it as
 * "insider dumps stock". Only a few transaction codes represent someone choosing
 * to buy or sell on the open market, and those are separated out here.
 */

import { XMLParser } from "fast-xml-parser";
import { getSecJson, getSecText, UpstreamError } from "../http.js";

const DATA = "https://data.sec.gov";

export type TransactionClass = "open-market" | "mechanical" | "other";

/**
 * SEC Form 4 transaction codes (Table I / II footnotes).
 * `open-market` means the insider actively chose to trade at market prices;
 * everything else is compensation plumbing or a non-market transfer.
 */
const CODES: Record<string, { label: string; klass: TransactionClass }> = {
  P: { label: "Open-market purchase", klass: "open-market" },
  S: { label: "Open-market sale", klass: "open-market" },
  A: { label: "Grant or award", klass: "mechanical" },
  M: { label: "Option exercise / conversion", klass: "mechanical" },
  F: { label: "Shares withheld for taxes", klass: "mechanical" },
  C: { label: "Conversion of derivative", klass: "mechanical" },
  D: { label: "Disposition to the issuer", klass: "mechanical" },
  X: { label: "In-the-money option exercise", klass: "mechanical" },
  G: { label: "Gift", klass: "other" },
  E: { label: "Short derivative expiration", klass: "other" },
  H: { label: "Long derivative expiration", klass: "other" },
  I: { label: "Discretionary transaction", klass: "other" },
  J: { label: "Other acquisition or disposition", klass: "other" },
  K: { label: "Equity swap", klass: "other" },
  L: { label: "Small acquisition", klass: "other" },
  U: { label: "Tender of shares", klass: "other" },
  V: { label: "Reported early, voluntarily", klass: "other" },
  W: { label: "Acquired by will or descent", klass: "other" },
};

export interface InsiderTransaction {
  date: string | null;
  code: string;
  label: string;
  klass: TransactionClass;
  security: string | null;
  shares: number | null;
  pricePerShare: number | null;
  /** shares × price, when both are reported. Mechanical rows often price at 0. */
  value: number | null;
  direction: "acquired" | "disposed" | null;
  sharesOwnedAfter: number | null;
}

export interface InsiderFiling {
  owner: string;
  roles: string[];
  filedAt: string;
  accession: string;
  url: string;
  transactions: InsiderTransaction[];
}

export interface InsiderSummary {
  buys: { filings: number; shares: number; value: number };
  sells: { filings: number; shares: number; value: number };
  mechanicalFilings: number;
  /** Open-market shares acquired minus disposed. Negative means net selling. */
  netOpenMarketShares: number;
  people: string[];
  from: string | null;
  to: string | null;
}

export interface InsiderActivity {
  company: string;
  cik: string;
  filings: InsiderFiling[];
  summary: InsiderSummary;
  /** Form 4s matching the filter that were not fetched because of `limit`. */
  omitted: number;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
});

/** fast-xml-parser collapses single-element lists to a bare object. */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Form 4 wraps most leaf values as `{ value: "..." }`, but not all of them. */
function leaf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number") return String(node);
  if (typeof node === "object" && "value" in (node as Record<string, unknown>)) {
    return leaf((node as Record<string, unknown>).value);
  }
  return null;
}

function num(node: unknown): number | null {
  const text = leaf(node);
  if (text == null) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The ownership schema permits either form for its boolean flags, and filing
 * agents disagree: some emit `<isOfficer>1</isOfficer>`, others `true`.
 * Checking only one silently drops every role filed the other way.
 */
function flag(node: unknown): boolean {
  const text = leaf(node);
  return text != null && ["1", "true", "y", "yes"].includes(text.toLowerCase());
}

/**
 * A full submission `.txt` carries SGML headers around the XML payload, and for
 * paper-era or amended filings may carry more than one document. Take the
 * ownership document.
 */
function extractOwnershipXml(raw: string): string {
  const start = raw.indexOf("<ownershipDocument");
  const end = raw.lastIndexOf("</ownershipDocument>");
  if (start === -1 || end === -1) {
    throw new UpstreamError("SEC EDGAR", null, "Filing contains no ownershipDocument XML");
  }
  return raw.slice(start, end + "</ownershipDocument>".length);
}

export function parseForm4(raw: string, accession: string, url: string, filedAt: string): InsiderFiling {
  const doc = parser.parse(extractOwnershipXml(raw)) as Record<string, any>;
  const od = doc.ownershipDocument ?? {};

  // A single Form 4 can report several owners (e.g. a trust and its trustee).
  const owners = toArray(od.reportingOwner);
  const names = owners.map((o) => leaf(o?.reportingOwnerId?.rptOwnerName)).filter(Boolean) as string[];

  const roles = new Set<string>();
  for (const o of owners) {
    const rel = o?.reportingOwnerRelationship ?? {};
    if (flag(rel.isDirector)) roles.add("Director");
    if (flag(rel.isTenPercentOwner)) roles.add("10% owner");
    if (flag(rel.isOfficer)) roles.add(leaf(rel.officerTitle) ?? "Officer");
    if (flag(rel.isOther)) roles.add(leaf(rel.otherText) ?? "Other");
  }

  // Non-derivative rows are the actual share movements. Derivative rows describe
  // options and RSUs, whose effect on shares held shows up here as an M/X row.
  const rows = toArray(od.nonDerivativeTable?.nonDerivativeTransaction);

  const transactions = rows.map<InsiderTransaction>((t) => {
    const code = (leaf(t?.transactionCoding?.transactionCode) ?? "?").toUpperCase();
    const meta = CODES[code] ?? { label: `Unrecognised code ${code}`, klass: "other" as const };
    const shares = num(t?.transactionAmounts?.transactionShares);
    const price = num(t?.transactionAmounts?.transactionPricePerShare);
    const ad = leaf(t?.transactionAmounts?.transactionAcquiredDisposedCode);
    return {
      date: leaf(t?.transactionDate),
      code,
      label: meta.label,
      klass: meta.klass,
      security: leaf(t?.securityTitle),
      shares,
      pricePerShare: price,
      // A zero price means "not a priced trade" (a grant), not a free purchase.
      value: shares != null && price != null && price > 0 ? shares * price : null,
      direction: ad === "A" ? "acquired" : ad === "D" ? "disposed" : null,
      sharesOwnedAfter: num(t?.postTransactionAmounts?.sharesOwnedFollowingTransaction),
    };
  });

  return {
    owner: names.join(", ") || "Unknown",
    roles: [...roles],
    filedAt,
    accession,
    url,
    transactions,
  };
}

interface SubmissionsResponse {
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
    };
  };
}

export async function getInsiderActivity(
  cik: string,
  limit: number,
  since?: string,
): Promise<InsiderActivity> {
  const data = await getSecJson<SubmissionsResponse>(`${DATA}/submissions/CIK${cik}.json`, {
    ttlMs: 15 * 60 * 1000,
  });

  const r = data.filings.recent;
  const bareCik = String(Number(cik));
  const matches: { accession: string; filedAt: string; url: string }[] = [];

  for (let i = 0; i < r.accessionNumber.length; i++) {
    if (r.form[i] !== "4") continue;
    if (since && r.filingDate[i] < since) continue;
    const accession = r.accessionNumber[i];
    const folder = accession.replace(/-/g, "");
    matches.push({
      accession,
      filedAt: r.filingDate[i],
      // The full submission text always exists at this path, whereas the primary
      // document filename varies between filing agents.
      url: `https://www.sec.gov/Archives/edgar/data/${bareCik}/${folder}/${accession}.txt`,
    });
  }

  const wanted = matches.slice(0, limit);

  // Each filing is a separate fetch. The shared HTTP layer paces requests per
  // host, so these stay inside EDGAR's rate limit without extra bookkeeping.
  const settled = await Promise.allSettled(
    wanted.map(async (m) => parseForm4(await getSecText(m.url, { ttlMs: 6 * 60 * 60 * 1000 }), m.accession, m.url, m.filedAt)),
  );

  const filings = settled
    .filter((s): s is PromiseFulfilledResult<InsiderFiling> => s.status === "fulfilled")
    .map((s) => s.value);

  if (filings.length === 0 && wanted.length > 0) {
    throw new UpstreamError(
      "SEC EDGAR",
      null,
      `Found ${wanted.length} Form 4 filing(s) for ${data.name} but none could be parsed.`,
    );
  }

  return {
    company: data.name,
    cik,
    filings,
    summary: summarise(filings),
    omitted: Math.max(0, matches.length - wanted.length),
  };
}

function summarise(filings: InsiderFiling[]): InsiderSummary {
  const s: InsiderSummary = {
    buys: { filings: 0, shares: 0, value: 0 },
    sells: { filings: 0, shares: 0, value: 0 },
    mechanicalFilings: 0,
    netOpenMarketShares: 0,
    people: [],
    from: null,
    to: null,
  };

  const people = new Set<string>();
  const dates: string[] = [];

  for (const f of filings) {
    people.add(f.owner);
    dates.push(f.filedAt);

    let bought = 0;
    let sold = 0;
    for (const t of f.transactions) {
      if (t.klass !== "open-market" || t.shares == null) continue;
      if (t.direction === "acquired") {
        bought += t.shares;
        s.buys.shares += t.shares;
        s.buys.value += t.value ?? 0;
      } else if (t.direction === "disposed") {
        sold += t.shares;
        s.sells.shares += t.shares;
        s.sells.value += t.value ?? 0;
      }
    }
    if (bought > 0) s.buys.filings++;
    if (sold > 0) s.sells.filings++;
    if (bought === 0 && sold === 0) s.mechanicalFilings++;
  }

  s.netOpenMarketShares = s.buys.shares - s.sells.shares;
  s.people = [...people];
  dates.sort();
  s.from = dates[0] ?? null;
  s.to = dates.at(-1) ?? null;
  return s;
}
