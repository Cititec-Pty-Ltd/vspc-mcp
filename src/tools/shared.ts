import type { CallToolResult } from './types.js';

/** Largest tool response, in characters. Bigger results are cut with a note, so one call cannot flood the conversation. */
export const MAX_RESPONSE_CHARS = 60_000;

export function textResult(value: unknown): CallToolResult {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  // Too long indented: try without indentation (about a third smaller) before cutting.
  if (text.length > MAX_RESPONSE_CHARS && typeof value !== 'string') text = JSON.stringify(value);
  if (text.length > MAX_RESPONSE_CHARS) {
    text =
      text.slice(0, MAX_RESPONSE_CHARS) +
      `\n... [response cut at ${MAX_RESPONSE_CHARS} characters; narrow the request (a company, a smaller limit, a status filter) and call again]`;
  }
  return { content: [{ type: 'text', text }] };
}

export function errorResult(message: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function missingConfigResult(): CallToolResult {
  return errorResult('VSPC is not configured. Set VSPC_URL (https://host:1280) and VSPC_API_KEY.');
}

/** Thrown for bad tool input; the message is shown to the caller as is. */
export class InputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value.trim());
}

export function toUuid(value: unknown, key: string): string {
  if (!isUuid(value)) throw new InputError(`${key} must be a VSPC UID (e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6)`);
  return (value as string).trim().toLowerCase();
}

/** Keeps only the listed keys that have a value. */
export function pick(obj: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const src = obj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

/** VSPC writes line breaks as \r\n; one line, trimmed, cut at `max`. */
export function oneLine(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Fields that can hold a secret in VSPC responses (company owner credentials,
 * keys, passwords). Replaced in every tool result.
 */
const SECRET_FIELDS = new Set([
  'password',
  'ownercredentials',
  'credentials',
  'apikey',
  'privatekey',
  'secret',
  'secretkey',
  'token',
  'accesstoken',
  'refreshtoken',
]);

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 32) return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELDS.has(k.toLowerCase()) && v !== null && v !== '' ? '[hidden]' : redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** An ISO time `hours` before `now`. */
export function hoursAgo(hours: number, now = Date.now()): string {
  return new Date(now - hours * 3_600_000).toISOString();
}

/** Epoch ms of an ISO time, or undefined. */
export function timeOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}
