import { vi } from 'vitest';
import type { CallToolResult } from '../tools/types.js';

/** Extracts the text of the first content block, failing loudly if it isn't text. */
export function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') {
    throw new Error(`Expected a text content block, got: ${JSON.stringify(block)}`);
  }
  return block.text;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A VSPC collection page. */
export function page(items: unknown[], total = items.length, offset = 0): Response {
  return json({ data: items, meta: { pagingInfo: { total, count: items.length, offset } }, errors: null });
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/**
 * A fake fetch that answers by path (after /api/v3). Unrouted requests fail
 * the test. `calls` records every request.
 */
export function fakeVspc(routes: Record<string, Route | Response | (() => Response)>) {
  const calls: { method: string; path: string; url: URL; init: RequestInit }[] = [];
  const fn = vi.fn(async (u: string, init: RequestInit) => {
    const url = new URL(u);
    const path = url.pathname.replace(/^\/api\/v3/, '');
    calls.push({ method: String(init.method ?? 'GET'), path, url, init });
    const route = routes[`${init.method ?? 'GET'} ${path}`] ?? routes[path];
    if (route === undefined) throw new Error(`Unrouted request: ${init.method} ${path}`);
    if (route instanceof Response) return route.clone();
    const r = await (route as Route)(url, init);
    if (!r) throw new Error(`Route returned nothing: ${path}`);
    return r;
  });
  return { fn, calls };
}

/** The `filter` query parameter, parsed. */
export function filterOf(url: URL): unknown {
  const f = url.searchParams.get('filter');
  return f ? JSON.parse(f) : undefined;
}
