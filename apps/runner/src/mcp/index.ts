import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LOCAL_REQUEST_TIMEOUT_MS } from '@nautelle/shared/protocol';
import { FinishGuard, parseFinishGuardArgs } from '../cards/finish-guard';
import { cardsDirOf, sessionCardNote } from '../handoff/context';
import { localRequest } from '../local/client';
import {
  readSessionToken,
  SESSION_TOKEN_ENV,
  sessionTokenDir,
} from '../local/session-tokens';
import type { LocalCommandDeps } from '../local/subcommand';
import { LOCAL_RETRY_METHODS, LOCAL_RETRY_WINDOW_MS } from '../local/types';
import { buildMcpServer, type McpRequest } from './server';
import { CARD_ESCALATE_ENV } from './tools';

/** The daemon retries inside its window, then makes one last attempt (#434). */
const RETRY_CALL_MS =
  LOCAL_RETRY_WINDOW_MS + 2 * LOCAL_REQUEST_TIMEOUT_MS + 1_000;

/**
 * #113: the token of this MCP server's session — from the env of a session
 * the runner launched, else the one the session's `SessionStart` hook kept
 * for its `claude` process, this process's parent.
 */
export const mcpSessionToken = (
  deps: Pick<LocalCommandDeps, 'env' | 'socketPath' | 'ppid'>,
): string | undefined =>
  deps.env[SESSION_TOKEN_ENV] ||
  (readSessionToken(sessionTokenDir(deps.socketPath), { pid: deps.ppid }) ??
    undefined);

/**
 * `nautelle-runner mcp` (spec 201 D20): the `nautelle` MCP server over
 * stdio. Every tool call is one request to the daemon's local socket (D5),
 * carrying the session's token (#113): from the env of a session the runner
 * launched, else the one its `SessionStart` hook kept for this process's
 * parent `claude` — read at each call, as the hook may run after this
 * process starts. The daemon being down is a tool error
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
      {
        token: mcpSessionToken(deps),
        ...(LOCAL_RETRY_METHODS.has(method)
          ? { callTimeoutMs: RETRY_CALL_MS }
          : {}),
      },
    );
  // #449 D6: the session's card note, from the daemon's store on disk.
  const cardNote = () => sessionCardNote(cardsDirOf(deps.env), cwd, deps.exec);
  const server = buildMcpServer(request, {
    finishGuard,
    cardNote,
    // #750 D8: set in the env of a round launched with `escalate`.
    escalate: deps.env[CARD_ESCALATE_ENV] === '1',
  });
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  // Claude closing our stdin is the end of the session.
  process.stdin.once('end', () => void server.close());
  await closed;
  return 0;
};
