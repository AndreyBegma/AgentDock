import {
  HOOK_EVENT_TYPES,
  type LocalErrorCode,
  type LocalRequestMessage,
  localErrorCodeSchema,
} from '@nautelle/shared/protocol';
import { z } from 'zod';
import { SESSION_TOKEN_MAX } from './session-tokens';

/**
 * The daemon's local socket protocol (docs/specs/201-claude-code-integration.md
 * D5): newline-delimited JSON, at most `LOCAL_LINE_MAX_BYTES` per line.
 * `{id, op, args}` → `{id, ok, data?, error?: {code, message}}`.
 */
export const LOCAL_LINE_MAX_BYTES = 256 * 1024;

/** How long a hook or MCP process waits to connect before it gives up (D12). */
export const LOCAL_CONNECT_TIMEOUT_MS = 300;

/**
 * Local methods that are idempotent on the server (`card.finish`: a round
 * already finished stays finished), so the daemon may wait for the connection
 * and send them again instead of answering `runner_offline` at once (#434).
 * Every other method keeps failing fast: a write is never replayed.
 */
export const LOCAL_RETRY_METHODS: ReadonlySet<string> = new Set([
  'card.finish',
]);

/** How long the daemon keeps waiting for the connection for such a method. */
export const LOCAL_RETRY_WINDOW_MS = 120_000;

/** First and longest pause between two attempts inside that window. */
export const LOCAL_RETRY_FIRST_DELAY_MS = 1_000;
export const LOCAL_RETRY_MAX_DELAY_MS = 10_000;

/** Said to the worker when the window ran out: the tool call is safe to repeat. */
export const LOCAL_RETRY_EXHAUSTED_MESSAGE =
  'the runner could not reach AgentDock within 2 minutes; nothing was lost — call this tool again in a minute';

export const localOpSchema = z.enum(['event', 'request', 'ping']);
export type LocalOp = z.infer<typeof localOpSchema>;

export const localLineSchema = z.object({
  id: z.string().min(1).max(128),
  op: localOpSchema,
  args: z.unknown(),
  /** #113: the caller's session token; only a `SessionStart` may come without. */
  token: z.string().min(1).max(SESSION_TOKEN_MAX).optional(),
});
export type LocalLine = z.infer<typeof localLineSchema>;

/**
 * #113: who is calling, as the daemon knows it — the token the line carried
 * and the peer pid the kernel reported (null where it cannot be read).
 */
export interface LocalCaller {
  token?: string;
  peerPid: number | null;
}

export interface LocalError {
  code: LocalErrorCode;
  message?: string;
}

/** What every local call resolves to; it never throws. */
export type LocalResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: LocalError };

export const localReplySchema = z.object({
  /** Absent only on a framing error that has no request to answer. */
  id: z.string().optional(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({ code: localErrorCodeSchema, message: z.string().optional() })
    .optional(),
});
export type LocalReply = z.infer<typeof localReplySchema>;

export const localFail = (
  code: LocalErrorCode,
  message?: string,
): { ok: false; error: LocalError } => ({
  ok: false,
  error: message === undefined ? { code } : { code, message },
});

/** `via` of a relayed request: which process asked (D8). */
export type LocalVia = LocalRequestMessage['via'];

/** A process above the hook, as the hook read it (D10). */
export const ancestorSchema = z.object({
  pid: z.number().int().positive(),
  /** The command name: `/proc/<pid>/stat`'s comm, or `ps -o comm=`. */
  comm: z.string().max(4096),
});
export type Ancestor = z.infer<typeof ancestorSchema>;

const sessionIdSchema = z.string().min(1).max(200);
const cwdSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' });

/** Raw content as the hook read it; the daemon gates, redacts and caps it (D13). */
const rawContentSchema = z.object({
  text: z.string(),
  /** The hook already cut it to fit a socket line. */
  truncated: z.boolean(),
});
export type RawContent = z.infer<typeof rawContentSchema>;

export const CONTENT_FIELDS = [
  'content',
  'input',
  'output',
  'response',
  'background',
] as const;
export type ContentField = (typeof CONTENT_FIELDS)[number];

/**
 * `op: 'event'` — one hook event before the daemon builds the envelope.
 * `data` is the event's data without content; `content` holds the raw texts
 * that may become its content fields.
 */
export const localEventArgsSchema = z.object({
  type: z.enum(HOOK_EVENT_TYPES),
  sessionId: sessionIdSchema,
  cwd: cwdSchema,
  data: z.record(z.string(), z.unknown()),
  content: z.partialRecord(z.enum(CONTENT_FIELDS), rawContentSchema).optional(),
  /** `session-start` only: the hook's ancestors, nearest first (D10). */
  ancestors: z.array(ancestorSchema).max(32).optional(),
});
export type LocalEventArgs = z.infer<typeof localEventArgsSchema>;

/**
 * What an `event` answers. A `SessionStart` also gets the session's token
 * (#113), which its hook keeps for the session's later calls.
 */
export const localEventResultSchema = z.object({
  queued: z.literal(true),
  token: z.string().min(1).max(SESSION_TOKEN_MAX).optional(),
});
export type LocalEventResult = z.infer<typeof localEventResultSchema>;

/** `op: 'request'` — relayed as `local.request` (D6). */
export const localRequestArgsSchema = z.object({
  method: z.string().min(1).max(64),
  args: z.unknown(),
  via: z.enum(['mcp', 'hook', 'cli']),
  /** The session's cwd; the daemon correlates it to a project (D9). */
  cwd: cwdSchema.optional(),
  /** Claude Code's session id, when the caller knows it (hooks do). */
  sessionId: sessionIdSchema.optional(),
  /** The caller's parent pid: the MCP server's `claude` (D10). */
  ppid: z.number().int().positive().optional(),
});
export type LocalRequestArgs = z.infer<typeof localRequestArgsSchema>;

/** `op: 'ping'` — liveness, and the state a hook decides on. */
export const localPingArgsSchema = z
  .object({ cwd: cwdSchema.optional() })
  .default({});
export const localPingResultSchema = z.object({
  pong: z.literal(true),
  /** The WSS is up: a `request` can reach the server. */
  online: z.boolean(),
  awayMode: z.boolean(),
  /** The correlated project of `cwd`, when it was given and matched. */
  projectId: z.string().nullable(),
});
export type LocalPingResult = z.infer<typeof localPingResultSchema>;

/** A relayed request as the connection sends it, without `type` and `id`. */
export type LocalRelayRequest = Omit<LocalRequestMessage, 'type' | 'id'>;
