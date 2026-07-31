/**
 * Tiny fetch wrapper: timeouts, retries, and an in-memory TTL cache.
 * Every upstream here is a free, keyless public API, so being polite about
 * request volume is the whole rate-limit strategy.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * SEC requires a declarative User-Agent carrying real contact info on every
 * request and answers anything else with 403. Set SEC_USER_AGENT to
 * "Your Name your@email.com" — see the README.
 */
export const SEC_USER_AGENT = process.env.SEC_USER_AGENT ?? "finance-mcp contact@example.com";

export const SEC_USER_AGENT_IS_DEFAULT = !process.env.SEC_USER_AGENT;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type CacheEntry = { expires: number; value: unknown };
const cache = new Map<string, CacheEntry>();

/**
 * Minimum gap between requests to the same host. Yahoo answers bursts with 429
 * and SEC's WAF answers them with 403, so requests to one host are queued and
 * spaced rather than fired in parallel.
 */
const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  "query1.finance.yahoo.com": 250,
  "query2.finance.yahoo.com": 250,
  "www.sec.gov": 150,
  "data.sec.gov": 150,
  "efts.sec.gov": 150,
  "api.coingecko.com": 350,
};
const DEFAULT_MIN_INTERVAL_MS = 100;

const hostQueue = new Map<string, Promise<void>>();

/** Serialize per host and hold the configured gap between consecutive calls. */
function paced<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const gap = HOST_MIN_INTERVAL_MS[host] ?? DEFAULT_MIN_INTERVAL_MS;
  const prior = hostQueue.get(host) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // The chain only tracks turn-taking, so swallow errors and add the spacing.
  hostQueue.set(
    host,
    run.then(
      () => sleep(gap),
      () => sleep(gap),
    ),
  );
  return run;
}

export class UpstreamError extends Error {
  constructor(
    readonly source: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export interface GetJsonOptions {
  /** Label used in error messages, e.g. "Yahoo Finance". */
  source: string;
  /** Cache the parsed body for this many ms. 0 disables caching. */
  ttlMs?: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Number of retries on 429/5xx/network errors. */
  retries?: number;
}

/**
 * Throttling shows up as 429 (Yahoo, CoinGecko) or 403 (SEC's WAF), and both
 * clear on their own. Every other 4xx is a real client error — fail fast.
 */
function isRetryable(status: number | null): boolean {
  if (status == null) return true; // network error / timeout
  return status === 429 || status === 403 || status >= 500;
}

export async function getJson<T>(url: string, opts: GetJsonOptions): Promise<T> {
  const { source, ttlMs = 0, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 3 } = opts;

  const cacheKey = `${url}|${JSON.stringify(headers)}`;
  if (ttlMs > 0) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value as T;
  }

  const host = new URL(url).host;
  let lastError: Error | null = null;
  // Rate-limit buckets refill on the order of seconds, so 429 gets a much
  // longer backoff than a transient network blip.
  let backoffMs = 600;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs + Math.random() * 250);
      backoffMs *= 2;
    }

    try {
      // The timeout is armed inside the queue so waiting for a slot never counts against it.
      const res = await paced(host, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": BROWSER_USER_AGENT,
              Accept: "application/json",
              ...headers,
            },
          });
        } finally {
          clearTimeout(timer);
        }
      });

      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        const err = new UpstreamError(
          source,
          res.status,
          res.status === 429
            ? `${source} is rate-limiting this IP (HTTP 429). It usually clears within a minute — retry the call.`
            : `${source} returned HTTP ${res.status}${body ? `: ${body}` : ""}`,
        );
        if (!isRetryable(res.status)) throw err;

        if (res.status === 429) backoffMs = Math.max(backoffMs, 2_000);

        // Honour Retry-After when the server tells us how long to back off.
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await sleep(Math.min(retryAfter * 1000, 10_000));
        }
        lastError = err;
        continue;
      }

      const value = (await res.json()) as T;
      if (ttlMs > 0) cache.set(cacheKey, { expires: Date.now() + ttlMs, value });
      return value;
    } catch (err) {
      if (err instanceof UpstreamError && !isRetryable(err.status)) throw err;
      lastError =
        err instanceof Error
          ? err.name === "AbortError"
            ? new UpstreamError(source, null, `${source} request timed out after ${timeoutMs}ms`)
            : err
          : new Error(String(err));
    }
  }

  throw lastError ?? new UpstreamError(source, null, `${source} request failed`);
}

/** SEC endpoints: same as getJson but with the required declarative User-Agent. */
export async function getSecJson<T>(
  url: string,
  opts: Omit<GetJsonOptions, "source" | "headers">,
): Promise<T> {
  try {
    return await getJson<T>(url, {
      ...opts,
      source: "SEC EDGAR",
      headers: { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" },
    });
  } catch (err) {
    // A 403 from EDGAR almost always means the User-Agent was rejected.
    if (err instanceof UpstreamError && err.status === 403) {
      throw new UpstreamError(
        "SEC EDGAR",
        403,
        SEC_USER_AGENT_IS_DEFAULT
          ? "SEC EDGAR rejected the request (403). EDGAR requires a User-Agent with real " +
            'contact info — set the SEC_USER_AGENT env var to "Your Name your@email.com" ' +
            "in your MCP client config and restart the server."
          : `SEC EDGAR rejected the request (403) for User-Agent "${SEC_USER_AGENT}". ` +
            "EDGAR expects a name and a working email address, and throttles above ~10 requests/second.",
      );
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
