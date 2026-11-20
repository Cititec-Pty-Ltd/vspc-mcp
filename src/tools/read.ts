import type { Api } from '../client.js';
import type { FilterExpression } from '../types.js';
import { VspcApiError } from '../types.js';
import { JOB_SOURCES, RESULT_STATUSES, companyFilter, findFailedJobs, groupFailures, jobCompanyFilter, jobCompanyUid, statusFilter } from './jobs.js';
import type { JobSource } from './jobs.js';
import { Names, resolveCompany, safely } from './lookups.js';
import type { ParamSpec, ReadSpec } from './spec.js';
import { hoursAgo, oneLine, pick, timeOf } from './shared.js';

// --- Shared parameters ------------------------------------------------------------------------

const COMPANY: ParamSpec = {
  type: 'string',
  maxLength: 200,
  description: 'Company (client) as its VSPC UID or its name (exact, or a unique part of it). Leave out for every company.',
};
const LIMIT: ParamSpec = { type: 'int', min: 1, max: 500, default: 100, description: 'Page size (VSPC maximum 500).' };
const OFFSET: ParamSpec = { type: 'int', min: 0, max: 1_000_000, default: 0, description: 'Items to skip (for the next page).' };
const NAME: ParamSpec = { type: 'string', maxLength: 200, description: 'Only items whose name contains this text (case-insensitive).' };

const JOB_STATUSES = [
  'Unknown', 'None', 'Idle', 'Success', 'Warning', 'Failed', 'Running', 'Starting', 'Stopping', 'Enabling', 'Disabling',
  'WaitingTape', 'WaitingRepository',
] as const;
const AGENT_JOB_STATUSES = ['Unknown', 'None', 'Success', 'Warning', 'Failed', 'Starting', 'Running', 'Stopping'] as const;
const SERVER_STATUSES = ['Unknown', 'Healthy', 'Warning', 'Inaccessible'] as const;
const ALARM_STATUSES = ['Error', 'Warning', 'Info', 'Acknowledged', 'Resolved', 'Unknown'] as const;
const COMPANY_STATUSES = ['Active', 'Disabled', 'Unknown'] as const;

function nameFilter(value: unknown): FilterExpression[] {
  return typeof value === 'string' ? [{ property: 'name', operation: 'contains', collation: 'ignorecase', value }] : [];
}

async function companyOf(api: Api, args: Record<string, unknown>): Promise<{ uid: string; name?: string } | undefined> {
  return typeof args.company === 'string' ? resolveCompany(api, args.company) : undefined;
}

function paging(p: { total: number; count: number; offset: number }) {
  const next = p.offset + p.count;
  return { total: p.total, count: p.count, offset: p.offset, ...(next < p.total ? { nextOffset: next } : {}) };
}

const JOB_FIELDS = [
  'type', 'status', 'isEnabled', 'scheduleType', 'lastRun', 'lastEndTime', 'lastDuration', 'avgDuration', 'transferredData',
  'destination', 'targetType', 'retentionLimit', 'retentionLimitType', 'bottleneck',
] as const;

/** License usage figures per workload (CurrentLicenseUsageWorkload, REST API 3.6.1). */
const USAGE_FIELDS = ['usedUnits', 'newUnits', 'rentalUnits', 'usedCount', 'newCount', 'rentalCount'] as const;
type UsageField = (typeof USAGE_FIELDS)[number];

/** Rows in vspc_failed_jobs_summary (Failed rows sort first; byCompany always counts every row). */
const MAX_SUMMARY_ROWS = 120;

// --- Tools ------------------------------------------------------------------------------------

export const READ_SPECS: ReadSpec[] = [
  {
    name: 'vspc_about',
    kind: 'read',
    description:
      'Veeam Service Provider Console version and installation details (server version, current Veeam Agent and management agent versions). A cheap first call to check the connection and key.',
    params: {},
    run: async (_args, api) =>
      pick(await api.get('/about'), [
        'serverVersion', 'installationId', 'installationDate', 'actualVawVersion', 'actualValVersion', 'actualVamVersion',
        'windowsManagementAgentVersion', 'linuxManagementAgentVersion', 'macManagementAgentVersion',
      ]),
  },
  {
    name: 'vspc_list_companies',
    kind: 'read',
    description:
      'Companies (clients) managed in VSPC, sorted by name: UID, name, status. Use a UID or name from here as `company` in the other tools.',
    params: {
      name: NAME,
      status: { type: 'string', enum: COMPANY_STATUSES, description: 'Only companies with this status.' },
      limit: LIMIT,
      offset: OFFSET,
    },
    run: async (args, api) => {
      const filter = nameFilter(args.name);
      if (args.status) filter.push({ property: 'status', operation: 'equals', value: args.status });
      const p = await api.page('/organizations/companies', {
        filter,
        sort: [{ property: 'name', direction: 'ascending' }],
        limit: args.limit as number,
        offset: args.offset as number,
      });
      const resellers = await safely(new Names(api).organizations());
      return {
        ...paging(p),
        companies: p.items.map((c) => ({
          ...pick(c, ['instanceUid', 'name', 'status']),
          ...(c.resellerUid ? { reseller: resellers?.get(String(c.resellerUid).toLowerCase()) ?? c.resellerUid } : {}),
        })),
      };
    },
  },
  {
    name: 'vspc_get_company',
    kind: 'read',
    description: 'One company: status, reseller, subscription plan, services enabled for it (owner credentials are never returned).',
    params: { company: { ...COMPANY, required: true, description: 'Company UID or name.' } },
    run: async (args, api) => {
      const { uid } = (await companyOf(api, args))!;
      const c = await api.get<Record<string, unknown>>(`/organizations/companies/${uid}`);
      const { ownerCredentials: _hidden, _embedded: _e, ...rest } = c ?? {};
      return rest;
    },
  },
  {
    name: 'vspc_list_backup_servers',
    kind: 'read',
    description:
      'Veeam Backup & Replication servers managed by VSPC, across every client: name, company, version (with patch), role, and status (Healthy, Warning, Inaccessible).',
    params: {
      company: COMPANY,
      name: NAME,
      statuses: { type: 'string_list', enum: SERVER_STATUSES, maxItems: 4, description: 'Only servers with one of these statuses, e.g. ["Inaccessible","Warning"].' },
      limit: LIMIT,
      offset: OFFSET,
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const filter = nameFilter(args.name);
      if (company) filter.push(companyFilter(['organizationUid'], company.uid));
      if (args.statuses) filter.push(statusFilter('status', args.statuses as string[]));
      const p = await api.page('/infrastructure/backupServers', {
        filter,
        sort: [{ property: 'name', direction: 'ascending' }],
        limit: args.limit as number,
        offset: args.offset as number,
      });
      const names = new Names(api);
      const orgs = await safely(names.organizations());
      return {
        ...paging(p),
        backupServers: p.items.map((s) => ({
          ...pick(s, ['instanceUid', 'name']),
          company: orgs?.get(String(s.organizationUid ?? '').toLowerCase()) ?? s.organizationUid,
          ...pick(s, ['status', 'displayVersion', 'version', 'backupServerRoleType', 'inHighAvailabilityCluster']),
        })),
      };
    },
  },
  {
    name: 'vspc_list_jobs',
    kind: 'read',
    description:
      'Jobs on managed Veeam Backup & Replication servers (VM backup, replication, backup copy, tape, file share, agent jobs managed by VBR): latest result, last run and end, duration, destination, failure message. Filter by company, backup server, latest result and name. For "what failed recently" across all clients, use vspc_list_failed_jobs or vspc_failed_jobs_summary.',
    params: {
      company: COMPANY,
      backup_server_uid: { type: 'uuid', description: 'Only jobs on this backup server (UID from vspc_list_backup_servers).' },
      statuses: { type: 'string_list', enum: JOB_STATUSES, maxItems: 13, description: 'Only jobs whose latest session has one of these results, e.g. ["Failed","Warning"].' },
      name: NAME,
      enabled: { type: 'boolean', description: 'true: only jobs whose schedule is enabled; false: only disabled ones.' },
      limit: LIMIT,
      offset: OFFSET,
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const filter = nameFilter(args.name);
      if (company) filter.push(jobCompanyFilter('backup_server', company.uid));
      if (args.statuses) filter.push(statusFilter('status', args.statuses as string[]));
      if (typeof args.enabled === 'boolean') filter.push({ property: 'isEnabled', operation: 'equals', value: args.enabled });
      const path = args.backup_server_uid ? `/infrastructure/backupServers/${args.backup_server_uid}/jobs` : '/infrastructure/backupServers/jobs';
      const p = await api.page(path, {
        filter,
        sort: [{ property: 'name', direction: 'ascending' }],
        limit: args.limit as number,
        offset: args.offset as number,
      });
      const names = new Names(api);
      const [orgs, servers] = await Promise.all([safely(names.organizations()), safely(names.backupServers())]);
      return {
        ...paging(p),
        jobs: p.items.map((j) => {
          const owner = jobCompanyUid('backup_server', j);
          return {
            ...pick(j, ['instanceUid', 'name']),
            company: (owner && orgs?.get(owner)) ?? owner,
            backupServer: servers?.get(String(j.backupServerUid ?? '').toLowerCase()) ?? j.backupServerUid,
            ...pick(j, JOB_FIELDS),
            ...(oneLine(j.failureMessage, 400) ? { failureMessage: oneLine(j.failureMessage, 400) } : {}),
          };
        }),
      };
    },
  },
  {
    name: 'vspc_list_agent_jobs',
    kind: 'read',
    description:
      'Jobs of Veeam Agents (Windows, Linux, Mac) managed by VSPC, such as backup policies on workstations and servers: computer, company, policy, latest result, last run, next run, failure message.',
    params: {
      company: COMPANY,
      statuses: { type: 'string_list', enum: AGENT_JOB_STATUSES, maxItems: 8, description: 'Only jobs whose latest session has one of these results.' },
      name: NAME,
      limit: LIMIT,
      offset: OFFSET,
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const filter = nameFilter(args.name);
      if (company) filter.push(jobCompanyFilter('agent', company.uid));
      if (args.statuses) filter.push(statusFilter('status', args.statuses as string[]));
      const p = await api.page('/infrastructure/backupAgents/jobs', {
        filter,
        sort: [{ property: 'name', direction: 'ascending' }],
        limit: args.limit as number,
        offset: args.offset as number,
      });
      const names = new Names(api);
      const orgs = await safely(names.organizations());
      const agentUids = [...new Set(p.items.map((j) => String(j.backupAgentUid ?? '')).filter(Boolean))].slice(0, 40);
      const computers = new Map<string, string | undefined>();
      await Promise.all(agentUids.map(async (u) => computers.set(u, await names.agentName(u))));
      return {
        ...paging(p),
        agentJobs: p.items.map((j) => ({
          ...pick(j, ['instanceUid', 'name']),
          computer: computers.get(String(j.backupAgentUid ?? '')) ?? j.backupAgentUid,
          company: ((uid) => (uid && orgs?.get(uid)) ?? uid)(jobCompanyUid('agent', j)),
          ...pick(j, ['systemType', 'backupPolicyName', 'backupPolicyAssignStatus', 'status', 'lastRun', 'lastEndTime', 'lastDuration', 'nextRun', 'backupMode', 'targetType', 'destination', 'isEnabled']),
          ...(oneLine(j.failureMessage ?? j.backupPolicyFailureMessage, 400)
            ? { failureMessage: oneLine(j.failureMessage ?? j.backupPolicyFailureMessage, 400) }
            : {}),
        })),
      };
    },
  },
  {
    name: 'vspc_list_failed_jobs',
    kind: 'read',
    description:
      'Every job across ALL companies whose latest session failed (or ended with a warning) in the last N hours, newest first, with company, backup server or computer, and the failure reason. Covers Veeam Backup & Replication server jobs, Veeam Agent jobs and Veeam Backup for Microsoft 365 jobs in one call. VSPC keeps only the latest session of each job, so a job that failed and then succeeded on retry is not listed. For one row per job with retries folded together, use vspc_failed_jobs_summary.',
    params: {
      hours: { type: 'int', min: 1, max: 720, default: 24, description: 'Look-back window in hours (default 24).' },
      statuses: { type: 'string_list', enum: RESULT_STATUSES, maxItems: 2, default: ['Failed'], description: 'Results to include: ["Failed"] (default) or ["Failed","Warning"].' },
      company: COMPANY,
      backup_server_uid: { type: 'uuid', description: 'Only jobs on this Veeam Backup & Replication server (then agent and VB365 jobs are skipped).' },
      sources: { type: 'string_list', enum: JOB_SOURCES, maxItems: 3, default: [...JOB_SOURCES], description: 'Job kinds: backup_server (VBR jobs), agent (Veeam Agent jobs), vb365 (Microsoft 365 jobs). Default all.' },
      max_rows: { type: 'int', min: 1, max: 200, default: 50, description: 'Most rows returned (newest first); `count` is always the full number.' },
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const r = await findFailedJobs(api, {
        hours: args.hours as number,
        statuses: args.statuses as string[],
        sources: args.sources as JobSource[],
        companyUid: company?.uid,
        backupServerUid: args.backup_server_uid as string | undefined,
      });
      return {
        window: r.window,
        statuses: r.statuses,
        count: r.jobs.length,
        ...(r.jobs.length > (args.max_rows as number) ? { shown: args.max_rows, more: 'Narrow by company, sources or hours, or use vspc_failed_jobs_summary.' } : {}),
        jobs: r.jobs.slice(0, args.max_rows as number).map(({ companyUid: _c, whereUid, ...j }) => ({ ...j, where: j.where ?? whereUid })),
        scanned: r.scanned,
        note: 'Latest session per job only (VSPC keeps no session history). Incomplete sources are marked complete: false.',
      };
    },
  },
  {
    name: 'vspc_failed_jobs_summary',
    kind: 'read',
    description:
      'Summary of backup failures across ALL companies in the last N hours: one row per job (retries of the same job, and one agent job failing on several computers of a company, are folded together, worst result first), counts per company, and VSPC\'s session counts (successful, warning, failed sessions) for the window. The best first call for "which backups failed in the last 24 hours?".',
    params: {
      hours: { type: 'int', min: 1, max: 720, default: 24, description: 'Look-back window in hours (default 24).' },
      include_warnings: { type: 'boolean', default: false, description: 'Also include jobs whose latest session ended with a warning.' },
      company: COMPANY,
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const now = Date.now();
      const hours = args.hours as number;
      const statuses = args.include_warnings ? ['Failed', 'Warning'] : ['Failed'];
      const [r, heat] = await Promise.all([
        findFailedJobs(api, { hours, statuses, sources: [...JOB_SOURCES], companyUid: company?.uid, now }),
        company
          ? Promise.resolve(undefined)
          : safely(api.get<Record<string, unknown>>('/infrastructure/jobSessionHeatmap/', { from: hoursAgo(hours, now), to: new Date(now).toISOString() })),
      ]);
      const groups = groupFailures(r.jobs);
      const perCompany = new Map<string, { failed: number; warning: number }>();
      for (const g of groups) {
        const k = g.company ?? '(unknown)';
        const c = perCompany.get(k) ?? { failed: 0, warning: 0 };
        if (g.status === 'Failed') c.failed++;
        else c.warning++;
        perCompany.set(k, c);
      }
      return {
        window: r.window,
        ...(heat ? { sessionCounts: pick(heat, ['successJobsCount', 'warningJobsCount', 'failJobsCount']) } : {}),
        failingJobs: groups.length,
        byCompany: [...perCompany.entries()]
          .map(([name, c]) => ({ company: name, ...c }))
          .sort((a, b) => b.failed - a.failed || b.warning - a.warning),
        ...(groups.length > MAX_SUMMARY_ROWS ? { shownRows: MAX_SUMMARY_ROWS } : {}),
        rows: groups.slice(0, MAX_SUMMARY_ROWS),
        scanned: r.scanned,
        note: 'Rows come from each job\'s latest session (VSPC keeps no session history): a job that failed and then succeeded is not a row. sessionCounts are VSPC\'s own count of sessions in the window (all companies).',
      };
    },
  },
  {
    name: 'vspc_list_alarms',
    kind: 'read',
    description:
      'Triggered (active) VSPC alarms across every client, newest first: alarm name, status (Error, Warning, ...), time, message, the object (job, server, agent, repository...), computer and company. Defaults to Error and Warning alarms.',
    params: {
      statuses: { type: 'string_list', enum: ALARM_STATUSES, maxItems: 6, default: ['Error', 'Warning'], description: 'Alarm statuses to include (default Error and Warning).' },
      company: COMPANY,
      hours: { type: 'int', min: 1, max: 8760, description: 'Only alarms last triggered within this many hours.' },
      limit: LIMIT,
      offset: OFFSET,
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const filter: FilterExpression[] = [statusFilter('lastActivation.status', args.statuses as string[])];
      if (company) filter.push({ property: 'object.organizationUid', operation: 'equals', value: company.uid });
      const since = typeof args.hours === 'number' ? Date.now() - (args.hours as number) * 3_600_000 : undefined;
      const query = (f: FilterExpression[]) =>
        api.page('/alarms/active', {
          filter: f,
          sort: [{ property: 'lastActivation.time', direction: 'descending' }],
          limit: args.limit as number,
          offset: args.offset as number,
        });
      // The time window goes to VSPC, so total, count and nextOffset are exact. If the console
      // refuses a date comparison (HTTP 400), filter here instead and say so (see the paging below).
      let timeFilter: 'vspc' | 'client' | undefined = since === undefined ? undefined : 'vspc';
      let p;
      try {
        p = await query(
          since === undefined
            ? filter
            : [...filter, { property: 'lastActivation.time', operation: 'greaterThanOrEqual', value: new Date(since).toISOString() }]
        );
      } catch (err) {
        if (!(since !== undefined && err instanceof VspcApiError && err.httpStatus === 400)) throw err;
        timeFilter = 'client';
        p = await query(filter);
      }
      const names = new Names(api);
      const [orgs, templates] = await Promise.all([
        safely(names.organizations()),
        safely(api.all<Record<string, unknown>>('/alarms/templates', {}, { maxItems: 5_000 })),
      ]);
      const templateName = new Map((templates?.items ?? []).map((t) => [String(t.instanceUid ?? '').toLowerCase(), String(t.name ?? '')]));
      const inWindow = (a: Record<string, unknown>) =>
        since === undefined || (timeOf((a.lastActivation as Record<string, unknown>)?.time) ?? 0) >= since;
      const alarms = p.items
        .filter(inWindow)
        .map((a) => {
          const last = (a.lastActivation ?? {}) as Record<string, unknown>;
          const obj = (a.object ?? {}) as Record<string, unknown>;
          return {
            instanceUid: a.instanceUid,
            alarm: templateName.get(String(a.alarmTemplateUid ?? '').toLowerCase()) || a.alarmTemplateUid,
            status: last.status,
            time: last.time,
            message: oneLine(last.message, 400),
            objectType: obj.type,
            objectName: obj.objectName ?? undefined,
            computer: obj.computerName || undefined,
            company: orgs?.get(String(obj.organizationUid ?? '').toLowerCase()) ?? obj.organizationUid,
            repeatCount: a.repeatCount,
          };
        });
      if (timeFilter !== 'client' && alarms.length === p.items.length) {
        return { ...paging(p), ...(timeFilter ? { timeFilter } : {}), alarms };
      }
      // Filtered here: `count` is what this page shows, `pageCountUnfiltered` what VSPC returned.
      // Alarms come newest first, so once this page reaches one outside the window there is
      // nothing later to page to; otherwise nextOffset follows VSPC's (unfiltered) paging.
      const nextRaw = p.offset + p.count;
      const reachedWindowEnd = p.items.some((a) => !inWindow(a));
      return {
        totalUnfiltered: p.total,
        count: alarms.length,
        pageCountUnfiltered: p.count,
        offset: p.offset,
        ...(!reachedWindowEnd && nextRaw < p.total ? { nextOffset: nextRaw } : {}),
        timeFilter: 'client',
        note: reachedWindowEnd
          ? 'Time filter applied after fetching; this page reached alarms older than the window, so there are no more in it.'
          : 'Time filter applied after fetching; a page can show fewer alarms than limit. Follow nextOffset for more.',
        alarms,
      };
    },
  },
  {
    name: 'vspc_list_protected_vms',
    kind: 'read',
    description:
      'Virtual machines protected by managed Veeam Backup & Replication servers: VM, company, backup server, restore points, latest restore point date, sizes, immutability. `oldest_first: true` puts the VMs with the oldest latest restore point first (stale backups).',
    params: {
      company: COMPANY,
      name: NAME,
      oldest_first: { type: 'boolean', default: false, description: 'Sort by latest restore point date, oldest first.' },
      limit: LIMIT,
      offset: OFFSET,
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const filter = nameFilter(args.name);
      if (company) filter.push({ property: 'organizationUid', operation: 'equals', value: company.uid });
      const p = await api.page('/protectedWorkloads/virtualMachines', {
        filter,
        sort: [args.oldest_first ? { property: 'latestRestorePointDate', direction: 'ascending' } : { property: 'name', direction: 'ascending' }],
        limit: args.limit as number,
        offset: args.offset as number,
      });
      const names = new Names(api);
      const [orgs, servers] = await Promise.all([safely(names.organizations()), safely(names.backupServers())]);
      return {
        ...paging(p),
        vms: p.items.map((v) => ({
          ...pick(v, ['instanceUid', 'name']),
          company: orgs?.get(String(v.organizationUid ?? '').toLowerCase()) ?? v.organizationUid,
          backupServer: servers?.get(String(v.backupServerUid ?? '').toLowerCase()) ?? v.backupServerUid,
          ...pick(v, ['restorePoints', 'latestRestorePointDate', 'provisionedSourceSize', 'usedSourceSize', 'totalRestorePointSize', 'immutable', 'malwareState']),
        })),
      };
    },
  },
  {
    name: 'vspc_list_backup_policies',
    kind: 'read',
    description: 'Veeam Agent backup policies defined in VSPC: name, OS, mode, who created it, last change, and how many companies and agents use it.',
    params: { name: NAME, limit: LIMIT, offset: OFFSET },
    run: async (args, api) => {
      const p = await api.page('/configuration/backupPolicies', {
        filter: nameFilter(args.name),
        sort: [{ property: 'name', direction: 'ascending' }],
        limit: args.limit as number,
        offset: args.offset as number,
      });
      return {
        ...paging(p),
        policies: p.items.map((x) => ({
          ...pick(x, ['instanceUid', 'name', 'systemType', 'type', 'operationMode', 'accessMode', 'createdBy', 'modifiedDate']),
          ...(oneLine(x.description, 200) ? { description: oneLine(x.description, 200) } : {}),
          companies: Array.isArray(x.companies) ? x.companies.length : undefined,
          agents: Array.isArray(x.agents) ? x.agents.length : undefined,
        })),
      };
    },
  },
  {
    name: 'vspc_get_license_usage',
    kind: 'read',
    description:
      'Current license usage by organization and server (Veeam Backup & Replication, Cloud Connect, VB365, VSPC, Veeam ONE): per workload type the used, new and rental units and counts, plus totals per workload across the result. Optionally one company.',
    params: {
      company: COMPANY,
      server_type: { type: 'string', enum: ['BackupAndReplication', 'CloudConnect', 'VSPC', 'VONE', 'VB365'], description: 'Only usage on servers of this product.' },
      limit: LIMIT,
      offset: OFFSET,
    },
    run: async (args, api) => {
      const company = await companyOf(api, args);
      const p = await api.page('/licensing/usage/organizations', {
        extra: { organizationUid: company?.uid, serverType: args.server_type as string | undefined },
        limit: args.limit as number,
        offset: args.offset as number,
      });
      const names = new Names(api);
      const [orgs, servers] = await Promise.all([safely(names.organizations()), safely(names.backupServers())]);
      // Every unit and count field of CurrentLicenseUsageWorkload (and ...ByPlatform) in the 3.6.1 spec.
      const nonZero = (w: Record<string, unknown>) => USAGE_FIELDS.some((f) => Number(w[f] ?? 0) !== 0);
      const totals = new Map<string, { workload: string; unitType?: unknown } & Record<UsageField, number>>();
      const organizations = p.items.map((o) => ({
        organization: orgs?.get(String(o.organizationUid ?? '').toLowerCase()) ?? o.organizationUid,
        organizationType: o.organizationType,
        servers: (Array.isArray(o.servers) ? (o.servers as Record<string, unknown>[]) : []).map((s) => ({
          server: servers?.get(String(s.serverUid ?? '').toLowerCase()) ?? s.serverUid,
          serverType: s.serverType,
          workloads: (Array.isArray(s.workloads) ? (s.workloads as Record<string, unknown>[]) : []).filter(nonZero).map((w) => {
            const workload = String(w.description ?? w.id ?? 'workload');
            // Units of different kinds (instances vs points) are never added together.
            const key = `${workload}|${String(w.unitType ?? '')}`;
            const t =
              totals.get(key) ??
              ({ workload, unitType: w.unitType, ...Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0])) } as {
                workload: string;
                unitType?: unknown;
              } & Record<UsageField, number>);
            for (const f of USAGE_FIELDS) t[f] += Number(w[f] ?? 0);
            totals.set(key, t);
            // The platform breakdown splits the same units: shown, never added to the totals again.
            const platforms = (Array.isArray(w.workloadsByPlatform) ? (w.workloadsByPlatform as Record<string, unknown>[]) : [])
              .filter(nonZero)
              .map((x) => pick(x, ['description', 'weight', ...USAGE_FIELDS]));
            return { ...pick(w, ['description', 'unitType', ...USAGE_FIELDS]), ...(platforms.length ? { byPlatform: platforms } : {}) };
          }),
        })),
      }));
      return {
        ...paging(p),
        totals: [...totals.values()],
        organizations,
      };
    },
  },
  {
    name: 'vspc_get_console_license',
    kind: 'read',
    description: 'The VSPC console license: edition, package, status, expiry and support expiry, last update result.',
    params: {},
    run: async (_args, api) =>
      pick(await api.get('/licensing/console'), [
        'edition', 'package', 'type', 'status', 'statusMessage', 'expirationDate', 'supportExpirationDate', 'licenseeCompany',
        'cloudConnect', 'lastUpdateDate', 'lastUpdateStatus', 'lastUpdateMessage',
      ]),
  },
];
