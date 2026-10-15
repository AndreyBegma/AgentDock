import type { Runtime } from '../protocol';

/**
 * Workflows analytics (#161): how agents work across sessions, as distinct
 * from Usage, which answers what they cost.
 *
 * **The unit is a root session** — a session with no parent, together with
 * every subagent session below it — started in `[from, to)`. Every metric,
 * Sankey node and filter counts root sessions, except the tool flow, which
 * counts tool-call transitions inside them.
 *
 * Definitions, used by every route alike:
 * - **depth** — the deepest subagent nesting below the root: 0 with no
 *   subagent, 1 when the main agent spawned subagents, 2 when one of those
 *   spawned its own, and so on.
 * - **subagents** — the number of sessions below the root, at any depth.
 * - **compactions** — `session.compacted` events summed over the whole tree.
 * - **duration** — the tree's last event minus the root's start, in ms.
 * - **active** — the tree had an event within `WORKFLOW_IDLE_MS` of now. A
 *   session that is not active has **ended**: no runtime reports an end, so
 *   idleness is the only signal.
 * - **outcome** of an ended session, in this order:
 *   1. `error` — its last signal is a `session.error`: no LLM request
 *      anywhere in the tree came after the last error;
 *   2. `abandoned` — the root's last turn never finished;
 *   3. `completed` — otherwise.
 *   An active session's outcome is `active`.
 * - **success rate** — `completed / ended`. The issue's "sessions that ended
 *   without error" is read as "completed": an abandoned session is not a
 *   success.
 * - **tool transition** — two consecutive tool calls (by start time) in one
 *   turn of one session; a subagent's calls chain in its own turns. Its
 *   `errors` count the transitions whose second call failed.
 * - **primary subagent type** — the type (Claude's `agentType`, e.g.
 *   `Explore`) most of the tree's subagents had; ties go to the name first in
 *   order. `WORKFLOW_AGENT_TYPE.none` without subagents,
 *   `WORKFLOW_AGENT_TYPE.unknown` when no subagent's type is known.
 *
 * Projected in the background from sessions, tool calls, compactions and
 * errors, then cached: a response may be up to `WORKFLOW_FRESHNESS_MS` old;
 * `computedAt` says when it was computed.
 */

/** Stable codes in the `error` field of a workflows route's error body. */
export const WORKFLOW_ERROR = {
  /** The `projectId` filtered on does not exist or is not visible. */
  notFound: 'not_found',
  /** `from` is not before `to`, or the range is longer than allowed. */
  invalidRange: 'invalid_range',
} as const;
export type WorkflowErrorCode =
  (typeof WORKFLOW_ERROR)[keyof typeof WORKFLOW_ERROR];

export interface WorkflowErrorBody {
  statusCode: number;
  error: WorkflowErrorCode;
  message: string;
}

/** A session is active while its tree had an event this recently. */
export const WORKFLOW_IDLE_MS = 30 * 60_000;
/** How old a response can be: the projector's lag plus the read cache. */
export const WORKFLOW_FRESHNESS_MS = 35_000;
/** The longest `[from, to)` a route takes. */
export const WORKFLOW_MAX_RANGE_DAYS = 400;
/** Subagent types shown in the orchestration Sankey; the rest fold into "+N more". */
export const WORKFLOW_TOP_AGENT_TYPES = 8;
export const WORKFLOW_TOOLS_DEFAULT_LIMIT = 20;
export const WORKFLOW_TOOLS_MAX_LIMIT = 100;

/** The page's segmented filter: every session, the active ones, the ended ones. */
export const WORKFLOW_STATUSES = ['all', 'active', 'ended'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WORKFLOW_OUTCOMES = [
  'completed',
  'error',
  'abandoned',
  'active',
] as const;
export type WorkflowOutcome = (typeof WORKFLOW_OUTCOMES)[number];

/** Compactions in a tree: 0, 1, 2 or more. */
export const WORKFLOW_COMPACTION_BUCKETS = ['none', 'one', 'many'] as const;
export type WorkflowCompactionBucket =
  (typeof WORKFLOW_COMPACTION_BUCKETS)[number];

/**
 * The `agentType` values that are not a runtime's type name. They start with
 * `~`, which no Claude agent type does.
 */
export const WORKFLOW_AGENT_TYPE = {
  /** The tree has no subagent. */
  none: '~none',
  /** It has subagents, and none of their types is known. */
  unknown: '~unknown',
  /** A type outside the top `WORKFLOW_TOP_AGENT_TYPES` of the same scope. */
  other: '~other',
} as const;

export const WORKFLOW_AGENT_TYPE_MAX_LENGTH = 200;

/**
 * Query of every workflows route. `from`/`to` bound the root's `startedAt`
 * (ISO, `to` exclusive). Without `projectId`, the scope is every project the
 * caller can see; an admin also sees sessions with no project.
 *
 * `outcome`, `agentType` and `compactions` are the Sankey's node filters:
 * a node's `filter` is sent back as one of them.
 */
export interface WorkflowsQuery {
  from: string;
  to: string;
  projectId?: string;
  /** The runtime profile (`sessions.profileKey`). */
  profileKey?: string;
  runtime?: Runtime;
  /** Default `all`. */
  status?: WorkflowStatus;
  outcome?: WorkflowOutcome;
  /** A primary subagent type, or one of `WORKFLOW_AGENT_TYPE`. */
  agentType?: string;
  compactions?: WorkflowCompactionBucket;
}

/** `GET /workflows/tools`: `limit` transitions, most frequent first. */
export interface WorkflowsToolsQuery extends WorkflowsQuery {
  limit?: number;
}

/** One tool following another; `errors` count failures of the second (`to`). */
export interface WorkflowToolFlow {
  from: string;
  to: string;
  count: number;
}

/**
 * `GET /workflows/summary`. Every average is over the root sessions in scope
 * and is null when there are none; `successRate` (0–1) is null when none has
 * ended. A null is "no data", never zero.
 */
export interface WorkflowsSummaryResponse {
  sessions: number;
  active: number;
  ended: number;
  /** Root sessions per outcome; `active` equals `active` above. */
  outcomes: Record<WorkflowOutcome, number>;
  avgDepth: number | null;
  avgSubagents: number | null;
  /** `completed / ended`; an abandoned session is not a success. */
  successRate: number | null;
  /** The most frequent tool transition; ties go to the names first in order. */
  topToolFlow: WorkflowToolFlow | null;
  avgCompactions: number | null;
  avgDurationMs: number | null;
  /** When this response was computed (ISO). */
  computedAt: string;
}

/** The orchestration Sankey's columns, left to right. */
export const WORKFLOW_COLUMNS = [
  'origin',
  'agent',
  'subagentType',
  'compactions',
  'outcome',
] as const;
export type WorkflowColumn = (typeof WORKFLOW_COLUMNS)[number];

/** What clicking a node filters the page on: one `WorkflowsQuery` field. */
export type WorkflowNodeFilter =
  | { key: 'runtime'; value: Runtime }
  | { key: 'agentType'; value: string }
  | { key: 'compactions'; value: WorkflowCompactionBucket }
  | { key: 'outcome'; value: WorkflowOutcome };

/** Shaped for glass-ui `Sankey` (`SankeyColumn`). */
export interface WorkflowSankeyColumn {
  id: WorkflowColumn;
  label: string;
}

/**
 * Shaped for glass-ui `Sankey` (`SankeyNode`), plus `filter`. Ids:
 * `origin`, `agent:<runtime>`, `type:<agentType>`, `compactions:<bucket>`,
 * `outcome:<outcome>`. `value` is the root sessions through the node.
 */
export interface WorkflowSankeyNode {
  id: string;
  label: string;
  column: WorkflowColumn;
  value: number;
  /** Null for the origin node, which filters nothing. */
  filter: WorkflowNodeFilter | null;
  /** On the "+N more" node (`type:~other`): how many types it folds. */
  folded?: number;
}

export interface WorkflowSankeyLink {
  source: string;
  target: string;
  value: number;
}

/**
 * `GET /workflows/orchestration`: Sessions → Main agent (one node per
 * runtime) → primary subagent type (top `WORKFLOW_TOP_AGENT_TYPES`, then
 * "+N more", "No subagents", "Unknown type") → compactions (None / 1 / 2+) →
 * outcome. Every root session follows exactly one path, so each column sums
 * to `sessions` and a node's inflow equals its outflow. Nodes and links with
 * no session are left out.
 */
export interface WorkflowsOrchestrationResponse {
  sessions: number;
  columns: WorkflowSankeyColumn[];
  nodes: WorkflowSankeyNode[];
  links: WorkflowSankeyLink[];
  computedAt: string;
}

export interface WorkflowToolTransition extends WorkflowToolFlow {
  /** Transitions whose `to` call failed. */
  errors: number;
  /** `errors / count`, 0–1. */
  errorShare: number;
}

/**
 * `GET /workflows/tools`: the most frequent transitions, ordered by `count`
 * descending, then `from`, then `to`. `from` can equal `to` (Bash → Bash) and
 * the graph can have cycles: drawn as a Sankey, `from` and `to` need their
 * own columns.
 */
export interface WorkflowsToolsResponse {
  transitions: WorkflowToolTransition[];
  /** Every transition in scope, not only the ones returned. */
  totalTransitions: number;
  /** Distinct `from → to` pairs in scope. */
  distinctTransitions: number;
  computedAt: string;
}
