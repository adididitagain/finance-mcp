# finance-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude — or any LLM agent — live financial data: stock quotes, price history, FX rates, crypto prices, SEC filings, as-filed company financials, and macroeconomic indicators.

**No API keys.** Every source is a free public API.

```
You:    How did NVDA do this month, and what did Apple report as revenue last year?

Claude: [get_price_history NVDA] [get_sec_financials AAPL revenue]
        NVDA is up 12.4% over the past month, from $174.20 to $195.83...
        Apple reported $416.16B in revenue for FY2025 (10-K filed 2025-10-31).
```

## Tools

| Tool | What it does |
|------|--------------|
| `get_stock_quote` | Current price, day/52-week range, and volume for stocks, ETFs, and indices |
| `get_price_history` | OHLCV candles plus period return and high/low summary |
| `search_symbols` | Resolve a company name to a ticker |
| `get_fx_rate` | Currency conversion at ECB reference rates |
| `get_crypto_price` | Spot price, 24h change, market cap, volume |
| `get_crypto_market` | Top coins ranked by market cap |
| `get_sec_filings` | Recent EDGAR filings with direct document URLs, filterable by form type |
| `get_sec_financials` | As-filed XBRL line items (revenue, net income, EPS, assets, …) as a time series |
| `search_sec_filings` | Full-text search across all EDGAR filings since 2001 |
| `get_economic_indicator` | World Bank macro series — GDP, inflation, unemployment, debt, trade |

## Data sources

| Source | Used for | Key required |
|--------|----------|--------------|
| [Yahoo Finance](https://finance.yahoo.com) | Equities, ETFs, indices, exotic FX | No |
| [CoinGecko](https://www.coingecko.com/en/api) | Cryptocurrency | No |
| [SEC EDGAR](https://www.sec.gov/edgar) | Filings and XBRL financials | No (User-Agent required) |
| [Frankfurter](https://frankfurter.dev) / ECB | FX reference rates | No |
| [World Bank](https://data.worldbank.org) | Macroeconomic indicators | No |

## Install

```bash
git clone https://github.com/YOUR_USERNAME/finance-mcp.git
cd finance-mcp
npm install
npm run build
```

## Connect it to Claude

### Claude Code

```bash
claude mcp add finance -e SEC_USER_AGENT="Your Name your@email.com" -- node /absolute/path/to/finance-mcp/dist/index.js
```

### Claude Desktop

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "finance": {
      "command": "node",
      "args": ["/absolute/path/to/finance-mcp/dist/index.js"],
      "env": {
        "SEC_USER_AGENT": "Your Name your@email.com"
      }
    }
  }
}
```

### Any other MCP client

The server speaks MCP over stdio. Run `node dist/index.js` and point your client at it.

## Configuration

| Env var | Required | Purpose |
|---------|----------|---------|
| `SEC_USER_AGENT` | For SEC tools | SEC EDGAR [requires](https://www.sec.gov/os/webmaster-faq#developers) a User-Agent with a real name and email on every request, and returns **403** without one. Format: `"Your Name your@email.com"`. |

MCP clients do **not** pass your shell environment to the server, so set `SEC_USER_AGENT` in the client config (as shown above) rather than in your shell profile.

## Try it

```
What's Apple trading at?
Compare BTC and ETH performance over the last 24 hours.
Show me Microsoft's revenue for the last 5 years from their filings.
What 8-Ks has Tesla filed recently?
Which companies mention "quantum computing" in their 10-Ks?
What's India's GDP growth been over the past decade?
Convert 5000 USD to JPY.
```

## Development

```bash
npm run dev     # tsc --watch
npm run build   # compile to dist/
```

Smoke test — starts the server over stdio and exercises every tool against the live APIs:

```bash
SEC_USER_AGENT="Your Name your@email.com" node scripts/smoke.mjs
```

## Notes and limitations

- **Yahoo Finance rate-limits by IP.** Bursts of requests get HTTP 429. The server paces requests per host, retries with exponential backoff, honours `Retry-After`, and falls back between Yahoo's two API hosts — but a heavily used IP can still be throttled for a few minutes. FX is served from the ECB instead, which has no such limit.
- **Quotes may be delayed** up to ~15 minutes, and are not exchange-official.
- **SEC XBRL figures are as-filed.** `get_sec_financials` labels each row by the period it covers, not by the fiscal year of the filing it was read from — a 10-K restating a prior year will show the later filing date against the earlier period.
- **World Bank data is annual** and typically lags one to two years.
- Responses are cached in memory briefly (30s for quotes, longer for filings and macro series) to keep repeated agent calls off the upstream APIs.

## Disclaimer

This is an informational data tool. Nothing it returns is investment advice, and the data carries no accuracy or availability guarantee. Verify anything you intend to act on against an official source.

## License

MIT
