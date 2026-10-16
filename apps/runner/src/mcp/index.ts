import { LOCAL_REQUEST_TIMEOUT_MS } from '@agentdock/shared/protocol';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FinishGuard, parseFinishGuardArgs } from '../cards/finish-guard';
import { localRequest } from '../local/client';
import type { LocalCommandDeps } from '../local/subcommand';
import { LOCAL_RETRY_METHODS, LOCAL_RETRY_WINDOW_MS } from '../local/types';
import { buildMcpServer, type McpRequest } from './server';

/** The daemon retries inside its window, then makes one last attempt (#434). */
const RETRY_CALL_MS =
  LOCAL_RETRY_WINDOW_MS + 2 * LOCAL_REQUEST_TIMEOUT_MS + 1_000;

/**
 * `agentdock-runner mcp` (spec 201 D20): the `agentdock` MCP server over
 * stdio. Every tool call is one request to the daemon's local socket (D5),
 * correlated to a project by `CLAUDE_PROJECT_DIR` (D9) and to the session by
 * this process's parent pid (D10). The daemon being down is a tool error
 * (`daemon_unavailable`), never a crash: Claude keeps its other tools.
 */
export const runMcp = async (
  args: readonly string[],
  deps: LocalCommandDeps,
): Promise<number> => {
  const cwd = deps.env.CLAUDE_PROJECT_DIR || deps.cwd;
  // #445 D8: a card round with Token saver on guards `finish_card`.
  const guard = parseFinishGuardArgs(args);
  const finishGuard = guard
    ? new FinishGuard({ ...guard, worktree: cwd })
    : undefined;
  const request: McpRequest = (method, args) =>
    // The daemon and the server check `args` against the method's schema.
    localRequest(
      deps.socketPath,
      method,
      args as never,
      { via: 'mcp', cwd, ppid: deps.ppid },
      LOCAL_RETRY_METHODS.has(method) ? { callTimeoutMs: RETRY_CALL_MS } : {},
    );
  const server = buildMcpServer(request, { finishGuard });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  // Claude closing our stdin is the end of the session.
  process.stdin.once('end', () => void server.close());
  await closed;
  return 0;
};
