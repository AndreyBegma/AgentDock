import type { AttachmentView } from '../attachments/contracts';
import type { TaskDesignSummary } from '../design/contracts';
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

/**
 * `POST /projects/:projectId/plans`. Defaults: the caller's planning model
 * (#337 D9, `GET /me/settings`), the project's default profile (D14).
 *
 * #337 D2: `mode: 'card'` is New work (#409) — `brief` is What to do, as typed, and
 * the first intake turn starts at once. `attachmentIds` (D10): pending
 * uploads of the caller in this project, claimed by the plan and passed to
 * `plan.turn`; the generated card claims them in turn.
 */
export interface CreatePlanRequest {
  brief: string;
  mode: PlanMode;
  model?: string;
  profileKey?: string;
  attachmentIds?: string[];
}

/**
 * `POST /projects/:projectId/plans/:planId/cards` (#337 D7): Create cards —
 * one Todo card per task of the current version, with Depends-on links
 * mirroring `dependsOn`. Once per plan: then 409 `cards_exist`. A `card`
 * plan is 409 `wrong_mode`: its card comes from the intake.
 */
export interface CreatePlanCardsResponse {
  /** In task order. */
  cards: PlanCreatedCard[];
}

export interface PlanCreatedCard {
  taskKey: string;
  /** The card's per-project number; `label` is `C-<number>`. */
  number: number;
  label: string;
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

/** A round of questions a turn opened, in the scope it was asked in. */
export interface PlanTurnRound {
  /** The task the round belongs to; null for a plan-level round (clarify). */
  taskKey: string | null;
  questions: PlanQuestion[];
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
  /** `contract_violation: <reason>: <message>`, or the runner's error. */
  error: string | null;
  /** Kept for a `contract_violation`, shown raw in a `Disclosure`. */
  resultText: string | null;
  /**
   * The rounds this turn opened, from its stored output: a clarify opens the
   * plan-level round, a grill its task's next round, a decompose or revise
   * the first round of each new or changed task. Empty when the output says
   * `done`, when the turn has no output (failed, running, older), or when the
   * stored output no longer parses.
   */
  rounds: PlanTurnRound[];
  createdAt: string;
  finishedAt: string | null;
}

/** An issued task's GitHub side, derived on read (spec "Data / Schema"). */
export interface PlanTaskIssueView {
  number: number;
  url: string;
  /** Null: issued but not queued yet — a feature waiting for its docs pull request (D10). */
  liveStatus: PlanTaskLiveStatus | null;
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
  /** Spec 223: the task's design; null while no design row exists (off, never suggested). */
  design: TaskDesignSummary | null;
  /** #337 D7: the board card Create cards made from the task; null before. */
  cardId: string | null;
}

/** The turn that produced a plan version: the decompose for 1, a revise after. */
export interface PlanVersionTurnView {
  id: string;
  action: Extract<PlanTurnAction, 'decompose' | 'revise'>;
  author: PlanUserRef;
  finishedAt: string | null;
}

/** A task as it was in one plan version (D9: earlier versions stay readable). */
export interface PlanTaskVersionView {
  version: number;
  status: PlanTaskStatus;
  frozen: boolean;
  title: string;
  summary: string;
  document: string | null;
  rewriteComment: string | null;
  /** When the version's row was written. */
  createdAt: string;
  /** Null when the producing turn cannot be told (an older or edited plan). */
  turn: PlanVersionTurnView | null;
}

/** `GET /projects/:projectId/plans/:planId/tasks/:key/versions`. */
export interface PlanTaskVersionsView {
  key: string;
  /** The plan's current version; the task may have left the plan before it. */
  currentVersion: number;
  /** The versions the task appeared in, oldest first. */
  versions: PlanTaskVersionView[];
}

/**
 * Why a plan needs the person although its stored status says otherwise
 * (#213): its newest turn failed and nothing replaced it. `failed` while the
 * plan had made no progress (clarifying, drafting); `attention` once it has
 * tasks to review. Derived on read, never stored.
 */
export interface PlanAttention {
  kind: 'failed' | 'attention';
  /** The failed turn's error, as the turn view carries it. */
  reason: string;
  turnId: string;
  /** When the turn failed (its `finishedAt`, else `createdAt`). */
  at: string;
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
  /**
   * Null when the plan needs nothing beyond what `status` says. Optional
   * until every route that answers a summary derives it; absent reads as null.
   */
  attention?: PlanAttention | null;
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
  /**
   * #379: `owner/name` of the docs repository the docs PR is in; `null` when
   * it is the project's own repository.
   */
  docsPrRepo: string | null;
  tasks: PlanTaskView[];
  turns: PlanTurnView[];
  graph: PlanGraphView;
  /** A turn queued or running: new turns are refused (`turn_in_progress`). */
  activeTurnId: string | null;
  /** #337 D4: a `card` plan's progress; null for any other mode. */
  intake: PlanIntakeView | null;
}

/** #337 D3, D4: where a card intake stands. */
export interface PlanIntakeView {
  /** Question rounds its turns opened (`intakeRoundsAsked`). */
  roundsAsked: number;
  /** `PLANNER_INTAKE_MAX_ROUNDS`: after this many, the next turn writes the card. */
  maxRounds: number;
  /**
   * #409: the split the intake proposes, waiting for the person — the last
   * succeeded intake turn's. Null when none is open (optional: absent reads
   * as null).
   */
  split?: PlanIntakeSplitView | null;
  /**
   * #594: the files the plan holds so far, oldest first — the web dialog's
   * and those a Telegram `/new` sent (optional: absent reads as none).
   */
  attachments?: AttachmentView[];
}

/** #409: a split proposal as the person reviews it. */
export interface PlanIntakeSplitView {
  /** The turn that proposed it: Confirm names it, so a stale list is refused. */
  turnId: string;
  /** Why several cards, in the person's language. */
  reason: string;
  /** In the proposal's order; `index` is what Confirm refers to. */
  cards: PlanIntakeSplitCard[];
  /**
   * #480 (ADR-0044): set when the intake proposed a stack — `cards` then
   * lists every card of it in stage order, and the stages name them by
   * `index`. Null (or absent) for a plain split.
   */
  stack?: PlanIntakeStackView | null;
}

/** #480: a stack proposal's shape as the person reviews it. */
export interface PlanIntakeStackView {
  title: string;
  /** Markdown, English. */
  body: string;
  /** The intake suggests a shared design of the whole result. */
  design: boolean;
  /** In order; each names its cards by `PlanIntakeSplitCard.index`. */
  stages: { title: string; cards: number[] }[];
}

export interface PlanIntakeSplitCard {
  index: number;
  title: string;
  kind: PlanTaskKind;
  summary: string;
}

/**
 * `POST /projects/:projectId/plans/:planId/split` (#409): Confirm a split —
 * the cards the person kept, in their order, each with its title and kind as
 * they left it. All are created at once in Todo, independent of each other;
 * the intake is then done. 409 `split_stale` when `turnId` is not the open
 * proposal; 409 `wrong_mode` on a plan that is not an intake.
 */
export interface ConfirmSplitRequest {
  turnId: string;
  cards: ConfirmSplitCard[];
  /**
   * #480 (ADR-0044): confirm the cards as a stack instead of independent
   * cards — whichever the intake proposed. Every kept card is in exactly one
   * stage; every card of a stage gets a dependency on every card of the stage
   * before it. Absent: independent cards, as before.
   */
  stack?: ConfirmStackRequest;
}

/** #480: the stack the person confirms. */
export interface ConfirmStackRequest {
  /** English, at most `STACK_TITLE_MAX` characters. */
  title: string;
  /** Markdown, at most `STACK_BODY_MAX` characters; may be empty. */
  body: string;
  /** Draw a stack design first: no card of the stack runs until it is approved. */
  design: boolean;
  /** In order, at least one, none empty; cards by `ConfirmSplitCard.index`. */
  stages: { title: string; cards: number[] }[];
}

export interface ConfirmSplitCard {
  /** `PlanIntakeSplitCard.index`; each at most once. */
  index: number;
  /** English, at most `CARD_DRAFT_TITLE_MAX` characters. */
  title: string;
  kind: PlanTaskKind;
}

export interface ConfirmSplitResponse {
  /** In the confirmed order. */
  cards: { number: number; label: string }[];
  /** #480: the stack made, when the request named one. */
  stack?: { number: number; label: string } | null;
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
  /** Retry of a turn that did not fail. */
  turnNotFailed: 'turn_not_failed',
  /** `approve` while a blocking question is open (D6). */
  needsTalk: 'needs_talk',
  /** `approve` while the task's design is on and not approved (spec 223 D1). */
  designNotApproved: 'design_not_approved',
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
  /** 409: the runner's advert does not list the command (#233); nothing was sent or written. */
  runnerOutdated: 'runner_outdated',
  /**
   * 422 (#379): `docs_pr` and the project's docs are a remote repository
   * with no local clone path to write the specs in.
   */
  noDocsClone: 'no_docs_clone',
  /** 409 (#337 D7): Create cards on a plan whose cards exist. */
  cardsExist: 'cards_exist',
  /**
   * 409 (#409): Confirm a split that is no longer the intake's open
   * proposal — a later turn replaced it, or none was proposed.
   */
  splitStale: 'split_stale',
  /**
   * 409 (#337): a route that does not fit the plan's mode — Create cards or
   * Send on a `card` plan, an intake turn on any other.
   */
  wrongMode: 'wrong_mode',
} as const;
export type PlannerErrorCode =
  (typeof PLANNER_ERROR)[keyof typeof PLANNER_ERROR];

export interface PlannerErrorBody {
  statusCode: number;
  error: PlannerErrorCode;
  message: string;
}
