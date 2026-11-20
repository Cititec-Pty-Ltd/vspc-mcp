import type { Api } from '../client.js';
import type { FilterExpression } from '../types.js';
import { VspcApiError, VspcAuthError, VspcRateLimitError } from '../types.js';
import { LookupLog, Names, agentNames, errorInfo, nameOrUid } from './lookups.js';
import type { ErrorInfo } from './lookups.js';
import { oneLine, timeOf } from './shared.js';

/**
 * Job failures across every client.
 *
 * VSPC v3 has no job-session history: each job carries its latest session
 * (status, start, end, failure message). "Failed in the last N hours" is
 * therefore "jobs whose latest session failed and ended in the last N hours".
 * A job that failed and then succeeded on retry is not a failure any more;
 * the session heatmap (vspc_failed_jobs_summary) gives the raw session counts.
 */

export const JOB_SOURCES = ['backup_server', 'agent', 'vb365'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export const RESULT_STATUSES = ['Failed', 'Warning'] as const;

interface SourceDef {
  path: string;
  statusProperty: string;
  /** The job's company fields, in order of precedence (see jobCompanyUid). */
  companyProperties: string[];
}

const SOURCES: Record<JobSource, SourceDef> = {
  // Jobs on managed Veeam Backup & Replication servers (VM, copy, tape, file share, agent jobs managed by VBR...).
  // mappedOrganizationUid is the company the job is assigned to; organizationUid owns the backup
  // server (on a hosted server that is the provider), so the mapped company comes first.
  backup_server: {
    path: '/infrastructure/backupServers/jobs',
    statusProperty: 'status',
    companyProperties: ['mappedOrganizationUid', 'organizationUid'],
  },
  // Jobs of Veeam Agents managed by VSPC (backup policies on workstations and servers)
  agent: { path: '/infrastructure/backupAgents/jobs', statusProperty: 'status', companyProperties: ['organizationUid'] },
  // Veeam Backup for Microsoft 365 jobs
  vb365: {
    path: '/infrastructure/vb365Servers/organizations/jobs',
    statusProperty: 'lastStatus',
    companyProperties: ['vspcOrganizationUid'],
  },
};

/**
 * The company a job belongs to: the first non-empty company field in the
 * source's order of precedence (VBR jobs: mapped company, then the server's
 * owner). Every tool that names a job's company uses this, so a job is never
 * put under two different companies.
 */
export function jobCompanyUid(source: JobSource, job: Record<string, unknown>): string | undefined {
  for (const p of SOURCES[source].companyProperties) {
    const v = job[p];
    if (typeof v === 'string' && v.trim() !== '') return v.trim().toLowerCase();
  }
  return undefined;
}

/**
 * VSPC pre-filter for a company's jobs: any of the source's company fields.
 * It is a superset (a hosted job also matches its server's owner), so callers
 * must keep only jobs for which jobBelongsTo is true: a job belongs to the
 * company jobCompanyUid shows, and to no other.
 */
export function jobCompanyFilter(source: JobSource, uid: string): FilterExpression {
  return companyFilter(SOURCES[source].companyProperties, uid);
}

/** True if the job's effective company (jobCompanyUid) is `uid`. */
export function jobBelongsTo(source: JobSource, job: Record<string, unknown>, uid: string): boolean {
  return jobCompanyUid(source, job) === uid.trim().toLowerCase();
}

export function statusFilter(property: string, statuses: readonly string[]): FilterExpression {
  if (statuses.length === 1) return { property, operation: 'equals', value: statuses[0] };
  return { operation: 'or', items: statuses.map((s) => ({ property, operation: 'equals', value: s })) };
}

export function companyFilter(properties: string[], uid: string): FilterExpression {
  if (properties.length === 1) return { property: properties[0], operation: 'equals', value: uid };
  return { operation: 'or', items: properties.map((p) => ({ property: p, operation: 'equals', value: uid })) };
}

export interface FailedJob {
  source: JobSource;
  jobUid?: string;
  job: string;
  type?: string;
  status: string;
  company?: string;
  companyUid?: string;
  /** Backup server, agent computer or VB365 server. */
  where?: string;
  whereUid?: string;
  lastRun?: string;
  lastEndTime?: string;
  message?: string;
}

export interface FailedJobsResult {
  window: { hours: number; since: string; until: string };
  statuses: string[];
  jobs: FailedJob[];
  /** Per source: matching latest-session jobs before the time filter, and whether every page was read. */
  scanned: Record<string, { matched: number; read: number; complete: boolean; error?: string }>;
  /**
   * True only if every source asked for was read in full. When false, `jobs`
   * is a lower bound: a zero means "none found in what could be read", never
   * "no failures".
   */
  complete: boolean;
  /** Sources that could not be read, and why. */
  sourceErrors: ({ source: JobSource } & ErrorInfo)[];
  /** Sources read only in part (the page or time cap was hit). */
  partialSources: JobSource[];
  /** Name lookups that failed (rows then show UIDs), with the reason. */
  lookupErrors: ReturnType<LookupLog['report']>['lookupErrors'];
}

/**
 * Thrown when no job source could be read: a tool must report that as an
 * error, not as an empty result. Keeps a rate-limit wait if any source had one.
 */
function allSourcesFailed(failures: { source: JobSource; err: unknown }[]): Error {
  const reasons = failures.map((f) => `${f.source}: ${(f.err as Error).message}`).join('; ');
  const message = `No job source could be read, so failures are unknown (not zero). ${reasons}`;
  const limited = failures.map((f) => f.err).find((e): e is VspcRateLimitError => e instanceof VspcRateLimitError);
  if (limited) return new VspcRateLimitError(message, limited.retryAfterSeconds);
  const auth = failures.map((f) => f.err).find((e): e is VspcAuthError => e instanceof VspcAuthError);
  if (auth) return new VspcAuthError(message, auth.httpStatus);
  return new VspcApiError(message);
}

export interface FailedJobsQuery {
  hours: number;
  statuses: string[];
  sources: JobSource[];
  companyUid?: string;
  backupServerUid?: string;
  now?: number;
}


function vb365Message(j: Record<string, unknown>): string | undefined {
  const logs = Array.isArray(j.lastErrorLogRecords) ? (j.lastErrorLogRecords as Record<string, unknown>[]) : [];
  const errors = logs.filter((l) => l?.logType === 'Error' || l?.logType === 'Warning').map((l) => oneLine(l.message, 200));
  return oneLine([j.lastStatusDetails, ...errors].filter(Boolean).join(' | '), 400);
}

export async function findFailedJobs(api: Api, q: FailedJobsQuery): Promise<FailedJobsResult> {
  const now = q.now ?? Date.now();
  const since = now - q.hours * 3_600_000;
  const deadline = now + 40_000;
  const names = new Names(api);
  const log = new LookupLog();
  const scanned: FailedJobsResult['scanned'] = {};
  const failures: { source: JobSource; err: unknown }[] = [];
  const jobs: FailedJob[] = [];
  // With a backup server given, only that server's jobs can match.
  const sources = q.backupServerUid ? (['backup_server'] as JobSource[]) : q.sources;

  await Promise.all(
    sources.map(async (source) => {
      const def = SOURCES[source];
      const filter: FilterExpression[] = [statusFilter(def.statusProperty, q.statuses)];
      if (q.companyUid) filter.push(jobCompanyFilter(source, q.companyUid));
      const path = source === 'backup_server' && q.backupServerUid ? `/infrastructure/backupServers/${q.backupServerUid}/jobs` : def.path;
      let got;
      try {
        got = await api.all<Record<string, unknown>>(
          path,
          { filter, sort: [{ property: source === 'vb365' ? 'lastRun' : 'lastEndTime', direction: 'descending' }] },
          { maxItems: 2_000, deadline }
        );
      } catch (err) {
        // One source failing (e.g. no VB365 servers, or the key's user cannot see agents) must not hide the others.
        scanned[source] = { matched: 0, read: 0, complete: false, error: (err as Error).message };
        failures.push({ source, err });
        return;
      }
      for (const j of got.items) {
        const ended = timeOf(j.lastEndTime) ?? timeOf(j.lastRun);
        if (ended === undefined || ended < since) continue;
        // VSPC's company filter is a superset (see jobCompanyFilter): keep only the company's own jobs.
        if (q.companyUid && !jobBelongsTo(source, j, q.companyUid)) continue;
        const status = String((source === 'vb365' ? j.lastStatus : j.status) ?? 'Unknown');
        const companyUid = jobCompanyUid(source, j);
        jobs.push({
          source,
          jobUid: (j.instanceUid as string) ?? undefined,
          job: String(j.name ?? '(unnamed job)'),
          type: (source === 'vb365' ? (j.jobType as string) : (j.type as string)) ?? (source === 'agent' ? (j.systemType as string) : undefined),
          status,
          companyUid,
          whereUid:
            source === 'backup_server'
              ? (j.backupServerUid as string)
              : source === 'agent'
                ? (j.backupAgentUid as string)
                : (j.vb365ServerUid as string),
          where: source === 'vb365' ? (j.vb365ServerName as string) : undefined,
          lastRun: (j.lastRun as string) ?? undefined,
          lastEndTime: (j.lastEndTime as string) ?? undefined,
          message:
            source === 'vb365'
              ? vb365Message(j)
              : oneLine(j.failureMessage, 400) ?? oneLine(j.backupPolicyFailureMessage, 400),
        });
      }
      scanned[source] = { matched: got.total, read: got.items.length, complete: got.complete };
    })
  );
  if (failures.length === sources.length) throw allSourcesFailed(failures);

  // Names, best effort.
  const orgs = await log.safely('company names', names.organizations());
  const servers = jobs.some((j) => j.source === 'backup_server') ? await log.safely('backup server names', names.backupServers()) : undefined;
  const agents = await agentNames(
    names,
    jobs.filter((j) => j.source === 'agent' && j.whereUid).map((j) => String(j.whereUid)),
    log
  );
  for (const j of jobs) {
    j.company = nameOrUid(orgs, j.companyUid);
    if (j.source === 'backup_server') j.where = nameOrUid(servers, j.whereUid);
    else if (j.source === 'agent') j.where = nameOrUid(agents, j.whereUid);
    else j.where = j.where || nameOrUid(undefined, j.whereUid);
  }

  jobs.sort((a, b) => (timeOf(b.lastEndTime ?? b.lastRun) ?? 0) - (timeOf(a.lastEndTime ?? a.lastRun) ?? 0));
  return {
    window: { hours: q.hours, since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    statuses: q.statuses,
    jobs,
    scanned,
    complete: sources.every((s) => scanned[s]?.complete === true),
    sourceErrors: failures.map((f) => ({ source: f.source, ...errorInfo(f.err) })),
    partialSources: sources.filter((s) => scanned[s] && !scanned[s].error && !scanned[s].complete),
    lookupErrors: log.report().lookupErrors,
  };
}

export interface FailureGroup {
  company?: string;
  source: JobSource;
  job: string;
  /** Backup server, VB365 server, or the agent computers (agent jobs are grouped across computers). */
  where: string[];
  status: string;
  /** Jobs (or agent computers) folded into this row. */
  occurrences: number;
  latest?: string;
  message?: string;
  jobUids: string[];
}

/** Normalises a job name so "Job X (Retry 2)" groups with "Job X". */
export function baseJobName(name: string): string {
  return name
    .replace(/\s*\((?:retry|incremental|full|active full)(?:\s*\d+)?\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One row per job: retries of the same job, and the same agent job (backup
 * policy) failing on several computers of one company, fold into one row.
 * Worst status wins (Failed over Warning); the latest message is shown.
 */
export function groupFailures(jobs: FailedJob[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup & { _latest: number }>();
  const ordered = [...jobs].sort((a, b) => (timeOf(b.lastEndTime ?? b.lastRun) ?? 0) - (timeOf(a.lastEndTime ?? a.lastRun) ?? 0));
  for (const j of ordered) {
    const where = j.where ?? j.whereUid ?? '';
    const key = [j.source, j.companyUid ?? '', j.source === 'agent' ? '' : (j.whereUid ?? where).toLowerCase(), baseJobName(j.job).toLowerCase()].join('|');
    const when = timeOf(j.lastEndTime ?? j.lastRun) ?? 0;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        company: j.company ?? j.companyUid,
        source: j.source,
        job: baseJobName(j.job),
        where: where ? [where] : [],
        status: j.status,
        occurrences: 1,
        latest: j.lastEndTime ?? j.lastRun,
        message: oneLine(j.message, 250),
        jobUids: j.jobUid ? [j.jobUid] : [],
        _latest: when,
      });
      continue;
    }
    g.occurrences++;
    if (where && !g.where.includes(where) && g.where.length < 15) g.where.push(where);
    if (j.jobUid && !g.jobUids.includes(j.jobUid) && g.jobUids.length < 15) g.jobUids.push(j.jobUid);
    if (g.status !== 'Failed' && j.status === 'Failed') g.status = 'Failed';
    if (!g.message && j.message) g.message = oneLine(j.message, 250);
  }
  return [...groups.values()]
    .map(({ _latest: _drop, ...g }) => g)
    .sort((a, b) => (a.status === b.status ? (timeOf(b.latest) ?? 0) - (timeOf(a.latest) ?? 0) : a.status === 'Failed' ? -1 : 1));
}
