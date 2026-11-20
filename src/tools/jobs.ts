import type { Api } from '../client.js';
import type { FilterExpression } from '../types.js';
import { Names, safely } from './lookups.js';
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

/** VSPC filter for a company's jobs: any of the source's company fields (so a job matches by either). */
export function jobCompanyFilter(source: JobSource, uid: string): FilterExpression {
  return companyFilter(SOURCES[source].companyProperties, uid);
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
}

export interface FailedJobsQuery {
  hours: number;
  statuses: string[];
  sources: JobSource[];
  companyUid?: string;
  backupServerUid?: string;
  now?: number;
}

/** Most agent lookups per call (one GET each); past this, agent rows show the agent UID. */
const MAX_AGENT_LOOKUPS = 40;

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
  const scanned: FailedJobsResult['scanned'] = {};
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
        return;
      }
      for (const j of got.items) {
        const ended = timeOf(j.lastEndTime) ?? timeOf(j.lastRun);
        if (ended === undefined || ended < since) continue;
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

  // Names, best effort.
  const orgs = await safely(names.organizations());
  const servers = jobs.some((j) => j.source === 'backup_server') ? await safely(names.backupServers()) : undefined;
  const agentUids = [...new Set(jobs.filter((j) => j.source === 'agent' && j.whereUid).map((j) => String(j.whereUid)))].slice(
    0,
    MAX_AGENT_LOOKUPS
  );
  const agentNames = new Map<string, string | undefined>();
  await Promise.all(agentUids.map(async (u) => agentNames.set(u, await names.agentName(u))));
  for (const j of jobs) {
    if (j.companyUid) j.company = orgs?.get(j.companyUid.toLowerCase());
    if (j.source === 'backup_server' && j.whereUid) j.where = servers?.get(j.whereUid.toLowerCase());
    if (j.source === 'agent' && j.whereUid) j.where = agentNames.get(j.whereUid);
  }

  jobs.sort((a, b) => (timeOf(b.lastEndTime ?? b.lastRun) ?? 0) - (timeOf(a.lastEndTime ?? a.lastRun) ?? 0));
  return {
    window: { hours: q.hours, since: new Date(since).toISOString(), until: new Date(now).toISOString() },
    statuses: q.statuses,
    jobs,
    scanned,
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
