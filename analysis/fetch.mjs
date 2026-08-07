#!/usr/bin/env node
/**
 * Fetch stage. Pulls Form 4 filings for the universe and dumps them raw, one
 * filing per line, with roles and every transaction preserved.
 *
 * Fetching is slow (EDGAR is rate-limited, ~45 minutes for the S&P 100) and the
 * analysis went through several revisions, so the two are separated: fetch once,
 * then re-analyse `filings.jsonl` as often as needed without touching the network.
 *
 *   node analysis/fetch.mjs [--limit 30] [--months 12] [--out analysis/filings.jsonl]
 */
import { createWriteStream } from "node:fs";
import { resolveCik } from "../dist/sources/sec.js";
import { getInsiderActivity } from "../dist/sources/insider.js";
import { UNIVERSE } from "./universe.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const PER_COMPANY = Number(opt("limit", 30));
const MONTHS = Number(opt("months", 12));
const OUT = opt("out", "analysis/filings.jsonl");
const tickers = opt("only", null)?.split(",") ?? UNIVERSE;

if (!process.env.SEC_USER_AGENT) {
  console.error('SEC_USER_AGENT is not set. Export "Your Name your@email.com" and retry.');
  process.exit(1);
}

const since = new Date(Date.now() - MONTHS * 30.44 * 864e5).toISOString().slice(0, 10);
const out = createWriteStream(OUT);
console.error(`Fetching ${tickers.length} companies, filings since ${since}, <=${PER_COMPANY} each\n`);

let done = 0;
const meta = [];
const queue = [...tickers];

await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (queue.length) {
      const ticker = queue.shift();
      try {
        const { cik } = await resolveCik(ticker);
        const a = await getInsiderActivity(cik, PER_COMPANY, since);
        for (const f of a.filings) {
          out.write(
            JSON.stringify({
              ticker,
              company: a.company,
              cik,
              accession: f.accession,
              filedAt: f.filedAt,
              owner: f.owner,
              roles: f.roles,
              url: f.url,
              transactions: f.transactions,
            }) + "\n",
          );
        }
        meta.push({ ticker, company: a.company, filings: a.filings.length, omitted: a.omitted });
        console.error(`[${String(++done).padStart(3)}/${tickers.length}] ${ticker.padEnd(6)} ${String(a.filings.length).padStart(3)} filings  ${a.company.slice(0, 40)}`);
      } catch (err) {
        meta.push({ ticker, error: err.message.split("\n")[0].slice(0, 120) });
        console.error(`[${String(++done).padStart(3)}/${tickers.length}] ${ticker.padEnd(6)} FAILED  ${err.message.split("\n")[0].slice(0, 60)}`);
      }
    }
  }),
);

out.end();
console.error(`\nWrote ${OUT} — ${meta.reduce((s, m) => s + (m.filings ?? 0), 0)} filings`);
console.error(JSON.stringify({ since, months: MONTHS, perCompany: PER_COMPANY, meta }, null, 0).slice(0, 0) || "");
import { writeFileSync } from "node:fs";
writeFileSync(OUT.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ since, months: MONTHS, perCompany: PER_COMPANY, generatedAt: new Date().toISOString().slice(0, 10), meta }, null, 2));
