import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConfigError, getConfig, makeApi, makeWriteApi, scrub, writeRequestId } from '../client.js';
import type { Api, WriteApi } from '../client.js';
import { VspcAuthError, VspcRateLimitError } from '../types.js';
import type { CallToolResult } from './types.js';
import { InputError, errorResult, missingConfigResult, redactSecrets, textResult, toUuid } from './shared.js';

/**
 * Every tool is a row in a table: a name, typed parameters, and a `run`
 * function that calls fixed VSPC endpoints. No tool takes a free-form path,
 * filter or property name; every value is validated first.
 */

export type ParamType = 'string' | 'int' | 'boolean' | 'uuid' | 'string_list';

export interface ParamSpec {
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  maxItems?: number;
  maxLength?: number;
  /** Used when the caller leaves the parameter out. */
  default?: unknown;
}

/**
 * - read: GET only. Goes in the host's read_tools; retried once after a short 429.
 * - write: one POST that changes something in VSPC or on a backup server. Goes
 *   in the host's write_tools, so every call is a proposal an administrator
 *   approves before it is sent. Never retried.
 */
export type ToolKind = 'read' | 'write';

interface BaseSpec {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  destructive?: boolean;
}

export interface ReadSpec extends BaseSpec {
  kind: 'read';
  run: (args: Record<string, unknown>, api: Api) => Promise<unknown>;
}

export interface WriteSpec extends BaseSpec {
  kind: 'write';
  /** A write makes exactly one POST (no lookups first), so the approved proposal is what is sent. */
  run: (args: Record<string, unknown>, api: WriteApi) => Promise<unknown>;
}

export type ToolSpec = ReadSpec | WriteSpec;

function jsonSchemaFor(p: ParamSpec): Record<string, unknown> {
  const description = p.description;
  const dflt = p.default !== undefined ? { default: p.default } : {};
  switch (p.type) {
    case 'boolean':
      return { type: 'boolean', description, ...dflt };
    case 'int':
      return {
        type: 'integer',
        description,
        ...(p.min !== undefined ? { minimum: p.min } : {}),
        ...(p.max !== undefined ? { maximum: p.max } : {}),
        ...dflt,
      };
    case 'string_list':
      return {
        type: 'array',
        items: { type: 'string', ...(p.enum ? { enum: [...p.enum] } : {}) },
        description,
        ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
        ...dflt,
      };
    case 'uuid':
      return { type: 'string', description, format: 'uuid' };
    default:
      return {
        type: 'string',
        description,
        ...(p.enum ? { enum: [...p.enum] } : {}),
        ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
        ...dflt,
      };
  }
}

export function buildTool(spec: ToolSpec): Tool {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, p] of Object.entries(spec.params)) {
    properties[key] = jsonSchemaFor(p);
    if (p.required) required.push(key);
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: {
      readOnlyHint: spec.kind === 'read',
      destructiveHint: spec.destructive === true,
      idempotentHint: spec.kind === 'read',
      openWorldHint: true,
    },
  };
}

function convert(key: string, p: ParamSpec, value: unknown): unknown {
  switch (p.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new InputError(`${key} must be true or false`);
      return value;
    case 'int': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw new InputError(`${key} must be a whole number`);
      if (p.min !== undefined && n < p.min) throw new InputError(`${key} must be at least ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new InputError(`${key} must be at most ${p.max}`);
      return n;
    }
    case 'uuid':
      return toUuid(value, key);
    case 'string_list': {
      const list = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(list) || list.length === 0) throw new InputError(`${key} must be a non-empty list`);
      if (p.maxItems !== undefined && list.length > p.maxItems) throw new InputError(`${key} can have at most ${p.maxItems} entries`);
      const out = list.map((v, i) => {
        if (typeof v !== 'string' || v.trim() === '') throw new InputError(`${key}[${i}] must be text`);
        const s = v.trim();
        if (p.enum) {
          const match = p.enum.find((e) => e.toLowerCase() === s.toLowerCase());
          if (!match) throw new InputError(`${key}[${i}] must be one of: ${p.enum.join(', ')}`);
          return match;
        }
        return s;
      });
      return [...new Set(out)];
    }
    default: {
      if (typeof value !== 'string') throw new InputError(`${key} must be text`);
      const s = value.trim();
      if (s === '') throw new InputError(`${key} must not be empty`);
      if (p.enum) {
        const match = p.enum.find((e) => e.toLowerCase() === s.toLowerCase());
        if (!match) throw new InputError(`${key} must be one of: ${p.enum.join(', ')}`);
        return match;
      }
      if (p.maxLength !== undefined && s.length > p.maxLength) throw new InputError(`${key} is longer than ${p.maxLength} characters`);
      return s;
    }
  }
}

/** Validates the arguments; returns them converted, with defaults filled in. Exported for tests. */
export function validateArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(args)) {
    if (!(key in spec.params)) throw new InputError(`Unknown parameter: ${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    const given = args[key];
    const raw = given === undefined || given === null ? p.default : given;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (p.required) throw new InputError(`${key} is required`);
      continue;
    }
    out[key] = convert(key, p, raw);
  }
  return out;
}

export async function runSpec(spec: ToolSpec, args: Record<string, unknown>): Promise<CallToolResult> {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) return errorResult(err.message);
    throw err;
  }
  if (!config) return missingConfigResult();
  try {
    const valid = validateArgs(spec, args);
    const out =
      spec.kind === 'read'
        ? await spec.run(valid, makeApi(config))
        : await spec.run(valid, makeWriteApi(config, writeRequestId(spec.name, valid)));
    return textResult(redactSecrets(out));
  } catch (err) {
    const message = scrub((err as Error).message, config);
    if (err instanceof VspcRateLimitError) {
      // Structured, so the MCP host's 429 cooldown and Claude can both read the wait.
      return errorResult(message, { error: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds });
    }
    if (err instanceof VspcAuthError) return errorResult(message, { error: 'auth_failed', httpStatus: err.httpStatus });
    return errorResult(message);
  }
}
