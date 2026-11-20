import type { Api } from '../client.js';
import { InputError, isUuid } from './shared.js';

/** How long the organisation and backup server name lists are reused. */
export const NAME_CACHE_TTL_MS = 5 * 60_000;

type NameMap = Map<string, string>;
// Process-wide: one entry per console and key (Api.cacheKey) and list. A request in flight is
// shared; a failed one is dropped at once, so the next call tries again.
const nameCache = new Map<string, { expires: number; value: Promise<NameMap> }>();

export function clearNameCacheForTests(): void {
  nameCache.clear();
}

function cachedNames(api: Api, list: string, load: () => Promise<NameMap>): Promise<NameMap> {
  const key = `${api.cacheKey}|${list}`;
  const now = Date.now();
  const hit = nameCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = load();
  nameCache.set(key, { expires: now + NAME_CACHE_TTL_MS, value });
  value.catch(() => {
    if (nameCache.get(key)?.value === value) nameCache.delete(key);
  });
  return value;
}

function uidNameMap(items: { instanceUid?: string; name?: string }[]): NameMap {
  return new Map(items.filter((o) => o.instanceUid).map((o) => [String(o.instanceUid).toLowerCase(), String(o.name ?? '')]));
}

/**
 * Name lookups, so results show company and server names instead of bare
 * UIDs. The organisation and backup server lists are cached for
 * NAME_CACHE_TTL_MS per console and key; agent names are per call.
 */
export class Names {
  private agents = new Map<string, Promise<string | undefined>>();

  constructor(private readonly api: Api) {}

  /** UID -> name for every organization (companies, resellers, the provider). */
  organizations(): Promise<NameMap> {
    return cachedNames(this.api, 'organizations', () =>
      this.api.all<{ instanceUid?: string; name?: string }>('/organizations', {}, { maxItems: 20_000 }).then((r) => uidNameMap(r.items))
    );
  }

  /** UID -> name for every managed Veeam Backup & Replication server. */
  backupServers(): Promise<NameMap> {
    return cachedNames(this.api, 'backupServers', () =>
      this.api
        .all<{ instanceUid?: string; name?: string }>('/infrastructure/backupServers', {}, { maxItems: 20_000 })
        .then((r) => uidNameMap(r.items))
    );
  }

  /** Computer name of a Veeam backup agent (one GET per agent, remembered for this call). */
  agentName(uid: string): Promise<string | undefined> {
    const key = uid.toLowerCase();
    let p = this.agents.get(key);
    if (!p) {
      p = this.api
        .get<{ name?: string }>(`/infrastructure/backupAgents/${key}`)
        .then((a) => (a?.name ? String(a.name) : undefined))
        .catch(() => undefined);
      this.agents.set(key, p);
    }
    return p;
  }

  async org(uid: unknown): Promise<string | undefined> {
    if (typeof uid !== 'string' || !uid) return undefined;
    return (await this.organizations()).get(uid.toLowerCase());
  }

  async server(uid: unknown): Promise<string | undefined> {
    if (typeof uid !== 'string' || !uid) return undefined;
    return (await this.backupServers()).get(uid.toLowerCase());
  }
}

/** Lookups are a convenience: if one fails, results still come back with UIDs only. */
export async function safely<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch {
    return undefined;
  }
}

/** Most company-name matches read when resolving a name. */
export const MAX_NAME_MATCHES = 1_000;

/**
 * A company given as a UID or a name. A name matches case-insensitively,
 * exactly first, then as part of the name; more than one partial match is an
 * error that lists them. Every match is read (up to MAX_NAME_MATCHES) before
 * deciding, so an exact match is found wherever it sorts.
 */
export async function resolveCompany(api: Api, value: string): Promise<{ uid: string; name?: string }> {
  if (isUuid(value)) return { uid: value.trim().toLowerCase() };
  const wanted = value.trim();
  const found = await api.all<{ instanceUid?: string; name?: string }>(
    '/organizations/companies',
    {
      filter: [{ property: 'name', operation: 'contains', collation: 'ignorecase', value: wanted }],
      sort: [{ property: 'name', direction: 'ascending' }],
    },
    { maxItems: MAX_NAME_MATCHES }
  );
  const companies = found.items.filter((c) => c.instanceUid && c.name);
  const exact = companies.filter((c) => String(c.name).toLowerCase() === wanted.toLowerCase());
  // A partial match only counts as the answer when every match was read.
  const pickOne = exact.length === 1 ? exact : companies.length === 1 && found.complete ? companies : [];
  if (pickOne.length === 1) return { uid: String(pickOne[0].instanceUid).toLowerCase(), name: String(pickOne[0].name) };
  if (companies.length === 0) {
    throw new InputError(`No VSPC company name contains "${wanted}". vspc_list_companies lists them.`);
  }
  const names = companies.slice(0, 15).map((c) => `${c.name} (${c.instanceUid})`);
  const partial = found.complete ? '' : ` (only the first ${found.items.length} were read)`;
  throw new InputError(
    `"${wanted}" matches ${found.total} companies${partial}${exact.length > 1 ? `, ${exact.length} of them exactly` : ''}; give the full name or the UID: ${names.join('; ')}${found.total > 15 ? '; ...' : ''}`
  );
}

/**
 * How every tool names a company, server or computer: the name when the lookup
 * found one, otherwise the UID itself, so a failed or incomplete lookup never
 * loses the reference. Undefined only when there is no UID at all.
 */
export function nameOrUid(names: ReadonlyMap<string, string | undefined> | undefined, uid: unknown): string | undefined {
  if (typeof uid !== 'string' || uid.trim() === '') return undefined;
  const id = uid.trim();
  return names?.get(id.toLowerCase()) || id;
}
