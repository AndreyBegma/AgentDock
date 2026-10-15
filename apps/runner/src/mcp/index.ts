import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { localRequest } from '../local/client';
import type { LocalCommandDeps } from '../local/subcommand';
import { buildMcpServer, type McpRequest } from './server';

/**
 * `agentdock-runner mcp` (spec 201 D20): the `agentdock` MCP server over
 * stdio. Every tool call is one request to the daemon's local socket (D5),
 * correlated to a project by `CLAUDE_PROJECT_DIR` (D9) and to the session by
 * this process's parent pid (D10). The daemon being down is a tool error
 * (`daemon_unavailable`), never a crash: Claude keeps its other tools.
 */
export const runMcp = async (
  _args: readonly string[],
  deps: LocalCommandDeps,
): Promise<number> => {
  const cwd = deps.env.CLAUDE_PROJECT_DIR || deps.cwd;
  const request: McpRequest = (method, args) =>
    // The daemon and the server check `args` against the method's schema.
    localRequest(deps.socketPath, method, args as never, {
      via: 'mcp',
      cwd,
      ppid: deps.ppid,
    });
  const server = buildMcpServer(request);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  // Claude closing our stdin is the end of the session.
  process.stdin.once('end', () => void server.close());
  await closed;
  return 0;
};
