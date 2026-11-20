import type { WriteSpec } from './spec.js';

/**
 * Write tools. Each one is exactly one POST to a fixed VSPC endpoint with
 * validated UIDs, and no lookups first, so on the MCP host the proposal an
 * administrator approves is exactly what is sent. Never retried (a
 * rate-limited write returns the rate_limited error). Each request carries a
 * fresh X-Request-id, so VSPC itself ignores an accidental repeat within 5 min.
 * They need a key that is not read-only.
 */
export const WRITE_SPECS: WriteSpec[] = [
  {
    name: 'vspc_start_job',
    kind: 'write',
    description:
      'Starts a job on a managed Veeam Backup & Replication server now (job UID from vspc_list_jobs or vspc_list_failed_jobs). VSPC queues the start and returns at once; check the result later with vspc_list_jobs.',
    params: { job_uid: { type: 'uuid', required: true, description: 'Job UID (VSPC instanceUid of the job).' } },
    run: async (args, api) => {
      const data = await api.post(`/infrastructure/backupServers/jobs/${args.job_uid}/start`);
      return { requested: 'start', jobUid: args.job_uid, accepted: true, ...(data && typeof data === 'object' ? { response: data } : {}) };
    },
  },
  {
    name: 'vspc_retry_job',
    kind: 'write',
    description:
      'Retries a failed job on a managed Veeam Backup & Replication server (only the failed objects are processed again). VSPC queues the retry and returns at once.',
    params: { job_uid: { type: 'uuid', required: true, description: 'Job UID (VSPC instanceUid of the job).' } },
    run: async (args, api) => {
      const data = await api.post(`/infrastructure/backupServers/jobs/${args.job_uid}/retry`);
      return { requested: 'retry', jobUid: args.job_uid, accepted: true, ...(data && typeof data === 'object' ? { response: data } : {}) };
    },
  },
  {
    name: 'vspc_acknowledge_alarm',
    kind: 'write',
    description: 'Acknowledges a triggered VSPC alarm (alarm UID from vspc_list_alarms) with a comment. The alarm stays until it is resolved.',
    params: {
      alarm_uid: { type: 'uuid', required: true, description: 'Triggered alarm UID (instanceUid from vspc_list_alarms).' },
      comment: { type: 'string', required: true, maxLength: 512, description: 'Why it is acknowledged (shown in VSPC; up to 512 characters).' },
      on_client_portal: { type: 'boolean', default: false, description: 'Also acknowledge it on the client\'s portal.' },
    },
    run: async (args, api) => {
      const data = await api.post(`/alarms/active/${args.alarm_uid}/acknowledge`, {
        comment: args.comment as string,
        resolveOnClients: args.on_client_portal as boolean,
      });
      return { requested: 'acknowledge', alarmUid: args.alarm_uid, accepted: true, ...(data && typeof data === 'object' ? { alarm: data } : {}) };
    },
  },
  {
    name: 'vspc_resolve_alarm',
    kind: 'write',
    description: 'Marks a triggered VSPC alarm as resolved, with a comment. If the cause is still there, VSPC triggers it again.',
    params: {
      alarm_uid: { type: 'uuid', required: true, description: 'Triggered alarm UID (instanceUid from vspc_list_alarms).' },
      comment: { type: 'string', required: true, maxLength: 512, description: 'How it was resolved (shown in VSPC; up to 512 characters).' },
      on_client_portal: { type: 'boolean', default: false, description: 'Also resolve it on the client\'s portal.' },
    },
    run: async (args, api) => {
      const data = await api.post(`/alarms/active/${args.alarm_uid}/resolve`, {
        comment: args.comment as string,
        resolveOnClients: args.on_client_portal as boolean,
      });
      return { requested: 'resolve', alarmUid: args.alarm_uid, accepted: true, ...(data && typeof data === 'object' ? { alarm: data } : {}) };
    },
  },
];
