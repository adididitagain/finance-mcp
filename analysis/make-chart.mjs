#!/usr/bin/env node
/**
 * Renders analysis/results.json to the README figure.
 *
 * Form: emphasis, not categorical. The story is one number, so a single hue
 * carries the filings that involved a decision and everything else recedes to
 * gray. Every bar is direct-labelled, so identity never rests on color alone.
 *
 *   node analysis/make-chart.mjs [--in analysis/results.json] [--out assets/insider-study.svg]
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const { summary } = JSON.parse(readFileSync(opt("in", "analysis/results.json"), "utf8"));
const OUT = opt("out", "assets/insider-study.svg");
const c = summary.filingClasses;

const denom = c.pureMechanical + c.giftOnly + c.openMarketSale + c.openMarketPurchase + c.both;

// `decision` drives the hue: blue where the insider chose something, gray where
// the shares moved on their own.
const bars = [
  { label: "Vesting, option exercise, tax withholding", n: c.pureMechanical, decision: false },
  { label: "Contained an open-market SALE", n: c.openMarketSale + c.both, decision: true },
  { label: "Gifts only", n: c.giftOnly, decision: false },
  { label: "Contained an open-market PURCHASE", n: c.openMarketPurchase, decision: true },
].filter((b) => b.n > 0);

const W = 880;
const PAD = 36;
const LABEL_W = 292;
const BAR_X = PAD + LABEL_W + 14;
// The reserve on the right has to hold the longest value label ("69.2%  1,527
// filings"); sizing the bars to the full width clips it.
const BAR_MAX = W - BAR_X - 250;
const ROW_H = 36;
const BAR_H = 16;
const TOP = 210;
const H = TOP + bars.length * ROW_H + 92;

const maxN = Math.max(...bars.map((b) => b.n));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Bar with only its data-end rounded, sitting flat on the baseline. */
function barPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2);
  return `M${x} ${y} H${x + w - rr} A${rr} ${rr} 0 0 1 ${x + w} ${y + rr} V${y + h - rr} A${rr} ${rr} 0 0 1 ${x + w - rr} ${y + h} H${x} Z`;
}

const rows = bars
  .map((b, i) => {
    const y = TOP + i * ROW_H;
    const w = Math.max(3, (b.n / maxN) * BAR_MAX);
    const pct = (b.n / denom) * 100;
    const k = b.decision ? "key" : "ctx";
    return `    <text class="lbl lbl-${k}" x="${PAD + LABEL_W}" y="${y + BAR_H - 3}" text-anchor="end">${esc(b.label)}</text>
    <path class="mark-${k}" d="${barPath(BAR_X, y, w, BAR_H)}"/>
    <text class="val val-${k}" x="${BAR_X + w + 11}" y="${y + BAR_H - 3}">${pct.toFixed(1)}%<tspan class="sub">  ${b.n.toLocaleString()}</tspan></text>`;
  })
  .join("\n");

const hero = summary.pctFilingsWithNoMarketDecision;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Of ${denom.toLocaleString()} SEC Form 4 filings by insiders at ${summary.companies} S and P 100 companies over ${summary.window.months} months, ${hero} percent contained no decision to trade — they were vesting, option exercises and tax withholding. ${((c.openMarketSale + c.both) / denom * 100).toFixed(1)} percent contained an open-market sale.">
  <title>Most insider Form 4 filings contain no decision to trade</title>
  <desc>SEC Form 4 filings by individual insiders at ${summary.companies} S&amp;P 100 companies, ${summary.window.months} months to ${summary.generatedAt}, classified by whether the filing contains an open-market trade. Filings by corporations and funds are excluded.</desc>
  <style>
    .viz { --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --ink3:#8a8a85;
           --key:#2a78d6; --ctx:#c9c8c2; --rule:#e4e3dd; }
    @media (prefers-color-scheme: dark) {
      .viz { --surface:#1a1a19; --ink:#ffffff; --ink2:#c3c2b7; --ink3:#8a8a85;
             --key:#3987e5; --ctx:#46453f; --rule:#2f2e2a; }
    }
    text { font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
    .ttl { font-size:20px; font-weight:600; fill:var(--ink); }
    .sub2{ font-size:13px; fill:var(--ink2); }
    .hero{ font-size:66px; font-weight:680; fill:var(--key); letter-spacing:-2px; }
    .hcap{ font-size:14.5px; fill:var(--ink2); }
    .lbl { font-size:13px; }
    .lbl-key { fill:var(--ink); font-weight:600; }
    .lbl-ctx { fill:var(--ink2); }
    .val { font-size:13px; }
    .val-key { fill:var(--ink); font-weight:600; }
    .val-ctx { fill:var(--ink2); }
    .sub { fill:var(--ink3); font-weight:400; }
    .foot{ font-size:11.5px; fill:var(--ink3); }
    .cap { font-size:11px; fill:var(--ink3); letter-spacing:0.6px; }
    .mark-key{ fill:var(--key); }
    .mark-ctx{ fill:var(--ctx); }
    .rule{ stroke:var(--rule); stroke-width:1; }
  </style>

  <g class="viz">
    <rect width="${W}" height="${H}" fill="var(--surface)"/>

    <text class="ttl" x="${PAD}" y="44">Most "insider selling" is not a decision to sell</text>
    <text class="sub2" x="${PAD}" y="68">${denom.toLocaleString()} SEC Form 4 filings by individuals at ${summary.companies} S&amp;P 100 companies · ${summary.window.months} months to ${summary.generatedAt}</text>

    <text class="hero" x="${PAD}" y="140">${hero}%</text>
    <text class="hcap" x="${PAD + 212}" y="124">of insider filings contain no decision to</text>
    <text class="hcap" x="${PAD + 212}" y="144">trade at all — the shares moved on their own.</text>
    <text class="sub2" x="${PAD}" y="172">At the median company it is ${summary.medianCompanyPctFilingsNoDecision}%.</text>

    <line class="rule" x1="${PAD}" y1="${TOP - 30}" x2="${W - PAD}" y2="${TOP - 30}"/>
    <text class="cap" x="${PAD}" y="${TOP - 13}">WHAT THE FILING ACTUALLY REPORTED · SHARE OF FILINGS, AND COUNT</text>

${rows}

    <line class="rule" x1="${PAD}" y1="${H - 70}" x2="${W - PAD}" y2="${H - 70}"/>
    <text class="foot" x="${PAD}" y="${H - 51}">Source: SEC EDGAR Form 4, non-derivative transactions. Up to ${summary.window.perCompanyLimit} filings per company, most recent first.</text>
    <text class="foot" x="${PAD}" y="${H - 34}">Excludes filings by corporations and funds — ${summary.filingsByEntities} such filings accounted for ${((summary.shareWeighted.disposedByEntities / (summary.shareWeighted.disposedByEntities + summary.shareWeighted.disposedByPeople)) * 100).toFixed(0)}% of all disposed shares.</text>
    <text class="foot" x="${PAD}" y="${H - 17}">Reproduce with analysis/fetch.mjs. See analysis/README.md for limitations.</text>
  </g>
</svg>
`;

writeFileSync(OUT, svg);
console.log(`Wrote ${OUT} (${(svg.length / 1024).toFixed(1)}KB) — hero ${hero}%, ${denom.toLocaleString()} filings`);
