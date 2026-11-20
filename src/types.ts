/**
 * Veeam Service Provider Console REST API v3 (VSPC 9.1 = API 3.6.1).
 * Authentication is a Simple REST API key sent as `Authorization: Bearer <key>`
 * on every request: no token exchange, no expiry (it works until its user is
 * disabled or deleted). A read-only key only allows GET.
 */
export interface VspcConfig {
  /** https://host:port (origin only). */
  origin: string;
  apiKey: string;
  /** Skip certificate verification (self-signed, or a certificate for another name). */
  acceptSelfSigned: boolean;
}

/** VSPC refused the key (401) or the key's user may not do this (403). */
export class VspcAuthError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
  }
}

/** VSPC rate-limited the request (HTTP 429, or 503 with Retry-After). */
export class VspcRateLimitError extends Error {
  readonly code = 'rate_limited';
  /** Seconds to wait before trying again (Retry-After, or 60 when VSPC did not say). */
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
  }
}

/** Any other failure: a non-2xx response, a network error, an unreadable body. */
export class VspcApiError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly vspcCode?: number) {
    super(message);
  }
}

/** VSPC's response envelope: { data, meta: { pagingInfo }, errors }. */
export interface VspcEnvelope<T = unknown> {
  data: T;
  meta?: { pagingInfo?: { total: number; count: number; offset: number } | null } | null;
  errors?: { message?: string; type?: string; code?: number }[] | null;
}

/** One VSPC filter expression (see the REST reference, "Filter Parameter"). */
export interface FilterExpression {
  property?: string;
  operation:
    | 'in'
    | 'contains'
    | 'equals'
    | 'notEquals'
    | 'lessThan'
    | 'lessThanOrEqual'
    | 'greaterThan'
    | 'greaterThanOrEqual'
    | 'or'
    | 'and'
    | 'not';
  collation?: 'ordinal' | 'ignorecase' | 'lexicographic';
  value?: unknown;
  items?: FilterExpression[];
}

export interface SortExpression {
  property: string;
  direction: 'ascending' | 'descending';
}
