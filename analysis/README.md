# Form 4 disposal study

A question with a checkable answer: **when insiders are reported to have "sold"
stock, how much of that was a decision to sell?**

## Why the question is worth asking

Officers, directors and 10% owners must report trades in their own company's stock
on SEC Form 4 within two business days. Coverage of those filings almost always
reduces them to a single number — shares disposed of — and calls it selling.

But Form 4 assigns every transaction a code, and the codes do not mean the same
thing:

| Code | What happened | A decision? |
|------|---------------|-------------|
| `S` | Sold on the open market | **Yes** |
| `P` | Bought on the open market | **Yes** |
| `F` | Shares withheld by the company to cover tax on vesting | No |
| `M` | Option exercised / derivative converted | No |
| `D` | Returned to the issuer | No |
| `A` | Granted or awarded | No |
| `G` | Given away | Not a market action |

When an RSU grant vests, the company automatically keeps a slice of the shares to
pay the recipient's tax bill. That is code `F`. Nobody chose it, no shares reach
the market, and the insider's decision-making had nothing to do with it — but the
shares left their holdings, so a naive reading counts them as selling.

This study measures how much of the total is which.

## Method

- **Universe:** the S&P 100 (`universe.mjs`) — large, widely-held companies whose
  filings are the ones that actually get written about. GOOG is dropped as a
  duplicate of GOOGL; Berkshire uses EDGAR's `BRK-B`.
- **Window:** trailing 12 months.
- **Source:** each company's Form 4 filings, pulled from EDGAR's full submission
  text and parsed from the `<ownershipDocument>` XML.
- **Measured:** every non-derivative transaction with a direction of *disposed*,
  bucketed by its transaction code and summed in shares.

Shares are the primary unit rather than dollars, because mechanical rows are
frequently filed with a price of zero — they are not priced trades — so a
dollar-weighted total would silently drop them and overstate the very thing being
measured.

## Why the headline counts filings, not shares

The obvious metric — what share of *disposed shares* were open-market sales — is
not usable, and finding out why was most of the work. Two independent problems
break it:

**Corporations file Form 4s.** Honeywell and FedEx each filed as a "10% owner" of
a company they were spinning off, disposing of 317M and 120M shares. Together,
that was 63% of every disposed share in the first pass. Entity filers are now
separated from individuals.

**One transaction can be reported more than once.** A single NVIDIA filing lists
the same gift once per ownership vehicle — direct holdings and each trust get
their own row, and the rows sum to a total that also appears as its own row.
Distinguishing a genuine second transaction from a second view of the same one
requires the `ownershipNature` footnotes this parser does not read.

Both distort pooled share sums and neither distorts a filing count, so the
headline counts filings. The share-weighted figure is still reported in
`results.json` with its caveat. The gap between them is instructive: pooled, 10.2%
of shares disposed by individuals were sales; at the median company, 51.6%.

## Limitations — read these before quoting the number

1. **Up to 30 filings per company, most recent first.** Large caps file more than
   that in a year, so this is a recency-weighted sample, not a census.
2. **709 filings reported no non-derivative rows** and are excluded from the
   denominator — these are option and RSU grants, which live in the derivative
   table. Including them would raise the "no decision" share, so the published
   figure is the conservative one.
3. **XOM is absent.** SEC's ticker file maps it to "ExxonMobil Holdings Corp"
   (CIK 2115436), a post-reorganization holding company with no Form 4 history;
   the filings remain under the old CIK. 100 of 101 companies resolved.
4. **Person vs. corporation is a heuristic** over the reporting owner's name and
   roles. It correctly files Liberty Broadband — a corporation holding a Charter
   board seat — as an entity, but it is not infallible.
5. This is a description of what was filed. It is not investment advice, and it
   does not claim insider trading is or isn't informative about future returns.

## Reproducing

```bash
npm run build
export SEC_USER_AGENT="Your Name your@email.com"
node analysis/fetch.mjs        # ~45 min; EDGAR is rate-limited
node analysis/analyse.mjs > analysis/results.json
node analysis/make-chart.mjs
```

Fetching and analysis are deliberately separate. `fetch.mjs` writes every filing
to `filings.jsonl` (committed, so you can skip the 45 minutes); `analyse.mjs`
touches no network, so the classification can be disagreed with and rewritten
freely.
