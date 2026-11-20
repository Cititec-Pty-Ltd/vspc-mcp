import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_SPECS, ALL_TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, dispatchToolCall } from '../tools/index.js';
import { parseVspcUrl, runWithConfig, setFetchForTests, scrub, buildUrl, getConfig } from '../client.js';
import { baseJobName, groupFailures } from '../tools/jobs.js';
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
          { operation: 'or', items: [{ property: 'organizationUid', operation: 'equals', value: C1 }, { property: 'mappedOrganizationUid', operation: 'equals', value: C1 }] },
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

  it('lists active alarms with template names', async () => {
    const now = Date.now();
    const vspc = fakeVspc({
      '/alarms/active': (url) => {
        expect(filterOf(url)).toEqual([
          { operation: 'or', items: [{ property: 'lastActivation.status', operation: 'equals', value: 'Error' }, { property: 'lastActivation.status', operation: 'equals', value: 'Warning' }] },
        ]);
        expect(JSON.parse(url.searchParams.get('sort')!)).toEqual([{ property: 'lastActivation.time', direction: 'descending' }]);
        return page([
          {
            instanceUid: AL1,
            alarmTemplateUid: 'T1',
            repeatCount: 3,
            object: { type: 'BackupServerJob', organizationUid: C2, computerName: 'VBR-02', objectName: 'Nightly' },
            lastActivation: { time: new Date(now - 3_600_000).toISOString(), status: 'Error', message: 'Job failed' },
          },
          {
            instanceUid: 'old',
            alarmTemplateUid: 'T1',
            object: { organizationUid: C2 },
            lastActivation: { time: new Date(now - 100 * 3_600_000).toISOString(), status: 'Error' },
          },
        ]);
      },
      '/alarms/templates': page([{ instanceUid: 't1', name: 'Job state' }]),
      '/organizations': ORGS,
    });
    setFetchForTests(vspc.fn);
    const out = JSON.parse(textOf(await call('vspc_list_alarms', { hours: 24 })));
    expect(out.alarms).toHaveLength(1);
    expect(out.alarms[0]).toMatchObject({ alarm: 'Job state', status: 'Error', company: 'Client Two', computer: 'VBR-02', objectName: 'Nightly' });
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
    expect(out.totals).toEqual([{ workload: 'VMs', unitType: 'Instances', usedUnits: 7, usedCount: 7, newCount: 0, rentalCount: 0 }]);
    expect(out.organizations[0].servers[0]).toMatchObject({ server: 'VBR-01', workloads: [{ description: 'VMs' }] });
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
