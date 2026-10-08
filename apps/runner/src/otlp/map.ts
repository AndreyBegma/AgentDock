import {
  EVENT_SCHEMA_VERSION,
  LLM_REQUEST_EVENT,
  type LlmRequestData,
  llmRequestDataSchema,
  type QuerySource,
  type Runtime,
  type TokenBuckets,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import type { AttributeValue, OtlpLogRecord } from './decode';

/** The envelope's `project` (event-schema.md). */
export interface EnvelopeProject {
  repo: string;
  root: string;
}

export interface MapContext {
  /**
   * The envelope project of an `agentdock.project` id, when that id is on the
   * runner's watch list; otherwise undefined and no project is set (D14).
   */
  project: (id: string) => EnvelopeProject | undefined;
  /** Map Codex records too; their attribute names are [Unknown] (D13). */
  codexExperimental: boolean;
  /** Used only when a record carries no time of its own. */
  now: () => string;
}

/** `llm.request` data as the receiver builds it, before the shared parse. */
type OtelLlmRequestData = LlmRequestData & { source: 'otel' };

/** The shared schema's limit on `run` (spec 13 D14). */
const MAX_RUN = 128;

export interface MapResult {
  events: UnsequencedEvent[];
  /** Request records that could not become an event (missing id, model…). */
  dropped: number;
}

export const CLAUDE_API_REQUEST = 'claude_code.api_request';
export const CODEX_API_REQUEST = 'codex.api_request';
export const CODEX_SSE_EVENT = 'codex.sse_event';

const MAX_ID = 200;

/** A record attribute, else the same key on its resource. */
const read = (record: OtlpLogRecord, key: string): AttributeValue | undefined =>
  record.attributes[key] ?? record.resource[key];

const str = (record: OtlpLogRecord, key: string): string | undefined => {
  const value = read(record, key);
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

/** A non-negative integer, from an int, a double or a numeric string. */
const count = (record: OtlpLogRecord, key: string): number | undefined => {
  const value = read(record, key);
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
};

const decimal = (record: OtlpLogRecord, key: string): number | undefined => {
  const value = read(record, key);
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const eventName = (record: OtlpLogRecord): string | null =>
  record.eventName ?? record.body;

/** `event.timestamp` (ISO), else the record's own time, else now. */
const timestamp = (record: OtlpLogRecord, now: () => string): string => {
  const iso = str(record, 'event.timestamp');
  if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  if (record.timeUnixNano && /^\d+$/.test(record.timeUnixNano)) {
    const ms = Number(BigInt(record.timeUnixNano) / 1_000_000n);
    if (ms > 0) return new Date(ms).toISOString();
  }
  return now();
};

/**
 * Claude Code's `query_source` [Inferred from one capture: `sdk` for
 * `claude -p`]: the main thread, a subagent, or anything else the runtime
 * asks the model on its own behalf.
 */
const MAIN_QUERY_SOURCES = new Set(['main', 'repl_main_thread', 'sdk']);
export const claudeQuerySource = (
  querySource: string | undefined,
  agentName: string | undefined,
): QuerySource => {
  if (agentName || querySource?.startsWith('agent')) return 'subagent';
  if (querySource === undefined || MAIN_QUERY_SOURCES.has(querySource)) {
    return 'main';
  }
  return 'auxiliary';
};

/** Envelope `slot` and `issue`, and the watched project, from `agentdock.*` (D14). */
const correlation = (
  record: OtlpLogRecord,
  context: MapContext,
): Pick<UnsequencedEvent, 'project' | 'slot' | 'issue'> & { run?: string } => {
  const projectId = str(record, 'agentdock.project');
  const project = projectId ? context.project(projectId) : undefined;
  const slot = str(record, 'agentdock.slot')?.slice(0, MAX_ID);
  const issueText = str(record, 'agentdock.issue');
  const issue =
    issueText && /^\d+$/.test(issueText) ? Number(issueText) : undefined;
  const run = str(record, 'agentdock.run')?.slice(0, MAX_RUN);
  return {
    ...(project ? { project } : {}),
    ...(slot ? { slot } : {}),
    ...(issue && Number.isSafeInteger(issue) && issue > 0 ? { issue } : {}),
    ...(run ? { run } : {}),
  };
};

const buckets = (partial: Partial<TokenBuckets>): TokenBuckets => ({
  input: partial.input ?? 0,
  output: partial.output ?? 0,
  cacheRead: partial.cacheRead ?? 0,
  cacheWrite5m: partial.cacheWrite5m ?? 0,
  cacheWrite1h: partial.cacheWrite1h ?? 0,
  reasoning: partial.reasoning ?? 0,
});

interface Mapped {
  runtime: Runtime;
  sessionId: string;
  data: OtelLlmRequestData;
}

/**
 * `claude_code.api_request` (D13). Every field is read by name and copied
 * into a new object: no attribute reaches the event unless it is named here
 * (D16). Claude Code reports one cache-write count without its TTL; it goes
 * to `cacheWrite5m`, flagged, and the transcript copy splits it (D15).
 * There is no thinking split, so `reasoning` stays 0 until the transcript.
 */
const mapClaude = (record: OtlpLogRecord): Mapped | null => {
  const sessionId = str(record, 'session.id');
  const requestId = str(record, 'request_id');
  const model = str(record, 'model');
  if (!sessionId || !requestId || !model) return null;
  const cacheWrite = count(record, 'cache_creation_tokens') ?? 0;
  const promptId = str(record, 'prompt.id');
  const durationMs = count(record, 'duration_ms');
  const ttftMs = count(record, 'ttft_ms');
  const agentName = str(record, 'agent.name');
  const reportedCostUsd = decimal(record, 'cost_usd');
  return {
    runtime: 'claude',
    sessionId,
    data: {
      requestId,
      ...(promptId ? { promptId } : {}),
      model,
      tokens: buckets({
        input: count(record, 'input_tokens'),
        output: count(record, 'output_tokens'),
        cacheRead: count(record, 'cache_read_tokens'),
        cacheWrite5m: cacheWrite,
      }),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      querySource: claudeQuerySource(str(record, 'query_source'), agentName),
      ...(agentName ? { agentName } : {}),
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTtlUnknown: true } : {}),
      source: 'otel',
    },
  };
};

/**
 * Codex — **experimental**: the names below are D13's research notes, not a
 * capture (Codex is not installed on the reference machine). Off unless
 * `otlp.codexExperimental` is set.
 */
const mapCodex = (record: OtlpLogRecord): Mapped | null => {
  const sessionId = str(record, 'conversation.id') ?? str(record, 'session.id');
  const requestId = str(record, 'request_id') ?? str(record, 'response.id');
  const model = str(record, 'model');
  const input = count(record, 'input_tokens');
  const output = count(record, 'output_tokens');
  if (!sessionId || !requestId || !model) return null;
  if (input === undefined && output === undefined) return null;
  const durationMs = count(record, 'duration_ms');
  return {
    runtime: 'codex',
    sessionId,
    data: {
      requestId,
      model,
      tokens: buckets({
        input,
        output,
        cacheRead: count(record, 'cached_input_tokens'),
        reasoning: count(record, 'reasoning_output_tokens'),
      }),
      ...(durationMs !== undefined ? { durationMs } : {}),
      querySource: 'main',
      source: 'otel',
    },
  };
};

const mapperFor = (
  name: string | null,
  context: MapContext,
): ((record: OtlpLogRecord) => Mapped | null) | null => {
  if (name === CLAUDE_API_REQUEST) return mapClaude;
  if (
    context.codexExperimental &&
    (name === CODEX_API_REQUEST || name === CODEX_SSE_EVENT)
  ) {
    return mapCodex;
  }
  return null;
};

/**
 * Turns decoded log records into `llm.request` events (D13, D14). Records of
 * any other event — prompts, tool results, responses — are ignored whole.
 */
export const mapLogRecords = (
  records: readonly OtlpLogRecord[],
  context: MapContext,
): MapResult => {
  const events: UnsequencedEvent[] = [];
  let dropped = 0;
  for (const record of records) {
    const mapper = mapperFor(eventName(record), context);
    if (!mapper) continue;
    const mapped = mapper(record);
    const { run, ...envelope } = correlation(record, context);
    // The shared schema's output is what is sent: the runner and the API
    // agree on the shape by construction.
    const parsed = mapped
      ? llmRequestDataSchema.safeParse({
          ...mapped.data,
          ...(run ? { run } : {}),
        })
      : null;
    if (!mapped || !parsed?.success || mapped.sessionId.length > MAX_ID) {
      dropped += 1;
      continue;
    }
    const data: LlmRequestData = parsed.data;
    events.push({
      v: EVENT_SCHEMA_VERSION,
      ts: timestamp(record, context.now),
      type: LLM_REQUEST_EVENT,
      source: 'otel',
      ...envelope,
      session: { runtime: mapped.runtime, id: mapped.sessionId },
      data,
    });
  }
  return { events, dropped };
};
