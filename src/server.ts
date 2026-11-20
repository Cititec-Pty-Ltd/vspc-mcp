import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ALL_TOOLS, dispatchToolCall } from './tools/index.js';
import { logger } from './utils/logger.js';

export const SERVER_VERSION = '0.1.0';

/** Shown to the client on connect. VCSP is the partner programme, VSPC the console these tools read. */
export const SERVER_INSTRUCTIONS =
  "Veeam Service Provider Console (VSPC) tools for a VCSP (Veeam Cloud Service Provider): every client's Veeam backups in one place. " +
  'Use them for backup and VCSP questions across clients: vspc_failed_jobs_summary for "what failed in the last 24 hours", ' +
  'vspc_get_license_usage for the licence points and instances reported to Veeam under the VCSP programme. ' +
  'Each job shows only its latest session; when a result says complete: false, its counts are a lower bound.';

export function createServer(): Server {
  const server = new Server(
    { name: 'vspc-mcp', version: SERVER_VERSION },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await dispatchToolCall(name, (args || {}) as Record<string, unknown>);
    } catch (error) {
      logger.error('Tool call failed', { tool: name, error: (error as Error).message });
      return {
        content: [{ type: 'text' as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}
