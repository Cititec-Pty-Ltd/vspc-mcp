# VSPC MCP server

An MCP server for the [Veeam Service Provider Console](https://www.veeam.com/service-provider-console.html) (VSPC) REST API v3. VSPC sees every client's Veeam Backup & Replication servers, Veeam Agents and Veeam Backup for Microsoft 365 servers, so Claude can answer questions across all clients in one call, for example "which backups failed in the last 24 hours?". Separately named write tools can start or retry a job and acknowledge or resolve an alarm.

It uses the same framework as Cititec's other MCP servers: TypeScript, `@modelcontextprotocol/sdk`, a stdio transport, vitest tests, tsup and a Docker image.

## The API

- **VSPC 9.1 = REST API 3.6.1**, at `https://<console>:1280/api/v3`. Paths, filters and fields were taken from Veeam's OpenAPI document for 3.6.1 (the one the console serves on its Swagger page).
- **Authentication:** a **Simple REST API key**, sent as `Authorization: Bearer <key>` on every request. No token exchange, and the key does not expire; it works until its user is disabled or deleted. Create it in VSPC under **Configuration > Access Management > REST API Keys** (scope `rest`). Tick read-only unless the write tools are wanted: a read-only key allows GET only.
- **API contract:** every request sends `X-Client-Version: 3.6.1`, so a newer console answers in the 9.1 contract the tools were written for.
- **Collections** are paged with `limit` (max 500) and `offset`. `meta.pagingInfo` gives `total`, `count` and `offset`. Every list tool returns `total`, `count`, `offset` and `nextOffset` when there is more.
- **Filters** are JSON in the query string (`filter=[{"property":"status","operation":"equals","value":"Failed"}]`). Tools build them from typed parameters. No tool takes a free-form path, filter or property name.
- **No session history.** VSPC v3 has no job-session endpoint. Each job carries its **latest** session: result, start, end and failure message. "Failed in the last N hours" therefore means "the latest session failed and ended in the last N hours". A job that failed and then succeeded on retry is not a failure any more. `vspc_failed_jobs_summary` adds VSPC's own session counts for the window (the job-session heatmap), which do include every session.

## Configuration

| Variable | |
|---|---|
| `VSPC_URL` | The console address, https only, with its port: `https://vspc.example.local:1280`. A trailing `/api/v3` is accepted. |
| `VSPC_API_KEY` | The Simple REST API key. Never logged; removed from every error message. |
| `VSPC_ACCEPT_SELF_SIGNED` | `true` only when the console's certificate is self-signed or not issued for the name in `VSPC_URL`. The connection stays encrypted, but the server is not authenticated, so use this only over a trusted path (VPN). Default `false`. |
| `LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. Logs go to stderr. Tool arguments and the key are never logged. |

## Tools

Read tools only send GET requests. Results are trimmed to the useful fields. Company and server UIDs are turned into names, and each response is capped at 60,000 characters. `company` accepts a company's UID or its name (an exact or unique partial match). Secrets in VSPC responses, such as a company's owner credentials, are never returned.

| Tool | VSPC endpoint(s) |
|------|------------------|
| `vspc_about` | `GET /about` |
| `vspc_list_companies` / `vspc_get_company` | `GET /organizations/companies[/{uid}]` |
| `vspc_list_backup_servers` | `GET /infrastructure/backupServers` (status, version with patch, role) |
| `vspc_list_jobs` | `GET /infrastructure/backupServers[/{uid}]/jobs`, filtered by company, server, latest result, name, enabled |
| `vspc_list_agent_jobs` | `GET /infrastructure/backupAgents/jobs` (Veeam Agent jobs and backup policies, with computer names) |
| `vspc_list_failed_jobs` | All three job lists, filtered on the latest result (Failed, optionally Warning) and paged through: every failure in the last N hours across all companies, newest first, with the failure reason |
| `vspc_failed_jobs_summary` | As above, one row per job. Retries of a job, and an agent job failing on several computers of one company, are folded together. Also gives counts per company and the session counts from `GET /infrastructure/jobSessionHeatmap/` |
| `vspc_list_alarms` | `GET /alarms/active` (Error and Warning by default, newest first), with alarm names from `GET /alarms/templates` |
| `vspc_list_protected_vms` | `GET /protectedWorkloads/virtualMachines` (`oldest_first` finds stale backups) |
| `vspc_list_backup_policies` | `GET /configuration/backupPolicies` |
| `vspc_get_license_usage` | `GET /licensing/usage/organizations`, with totals per workload |
| `vspc_get_console_license` | `GET /licensing/console` |

Job sources in the failure tools:

- `backup_server`: Veeam Backup & Replication jobs, including agent jobs managed by VBR.
- `agent`: Veeam Agents managed by VSPC.
- `vb365`: Veeam Backup for Microsoft 365 jobs.

If one source fails (for example, the key's user cannot see VB365), the others are still returned. The failed source is reported under `scanned`.

### Write tools

Each write tool makes exactly one POST to a fixed endpoint, with a validated UID and no lookups first. On the Cititec MCP host, the proposal an administrator approves is exactly what is sent. Writes are **never retried**. They need a key that is not read-only.

**Idempotency.** VSPC treats `X-Request-id` as an idempotency key for 5 minutes. A write's id is derived from the tool name and its validated arguments (canonical JSON, keys sorted; SHA-256 shown as a version 8 UUID). If an identical write is sent again within 5 minutes, VSPC runs it once. Examples: a response lost on the network and sent again, or the same proposal approved twice. A different job, alarm or comment gets a different id. So does the same write more than 5 minutes later. Starting the same job twice on purpose within 5 minutes therefore runs it once. Reads send no request id.

| Tool | VSPC endpoint |
|------|---------------|
| `vspc_start_job` | `POST /infrastructure/backupServers/jobs/{jobUid}/start` |
| `vspc_retry_job` | `POST /infrastructure/backupServers/jobs/{jobUid}/retry` |
| `vspc_acknowledge_alarm` | `POST /alarms/active/{alarmUid}/acknowledge?comment=...&resolveOnClients=...` |
| `vspc_resolve_alarm` | `POST /alarms/active/{alarmUid}/resolve?comment=...&resolveOnClients=...` |

## Rate limits (Cititec fleet 429 policy)

VSPC throttles with HTTP 429 and gives the wait either in a `Retry-After` header or in a `retryAfter` property in the body.

- **Reads (GET):** retried once if the wait is 10 s or less.
- **Longer or missing wait:** the tool returns at once with a structured error: `structuredContent: { "error": "rate_limited", "retryAfterSeconds": N }`, plus the text `Try again in N s`.
- **Writes:** never retried.

## Running it

```bash
npm ci
npm run build
VSPC_URL=https://vspc.example.local:1280 VSPC_API_KEY=... node dist/index.js   # stdio
npm test
```

The Docker image is `ghcr.io/cititec-pty-ltd/vspc-mcp`. It is published by the *Cititec release* workflow (semantic-release) on every release commit to `main`. On the Cititec MCP host, each connection gets its own container (`docker run --rm -i`) with the service's env file.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
