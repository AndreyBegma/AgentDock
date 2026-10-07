import { z } from 'zod';
import type { RunnerEvent } from '../envelope';

/**
 * Agent-session events (docs/specs/12-agent-sessions.md), source `transcript`.
 * The envelope's `session: { runtime, id }` names the runtime session the event
 * belongs to; `id` is the runtime's own session id.
 *
 * D9: these carry names, ids, timing and counts only. No field holds prompt,
 * response, thinking or tool-argument text, and nothing here is free text
 * except `title` (the session's own custom title).
 */

export const SESSION_OBSERVED_EVENT = 'session.observed';
export const TURN_STARTED_EVENT = 'turn.started';
export const TURN_FINISHED_EVENT = 'turn.finished';
export const LLM_REQUEST_EVENT = 'llm.request';
export const TOOL_CALL_EVENT = 'tool.call';

export const SESSION_EVENT_TYPES = [
  SESSION_OBSERVED_EVENT,
  TURN_STARTED_EVENT,
  TURN_FINISHED_EVENT,
  LLM_REQUEST_EVENT,
  TOOL_CALL_EVENT,
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export const SESSION_ID_MAX_LENGTH = 200;
export const SESSION_NAME_MAX_LENGTH = 200;
export const SESSION_TITLE_MAX_LENGTH = 500;
export const SESSION_PATH_MAX_LENGTH = 4096;

const id = z.string().min(1).max(SESSION_ID_MAX_LENGTH);
const name = z.string().min(1).max(SESSION_NAME_MAX_LENGTH);
const count = z.number().int().nonnegative();
const ms = z.number().int().nonnegative();

/** Where the usage of a request is attributed (event-schema.md). */
export const querySourceSchema = z.enum(['main', 'subagent', 'auxiliary']);
export type QuerySource = z.infer<typeof querySourceSchema>;

/** The six token buckets (D3). `reasoning` is counted inside `output`. */
export const tokenBucketsSchema = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite5m: count,
  cacheWrite1h: count,
  reasoning: count,
});
export type TokenBuckets = z.infer<typeof tokenBucketsSchema>;

/**
 * `session.observed`: what the runner knows about a session, re-sent whenever
 * a field changes. `projectId` and `slot` are the adapter's correlation (D6);
 * `projectId` is an id from the runner's watch list. `parent` links a subagent
 * transcript to its parent session and, when known, the tool call that spawned it.
 */
export const sessionObservedDataSchema = z.object({
  profileKey: name.optional(),
  cwd: z
    .string()
    .min(1)
    .max(SESSION_PATH_MAX_LENGTH)
    .refine((p) => p.startsWith('/'), { message: 'must be an absolute path' }),
  gitBranch: z.string().min(1).max(255).optional(),
  title: z.string().min(1).max(SESSION_TITLE_MAX_LENGTH).optional(),
  startedAt: z.iso.datetime(),
  /** False while the runtime's transcript format is not parsed (Codex, D7). */
  parsed: z.boolean(),
  projectId: id.optional(),
  slot: name.optional(),
  parent: z.object({ sessionId: id, toolUseId: id.optional() }).optional(),
});
export type SessionObservedData = z.infer<typeof sessionObservedDataSchema>;

/** `turn.started` / `turn.finished`: the envelope's `ts` is the moment. */
export const turnDataSchema = z.object({ promptId: id });
export type TurnData = z.infer<typeof turnDataSchema>;

/**
 * `llm.request`: one per distinct `requestId` (D4). The envelope's `ts` is the
 * request's time. Re-sent with newer usage, the last one wins.
 */
export const llmRequestDataSchema = z.object({
  requestId: id,
  promptId: id.optional(),
  model: name,
  tokens: tokenBucketsSchema,
  durationMs: ms.optional(),
  /** `durationMs` was derived from the timestamp delta, not measured. */
  durationApprox: z.boolean().optional(),
  ttftMs: ms.optional(),
  stopReason: z.string().min(1).max(64).optional(),
  querySource: querySourceSchema,
  agentName: name.optional(),
});
export type LlmRequestData = z.infer<typeof llmRequestDataSchema>;

/**
 * `tool.call`: sent when the tool is used, and again when its result arrives
 * with `endedAt` and `ok`. `childSessionId` is the runtime id of a subagent
 * session this call spawned. Tool arguments and output are never sent (D9).
 */
export const toolCallDataSchema = z.object({
  toolUseId: id,
  promptId: id.optional(),
  tool: name,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().optional(),
  ok: z.boolean().optional(),
  durationMs: ms.optional(),
  decision: z.string().min(1).max(32).optional(),
  childSessionId: id.optional(),
});
export type ToolCallData = z.infer<typeof toolCallDataSchema>;

export const sessionEventDataSchemas = {
  [SESSION_OBSERVED_EVENT]: sessionObservedDataSchema,
  [TURN_STARTED_EVENT]: turnDataSchema,
  [TURN_FINISHED_EVENT]: turnDataSchema,
  [LLM_REQUEST_EVENT]: llmRequestDataSchema,
  [TOOL_CALL_EVENT]: toolCallDataSchema,
} as const satisfies Record<SessionEventType, z.ZodType>;

interface SessionEventBase {
  ts: string;
  /** The runtime and the runtime's own session id, from the envelope. */
  session: { runtime: string; id: string };
}

/** A session event with its `data` validated, discriminated by `type`. */
export type SessionEvent = SessionEventBase &
  (
    | { type: typeof SESSION_OBSERVED_EVENT; data: SessionObservedData }
    | { type: typeof TURN_STARTED_EVENT; data: TurnData }
    | { type: typeof TURN_FINISHED_EVENT; data: TurnData }
    | { type: typeof LLM_REQUEST_EVENT; data: LlmRequestData }
    | { type: typeof TOOL_CALL_EVENT; data: ToolCallData }
  );

export const isSessionEventType = (type: string): type is SessionEventType =>
  (SESSION_EVENT_TYPES as readonly string[]).includes(type);

export type ParsedSessionEvent =
  | { ok: true; event: SessionEvent }
  | { ok: false; error: string };

/**
 * Validates a wire event as a session event. `null` when its type is not a
 * session type; an error when it is one but its envelope or `data` is wrong.
 */
export const parseSessionEvent = (
  event: RunnerEvent,
): ParsedSessionEvent | null => {
  if (!isSessionEventType(event.type)) return null;
  if (!event.session) {
    return { ok: false, error: `${event.type} without an envelope session` };
  }
  const data = sessionEventDataSchemas[event.type].safeParse(event.data);
  if (!data.success) {
    return { ok: false, error: z.prettifyError(data.error) };
  }
  if (event.session.id.length > SESSION_ID_MAX_LENGTH) {
    return { ok: false, error: 'session id too long' };
  }
  return {
    ok: true,
    event: {
      type: event.type,
      ts: event.ts,
      session: { runtime: event.session.runtime, id: event.session.id },
      data: data.data,
    } as SessionEvent,
  };
};
