import {
  EVENT_SCHEMA_VERSION,
  LLM_REQUEST_EVENT,
  type LlmRequestData,
  SESSION_OBSERVED_EVENT,
  type SessionEventType,
  type SessionObservedData,
  TOOL_CALL_EVENT,
  type TokenBuckets,
  type ToolCallData,
  TURN_FINISHED_EVENT,
  TURN_STARTED_EVENT,
  type UnsequencedEvent,
  type WatchedProject,
} from '@agentdock/shared/protocol';
import { z } from 'zod';
import { correlateCwd } from '../correlate';
import type { FileState, TranscriptSource } from '../types';

/**
 * Claude Code transcript parsing (D3, D4, D9). Pure: lines and state in,
 * events and state out. Only names, ids, timing and counts are copied into an
 * event; message text, thinking, tool input and tool output are never read
 * into one.
 */

/** Model of the messages Claude Code writes itself (errors, interrupts); not API requests. */
const SYNTHETIC_MODEL = '<synthetic>';

const openToolSchema = z.object({
  tool: z.string(),
  startedAt: z.string(),
  promptId: z.string().optional(),
});

/** Persisted between reads, so a restart resumes mid-turn and mid-request. */
export const claudeParserStateSchema = z.object({
  /** The turn the next lines belong to. */
  promptId: z.string().nullable(),
  turnOpen: z.boolean(),
  /** Timestamp of the last line read: the start of the next request. */
  lastTs: z.string().nullable(),
  /** The last request sent, to send it again only when its usage changed (D4). */
  request: z
    .object({
      id: z.string(),
      sig: z.string(),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .nullable(),
  /** `tool_use` blocks whose `tool_result` has not been read yet. */
  tools: z.record(z.string(), openToolSchema),
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  title: z.string().nullable(),
  startedAt: z.string().nullable(),
});
export type ClaudeParserState = z.infer<typeof claudeParserStateSchema>;

export const freshClaudeParserState = (): ClaudeParserState => ({
  promptId: null,
  turnOpen: false,
  lastTs: null,
  request: null,
  tools: {},
  cwd: null,
  gitBranch: null,
  title: null,
  startedAt: null,
});

/** The adapter's state from `offsets.json`; unreadable state starts afresh. */
export const readParserState = (raw: unknown): ClaudeParserState => {
  const parsed = claudeParserStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : freshClaudeParserState();
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const tokens = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;

const isoTime = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};

const elapsed = (from: string, to: string): number | undefined => {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
};

/**
 * The six buckets (D3). `thinking_tokens` is counted inside `output_tokens`
 * (spec 12 implementation notes), so it is reported apart, never added. A
 * cache write with no TTL split is a 5-minute write, the API's default TTL.
 */
export const tokenBuckets = (usage: Json): TokenBuckets => {
  const creation = isObject(usage.cache_creation) ? usage.cache_creation : null;
  const details = isObject(usage.output_tokens_details)
    ? usage.output_tokens_details
    : null;
  return {
    input: tokens(usage.input_tokens),
    output: tokens(usage.output_tokens),
    cacheRead: tokens(usage.cache_read_input_tokens),
    cacheWrite5m: creation
      ? tokens(creation.ephemeral_5m_input_tokens)
      : tokens(usage.cache_creation_input_tokens),
    cacheWrite1h: creation ? tokens(creation.ephemeral_1h_input_tokens) : 0,
    reasoning: details ? tokens(details.thinking_tokens) : 0,
  };
};

export interface ParseContext {
  source: TranscriptSource;
  projects: readonly WatchedProject[];
}

/** Events read from lines, and the file state after them. */
export interface Parsed {
  events: UnsequencedEvent[];
  observed: SessionObservedData | null;
  parser: ClaudeParserState;
}

const sameObserved = (
  a: SessionObservedData | null,
  b: SessionObservedData,
): boolean => a !== null && JSON.stringify(a) === JSON.stringify(b);

/**
 * Parses complete transcript lines. `state` is not modified; the result
 * carries the next one. A line that is not JSON, or not a type read here, is
 * skipped.
 */
export const parseClaudeLines = (
  lines: readonly string[],
  state: Pick<FileState, 'observed'> & { parser: ClaudeParserState },
  context: ParseContext,
): Parsed => {
  const { source } = context;
  const p: ClaudeParserState = structuredClone(state.parser);
  let observed = state.observed;
  const events: UnsequencedEvent[] = [];

  const emit = (type: SessionEventType, ts: string, data: object) => {
    events.push({
      v: EVENT_SCHEMA_VERSION,
      ts,
      type,
      source: 'transcript',
      session: { runtime: 'claude', id: source.sessionId },
      data,
    });
  };

  /** Sends `session.observed` when any field of it changed (D6). */
  const observe = (ts: string) => {
    if (!p.cwd?.startsWith('/') || !p.startedAt) return;
    const { projectId, slot } = correlateCwd(p.cwd, context.projects);
    const next: SessionObservedData = {
      profileKey: source.profileKey,
      cwd: p.cwd,
      ...(p.gitBranch ? { gitBranch: p.gitBranch } : {}),
      ...(p.title ? { title: p.title } : {}),
      startedAt: p.startedAt,
      parsed: true,
      ...(projectId ? { projectId } : {}),
      ...(slot ? { slot } : {}),
      ...(source.parent
        ? {
            parent: {
              sessionId: source.parent.sessionId,
              ...(source.parent.toolUseId
                ? { toolUseId: source.parent.toolUseId }
                : {}),
            },
          }
        : {}),
    };
    if (sameObserved(observed, next)) return;
    observed = next;
    emit(SESSION_OBSERVED_EVENT, ts, next);
  };

  const finishTurn = (ts: string) => {
    if (!p.turnOpen || !p.promptId) return;
    emit(TURN_FINISHED_EVENT, ts, { promptId: p.promptId });
    p.turnOpen = false;
  };

  const startTurn = (promptId: string, ts: string) => {
    if (promptId === p.promptId) return;
    finishTurn(p.lastTs ?? ts);
    p.promptId = promptId;
    p.turnOpen = true;
    emit(TURN_STARTED_EVENT, ts, { promptId });
  };

  const promptRef = () => (p.promptId ? { promptId: p.promptId } : {});

  const onAssistant = (line: Json, ts: string) => {
    const message = isObject(line.message) ? line.message : null;
    if (!message) return;
    const model = text(message.model);
    const requestId = text(line.requestId) ?? text(message.id);
    const querySource = line.isSidechain === true ? 'subagent' : 'main';

    if (model && model !== SYNTHETIC_MODEL && requestId) {
      const usage = isObject(message.usage) ? message.usage : {};
      const buckets = tokenBuckets(usage);
      const stopReason = text(message.stop_reason);
      const sig = JSON.stringify([model, buckets, stopReason ?? null]);
      const isNew = p.request?.id !== requestId;
      if (isNew || p.request?.sig !== sig) {
        // Timing is the gap since the line before the request's first line.
        const durationMs = isNew
          ? p.lastTs
            ? elapsed(p.lastTs, ts)
            : undefined
          : p.request?.durationMs;
        p.request = {
          id: requestId,
          sig,
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        const data: LlmRequestData = {
          requestId,
          ...promptRef(),
          model,
          tokens: buckets,
          ...(durationMs !== undefined
            ? { durationMs, durationApprox: true }
            : {}),
          ...(stopReason ? { stopReason: stopReason.slice(0, 64) } : {}),
          querySource,
          ...(source.parent?.agentName
            ? { agentName: source.parent.agentName }
            : {}),
        };
        emit(LLM_REQUEST_EVENT, ts, data);
      }
    }

    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_use') continue;
      const toolUseId = text(block.id);
      const tool = text(block.name);
      if (!toolUseId || !tool || p.tools[toolUseId]) continue;
      p.tools[toolUseId] = { tool, startedAt: ts, ...promptRef() };
      const data: ToolCallData = {
        toolUseId,
        ...promptRef(),
        tool,
        startedAt: ts,
      };
      emit(TOOL_CALL_EVENT, ts, data);
    }
  };

  const onUser = (line: Json, ts: string) => {
    const message = isObject(line.message) ? line.message : null;
    const content = Array.isArray(message?.content) ? message.content : [];
    const results = content.filter(
      (block): block is Json => isObject(block) && block.type === 'tool_result',
    );
    const promptId = text(line.promptId);
    if (promptId) startTurn(promptId, ts);

    // The id of the subagent an Agent/Task call spawned, from its result.
    const result = isObject(line.toolUseResult) ? line.toolUseResult : null;
    const agentId = results.length === 1 ? text(result?.agentId) : undefined;

    for (const block of results) {
      const toolUseId = text(block.tool_use_id);
      const open = toolUseId ? p.tools[toolUseId] : undefined;
      if (!toolUseId || !open) continue;
      delete p.tools[toolUseId];
      const durationMs = elapsed(open.startedAt, ts);
      const data: ToolCallData = {
        toolUseId,
        ...(open.promptId ? { promptId: open.promptId } : {}),
        tool: open.tool,
        startedAt: open.startedAt,
        endedAt: ts,
        ok: block.is_error !== true,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(agentId ? { childSessionId: agentId } : {}),
      };
      emit(TOOL_CALL_EVENT, ts, data);
    }
  };

  for (const raw of lines) {
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isObject(line)) continue;

    if (line.type === 'custom-title') {
      const title = text(line.customTitle);
      if (title) p.title = title.slice(0, 500);
      if (p.lastTs) observe(p.lastTs);
      continue;
    }

    const ts = isoTime(line.timestamp);
    if (!ts) continue;
    const cwd = text(line.cwd);
    if (cwd) p.cwd = cwd;
    const gitBranch = text(line.gitBranch);
    if (gitBranch) p.gitBranch = gitBranch.slice(0, 255);
    if (!p.startedAt) p.startedAt = ts;
    observe(ts);

    if (line.type === 'user') onUser(line, ts);
    else if (line.type === 'assistant') onAssistant(line, ts);
    else if (line.type === 'system' && line.subtype === 'turn_duration') {
      finishTurn(ts);
    }
    p.lastTs = ts;
  }

  return { events, observed, parser: p };
};
