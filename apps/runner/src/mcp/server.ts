import type { LocalMethodName } from '@agentdock/shared/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ARTIFACT_INCOMPLETE, type FinishGuard } from '../cards/finish-guard';
import type { LocalResult } from '../local/types';
import { RUNNER_VERSION } from '../version';
import { MCP_TOOLS, type McpToolDefinition } from './tools';

/** Asks the daemon one local method; the context (cwd, ppid) is the caller's. */
export type McpRequest = (
  method: LocalMethodName,
  args: Record<string, unknown>,
) => Promise<LocalResult<unknown>>;

/** The server name; with the plugin name it makes `mcp__plugin_agentdock_agentdock__*`. */
export const MCP_SERVER_NAME = 'agentdock';

const errorResult = (code: string, message?: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message ? `${code}: ${message}` : code }],
  structuredContent: { error: { code, ...(message ? { message } : {}) } },
});

/**
 * #445 D8: a guarded `finish_card` either never reaches the daemon (what is
 * missing goes back to the worker) or goes with `artifactIncomplete: true`
 * once the guard has given up.
 */
const guardedArgs = (
  guard: FinishGuard,
  args: Record<string, unknown>,
): Record<string, unknown> | CallToolResult => {
  const summary = typeof args.summary === 'string' ? args.summary : '';
  const decision = guard.check(summary);
  if (decision.kind === 'reject') {
    return errorResult(ARTIFACT_INCOMPLETE, decision.message);
  }
  return decision.artifactIncomplete
    ? { ...args, artifactIncomplete: true }
    : args;
};

const isToolResult = (
  value: Record<string, unknown> | CallToolResult,
): value is CallToolResult => value.isError === true;

/**
 * The twelve tools of spec 201 D20 and `finish_card` (#242 D6), each a thin
 * call to one local method (D7). With a `finishGuard` (#445 D8),
 * `finish_card` passes it first.
 */
export const buildMcpServer = (
  request: McpRequest,
  options: { finishGuard?: FinishGuard } = {},
): McpServer => {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: RUNNER_VERSION,
  });
  const tools: readonly McpToolDefinition[] = MCP_TOOLS;
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      async (input: Record<string, unknown>): Promise<CallToolResult> => {
        const { finishGuard } = options;
        const args =
          finishGuard && tool.method === 'card.finish'
            ? guardedArgs(finishGuard, input)
            : input;
        if (isToolResult(args)) return args;
        const result = await request(tool.method, args);
        if (!result.ok)
          return errorResult(result.error.code, result.error.message);
        const data = z.record(z.string(), z.unknown()).safeParse(result.data);
        return {
          content: [
            { type: 'text', text: JSON.stringify(result.data, null, 2) },
          ],
          ...(data.success ? { structuredContent: data.data } : {}),
        };
      },
    );
  }
  return server;
};
