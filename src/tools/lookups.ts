import type { Api } from '../client.js';
import { InputError, isUuid } from './shared.js';

/**
 * Name lookups, so results show company and server names instead of bare
 * UIDs. Each tool call builds its own (no cache across calls): VSPC is the
 * source of truth and these lists are small.
 */
export class Names {
  private orgs?: Promise<Map<string, string>>;
  private servers?: Promise<Map<string, string>>;
  private agents = new Map<string, Promise<string | undefined>>();

  constructor(private readonly api: Api) {}

  /** UID -> name for every organization (companies, resellers, the provider). */
  organizations(): Promise<Map<string, string>> {
    this.orgs ??= this.api
      .all<{ instanceUid?: string; name?: string }>('/organizations', {}, { maxItems: 20_000 })
      .then((r) => new Map(r.items.filter((o) => o.instanceUid).map((o) => [String(o.instanceUid).toLowerCase(), String(o.name ?? '')])));
    return this.orgs;
  }

  /** UID -> name for every managed Veeam Backup & Replication server. */
  backupServers(): Promise<Map<string, string>> {
    this.servers ??= this.api
      .all<{ instanceUid?: string; name?: string }>('/infrastructure/backupServers', {}, { maxItems: 20_000 })
      .then((r) => new Map(r.items.filter((s) => s.instanceUid).map((s) => [String(s.instanceUid).toLowerCase(), String(s.name ?? '')])));
    return this.servers;
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

/**
 * A company given as a UID or a name. A name matches case-insensitively,
 * exactly first, then as part of the name; more than one partial match is an
 * error that lists them.
 */
export async function resolveCompany(api: Api, value: string): Promise<{ uid: string; name?: string }> {
  if (isUuid(value)) return { uid: value.trim().toLowerCase() };
  const wanted = value.trim();
  const page = await api.page<{ instanceUid?: string; name?: string; status?: string }>('/organizations/companies', {
    filter: [{ property: 'name', operation: 'contains', collation: 'ignorecase', value: wanted }],
    limit: 50,
  });
  const companies = page.items.filter((c) => c.instanceUid && c.name);
  const exact = companies.filter((c) => String(c.name).toLowerCase() === wanted.toLowerCase());
  const pickOne = exact.length === 1 ? exact : companies.length === 1 ? companies : [];
  if (pickOne.length === 1) return { uid: String(pickOne[0].instanceUid).toLowerCase(), name: String(pickOne[0].name) };
  if (companies.length === 0) {
    throw new InputError(`No VSPC company name contains "${wanted}". vspc_list_companies lists them.`);
  }
  const names = companies.slice(0, 15).map((c) => `${c.name} (${c.instanceUid})`);
  throw new InputError(
    `"${wanted}" matches ${page.total} companies; give the full name or the UID: ${names.join('; ')}${page.total > 15 ? '; ...' : ''}`
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
