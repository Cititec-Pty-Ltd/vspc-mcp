import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import { logger } from './utils/logger.js';
import { fetchWithRateLimitRetry } from './rate-limit.js';
import type { FetchFn } from './rate-limit.js';
import { VspcApiError, VspcAuthError, VspcRateLimitError } from './types.js';
import type { FilterExpression, SortExpression, VspcConfig, VspcEnvelope } from './types.js';

/** Largest response body read, in characters. */
const MAX_RESPONSE_CHARS = 25_000_000;
/** Wait reported for a 429 that does not say how long. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** VSPC's largest page. */
export const MAX_PAGE = 500;
/**
 * The REST API contract this client is written for, sent as X-Client-Version on every request
 * (VSPC 9.1 = 3.6.1). A newer console answers in this contract's shape.
 */
export const VSPC_API_VERSION = '3.6.1';

const KEY_HINT =
  ' Check VSPC_API_KEY: a Simple REST API key (Configuration > Access Management > REST API Keys, scope rest) whose user is enabled.';
const TLS_HINT =
  ' If the console uses a self-signed certificate or one issued for another name, set VSPC_ACCEPT_SELF_SIGNED=true.';

// Request-scoped configuration, for tests and embedding. The MCP host uses the
// process environment (the service's env file).
const configStore = new AsyncLocalStorage<VspcConfig>();

export function runWithConfig<T>(config: VspcConfig, fn: () => T): T {
  return configStore.run(config, fn);
}

/** Thrown when VSPC_URL is set but not usable. */
export class ConfigError extends Error {}

/** https://host:port from VSPC_URL; a trailing /api or /api/v3 is accepted and dropped. */
export function parseVspcUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError('VSPC_URL is not a valid URL (example: https://vspc.example.local:1280).');
  }
  if (url.protocol !== 'https:') throw new ConfigError('VSPC_URL must start with https://.');
  if (url.username || url.password) throw new ConfigError('VSPC_URL must not contain a user name or password.');
  if (url.search || url.hash) throw new ConfigError('VSPC_URL must not have a query string or fragment.');
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && !/^\/api(\/v3)?$/i.test(path)) {
    throw new ConfigError('VSPC_URL must be the console address only, e.g. https://vspc.example.local:1280.');
  }
  return url.origin;
}

export function getConfig(): VspcConfig | null {
  const scoped = configStore.getStore();
  if (scoped?.origin && scoped.apiKey) return scoped;
  const rawUrl = process.env.VSPC_URL?.trim();
  const apiKey = process.env.VSPC_API_KEY?.trim();
  if (!rawUrl || !apiKey) {
    logger.warn('Missing configuration', { hasUrl: Boolean(rawUrl), hasApiKey: Boolean(apiKey) });
    return null;
  }
  const acceptSelfSigned = /^(1|true|yes)$/i.test(process.env.VSPC_ACCEPT_SELF_SIGNED?.trim() ?? '');
  return { origin: parseVspcUrl(rawUrl), apiKey, acceptSelfSigned };
}

/** Removes the API key from any text that leaves this module. */
export function scrub(text: string, config: Pick<VspcConfig, 'apiKey'>): string {
  let out = text;
  if (config.apiKey.length >= 4) out = out.split(config.apiKey).join('[REDACTED]');
  return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [REDACTED]');
}

// --- HTTP ------------------------------------------------------------------------------------

let insecureAgent: Agent | undefined;
let fetchOverride: FetchFn | undefined;

/** Tests replace the network with a fake fetch. */
export function setFetchForTests(fn?: FetchFn): void {
  fetchOverride = fn;
}

function fetchFor(config: VspcConfig): FetchFn {
  if (fetchOverride) return fetchOverride;
  if (!config.acceptSelfSigned) return undiciFetch as unknown as FetchFn;
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  const agent = insecureAgent;
  return (url, init) => undiciFetch(url, { ...(init as object), dispatcher: agent } as never) as unknown as Promise<Response>;
}

export type Query = Record<string, string | number | boolean | undefined | FilterExpression[] | SortExpression[]>;

/** Builds /api/v3<path>?query. Array values (filter, sort) are sent as JSON, as VSPC expects. */
export function buildUrl(origin: string, path: string, query: Query = {}): string {
  if (!/^\/[A-Za-z0-9/_{}.-]*$/.test(path) || path.includes('..')) throw new Error(`Bad API path: ${path}`);
  const url = new URL(`${origin}/api/v3${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length) url.searchParams.set(k, JSON.stringify(v));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function describeNetworkError(err: unknown, config: VspcConfig): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e.name === 'TimeoutError') return 'timed out';
  const code = e.cause?.code ?? '';
  const detail = scrub(`${e.cause?.message ?? e.message}`, config).slice(0, 200);
  const tls = /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|TLS|SSL/i.test(`${code} ${detail}`);
  return `failed (${code || e.name}: ${detail}).${tls ? TLS_HINT : ''}`;
}

function errorDetail(body: string, config: VspcConfig): { message: string; code?: number } {
  try {
    const parsed = JSON.parse(body) as VspcEnvelope;
    const first = parsed.errors?.find((e) => e && e.message);
    if (first) return { message: scrub(String(first.message), config).replace(/\r\n/g, ' ').slice(0, 400), code: first.code };
  } catch {
    // not JSON
  }
  return { message: scrub(body, config).replace(/\s+/g, ' ').slice(0, 200) };
}

/** JSON with object keys sorted at every level, so equal arguments always give the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The X-Request-id of a write: SHA-256 of the tool name and its canonical
 * arguments, as an RFC 9562 version 8 (custom) UUID. VSPC treats a repeat
 * with the same id within 5 minutes as the same request, so an identical
 * write sent again (a lost response, a proposal approved twice) runs once.
 */
export function writeRequestId(tool: string, args: Record<string, unknown>): string {
  const h = createHash('sha256').update(`${tool}\n${canonicalJson(args)}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80; // version 8
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 9562 variant
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface RequestOptions {
  timeoutMs?: number;
  /** X-Request-id for a write (see writeRequestId); a random one if not given. Reads send none. */
  requestId?: string;
}

/**
 * Sends one request and returns VSPC's envelope. `readOnly` (GET) requests
 * may be retried once after a short 429; writes never are.
 * Errors carry the method, path, status and VSPC's message, never the key.
 */
export async function request<T = unknown>(
  config: VspcConfig,
  method: 'GET' | 'POST',
  path: string,
  query: Query = {},
  options: RequestOptions = {}
): Promise<VspcEnvelope<T>> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const url = buildUrl(config.origin, path, query);
  const label = `${method} ${path}`;
  const readOnly = method === 'GET';
  // A write carries an idempotency key: VSPC treats a repeat with the same id within 5 minutes as the same request.
  const requestId = readOnly ? undefined : (options.requestId ?? randomUUID());
  let result;
  try {
    result = await fetchWithRateLimitRetry(fetchFor(config), url, label, readOnly, () => ({
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'X-Client-Version': VSPC_API_VERSION,
        ...(requestId ? { 'X-Request-id': requestId } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch (err) {
    throw new VspcApiError(`VSPC ${label} ${describeNetworkError(err, config)}`);
  }
  const { res } = result;

  if (res.status === 429 || (res.status === 503 && result.retryAfterMs !== undefined)) {
    const wait = result.retryAfterMs !== undefined ? Math.max(1, Math.ceil(result.retryAfterMs / 1000)) : DEFAULT_RETRY_AFTER_SECONDS;
    throw new VspcRateLimitError(`VSPC rate-limited the request (HTTP ${res.status}): ${label}. Try again in ${wait} s.`, wait);
  }

  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > MAX_RESPONSE_CHARS) {
    await res.body?.cancel().catch(() => undefined);
    throw new VspcApiError(`VSPC ${label}: response too large (${length} bytes)`, res.status);
  }
  const text = result.body ?? (await res.text());
  if (text.length > MAX_RESPONSE_CHARS) throw new VspcApiError(`VSPC ${label}: response too large`, res.status);

  if (res.status === 401 || res.status === 403) {
    const { message } = errorDetail(text, config);
    throw new VspcAuthError(
      `VSPC refused the request (HTTP ${res.status}): ${label}${message ? ` - ${message}` : ''}.${res.status === 401 ? KEY_HINT : ' The key\'s user may not have access to this, or the key is read-only.'}`,
      res.status
    );
  }
  if (!res.ok) {
    const { message, code } = errorDetail(text, config);
    throw new VspcApiError(`VSPC ${label} failed: HTTP ${res.status}${message ? ` - ${message}` : ''}`, res.status, code);
  }
  if (text.trim() === '') return { data: null as T };
  let parsed: VspcEnvelope<T>;
  try {
    parsed = JSON.parse(text) as VspcEnvelope<T>;
  } catch {
    throw new VspcApiError(`VSPC ${label}: the response is not JSON`, res.status);
  }
  if (!parsed || typeof parsed !== 'object') throw new VspcApiError(`VSPC ${label}: unexpected response`, res.status);
  return parsed;
}

// --- Collections ------------------------------------------------------------------------------

export interface Page<T> {
  total: number;
  count: number;
  offset: number;
  items: T[];
}

export interface ListOptions {
  filter?: FilterExpression[];
  sort?: SortExpression[];
  limit?: number;
  offset?: number;
  extra?: Query;
}

/** The read-only API handed to tools. Every method is a GET, except `post`. */
export interface Api {
  /** Identifies the console and key (URL + SHA-256 of the key, never the key), for caches. */
  readonly cacheKey: string;
  get<T = unknown>(path: string, query?: Query): Promise<T>;
  page<T = Record<string, unknown>>(path: string, options?: ListOptions): Promise<Page<T>>;
  /**
   * Every item of a collection, 500 a page, up to `maxItems` or until
   * `deadline` (epoch ms). `complete` is false when it stopped early.
   */
  all<T = Record<string, unknown>>(
    path: string,
    options?: Omit<ListOptions, 'limit' | 'offset'>,
    stop?: { maxItems?: number; deadline?: number }
  ): Promise<{ items: T[]; total: number; complete: boolean }>;
}

/** Write access: only write tools get this. */
export interface WriteApi {
  post<T = unknown>(path: string, query?: Query): Promise<T>;
}

function pagingOf(env: VspcEnvelope<unknown>, offset: number, got: number): { total: number; count: number; offset: number } {
  const p = env.meta?.pagingInfo;
  return {
    total: typeof p?.total === 'number' ? p.total : offset + got,
    count: typeof p?.count === 'number' ? p.count : got,
    offset: typeof p?.offset === 'number' ? p.offset : offset,
  };
}

export function makeApi(config: VspcConfig): Api {
  const page = async <T>(path: string, options: ListOptions = {}): Promise<Page<T>> => {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_PAGE);
    const offset = Math.max(options.offset ?? 0, 0);
    const env = await request<T[]>(config, 'GET', path, {
      ...options.extra,
      filter: options.filter,
      sort: options.sort,
      limit,
      offset,
    });
    const items = Array.isArray(env.data) ? env.data : [];
    return { ...pagingOf(env, offset, items.length), items };
  };
  return {
    cacheKey: `${config.origin}|${createHash('sha256').update(config.apiKey).digest('hex').slice(0, 16)}`,
    async get<T>(path: string, query: Query = {}): Promise<T> {
      const env = await request<T>(config, 'GET', path, query);
      return env.data;
    },
    page,
    async all<T>(path: string, options: Omit<ListOptions, 'limit' | 'offset'> = {}, stop: { maxItems?: number; deadline?: number } = {}) {
      const maxItems = stop.maxItems ?? 5_000;
      const items: T[] = [];
      let total = 0;
      for (let offset = 0; ; ) {
        const p = await page<T>(path, { ...options, limit: MAX_PAGE, offset });
        items.push(...p.items);
        total = p.total;
        offset += p.items.length;
        if (p.items.length === 0 || offset >= total) return { items, total, complete: true };
        if (items.length >= maxItems || (stop.deadline !== undefined && Date.now() > stop.deadline)) {
          return { items, total, complete: false };
        }
      }
    },
  };
}

/**
 * Write access for one tool call. `requestId` (writeRequestId of the tool and
 * its arguments) is sent as X-Request-id; each write tool makes one POST.
 */
export function makeWriteApi(config: VspcConfig, requestId?: string): WriteApi {
  return {
    async post<T>(path: string, query: Query = {}): Promise<T> {
      const env = await request<T>(config, 'POST', path, query, { requestId });
      return env.data;
    },
  };
}
