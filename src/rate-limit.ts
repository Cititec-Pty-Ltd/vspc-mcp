import { logger } from './utils/logger.js';

/**
 * Bounded retry for rate-limited responses (Cititec fleet 429 policy).
 *
 * VSPC throttles with HTTP 429, with a Retry-After header or a `retryAfter`
 * property (seconds) in the JSON body. If that wait is at most 10 s, a read
 * (GET) waits and is sent once more. With no wait given, or a longer one, the
 * caller gets a structured `rate_limited` error at once (no invented backoff),
 * so a tool call is never held for long. Writes (POST) are never retried:
 * nothing says a rate-limited write was rejected before it ran.
 */
export const RATE_LIMIT_RETRY = {
  /** Retries after the first attempt (fleet 429 policy: at most one). */
  maxRetries: 1,
  /** Longest wait that is retried. A missing or larger wait is not retried. */
  maxWaitMs: 10_000,
};

/** Parses a Retry-After value into milliseconds from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** `retryAfter` (seconds) from a VSPC JSON error body, in milliseconds; undefined if absent. */
export function retryAfterFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    // VSPC's documented throttling body: {"errors":[{"type":"transport","code":429,"retryAfter":25}]}
    const errors = Array.isArray(parsed?.errors) ? (parsed.errors as Record<string, unknown>[]) : [];
    const candidates = [
      ...errors.map((e) => e?.retryAfter),
      parsed?.retryAfter,
      (parsed?.data as Record<string, unknown> | undefined)?.retryAfter,
    ];
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return Math.ceil(c * 1000);
      if (typeof c === 'string') {
        const ms = parseRetryAfter(c);
        if (ms !== undefined) return ms;
      }
    }
  } catch {
    // not JSON
  }
  return undefined;
}

/** Milliseconds to wait before retry number `attempt` (0-based), or undefined for no retry. */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number | undefined {
  if (attempt >= RATE_LIMIT_RETRY.maxRetries) return undefined;
  if (retryAfterMs === undefined || retryAfterMs > RATE_LIMIT_RETRY.maxWaitMs) return undefined;
  return retryAfterMs;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** A response plus the rate-limit wait read from it (header first, then the JSON body). */
export interface FetchResult {
  res: Response;
  /** Body text, already read for a 429/503 response (its stream is then used up). */
  body?: string;
  retryAfterMs?: number;
}

function isThrottle(res: Response): boolean {
  return res.status === 429 || res.status === 503;
}

async function inspect(res: Response): Promise<FetchResult> {
  if (!isThrottle(res)) return { res };
  const header = parseRetryAfter(res.headers.get('retry-after'));
  const body = await res.text().catch(() => '');
  return { res, body, retryAfterMs: header ?? retryAfterFromBody(body) };
}

/**
 * fetch() with the bounded retry above. `makeInit` is called for every
 * attempt so each one gets a fresh timeout signal. `replaySafe` is true only
 * for GET. A 503 counts as throttling only when it says how long to wait.
 */
export async function fetchWithRateLimitRetry(
  fetchFn: FetchFn,
  url: string,
  label: string,
  replaySafe: boolean,
  makeInit: () => RequestInit
): Promise<FetchResult> {
  let result = await inspect(await fetchFn(url, makeInit()));
  for (let attempt = 0; ; attempt++) {
    const { res, retryAfterMs } = result;
    const throttled = res.status === 429 || (res.status === 503 && retryAfterMs !== undefined);
    if (!throttled || !replaySafe) return result;
    const delay = retryDelayMs(attempt, retryAfterMs);
    if (delay === undefined) return result;
    logger.warn('VSPC asked us to slow down; retrying', { status: res.status, request: label, delayMs: delay });
    await sleep(delay);
    result = await inspect(await fetchFn(url, makeInit()));
  }
}
