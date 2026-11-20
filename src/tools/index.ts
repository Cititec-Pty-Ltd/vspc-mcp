import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { READ_SPECS } from './read.js';
import { WRITE_SPECS } from './write.js';
import { buildTool, runSpec } from './spec.js';
import type { ToolSpec } from './spec.js';
import type { CallToolResult } from './types.js';

export const ALL_SPECS: ToolSpec[] = [...READ_SPECS, ...WRITE_SPECS];

export const ALL_TOOLS: Tool[] = ALL_SPECS.map(buildTool);

/** For the MCP host's `read_tools`. */
export const READ_TOOL_NAMES: readonly string[] = ALL_SPECS.filter((s) => s.kind === 'read').map((s) => s.name);

/** For the MCP host's `write_tools`: every call is an approval-gated proposal. */
export const WRITE_TOOL_NAMES: readonly string[] = ALL_SPECS.filter((s) => s.kind === 'write').map((s) => s.name);

const SPEC_BY_NAME = new Map(ALL_SPECS.map((s) => [s.name, s]));

export async function dispatchToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  return runSpec(spec, args);
}
