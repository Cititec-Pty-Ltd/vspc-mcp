import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_SPECS, ALL_TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, dispatchToolCall } from '../tools/index.js';
import { SERVER_INSTRUCTIONS } from '../server.js';
import { parseVspcUrl, runWithConfig, setFetchForTests, scrub, buildUrl, getConfig, canonicalJson, writeRequestId } from '../client.js';
import { baseJobName, groupFailures } from '../tools/jobs.js';
import { MAX_NAME_MATCHES, NAME_CACHE_TTL_MS, clearNameCacheForTests, nameOrUid } from '../tools/lookups.js';
import type { FailedJob } from '../tools/jobs.js';
import { fakeVspc, filterOf, json, page, textOf } from './test-helpers.js';

const KEY = 'SECRET-VSPC-KEY-0123456789abcdef';
const config = { origin: 'https://vspc.test:1280', apiKey: KEY, acceptSelfSigned: false };

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const A1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const A2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const J1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const AL1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';

beforeEach(() => clearNameCacheForTests());

afterEach(() => {
  setFetchForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function call(name: string, args: Record<string, unknown> = {}) {
  return runWithConfig(config, () => dispatchToolCall(name, args));
}

const ORGS = page([
  { instanceUid: C1, name: 'Client One', type: 'Company' },
  { instanceUid: C2, name: 'Client Two', type: 'Company' },
]);
const SERVERS = page([{ instanceUid: S1, name: 'VBR-01', organizationUid: C1, status: 'Healthy', displayVersion: '12.3.1' }]);

describe('tool table', () => {
  it('can be found by "VCSP" (the partner programme) as well as "VSPC" (the console)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('VCSP (Veeam Cloud Service Provider)');
    expect(SERVER_INSTRUCTIONS).toContain('Veeam Service Provider Console (VSPC)');
    const desc = (n: string) => ALL_TOOLS.find((t) => t.name === n)!.description!;
    expect(desc('vspc_failed_jobs_summary')).toContain('VCSP');
    expect(desc('vspc_get_license_usage')).toContain('VCSP (Veeam Cloud Service Provider)');
  });

  it('has unique names, strict schemas and the right hints', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of ALL_TOOLS) {
      expect(t.name).toMatch(/^vspc_[a-z0-9_]+$/);
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description!.length).toBeGreaterThan(30);
    }
    expect(READ_TOOL_NAMES).toContain('vspc_failed_jobs_summary');
    expect(WRITE_TOOL_NAMES).toEqual(['vspc_start_job', 'vspc_retry_job', 'vspc_acknowledge_alarm', 'vspc_resolve_alarm']);
    for (const t of ALL_TOOLS) expect(t.annotations!.readOnlyHint).toBe(READ_TOOL_NAMES.includes(t.name));
    expect(ALL_SPECS.length).toBe(READ_TOOL_NAMES.length + WRITE_TOOL_NAMES.length);
  });

  it('rejects unknown parameters and bad UIDs before calling VSPC', async () => {
    const vspc = fakeVspc({});
    setFetchForTests(vspc.fn);
    expect(textOf(await call('vspc_about', { x: 1 }))).toContain('Unknown parameter: x');
    expect(textOf(await call('vspc_start_job', { job_uid: '../../x' }))).toContain('must be a VSPC UID');
    expect(textOf(await call('vspc_list_failed_jobs', { hours: 0 }))).toContain('at least 1');
    expect(textOf(await call('vspc_list_failed_jobs', { statuses: ['Success'] }))).toContain('must be one of');
    expect(vspc.calls).toHaveLength(0);
  });
});

describe('configuration', () => {
  it('accepts an https origin, with or without /api/v3', () => {
    expect(parseVspcUrl('https://vspc.example:1280')).toBe('https://vspc.example:1280');
    expect(parseVspcUrl('https://vspc.example:1280/api/v3/')).toBe('https://vspc.example:1280');
    expect(() => parseVspcUrl('http://vspc.example:1280')).toThrow(/https/);
    expect(() => parseVspcUrl('https://u:p@vspc.example:1280')).toThrow(/user name/);
    expect(() => parseVspcUrl('https://vspc.example:1280/other')).toThrow(/address only/);
  });

  it('reads the environment', () => {
    vi.stubEnv('VSPC_URL', 'https://vspc.example:1280');
    vi.stubEnv('VSPC_API_KEY', KEY);
    vi.stubEnv('VSPC_ACCEPT_SELF_SIGNED', 'true');
    expect(getConfig()).toEqual({ origin: 'https://vspc.example:1280', apiKey: KEY, acceptSelfSigned: true });
    vi.stubEnv('VSPC_API_KEY', '');
    expect(getConfig()).toBeNull();
  });

  it('says what is missing', async () => {
    vi.stubEnv('VSPC_URL', '');
    vi.stubEnv('VSPC_API_KEY', '');
    const r = await dispatchToolCall('vspc_about', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('VSPC_URL');
  });

  it('builds URLs with JSON filters and refuses odd paths', () => {
    const u = new URL(buildUrl('https://h:1280', '/alarms/active', { filter: [{ property: 'a', operation: 'equals', value: 'b' }], limit: 5 }));
    expect(u.pathname).toBe('/api/v3/alarms/active');
    expect(JSON.parse(u.searchParams.get('filter')!)).toEqual([{ property: 'a', operation: 'equals', value: 'b' }]);
    expect(() => buildUrl('https://h:1280', '/a/../b')).toThrow();
    expect(() => buildUrl('https://h:1280', '/a?x=1')).toThrow();
  });

  it('scrubs the key and bearer tokens', () => {
    expect(scrub(`x ${KEY} y Bearer abcdefghijkl`, config)).toBe('x [REDACTED] y Bearer [REDACTED]');
  });
});

describe('requests', () => {
  it('sends the key as a Bearer token and returns compact fields', async () => {
    const vspc = fakeVspc({ '/about': json({ data: { serverVersion: '9.1.0.1', installationId: 'x', extra: 'dropped' } }) });
    setFetchForTests(vspc.fn);
    const r = await call('vspc_about');
    expect(JSON.parse(textOf(r))).toEqual({ serverVersion: '9.1.0.1', installationId: 'x' });
    const headers = vspc.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['X-Client-Version']).toBe('3.6.1');
    expect(vspc.calls[0].url.origin).toBe('https://vspc.test:1280');
  });

  it('reports 401 with a hint and never echoes the key', async () => {
    const vspc = fakeVspc({ '/about': json({ data: null, errors: [{ message: `bad key ${KEY}`, type: 'security', code: 1 }] }, 401) });
    setFetchForTests(vspc.fn);
    const r = await call('vspc_about');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('HTTP 401');
    expect(textOf(r)).toContain('Simple REST API key');
    expect(textOf(r)).not.toContain(KEY);
    expect(r.structuredContent).toEqual({ error: 'auth_failed', httpStatus: 401 });
  });

  it('reports VSPC error messages', async () => {
    const vspc = fakeVspc({ '/licensing/console': json({ data: null, errors: [{ message: 'Line one\r\nline two', type: 'logical', code: 500 }] }, 500) });
    setFetchForTests(vspc.fn);
    expect(textOf(await call('vspc_get_console_license'))).toContain('HTTP 500 - Line one line two');
  });

  it('suggests VSPC_ACCEPT_SELF_SIGNED on a certificate error', async () => {
    setFetchForTests(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' } });
    });
    expect(textOf(await call('vspc_about'))).toContain('VSPC_ACCEPT_SELF_SIGNED=true');
  });
});

describe('fleet 429 policy', () => {
  it('retries a read once after a short Retry-After', async () => {
    vi.useFakeTimers();
    let n = 0;
    const vspc = fakeVspc({ '/about': () => (n++ === 0 ? json({}, 429, { 'Retry-After': '2' }) : json({ data: { serverVersion: '9.1' } })) });
    setFetchForTests(vspc.fn);
    const p = call('vspc_about');
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(r.isError).toBeUndefined();
    expect(vspc.calls).toHaveLength(2);
  });

  it('retries after VSPC\'s documented errors[].retryAfter body (no header)', async () => {
    vi.useFakeTimers();
    let n = 0;
    const vspc = fakeVspc({
      '/about': () =>
        n++ === 0
          ? json({ data: null, errors: [{ type: 'transport', code: 429, retryAfter: 3 }] }, 429)
          : json({ data: { serverVersion: '9.1' } }),
    });
    setFetchForTests(vspc.fn);
    const p = call('vspc_about');
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await p).isError).toBeUndefined();
    expect(vspc.calls).toHaveLength(2);
  });

  it('reports the errors[].retryAfter wait when it is too long to retry', async () => {
    const vspc = fakeVspc({ '/about': json({ data: null, errors: [{ type: 'transport', code: 429, retryAfter: 25 }] }, 429) });
    setFetchForTests(vspc.fn);
    const r = await call('vspc_about');
    expect(r.structuredContent).toEqual({ error: 'rate_limited', retryAfterSeconds: 25 });
    expect(vspc.calls).toHaveLength(1);
  });

  it('reads retryAfter from the JSON body', async () => {
    vi.useFakeTimers();
    let n = 0;
    const vspc = fakeVspc({ '/about': () => (n++ === 0 ? json({ retryAfter: 1 }, 429) : json({ data: { serverVersion: '9.1' } })) });
    setFetchForTests(vspc.fn);
    const p = call('vspc_about');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p).isError).toBeUndefined();
    expect(vspc.calls).toHaveLength(2);
  });

  it('returns a structured rate_limited error for a long wait, without retrying', async () => {
    const vspc = fakeVspc({ '/about': json({}, 429, { 'Retry-After': '120' }) });
    setFetchForTests(vspc.fn);
    const r = await call('vspc_about');
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ error: 'rate_limited', retryAfterSeconds: 120 });
    expect(textOf(r)).toContain('Try again in 120 s');
    expect(vspc.calls).toHaveLength(1);
  });

  it('gives up after one retry', async () => {
    vi.useFakeTimers();
    const vspc = fakeVspc({ '/about': () => json({}, 429, { 'Retry-After': '1' }) });
    setFetchForTests(vspc.fn);
    const p = call('vspc_about');
    await vi.advanceTimersByTimeAsync(1_000);
    const r = await p;
    expect(r.structuredContent).toEqual({ error: 'rate_limited', retryAfterSeconds: 1 });
    expect(vspc.calls).toHaveLength(2);
  });

  it('never retries a write', async () => {
    const vspc = fakeVspc({ [`POST /infrastructure/backupServers/jobs/${J1}/retry`]: json({}, 429, { 'Retry-After': '1' }) });
    setFetchForTests(vspc.fn);
    const r = await call('vspc_retry_job', { job_uid: J1 });
    expect(r.structuredContent).toMatchObject({ error: 'rate_limited' });
    expect(vspc.calls).toHaveLength(1);
  });
});

describe('paging and lists', () => {
  it('passes limit/offset and returns the next offset', async () => {
    const vspc = fakeVspc({
      '/organizations/companies': (url) => {
        expect(url.searchParams.get('limit')).toBe('2');
        expect(url.searchParams.get('offset')).toBe('0');
        expect(filterOf(url)).toEqual([{ property: 'name', operation: 'contains', collation: 'ignorecase', value: 'client' }]);
        return page([{ instanceUid: C1, name: 'Client One', status: 'Active', ownerCredentials: { userName: 'a', password: 'p' } }], 3);
      },
      '/organizations': ORGS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_companies', { name: 'client', limit: 2 })));
    expect(out).toMatchObject({ total: 3, count: 1, offset: 0, nextOffset: 1 });
    expect(out.companies[0]).toEqual({ instanceUid: C1, name: 'Client One', status: 'Active' });
  });

  it('hides owner credentials of a company', async () => {
    const vspc = fakeVspc({
      [`/organizations/companies/${C1}`]: json({ data: { instanceUid: C1, name: 'Client One', ownerCredentials: { userName: 'u', password: 'p' } } }),
    });
    setFetchForTests(vspc.fn);
    const text = textOf(await call('vspc_get_company', { company: C1 }));
    expect(text).not.toContain('"p"');
    expect(text).not.toContain('ownerCredentials');
  });

  it('resolves a company name and filters jobs by it', async () => {
    const vspc = fakeVspc({
      '/organizations/companies': page([
        { instanceUid: C1, name: 'Client One' },
        { instanceUid: C2, name: 'Client One Holdings' },
      ]),
      '/infrastructure/backupServers/jobs': (url) => {
        expect(filterOf(url)).toEqual([
          { operation: 'or', items: [{ property: 'mappedOrganizationUid', operation: 'equals', value: C1 }, { property: 'organizationUid', operation: 'equals', value: C1 }] },
          { operation: 'or', items: [{ property: 'status', operation: 'equals', value: 'Failed' }, { property: 'status', operation: 'equals', value: 'Warning' }] },
        ]);
        return page([{ instanceUid: J1, name: 'Nightly', backupServerUid: S1, organizationUid: C1, status: 'Failed', failureMessage: 'Error: disk\r\nfull' }]);
      },
      '/organizations': ORGS,
      '/infrastructure/backupServers': SERVERS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_jobs', { company: 'client one', statuses: ['failed', 'Warning'] })));
    expect(out.jobs[0]).toMatchObject({ name: 'Nightly', company: 'Client One', backupServer: 'VBR-01', status: 'Failed', failureMessage: 'Error: disk full' });
  });

  it('lists the matches when a company name is ambiguous', async () => {
    const vspc = fakeVspc({
      '/organizations/companies': page([
        { instanceUid: C1, name: 'Acme North' },
        { instanceUid: C2, name: 'Acme South' },
      ]),
    });
    setFetchForTests(vspc.fn);
    const text = textOf(await call('vspc_list_jobs', { company: 'acme' }));
    expect(text).toContain('matches 2 companies');
    expect(text).toContain('Acme South');
  });

  describe('alarms', () => {
    const now = Date.now();
    const STATUS_FILTER = {
      operation: 'or',
      items: [{ property: 'lastActivation.status', operation: 'equals', value: 'Error' }, { property: 'lastActivation.status', operation: 'equals', value: 'Warning' }],
    };
    const recent = (id: string, h: number) => ({
      instanceUid: id,
      alarmTemplateUid: 'T1',
      repeatCount: 3,
      object: { type: 'BackupServerJob', organizationUid: C2, computerName: 'VBR-02', objectName: 'Nightly' },
      lastActivation: { time: new Date(now - h * 3_600_000).toISOString(), status: 'Error', message: 'Job failed' },
    });
    const common = { '/alarms/templates': page([{ instanceUid: 't1', name: 'Job state' }]), '/organizations': ORGS };

    it('lists them with template names, newest first', async () => {
      const vspc = fakeVspc({
        ...common,
        '/alarms/active': (url) => {
          expect(filterOf(url)).toEqual([STATUS_FILTER]);
          expect(JSON.parse(url.searchParams.get('sort')!)).toEqual([{ property: 'lastActivation.time', direction: 'descending' }]);
          return page([recent(AL1, 1)], 3);
        },
      });
      setFetchForTests(vspc.fn);
      const out = JSON.parse(textOf(await call('vspc_list_alarms', { limit: 1 })));
      expect(out).toMatchObject({ total: 3, count: 1, offset: 0, nextOffset: 1 });
      expect(out.timeFilter).toBeUndefined();
      expect(out.alarms[0]).toMatchObject({ alarm: 'Job state', status: 'Error', company: 'Client Two', computer: 'VBR-02', objectName: 'Nightly' });
    });

    it('sends the time window to VSPC, so paging is exact', async () => {
      const vspc = fakeVspc({
        ...common,
        '/alarms/active': (url) => {
          const f = filterOf(url) as Record<string, unknown>[];
          expect(f[0]).toEqual(STATUS_FILTER);
          expect(f[1]).toMatchObject({ property: 'lastActivation.time', operation: 'greaterThanOrEqual' });
          const cutoff = Date.parse(String(f[1].value));
          expect(Math.abs(cutoff - (now - 24 * 3_600_000))).toBeLessThan(60_000);
          return page([recent(AL1, 1), recent('a2', 2)], 5);
        },
      });
      setFetchForTests(vspc.fn);
      const out = JSON.parse(textOf(await call('vspc_list_alarms', { hours: 24, limit: 2 })));
      expect(out).toMatchObject({ total: 5, count: 2, offset: 0, nextOffset: 2, timeFilter: 'vspc' });
      expect(out.alarms).toHaveLength(2);
    });

    it('falls back to filtering here when VSPC refuses the date filter, with honest paging', async () => {
      const vspc = fakeVspc({
        ...common,
        '/alarms/active': (url) => {
          const f = filterOf(url) as unknown[];
          if (f.length === 2) return json({ data: null, errors: [{ message: 'Unsupported filter', code: 400 }] }, 400);
          return page([recent(AL1, 1), recent('old', 100)], 7);
        },
      });
      setFetchForTests(vspc.fn);
      const out = JSON.parse(textOf(await call('vspc_list_alarms', { hours: 24, limit: 2 })));
      expect(out).toMatchObject({ totalUnfiltered: 7, count: 1, pageCountUnfiltered: 2, offset: 0, timeFilter: 'client' });
      // newest first: the page reached an alarm outside the window, so nothing later can be in it
      expect(out.nextOffset).toBeUndefined();
      expect(out.alarms.map((a: { instanceUid: string }) => a.instanceUid)).toEqual([AL1]);
      expect(out.alarms).toHaveLength(out.count);
    });

    it('keeps a followable nextOffset when the whole fallback page is in the window', async () => {
      const vspc = fakeVspc({
        ...common,
        '/alarms/active': (url) =>
          (filterOf(url) as unknown[]).length === 2
            ? json({ data: null, errors: [{ message: 'Unsupported filter', code: 400 }] }, 400)
            : page([recent(AL1, 1), recent('a2', 2)], 7),
      });
      setFetchForTests(vspc.fn);
      const out = JSON.parse(textOf(await call('vspc_list_alarms', { hours: 24, limit: 2 })));
      expect(out).toMatchObject({ count: 2, pageCountUnfiltered: 2, nextOffset: 2, timeFilter: 'client' });
    });

    it('does not hide other errors behind the fallback', async () => {
      const vspc = fakeVspc({ ...common, '/alarms/active': json({ data: null, errors: [{ message: 'boom', code: 500 }] }, 500) });
      setFetchForTests(vspc.fn);
      const r = await call('vspc_list_alarms', { hours: 24 });
      expect(r.isError).toBe(true);
      expect(vspc.calls.filter((c) => c.path === '/alarms/active')).toHaveLength(1);
    });
  });

  it('totals license usage per workload', async () => {
    const vspc = fakeVspc({
      '/licensing/usage/organizations': page([
        { organizationUid: C1, organizationType: 'Company', servers: [{ serverUid: S1, serverType: 'BackupAndReplication', workloads: [{ description: 'VMs', unitType: 'Instances', usedUnits: 5, usedCount: 5 }, { description: 'Unused', usedCount: 0 }] }] },
        { organizationUid: C2, organizationType: 'Company', servers: [{ serverUid: S1, serverType: 'BackupAndReplication', workloads: [{ description: 'VMs', unitType: 'Instances', usedUnits: 2, usedCount: 2 }] }] },
      ]),
      '/organizations': ORGS,
      '/infrastructure/backupServers': SERVERS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_get_license_usage')));
    expect(out.totals).toEqual([
      { workload: 'VMs', unitType: 'Instances', usedUnits: 7, newUnits: 0, rentalUnits: 0, usedCount: 7, newCount: 0, rentalCount: 0 },
    ]);
    expect(out.organizations[0].servers[0]).toMatchObject({ server: 'VBR-01', workloads: [{ description: 'VMs' }] });
    expect(out.organizations[0].servers[0].workloads).toHaveLength(1);
  });

  it('keeps and totals new and rental units, per unit type, without double-counting platforms', async () => {
    const vspc = fakeVspc({
      '/licensing/usage/organizations': page([
        {
          organizationUid: C1,
          servers: [
            {
              serverUid: S1,
              serverType: 'CloudConnect',
              workloads: [
                // Only new units: must be kept and totalled
                { description: 'Cloud backups', unitType: 'Points', newUnits: 2.5, newCount: 1 },
                // Only rental units
                { description: 'Cloud backups', unitType: 'Points', rentalUnits: 4, rentalCount: 2 },
                // Same name, other unit type: a separate total
                { description: 'Cloud backups', unitType: 'Instances', usedUnits: 3, usedCount: 3 },
                {
                  description: 'Servers',
                  unitType: 'Instances',
                  usedUnits: 5,
                  usedCount: 5,
                  workloadsByPlatform: [
                    { description: 'VMware', weight: 1, usedUnits: 3, usedCount: 3 },
                    { description: 'Hyper-V', weight: 1, usedUnits: 2, usedCount: 2 },
                    { description: 'Nutanix', weight: 1 },
                  ],
                },
                { description: 'Nothing', unitType: 'Instances', usedUnits: 0, newUnits: 0, rentalUnits: 0 },
              ],
            },
          ],
        },
      ]),
      '/organizations': ORGS,
      '/infrastructure/backupServers': SERVERS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_get_license_usage')));
    const zero = { usedUnits: 0, newUnits: 0, rentalUnits: 0, usedCount: 0, newCount: 0, rentalCount: 0 };
    expect(out.totals).toEqual([
      { workload: 'Cloud backups', unitType: 'Points', ...zero, newUnits: 2.5, rentalUnits: 4, newCount: 1, rentalCount: 2 },
      { workload: 'Cloud backups', unitType: 'Instances', ...zero, usedUnits: 3, usedCount: 3 },
      { workload: 'Servers', unitType: 'Instances', ...zero, usedUnits: 5, usedCount: 5 },
    ]);
    const w = out.organizations[0].servers[0].workloads;
    expect(w.map((x: { description: string }) => x.description)).toEqual(['Cloud backups', 'Cloud backups', 'Cloud backups', 'Servers']);
    expect(w[0]).toEqual({ description: 'Cloud backups', unitType: 'Points', newUnits: 2.5, newCount: 1 });
    expect(w[3].byPlatform).toEqual([
      { description: 'VMware', weight: 1, usedUnits: 3, usedCount: 3 },
      { description: 'Hyper-V', weight: 1, usedUnits: 2, usedCount: 2 },
    ]);
  });
});

describe('failed jobs', () => {
  const now = Date.now();
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();

  function failureRoutes(extra: Record<string, unknown> = {}) {
    return {
      '/infrastructure/backupServers/jobs': (url: URL) => {
        expect(filterOf(url)).toEqual([{ property: 'status', operation: 'equals', value: 'Failed' }]);
        return page([
          { instanceUid: J1, name: 'Nightly VMs', backupServerUid: S1, organizationUid: C1, status: 'Failed', type: 'BackupVm', lastRun: ago(3), lastEndTime: ago(2), failureMessage: 'Error: repository full' },
          { instanceUid: 'old-job', name: 'Weekly', backupServerUid: S1, organizationUid: C1, status: 'Failed', lastRun: ago(50), lastEndTime: ago(49) },
        ]);
      },
      '/infrastructure/backupAgents/jobs': page([
        { instanceUid: 'aj1', name: 'Workstations', backupAgentUid: A1, organizationUid: C2, status: 'Failed', lastEndTime: ago(1), failureMessage: 'Network path not found' },
        { instanceUid: 'aj2', name: 'Workstations', backupAgentUid: A2, organizationUid: C2, status: 'Failed', lastEndTime: ago(5), failureMessage: 'Network path not found' },
      ]),
      '/infrastructure/vb365Servers/organizations/jobs': page([
        { instanceUid: 'm1', name: 'M365 Mail', vspcOrganizationUid: C1, vb365ServerName: 'VB365-01', lastStatus: 'Failed', lastRun: ago(4), lastStatusDetails: 'Processing failed', lastErrorLogRecords: [{ logType: 'Error', message: 'Mailbox locked' }] },
      ]),
      [`/infrastructure/backupAgents/${A1}`]: json({ data: { instanceUid: A1, name: 'PC-001' } }),
      [`/infrastructure/backupAgents/${A2}`]: json({ data: { instanceUid: A2, name: 'PC-002' } }),
      '/organizations': ORGS,
      '/infrastructure/backupServers': SERVERS,
      ...extra,
    };
  }

  it('lists failures in the window across every source, newest first, with names', async () => {
    const vspc = fakeVspc(failureRoutes());
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_failed_jobs', { hours: 24 })));
    expect(out.count).toBe(4);
    expect(out.jobs.map((j: { job: string }) => j.job)).toEqual(['Workstations', 'Nightly VMs', 'M365 Mail', 'Workstations']);
    expect(out.jobs[0]).toMatchObject({ source: 'agent', where: 'PC-001', company: 'Client Two', message: 'Network path not found' });
    expect(out.jobs[1]).toMatchObject({ source: 'backup_server', where: 'VBR-01', company: 'Client One', message: 'Error: repository full' });
    expect(out.jobs[2]).toMatchObject({ source: 'vb365', where: 'VB365-01', message: 'Processing failed | Mailbox locked' });
    expect(out.scanned.backup_server).toEqual({ matched: 2, read: 2, complete: true });
    // vb365 jobs are filtered on lastStatus
    const vbCall = vspc.calls.find((c) => c.path === '/infrastructure/vb365Servers/organizations/jobs')!;
    expect(filterOf(vbCall.url)).toEqual([{ property: 'lastStatus', operation: 'equals', value: 'Failed' }]);
  });

  it('keeps going when one source fails', async () => {
    const vspc = fakeVspc(
      failureRoutes({ '/infrastructure/vb365Servers/organizations/jobs': json({ data: null, errors: [{ message: 'Forbidden', code: 403 }] }, 403) })
    );
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_failed_jobs', {})));
    expect(out.count).toBe(3);
    expect(out.scanned.vb365.error).toContain('HTTP 403');
    expect(out.complete).toBe(false);
    expect(out.warning).toMatch(/^INCOMPLETE: could not read vb365\..*zero does not mean no failures/);
    expect(out.sourceErrors).toEqual([{ source: 'vb365', error: expect.stringContaining('HTTP 403') }]);
  });

  it('marks a complete read as complete', async () => {
    setFetchForTests(fakeVspc(failureRoutes()).fn);
    const out = JSON.parse(textOf(await call('vspc_list_failed_jobs', {})));
    expect(out.complete).toBe(true);
    expect(out.warning).toBeUndefined();
  });

  // What the first live run hit: the console's name did not resolve, so every request failed.
  const unreachable = () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND vspc.example.local' } });
  };

  it('is an error, not zero failures, when no source can be read', async () => {
    setFetchForTests(async () => unreachable());
    for (const tool of ['vspc_failed_jobs_summary', 'vspc_list_failed_jobs']) {
      const r = await call(tool, {});
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toContain('No job source could be read, so failures are unknown (not zero)');
      for (const s of ['backup_server:', 'agent:', 'vb365:']) expect(text).toContain(s);
      expect(text).toContain('ENOTFOUND');
      expect(text).toContain('in lower case');
      expect(text).not.toContain('failingJobs');
    }
  });

  it('keeps the rate-limit wait when every source is rate limited', async () => {
    setFetchForTests(async () => json({}, 429, { 'Retry-After': '120' }));
    const r = await call('vspc_failed_jobs_summary', {});
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ error: 'rate_limited', retryAfterSeconds: 120 });
  });

  it('the summary says it is incomplete, and a zero is not a clean zero', async () => {
    const vspc = fakeVspc(
      failureRoutes({
        '/infrastructure/backupServers/jobs': json({ data: null, errors: [{ message: 'Server unavailable' }] }, 500),
        '/infrastructure/backupAgents/jobs': page([]),
        '/infrastructure/vb365Servers/organizations/jobs': page([]),
        '/infrastructure/jobSessionHeatmap/': json({ data: { successJobsCount: 5, warningJobsCount: 0, failJobsCount: 2 } }),
      })
    );
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_failed_jobs_summary', {})));
    expect(out.failingJobs).toBe(0);
    expect(out.complete).toBe(false);
    expect(out.warning).toContain('could not read backup_server');
    expect(out.warning).toContain('zero does not mean no failures');
    expect(out.sourceErrors[0]).toMatchObject({ source: 'backup_server', error: expect.stringContaining('Server unavailable') });
    // Output order: the coverage verdict comes before any count
    expect(Object.keys(out).indexOf('complete')).toBeLessThan(Object.keys(out).indexOf('failingJobs'));
  });

  it('says when a source was cut short at the cap', async () => {
    const many = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ instanceUid: `j${from + i}`, name: `Job ${from + i}`, status: 'Failed', lastEndTime: ago(1) }));
    const vspc = fakeVspc({
      '/infrastructure/backupServers/jobs': (url) => {
        const offset = Number(url.searchParams.get('offset'));
        return page(many(500, offset), 3_000, offset);
      },
      '/organizations': ORGS,
      '/infrastructure/backupServers': SERVERS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_failed_jobs', { sources: ['backup_server'] })));
    expect(out.count).toBe(2_000);
    expect(out.complete).toBe(false);
    expect(out.partialSources).toEqual(['backup_server']);
    expect(out.warning).toContain('read only part of backup_server');
  });

  it('says when the session counts could not be read', async () => {
    setFetchForTests(fakeVspc(failureRoutes({ '/infrastructure/jobSessionHeatmap/': json({}, 500) })).fn);
    const out = JSON.parse(textOf(await call('vspc_failed_jobs_summary', {})));
    expect(out.sessionCounts).toBeNull();
    expect(out.sessionCountsError).toContain('could not be read');
    expect(out.complete).toBe(true);
  });

  it('only asks the given backup server', async () => {
    const vspc = fakeVspc({
      [`/infrastructure/backupServers/${S1}/jobs`]: page([]),
      '/organizations': ORGS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_failed_jobs', { backup_server_uid: S1 })));
    expect(out.count).toBe(0);
    expect(vspc.calls.map((c) => c.path)).not.toContain('/infrastructure/backupAgents/jobs');
  });

  it('pages through every failure', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ instanceUid: `j${i}`, name: `Job ${i}`, status: 'Failed', lastEndTime: ago(1) }));
    const vspc = fakeVspc({
      '/infrastructure/backupServers/jobs': (url) => {
        const offset = Number(url.searchParams.get('offset'));
        expect(url.searchParams.get('limit')).toBe('500');
        return offset === 0 ? page(many, 501, 0) : page([{ instanceUid: 'last', name: 'Last', status: 'Failed', lastEndTime: ago(1) }], 501, 500);
      },
      '/organizations': ORGS,
      '/infrastructure/backupServers': SERVERS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_failed_jobs', { sources: ['backup_server'] })));
    expect(out.count).toBe(501);
    expect(out.shown).toBe(50);
    expect(out.jobs).toHaveLength(50);
    expect(out.scanned.backup_server).toEqual({ matched: 501, read: 501, complete: true });
  });

  it('summarises: one row per job, agent computers folded, session counts', async () => {
    const vspc = fakeVspc(
      failureRoutes({
        '/infrastructure/jobSessionHeatmap/': (url: URL) => {
          expect(url.searchParams.get('from')).toBeTruthy();
          expect(url.searchParams.get('to')).toBeTruthy();
          return json({ data: { successJobsCount: 90, warningJobsCount: 3, failJobsCount: 7, dataPerDays: [] } });
        },
      })
    );
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_failed_jobs_summary', { hours: 24 })));
    expect(out.sessionCounts).toEqual({ successJobsCount: 90, warningJobsCount: 3, failJobsCount: 7 });
    expect(out.failingJobs).toBe(3);
    const ws = out.rows.find((r: { job: string }) => r.job === 'Workstations');
    expect(ws).toMatchObject({ occurrences: 2, where: ['PC-001', 'PC-002'], company: 'Client Two' });
    expect(out.byCompany).toEqual([
      { company: 'Client One', failed: 2, warning: 0 },
      { company: 'Client Two', failed: 1, warning: 0 },
    ]);
  });
});

describe('a job\'s company', () => {
  const now = Date.now();
  // Job on a hosted backup server: the server belongs to C2 (the provider), the job is assigned to C1.
  const hostedJob = {
    instanceUid: J1,
    name: 'Hosted nightly',
    backupServerUid: S1,
    organizationUid: C2,
    mappedOrganizationUid: C1,
    status: 'Failed',
    lastEndTime: new Date(now - 3_600_000).toISOString(),
    failureMessage: 'Error',
  };
  const routes = {
    '/infrastructure/backupServers/jobs': page([hostedJob]),
    '/infrastructure/backupAgents/jobs': page([]),
    '/infrastructure/vb365Servers/organizations/jobs': page([]),
    '/infrastructure/jobSessionHeatmap/': json({ data: { successJobsCount: 0, warningJobsCount: 0, failJobsCount: 1 } }),
    '/organizations': ORGS,
    '/infrastructure/backupServers': SERVERS,
  };

  it('is the mapped company in the job list, the failure list and the summary alike', async () => {
    setFetchForTests(fakeVspc(routes).fn);
    const list = JSON.parse(textOf(await call('vspc_list_jobs')));
    const failed = JSON.parse(textOf(await call('vspc_list_failed_jobs')));
    const summary = JSON.parse(textOf(await call('vspc_failed_jobs_summary')));
    expect(list.jobs[0].company).toBe('Client One');
    expect(failed.jobs[0].company).toBe('Client One');
    expect(summary.rows[0].company).toBe('Client One');
    expect(summary.byCompany).toEqual([{ company: 'Client One', failed: 1, warning: 0 }]);
  });

  // A second job on the same hosted server that really is the provider's own.
  const providerJob = { ...hostedJob, instanceUid: 'p1', name: 'Provider config backup', mappedOrganizationUid: null };

  it('asking for the provider leaves out jobs mapped to a client, everywhere', async () => {
    const vspc = fakeVspc({ ...routes, '/infrastructure/backupServers/jobs': page([hostedJob, providerJob]) });
    setFetchForTests(vspc.fn);
    const list = JSON.parse(textOf(await call('vspc_list_jobs', { company: C2 })));
    expect(list.jobs.map((j: { name: string }) => j.name)).toEqual(['Provider config backup']);
    expect(list).toMatchObject({ total: 1, count: 1, offset: 0 });
    expect(list.nextOffset).toBeUndefined();
    const failed = JSON.parse(textOf(await call('vspc_list_failed_jobs', { company: C2 })));
    expect(failed.jobs.map((j: { job: string }) => j.job)).toEqual(['Provider config backup']);
    const summary = JSON.parse(textOf(await call('vspc_failed_jobs_summary', { company: C2 })));
    expect(summary.rows.map((r: { job: string }) => r.job)).toEqual(['Provider config backup']);
    expect(summary.byCompany).toEqual([{ company: 'Client Two', failed: 1, warning: 0 }]);
  });

  it('asking for the client includes its hosted job', async () => {
    setFetchForTests(fakeVspc({ ...routes, '/infrastructure/backupServers/jobs': page([hostedJob, providerJob]) }).fn);
    const list = JSON.parse(textOf(await call('vspc_list_jobs', { company: C1 })));
    expect(list.jobs.map((j: { name: string }) => j.name)).toEqual(['Hosted nightly']);
    expect(list.total).toBe(1);
    const failed = JSON.parse(textOf(await call('vspc_list_failed_jobs', { company: C1 })));
    expect(failed.jobs.map((j: { job: string }) => j.job)).toEqual(['Hosted nightly']);
  });

  it('pages a company\'s jobs exactly after the company check', async () => {
    const jobs = [hostedJob, providerJob, { ...providerJob, instanceUid: 'p2', name: 'Provider 2' }, { ...providerJob, instanceUid: 'p3', name: 'Provider 3' }];
    setFetchForTests(fakeVspc({ ...routes, '/infrastructure/backupServers/jobs': page(jobs) }).fn);
    const first = JSON.parse(textOf(await call('vspc_list_jobs', { company: C2, limit: 2 })));
    expect(first).toMatchObject({ total: 3, count: 2, offset: 0, nextOffset: 2 });
    const second = JSON.parse(textOf(await call('vspc_list_jobs', { company: C2, limit: 2, offset: 2 })));
    expect(second).toMatchObject({ total: 3, count: 1, offset: 2 });
    expect(second.nextOffset).toBeUndefined();
    expect([...first.jobs, ...second.jobs].map((j: { name: string }) => j.name)).not.toContain('Hosted nightly');
  });

  it('falls back to the server owner when the mapped company is empty', async () => {
    const unmapped = { ...hostedJob, mappedOrganizationUid: '' };
    setFetchForTests(fakeVspc({ ...routes, '/infrastructure/backupServers/jobs': page([unmapped]) }).fn);
    expect(JSON.parse(textOf(await call('vspc_list_jobs'))).jobs[0].company).toBe('Client Two');
    expect(JSON.parse(textOf(await call('vspc_list_failed_jobs'))).jobs[0].company).toBe('Client Two');
    // ... and matches when the owner is asked for
    expect(JSON.parse(textOf(await call('vspc_list_jobs', { company: C2 }))).jobs.map((j: { name: string }) => j.name)).toEqual(['Hosted nightly']);
    expect(JSON.parse(textOf(await call('vspc_list_failed_jobs', { company: C2 }))).count).toBe(1);
    expect(JSON.parse(textOf(await call('vspc_list_jobs', { company: C1 }))).total).toBe(0);
  });
});

describe('names fall back to UIDs', () => {
  const now = Date.now();
  const C3 = '33333333-3333-4333-8333-333333333333'; // not in the organisation list
  const job = {
    instanceUid: J1,
    name: 'Nightly',
    backupServerUid: S1,
    organizationUid: C3,
    status: 'Failed',
    lastEndTime: new Date(now - 3_600_000).toISOString(),
  };
  const base = {
    '/infrastructure/backupServers/jobs': page([job]),
    '/infrastructure/backupAgents/jobs': page([{ instanceUid: 'aj', name: 'WS', backupAgentUid: A1, organizationUid: C3, status: 'Failed', lastEndTime: new Date(now - 3_600_000).toISOString() }]),
    [`/infrastructure/backupAgents/${A1}`]: json({ data: { instanceUid: A1, name: 'PC-001' } }),
    '/infrastructure/vb365Servers/organizations/jobs': page([]),
    '/infrastructure/jobSessionHeatmap/': json({ data: { successJobsCount: 0, warningJobsCount: 0, failJobsCount: 2 } }),
    '/alarms/active': page([{ instanceUid: AL1, alarmTemplateUid: 't1', object: { organizationUid: C3 }, lastActivation: { status: 'Error', time: new Date(now).toISOString() } }]),
    '/alarms/templates': page([]),
  };
  const lookupFails = { '/organizations': json({ data: null, errors: [{ message: 'boom' }] }, 500), '/infrastructure/backupServers': json({ data: null }, 500) };
  const missingEntry = { '/organizations': ORGS, '/infrastructure/backupServers': page([{ instanceUid: S1, name: 'VBR-01', organizationUid: C3 }]) };

  for (const [label, lookups] of [['the lookup fails', lookupFails], ['the entry is missing', missingEntry]] as const) {
    it(`keeps the UID when ${label}`, async () => {
      setFetchForTests(fakeVspc({ ...base, ...lookups }).fn);
      const failed = JSON.parse(textOf(await call('vspc_list_failed_jobs')));
      const vbr = failed.jobs.find((j: { source: string }) => j.source === 'backup_server');
      expect(vbr).toMatchObject({ company: C3, companyUid: C3 });
      expect(vbr.where).toBe(label === 'the lookup fails' ? S1 : 'VBR-01');
      const summary = JSON.parse(textOf(await call('vspc_failed_jobs_summary')));
      expect(summary.rows.every((r: { company: string }) => r.company === C3)).toBe(true);
      expect(summary.byCompany).toEqual([{ company: C3, failed: 2, warning: 0 }]);
      const list = JSON.parse(textOf(await call('vspc_list_jobs')));
      expect(list.jobs[0]).toMatchObject({ company: C3, companyUid: C3 });
      const agents = JSON.parse(textOf(await call('vspc_list_agent_jobs')));
      expect(agents.agentJobs[0]).toMatchObject({ company: C3, companyUid: C3, computer: 'PC-001' });
      const alarms = JSON.parse(textOf(await call('vspc_list_alarms')));
      expect(alarms.alarms[0].company).toBe(C3);
      expect(alarms.alarms[0].alarm).toBe('t1');
    });
  }

  it('servers keep their company UID too', async () => {
    setFetchForTests(fakeVspc({ '/infrastructure/backupServers': page([{ instanceUid: S1, name: 'VBR-01', organizationUid: C3 }]), '/organizations': json({}, 500) }).fn);
    const out = JSON.parse(textOf(await call('vspc_list_backup_servers')));
    expect(out.backupServers[0].company).toBe(C3);
  });

  it('nameOrUid: name, else UID, else nothing', () => {
    const m = new Map([[C1, 'Client One'], [C2, '']]);
    expect(nameOrUid(m, C1.toUpperCase())).toBe('Client One');
    expect(nameOrUid(m, C2)).toBe(C2); // empty name
    expect(nameOrUid(m, C3)).toBe(C3); // missing
    expect(nameOrUid(undefined, C3)).toBe(C3); // lookup failed
    expect(nameOrUid(m, '')).toBeUndefined();
    expect(nameOrUid(m, null)).toBeUndefined();
  });
});

describe('company names', () => {
  const many = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({ instanceUid: `00000000-0000-4000-8000-${String(from + i).padStart(12, '0')}`, name: `Acme ${from + i}` }));

  it('reads every match before deciding, so an exact match on a later page wins', async () => {
    const exactUid = '99999999-9999-4999-8999-999999999999';
    const vspc = fakeVspc({
      '/organizations/companies': (url) => {
        expect(url.searchParams.get('limit')).toBe('500');
        const offset = Number(url.searchParams.get('offset'));
        return offset === 0 ? page(many(500), 600, 0) : page([...many(99, 500), { instanceUid: exactUid, name: 'Acme' }], 600, 500);
      },
      '/infrastructure/backupServers/jobs': (url) => {
        expect(JSON.stringify(filterOf(url))).toContain(exactUid);
        return page([]);
      },
      '/organizations': ORGS,
      '/infrastructure/backupServers': SERVERS,
    });
    setFetchForTests(vspc.fn);
    const r = await call('vspc_list_jobs', { company: 'ACME' });
    expect(r.isError).toBeUndefined();
    expect(vspc.calls.filter((c) => c.path === '/organizations/companies')).toHaveLength(2);
  });

  it('says how many matched, and that not all were read, past the cap', async () => {
    const vspc = fakeVspc({
      '/organizations/companies': (url) => {
        const offset = Number(url.searchParams.get('offset'));
        return page(many(500, offset), 2_500, offset);
      },
    });
    setFetchForTests(vspc.fn);
    const text = textOf(await call('vspc_list_jobs', { company: 'acme' }));
    expect(text).toContain('matches 2500 companies');
    expect(text).toContain(`only the first ${MAX_NAME_MATCHES} were read`);
    expect(vspc.calls.filter((c) => c.path === '/organizations/companies')).toHaveLength(MAX_NAME_MATCHES / 500);
  });
});

describe('name cache', () => {
  const serversRoute = page([{ instanceUid: S1, name: 'VBR-01', organizationUid: C1 }]);
  const orgCalls = (vspc: ReturnType<typeof fakeVspc>) => vspc.calls.filter((c) => c.path === '/organizations').length;

  it('reuses the organisation list across tool calls, until it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const vspc = fakeVspc({ '/infrastructure/backupServers': serversRoute, '/organizations': ORGS });
    setFetchForTests(vspc.fn);
    expect(JSON.parse(textOf(await call('vspc_list_backup_servers'))).backupServers[0].company).toBe('Client One');
    await call('vspc_list_backup_servers');
    expect(orgCalls(vspc)).toBe(1);
    vi.setSystemTime(Date.now() + NAME_CACHE_TTL_MS + 1);
    await call('vspc_list_backup_servers');
    expect(orgCalls(vspc)).toBe(2);
  });

  it('does not keep a failed lookup', async () => {
    let n = 0;
    const vspc = fakeVspc({
      '/infrastructure/backupServers': serversRoute,
      '/organizations': () => (n++ === 0 ? json({ data: null, errors: [{ message: 'busy' }] }, 500) : ORGS.clone()),
    });
    setFetchForTests(vspc.fn);
    expect(JSON.parse(textOf(await call('vspc_list_backup_servers'))).backupServers[0].company).toBe(C1);
    expect(JSON.parse(textOf(await call('vspc_list_backup_servers'))).backupServers[0].company).toBe('Client One');
    expect(orgCalls(vspc)).toBe(2);
  });

  it('keeps consoles and keys apart', async () => {
    const vspc = fakeVspc({ '/infrastructure/backupServers': serversRoute, '/organizations': ORGS });
    setFetchForTests(vspc.fn);
    await call('vspc_list_backup_servers');
    await runWithConfig({ ...config, apiKey: 'ANOTHER-KEY-0123456789' }, () => dispatchToolCall('vspc_list_backup_servers', {}));
    await runWithConfig({ ...config, origin: 'https://other.test:1280' }, () => dispatchToolCall('vspc_list_backup_servers', {}));
    expect(orgCalls(vspc)).toBe(3);
  });
});

describe('grouping', () => {
  it('folds retries of the same job and keeps the worst status', () => {
    const base = { source: 'backup_server' as const, companyUid: C1, company: 'Client One', whereUid: S1, where: 'VBR-01' };
    const jobs: FailedJob[] = [
      { ...base, job: 'Nightly (Retry 1)', status: 'Warning', lastEndTime: '2026-11-20T02:00:00Z', jobUid: 'a' },
      { ...base, job: 'Nightly', status: 'Failed', lastEndTime: '2026-11-20T01:00:00Z', jobUid: 'b', message: 'first' },
      { ...base, job: 'Other', status: 'Warning', lastEndTime: '2026-11-20T03:00:00Z' },
    ];
    const g = groupFailures(jobs);
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ job: 'Nightly', status: 'Failed', occurrences: 2, latest: '2026-11-20T02:00:00Z', message: 'first', jobUids: ['a', 'b'] });
    expect(baseJobName('Backup Job 1 (Retry 3)')).toBe('Backup Job 1');
  });
});

describe('writes', () => {
  it('starts a job with one POST and a request id', async () => {
    const vspc = fakeVspc({ [`POST /infrastructure/backupServers/jobs/${J1}/start`]: json({ data: null }) });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_start_job', { job_uid: J1.toUpperCase() })));
    expect(out).toEqual({ requested: 'start', jobUid: J1, accepted: true });
    expect(vspc.calls).toHaveLength(1);
    expect((vspc.calls[0].init.headers as Record<string, string>)['X-Request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect((vspc.calls[0].init.headers as Record<string, string>)['X-Client-Version']).toBe('3.6.1');
  });

  it('derives the write request id from the tool and its arguments (idempotent within VSPC\'s 5 min)', async () => {
    const ids: string[] = [];
    const vspc = fakeVspc({
      [`POST /infrastructure/backupServers/jobs/${J1}/start`]: (_u: URL, init: RequestInit) => {
        ids.push((init.headers as Record<string, string>)['X-Request-id']);
        return json({ data: null });
      },
      [`POST /infrastructure/backupServers/jobs/${J1}/retry`]: (_u: URL, init: RequestInit) => {
        ids.push((init.headers as Record<string, string>)['X-Request-id']);
        return json({ data: null });
      },
      [`POST /alarms/active/${AL1}/acknowledge`]: (_u: URL, init: RequestInit) => {
        ids.push((init.headers as Record<string, string>)['X-Request-id']);
        return json({ data: null });
      },
    });
    setFetchForTests(vspc.fn);
    await call('vspc_start_job', { job_uid: J1 });
    await call('vspc_start_job', { job_uid: J1.toUpperCase() }); // same job: same id
    await call('vspc_retry_job', { job_uid: J1 }); // other tool: other id
    await call('vspc_acknowledge_alarm', { alarm_uid: AL1, comment: 'a' });
    await call('vspc_acknowledge_alarm', { alarm_uid: AL1, comment: 'b' }); // other args: other id
    await call('vspc_acknowledge_alarm', { comment: 'a', alarm_uid: AL1, on_client_portal: false }); // same after defaults
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[4]).not.toBe(ids[3]);
    expect(ids[5]).toBe(ids[3]);
    expect(new Set(ids).size).toBe(4);
  });

  it('sends no request id on reads', async () => {
    const vspc = fakeVspc({ '/about': json({ data: { serverVersion: '9.1' } }) });
    setFetchForTests(vspc.fn);
    await call('vspc_about');
    await call('vspc_about');
    for (const c of vspc.calls) expect((c.init.headers as Record<string, string>)['X-Request-id']).toBeUndefined();
  });

  it('builds canonical JSON and stable ids', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 'z' }, u: undefined })).toBe('{"a":{"c":"z","d":[2,{"x":2,"y":1}]},"b":1}');
    expect(writeRequestId('t', { a: 1, b: 2 })).toBe(writeRequestId('t', { b: 2, a: 1 }));
    expect(writeRequestId('t', { a: 1 })).not.toBe(writeRequestId('u', { a: 1 }));
  });

  it('acknowledges an alarm with its comment', async () => {
    const vspc = fakeVspc({
      [`POST /alarms/active/${AL1}/acknowledge`]: (url: URL) => {
        expect(url.searchParams.get('comment')).toBe('Looking at it');
        expect(url.searchParams.get('resolveOnClients')).toBe('false');
        return json({ data: { instanceUid: AL1 } });
      },
    });
    setFetchForTests(vspc.fn);
    const r = await call('vspc_acknowledge_alarm', { alarm_uid: AL1, comment: 'Looking at it' });
    expect(JSON.parse(textOf(r))).toMatchObject({ requested: 'acknowledge', accepted: true });
    expect(textOf(await call('vspc_acknowledge_alarm', { alarm_uid: AL1 }))).toContain('comment is required');
  });
});
