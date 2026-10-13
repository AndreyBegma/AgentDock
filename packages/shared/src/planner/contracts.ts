import type { PlannerViolationReason } from './contract';
import type {
  PlanAnswer,
  PlanMode,
  PlannerSpecOutput,
  PlanQuestion,
  PlanStatus,
  PlanTaskKind,
  PlanTaskLiveStatus,
  PlanTaskStatus,
  PlanTurnAction,
  PlanTurnInput,
  PlanTurnPhase,
  PlanVisibility,
} from './types';

/**
 * HTTP contracts of the Planner (docs/specs/172-planner.md "API"): plans,
 * turns, task review, revise, visibility, send, `/tasks`, and the
 * instructions and settings editors. Dates are ISO strings.
 */

// Requests

/** `POST /projects/:projectId/plans`. Defaults: model `opus`, the project's default profile (D14). */
export interface CreatePlanRequest {
  brief: string;
  mode: PlanMode;
  model?: string;
  profileKey?: string;
}

/** `POST …/plans/:planId/turns` and `…/tasks/:key/turns`: a chat message, a round's answers, or both (D7). */
export type PlanTurnRequest = PlanTurnInput;

export const PLAN_REVIEW_DECISIONS = ['approve', 'reject', 'rewrite'] as const;
export type PlanReviewDecision = (typeof PLAN_REVIEW_DECISIONS)[number];

/** `POST …/tasks/:key/review`. `comment` is required for `rewrite` (D9). */
export interface PlanTaskReviewRequest {
  decision: PlanReviewDecision;
  comment?: string;
}

/** `POST …/plans/:planId/visibility`. */
export interface PlanVisibilityRequest {
  visibility: PlanVisibility;
}

// Views

export interface PlanUserRef {
  id: string;
  name: string;
}

/** A turn (`plan_turns` row). `resultText` is kept for a `contract_violation` (D17). */
export interface PlanTurnView {
  id: string;
  planId: string;
  /** The task key for a grill or write turn; null for a plan-level turn. */
  taskKey: string | null;
  runId: string;
  action: PlanTurnAction;
  author: PlanUserRef;
  input: PlanTurnInput;
  phase: PlanTurnPhase;
  /** `contract_violation`, or the runner's error code. */
  error: string | null;
  /** Set with `error: 'contract_violation'`. */
  violation: PlannerViolationReason | null;
  resultText: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** An issued task's GitHub side, derived on read (spec "Data / Schema"). */
export interface PlanTaskIssueView {
  number: number;
  url: string;
  liveStatus: PlanTaskLiveStatus;
  prNumber: number | null;
  prUrl: string | null;
}

/** A task of a plan version (`plan_tasks` row). */
export interface PlanTaskView {
  id: string;
  key: string;
  planVersion: number;
  kind: PlanTaskKind;
  title: string;
  summary: string;
  dependsOn: string[];
  status: PlanTaskStatus;
  /** The current round's questions; blocking ones keep the task `needs_talk` (D6). */
  questions: PlanQuestion[];
  /** Unanswered blocking questions. */
  blockingOpen: number;
  document: string | null;
  rewriteComment: string | null;
  frozen: boolean;
  issue: PlanTaskIssueView | null;
  queuedAt: string | null;
}

/** One row of a plan list. */
export interface PlanSummary {
  id: string;
  projectId: string;
  title: string;
  author: PlanUserRef;
  mode: PlanMode;
  visibility: PlanVisibility;
  status: PlanStatus;
  version: number;
  /** Tasks of the current version, by status. */
  taskCounts: Partial<Record<PlanTaskStatus, number>>;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

/** `GET /projects/:projectId/plans`. */
export interface PlanListView {
  items: PlanSummary[];
}

/** The plan graph: tasks as nodes, `dependsOn` as edges (from → to = dependency → dependant). */
export interface PlanGraphView {
  nodes: { key: string; kind: PlanTaskKind; title: string }[];
  edges: { from: string; to: string }[];
}

/** `GET /projects/:projectId/plans/:planId`. */
export interface PlanDetail extends PlanSummary {
  brief: string;
  /** Plan-level questions of the current round (dialogue mode, before decomposition). */
  questions: PlanQuestion[];
  instructionsVersion: number;
  contractVersion: number;
  profileKey: string;
  model: string;
  docsPrNumber: number | null;
  docsPrUrl: string | null;
  tasks: PlanTaskView[];
  turns: PlanTurnView[];
  graph: PlanGraphView;
  /** A turn queued or running: new turns are refused (`turn_in_progress`). */
  activeTurnId: string | null;
}

/** `GET /tasks` query. */
export interface TasksQuery {
  projectId?: string;
  kind?: PlanTaskKind;
  status?: PlanTaskStatus | PlanTaskLiveStatus;
  planId?: string;
  q?: string;
  cursor?: string;
}

/** One row of `GET /tasks`: a task of a readable plan, with its live status. */
export interface TaskRow {
  projectId: string;
  projectName: string;
  planId: string;
  planTitle: string;
  taskId: string;
  key: string;
  title: string;
  kind: PlanTaskKind;
  /** The live status once issued, the task's own status before. */
  status: PlanTaskStatus | PlanTaskLiveStatus;
  issue: PlanTaskIssueView | null;
  updatedAt: string;
}

export interface TaskPage {
  items: TaskRow[];
  nextCursor: string | null;
}

/** One version of the instructions (`planner_instructions` row). */
export interface PlannerInstructionsVersion {
  id: string;
  version: number;
  body: string;
  /** Null for the seeded version 1. */
  author: PlanUserRef | null;
  createdAt: string;
}

/** `GET /admin/planner/instructions`: the current version first. */
export interface PlannerInstructionsView {
  current: PlannerInstructionsVersion;
  versions: PlannerInstructionsVersion[];
  /** The fixed output contract, shown read-only. */
  contract: string;
  contractVersion: number;
}

/** `PUT /admin/planner/instructions`: writes a new version. */
export interface PlannerInstructionsUpdateRequest {
  body: string;
}

/** `GET /projects/:projectId/planner/settings`. */
export interface PlannerSettingsView {
  specOutput: PlannerSpecOutput;
  /** Null: the project uses the global instructions. */
  override: PlannerInstructionsVersion | null;
  overrideVersions: PlannerInstructionsVersion[];
  contract: string;
  contractVersion: number;
}

/** `PUT /projects/:projectId/planner/settings`. An empty override clears it. */
export interface PlannerSettingsUpdateRequest {
  specOutput: PlannerSpecOutput;
  instructionsOverride?: string;
}

/** A round's answers, as the question cards send them. */
export type PlanRoundAnswers = PlanAnswer[];

// Live

/** Live event on topic `project:<id>`: ids only, a client refetches (spec "Live"). */
export const PLANNER_LIVE_EVENT = 'planner';

export interface PlannerLiveChange {
  kind: 'planner';
  projectId: string;
  planId: string;
}

// Errors

/** Stable codes in the `error` field of a planner route's error body. */
export const PLANNER_ERROR = {
  notFound: 'not_found',
  forbidden: 'forbidden',
  invalidArgs: 'invalid_args',
  /** A turn of this plan is queued or running. */
  turnInProgress: 'turn_in_progress',
  /** `approve` while a blocking question is open (D6). */
  needsTalk: 'needs_talk',
  /** Send found a cycle in `dependsOn`; the message names the tasks (D8). */
  dependencyCycle: 'dependency_cycle',
  /** Send with no approved task, or with a task in `needs_talk` (D8). */
  notSendable: 'not_sendable',
  /** A sent or archived plan takes no more turns, reviews or revisions. */
  planClosed: 'plan_closed',
  /** The turn's output did not validate (D17); nothing was applied. */
  contractViolation: 'contract_violation',
  /** A `codex` profile; nothing was sent. */
  unsupportedRuntime: 'unsupported_runtime',
  noProfile: 'no_profile',
  unknownProfile: 'unknown_profile',
  /** A budget refuses the run (#28). */
  budgetExceeded: 'budget_exceeded',
  commandUnavailable: 'command_unavailable',
  commandFailed: 'command_failed',
  runnerTimeout: 'runner_timeout',
} as const;
export type PlannerErrorCode =
  (typeof PLANNER_ERROR)[keyof typeof PLANNER_ERROR];

export interface PlannerErrorBody {
  statusCode: number;
  error: PlannerErrorCode;
  message: string;
}
