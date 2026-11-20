import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_RETRY, parseRetryAfter, retryAfterFromBody, retryDelayMs } from '../rate-limit.js';

describe('Retry-After parsing', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('0.5')).toBe(500);
    const now = Date.parse('2026-11-20T00:00:00Z');
    expect(parseRetryAfter('Fri, 20 Nov 2026 00:00:05 GMT', now)).toBe(5000);
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('reads retryAfter from a VSPC JSON body', () => {
    expect(retryAfterFromBody('{"retryAfter":4}')).toBe(4000);
    expect(retryAfterFromBody('{"data":{"retryAfter":"2"}}')).toBe(2000);
    // The shape VSPC documents for throttling
    expect(retryAfterFromBody('{"errors":[{"type":"transport","code":429,"retryAfter":25}]}')).toBe(25000);
    expect(retryAfterFromBody('{"errors":[{"type":"transport","code":429},{"retryAfter":3}]}')).toBe(3000);
    expect(retryAfterFromBody('{"errors":[]}')).toBeUndefined();
    expect(retryAfterFromBody('not json')).toBeUndefined();
  });

  it('retries once, only for a short wait', () => {
    expect(RATE_LIMIT_RETRY).toEqual({ maxRetries: 1, maxWaitMs: 10_000 });
    expect(retryDelayMs(0, 2000)).toBe(2000);
    expect(retryDelayMs(0, 10_000)).toBe(10_000);
    expect(retryDelayMs(0, 10_001)).toBeUndefined();
    expect(retryDelayMs(0, undefined)).toBeUndefined();
    expect(retryDelayMs(1, 1000)).toBeUndefined();
  });
});
