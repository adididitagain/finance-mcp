#!/usr/bin/env node
/**
 * Analysis stage. Reads analysis/filings.jsonl and answers: how much of what
 * gets reported as insider selling was a decision to sell?
 *
 * Two things forced the shape of this script, both discovered in a first pass
 * that pooled raw share counts:
 *
 *   1. Corporations file Form 4s. Honeywell and FedEx each filed as a "10% owner"
 *      of a company they were spinning off, disposing of 317M and 120M shares.
 *      Together that was 63% of every disposed share in the sample — none of it
 *      an insider deciding anything. Entity filers are separated out.
 *
 *   2. One filing reports the same gift once per ownership vehicle (direct, and
 *      each trust). Summing rows can therefore double-count, and telling when it
 *      does requires the ownershipNature footnotes this parser does not read.
 *
 * So the headline metric counts FILINGS, which neither problem can distort. The
 * share-weighted figure is reported too, as a secondary number with its caveat.
 */
import { readFileSync } from "node:fs";

const IN = process.argv.includes("--in") ? process.argv[process.argv.indexOf("--in") + 1] : "analysis/filings.jsonl";
const META = IN.replace(/\.jsonl$/, ".meta.json");

const filings = readFileSync(IN, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const meta = JSON.parse(readFileSync(META, "utf8"));

/* ------------------------------------------------- who actually filed this */

/**
 * "co" alone is deliberately absent: it is too easy to hit inside a personal
 * name, and "corp"/"company" already cover the real cases.
 */
const ENTITY_WORDS =
  /\b(inc|corp|corporation|llc|l\.l\.c|lp|l\.p|plc|ltd|holdings?|partners?|group|fund|funds|capital|management|trust|endowment|foundation|associates|ventures|advisors|bancorp|company|securities|n\.a)\b\.?/i;

/**
 * A Form 4 filer is either a person at the company or an institution that owns a
 * lot of it. Only the first is an "insider" in the sense the word is used when
 * these filings get reported.
 *
 * The name is checked BEFORE the roles, because a corporation can hold a board
 * seat: Liberty Broadband files on Charter as both "Director" and "10% owner",
 * and is still a corporation. Trusting the Director role first misfiles it as a
 * person.
 */
function isPerson(f) {
  if (ENTITY_WORDS.test(f.owner)) return false;
  const roles = f.roles ?? [];
  if (roles.some((r) => r === "Director")) return true;
  // A filer whose only relationship is being a large shareholder is usually an
  // institution even when the name gives nothing away.
  if (roles.length > 0 && roles.every((r) => /10%|10 percent/i.test(r))) return false;
  return true;
}

const people = filings.filter(isPerson);
const entities = filings.filter((f) => !isPerson(f));

/* ----------------------------------------------------- classify each filing */

const rows = (f) => f.transactions.filter((t) => t.shares != null);
const has = (f, code) => rows(f).some((t) => t.code === code);

let sale = 0, buy = 0, both = 0, mechanical = 0, giftOnly = 0, empty = 0;
for (const f of people) {
  const r = rows(f);
  if (r.length === 0) { empty++; continue; }
  const s = has(f, "S"), p = has(f, "P");
  if (s && p) both++;
  else if (s) sale++;
  else if (p) buy++;
  else if (r.every((t) => t.code === "G")) giftOnly++;
  else mechanical++;
}

const decided = sale + buy + both;
const withRows = people.length - empty;
const pctNoDecision = ((withRows - decided) / withRows) * 100;

/* -------------------------------------------- share-weighted, for reference */

const byCode = {};
const byCodeEntities = {};
for (const f of people) for (const t of rows(f)) if (t.direction === "disposed") byCode[t.code] = (byCode[t.code] ?? 0) + t.shares;
for (const f of entities) for (const t of rows(f)) if (t.direction === "disposed") byCodeEntities[t.code] = (byCodeEntities[t.code] ?? 0) + t.shares;

const disposedPeople = Object.values(byCode).reduce((a, b) => a + b, 0);
const disposedEntities = Object.values(byCodeEntities).reduce((a, b) => a + b, 0);

/* --------------------------- per-company distribution (robust to outliers) */

const companies = {};
for (const f of people) {
  const c = (companies[f.ticker] ??= { ticker: f.ticker, company: f.company, filings: 0, decided: 0, disposedS: 0, disposedAll: 0 });
  c.filings++;
  if (has(f, "S") || has(f, "P")) c.decided++;
  for (const t of rows(f)) {
    if (t.direction !== "disposed") continue;
    c.disposedAll += t.shares;
    if (t.code === "S") c.disposedS += t.shares;
  }
}
const perCompany = Object.values(companies).sort((a, b) => a.ticker.localeCompare(b.ticker));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const shareRatios = perCompany.filter((c) => c.disposedAll > 0).map((c) => (c.disposedS / c.disposedAll) * 100);
const filingRatios = perCompany.filter((c) => c.filings >= 5).map((c) => ((c.filings - c.decided) / c.filings) * 100);

const summary = {
  generatedAt: meta.generatedAt,
  window: { since: meta.since, months: meta.months, perCompanyLimit: meta.perCompany },
  companies: perCompany.length,
  filingsTotal: filings.length,
  filingsByPeople: people.length,
  filingsByEntities: entities.length,
  // Headline — robust to both the entity problem and the double-counting problem.
  filingClasses: { pureMechanical: mechanical, giftOnly, openMarketSale: sale, openMarketPurchase: buy, both, noTransactions: empty },
  pctFilingsWithNoMarketDecision: +pctNoDecision.toFixed(1),
  pctFilingsWithASale: +(((sale + both) / withRows) * 100).toFixed(1),
  pctFilingsWithAPurchase: +(((buy + both) / withRows) * 100).toFixed(1),
  medianCompanyPctFilingsNoDecision: median(filingRatios) == null ? null : +median(filingRatios).toFixed(1),
  // Secondary, caveated.
  shareWeighted: {
    disposedByPeople: disposedPeople,
    disposedByEntities: disposedEntities,
    peopleByCode: byCode,
    entitiesByCode: byCodeEntities,
    pctOfPeopleDisposalsThatWereSales: disposedPeople ? +(((byCode.S ?? 0) / disposedPeople) * 100).toFixed(1) : null,
    medianCompanyPctDisposalsThatWereSales: median(shareRatios) == null ? null : +median(shareRatios).toFixed(1),
    caveat: "Pooled share sums can double-count a transaction reported once per ownership vehicle, and are dominated by a few very large filings. The filing-count metrics above are the robust ones.",
  },
};

console.log(JSON.stringify({ summary, perCompany }, null, 2));

const pct = (n, d) => ((n / d) * 100).toFixed(1).padStart(5) + "%";
console.error(`\n${"=".repeat(70)}`);
console.error(`${filings.length} Form 4 filings · ${perCompany.length} companies · ${meta.months} months to ${meta.generatedAt}\n`);
console.error(`Filed by people at the company : ${people.length}`);
console.error(`Filed by corporations & funds  : ${entities.length}   (${((disposedEntities / (disposedEntities + disposedPeople)) * 100).toFixed(1)}% of all disposed shares)\n`);
console.error(`Of ${withRows} filings by actual insiders:`);
console.error(`  ${pct(mechanical, withRows)}  vesting / option exercise / tax withholding only — no decision`);
console.error(`  ${pct(giftOnly, withRows)}  gifts only`);
console.error(`  ${pct(sale, withRows)}  contained an open-market SALE`);
console.error(`  ${pct(buy, withRows)}  contained an open-market PURCHASE`);
console.error(`  ${pct(both, withRows)}  contained both`);
console.error(`\n  → ${summary.pctFilingsWithNoMarketDecision}% of insider Form 4 filings contain no decision to trade at all.`);
console.error(`  → median company: ${summary.medianCompanyPctFilingsNoDecision}%\n`);
