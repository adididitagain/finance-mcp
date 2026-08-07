# Most "insider selling" is not a decision to sell

I read 2,969 SEC Form 4 filings — every one filed at an S&P 100 company over twelve
months — and classified each by whether the insider actually decided anything.

**71.9% of them contain no decision to trade at all.** At the median company, 83%.

![Most insider selling is not a decision to sell](../assets/insider-study.svg)

## The setup

Officers, directors and 10% owners have to report every trade in their own
company's stock within two business days. The filings are public, structured XML,
and free. Almost nobody reads them, because reading them is tedious — so coverage
collapses each one to a single number, shares disposed of, and calls it selling.

Form 4 doesn't work that way. Every transaction carries a code, and the codes mean
very different things:

- **`S`** — sold on the open market. A decision.
- **`P`** — bought on the open market. A decision.
- **`F`** — shares the company kept to cover the tax bill on vesting. Not a decision.
- **`M`** — an option was exercised. Not a decision.
- **`D`** — shares returned to the issuer. Not a decision.

When an RSU grant vests, the company automatically withholds a slice to pay the
recipient's taxes. That's code `F`. Nobody chose it, nobody could have declined it,
and no shares reached the market. But the shares left the insider's holdings, so a
naive reading counts them as selling.

Here is the same executive in one filing:

```
2026-06-15  +30,100 shares  @ —         Option exercise
2026-06-15  −16,240 shares  @ $296.42   Shares withheld for taxes
```

A headline that says this person "sold $4.8M of stock" isn't lying about the
arithmetic. It's just describing payroll.

## What the numbers say

Of 2,207 filings by individuals that reported any share movement:

| | Share of filings |
|---|---|
| Vesting, option exercise, tax withholding only | **69.2%** |
| Contained an open-market **sale** | 26.2% |
| Gifts only | 2.7% |
| Contained an open-market **purchase** | 1.9% |

Insiders buy far less often than they sell, which is unsurprising — they're paid in
stock, so selling is how compensation becomes money. The point isn't that 26% is a
low number. It's that the other 74% is routinely reported as though it were the
same thing.

## The part I didn't expect

**Corporations file Form 4s too**, as 10% owners. And they are enormous.

53 filings — 1.8% of the sample — accounted for **65% of every disposed share in
the dataset.** The single largest "insider" was Honeywell International Inc,
disposing of 316,939,750 shares of a company it was spinning off. FedEx did the
same with 119.8M.

If you rank insider disposals by share count, the top of the list is not people. It
is companies doing corporate actions. Any screen that sorts by "biggest insider
sales" and doesn't filter on filer type is showing you spinoffs.

## Two things that nearly fooled me

I nearly published a very different number. My first pass pooled raw share counts
and reported that 4.8% of disposed shares were real sales. That figure was junk,
twice over.

**Corporate filers dominated it.** Honeywell and FedEx alone were 63% of the total.
The statistic was mostly describing two spinoffs.

**And one transaction can appear more than once.** A single NVIDIA filing reports
the same gift once per ownership vehicle:

```
29,481,301  → holdings after: 0
29,481,301  → holdings after: 0
58,962,602  → holdings after: 109,040,602     (= 2 × 29,481,301)
```

Direct holdings and each trust get their own row. Summing rows can double-count,
and knowing when it does requires the `ownershipNature` footnotes my parser doesn't
read.

Both problems attack the same thing: pooled share sums. So the headline counts
**filings** instead, which neither can distort. The share-weighted figure is still
in `results.json`, with its caveat attached.

The gap between the two is itself the argument. Pooled across the sample, 10.2% of
shares disposed by individuals were open-market sales. At the median company, 51.6%.
A five-fold difference between the pooled and typical case means a handful of giant
filings are steering the pooled number — which is exactly why you shouldn't quote it.

## Limitations

- **Up to 30 filings per company, most recent first.** Large caps file more than
  that annually, so this is recency-weighted, not a census.
- **709 filings reported no non-derivative rows** and are excluded from the
  denominator. These are grants of options and RSUs, which live in the derivative
  table. Including them would push the "no decision" share *higher*, so 71.9% is
  the conservative figure.
- **XOM is missing.** SEC's ticker file now maps it to "ExxonMobil Holdings Corp",
  a new holding company from their reorganization, which has no Form 4 history —
  the filings sit under the old CIK. 100 of 101 companies resolved.
- **Person vs. corporation is a heuristic**, based on the reporting owner's name
  and roles. It gets Liberty Broadband right (a corporation holding a Charter board
  seat) but it isn't infallible.
- **This describes what was filed.** It is not investment advice, and it makes no
  claim that insider trading predicts returns.

## Reproduce it

```bash
git clone https://github.com/adididitagain/finance-mcp && cd finance-mcp
npm install && npm run build
export SEC_USER_AGENT="Your Name your@email.com"
node analysis/fetch.mjs        # ~45 min, EDGAR is rate-limited
node analysis/analyse.mjs
```

`fetch.mjs` writes every filing to `filings.jsonl`; `analyse.mjs` is offline and
re-runnable, so you can disagree with my classification and rewrite it without
touching the network.

The parsing is from [`finance-mcp`](https://github.com/adididitagain/finance-mcp),
an MCP server that gives LLM agents this data directly — `get_insider_activity`
does this split per company, live.
