import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  RESUME_CONTEXT_TOOL,
  RUNNER_MCP_SERVER,
  resumeContextResultSchema,
} from '@nautelle/shared';
import type { LocalMethodName } from '@nautelle/shared/protocol';
import { z } from 'zod';
import { ARTIFACT_INCOMPLETE, type FinishGuard } from '../cards/finish-guard';
import {
  type CardNote,
  resumeContextOf,
  sessionNoteContext,
} from '../handoff/context';
import type { LocalResult } from '../local/types';
import { RUNNER_VERSION } from '../version';
import { MCP_TOOLS, type McpToolDefinition } from './tools';

/** Asks the daemon one local method; the context (cwd, ppid) is the caller's. */
export type McpRequest = (
  method: LocalMethodName,
  args: Record<string, unknown>,
) => Promise<LocalResult<unknown>>;

/** The server name; with the plugin name it makes `mcp__plugin_nautelle_nautelle__*`. */
export const MCP_SERVER_NAME = RUNNER_MCP_SERVER;

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

/** #449 D6: the card note of this session, read from the machine. */
export type McpCardNote = () => Promise<CardNote | null>;

/**
 * `resume_context` (#449 D6): answered here, from the note on the machine —
 * never through the daemon or the API, so it works with session content off.
 */
const resumeContext = async (
  cardNote: McpCardNote | undefined,
): Promise<CallToolResult> => {
  let found: CardNote | null = null;
  try {
    found = cardNote ? await cardNote() : null;
  } catch {
    found = null;
  }
  const result = resumeContextResultSchema.parse(resumeContextOf(found));
  const text =
    result.found && found ? sessionNoteContext(found) : JSON.stringify(result);
  return {
    content: [{ type: 'text', text }],
    structuredContent: result as Record<string, unknown>,
  };
};

/** `track_card` on a card with a note also returns the note (D6). */
const withCardNote = async (
  result: CallToolResult,
  cardNote: McpCardNote | undefined,
): Promise<CallToolResult> => {
  try {
    const found = cardNote ? await cardNote() : null;
    if (!found?.note) return result;
    return {
      ...result,
      content: [
        ...result.content,
        { type: 'text', text: sessionNoteContext(found) },
      ],
    };
  } catch {
    return result;
  }
};

/**
 * The twelve tools of spec 201 D20 and `finish_card` (#242 D6), each a thin
 * call to one local method (D7). With a `finishGuard` (#445 D8),
 * `finish_card` passes it first.
 */
export const buildMcpServer = (
  request: McpRequest,
  options: { finishGuard?: FinishGuard; cardNote?: McpCardNote } = {},
): McpServer => {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: RUNNER_VERSION,
  });
  server.registerTool(
    RESUME_CONTEXT_TOOL,
    {
      description:
        'The handoff note of the Nautelle card this session works on (its worktree or its branch): goal, what is done, what is next, decisions, dead ends, files, how to verify, checklist, open questions. Answers found: false outside a card session or when the card has no note yet.',
      inputSchema: {},
    },
    () => resumeContext(options.cardNote),
  );
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
        const answer: CallToolResult = {
          content: [
            { type: 'text', text: JSON.stringify(result.data, null, 2) },
          ],
          ...(data.success ? { structuredContent: data.data } : {}),
        };
        return tool.method === 'card.track'
          ? withCardNote(answer, options.cardNote)
          : answer;
      },
    );
  }
  return server;
};
