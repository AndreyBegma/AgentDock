import type {
  QuerySource,
  Runtime,
  SessionBackfillArgs,
  SessionBackfillResult,
  TokenBuckets,
} from '../protocol';

/** Stable codes in the `error` field of a sessions route's error body. */
export const SESSION_ERROR = {
  /** The session, or the `projectId` filtered on, does not exist or is not visible. */
  notFound: 'not_found',
  /** `unassigned=true` from a non-admin (D10). */
  forbidden: 'forbidden',
  /** `unassigned=true` together with `projectId`; an unknown `cursor`. */
  invalidFilter: 'invalid_filter',
  /** Backfill: the runner has no open connection. */
  runnerOffline: 'runner_offline',
  /** Backfill: no result within the command's timeout; the outcome is unknown. */
  runnerTimeout: 'runner_timeout',
  /** Backfill: the runner refused it (sessions disabled, project not watched). */
  runnerRefused: 'runner_refused',
  /** Backfill: the runner failed while running it. */
  runnerError: 'runner_error',
} as const;
export type SessionErrorCode =
  (typeof SESSION_ERROR)[keyof typeof SESSION_ERROR];

export interface SessionErrorBody {
  statusCode: number;
  error: SessionErrorCode;
  message: string;
}

export const SESSION_LIST_DEFAULT_LIMIT = 50;
export const SESSION_LIST_MAX_LIMIT = 200;

/**
 * Token buckets summed over a node, its request count, and its cost. `costUsd`
 * is a decimal string, null until #13 prices at least one of its requests.
 */
export interface SessionTotals extends TokenBuckets {
  requests: number;
  costUsd: string | null;
}

/**
 * `GET /sessions` query. Without `projectId` the list holds every project the
 * caller can see; `unassigned=true` (admins only) lists sessions with no
 * project instead. `from`/`to` bound `startedAt` (ISO, `to` exclusive).
 * `cursor` is the `nextCursor` of the previous page.
 */
export interface SessionListQuery {
  projectId?: string;
  runtime?: Runtime;
  model?: string;
  slot?: string;
  from?: string;
  to?: string;
  unassigned?: boolean;
  cursor?: string;
  limit?: number;
}

/**
 * A session as the list and the tree header show it. Totals cover the session
 * and every subagent session below it.
 */
export interface SessionSummary {
  id: string;
  runnerId: string;
  runtime: Runtime;
  profileKey: string | null;
  /** The runtime's own session id. */
  externalId: string;
  projectId: string | null;
  projectName: string | null;
  slotName: string | null;
  cwd: string;
  gitBranch: string | null;
  title: string | null;
  /** Distinct models used, in order of first use. */
  models: string[];
  parentSessionId: string | null;
  /** False while the runtime's transcripts are not parsed (Codex, D7). */
  parsed: boolean;
  startedAt: string;
  lastEventAt: string;
  endedAt: string | null;
  /** `(endedAt ?? lastEventAt) - startedAt`. */
  durationMs: number;
  turns: number;
  toolCalls: number;
  /** Subagent sessions anywhere below this one. */
  subagents: number;
  totals: SessionTotals;
}

/** `GET /sessions`. Root sessions only; subagents appear in the tree. */
export interface SessionListResponse {
  items: SessionSummary[];
  nextCursor: string | null;
}

/** One LLM request: a leaf of the tree. */
export interface SessionRequestNode {
  id: string;
  requestId: string;
  ts: string;
  model: string;
  querySource: QuerySource;
  durationMs: number | null;
  durationApprox: boolean;
  stopReason: string | null;
  totals: SessionTotals;
}

/**
 * One tool call. `totals` are the child session's totals when the call spawned
 * a subagent, zero otherwise. `child` is null when there is none, or when the
 * caller cannot see it.
 */
export interface SessionToolNode {
  id: string;
  toolUseId: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  ok: boolean | null;
  child: SessionTreeNode | null;
  totals: SessionTotals;
}

/** A turn: what one user prompt caused. `totals` = its requests + its tools. */
export interface SessionTurnNode {
  id: string;
  promptId: string;
  startedAt: string;
  endedAt: string | null;
  requests: SessionRequestNode[];
  tools: SessionToolNode[];
  totals: SessionTotals;
}

/**
 * A session and everything under it. `totals` = the sum of its turns, its
 * `unattributed` requests and tools (no turn known), and `subagents` (child
 * sessions no tool call links to).
 */
export interface SessionTreeNode {
  session: SessionSummary;
  turns: SessionTurnNode[];
  unattributed: {
    requests: SessionRequestNode[];
    tools: SessionToolNode[];
  };
  subagents: SessionTreeNode[];
  totals: SessionTotals;
}

/** `GET /sessions/:id`. */
export type SessionDetail = SessionTreeNode;

/**
 * `POST /admin/runners/:id/backfill` (admin): the `session.backfill` args.
 * `since` is an ISO date-time; only transcripts modified after it are re-read
 * (D11).
 */
export type BackfillRequest = SessionBackfillArgs;

/** `POST /admin/runners/:id/backfill`: the runner's `session.backfill` result. */
export type BackfillResponse = SessionBackfillResult;

/** Live event on `project:<id>` when that project's sessions changed. */
export const SESSIONS_CHANGED_LIVE_EVENT = 'sessions.changed';
export interface SessionsChangedLiveData {
  /** AgentDock ids of the sessions touched by one runner batch. */
  sessionIds: string[];
}
