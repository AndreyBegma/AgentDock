/**
 * Review steps (issue #862, ADR-0084): the checks a card's pull request
 * passes, in order, after CI is green and before the card is Finished. A
 * project has one built-in `peer_review` step, whose instructions are
 * generated from the repository, and any number of `skill` steps that run a
 * skill of the project's runner. The API stores the configuration; running
 * the steps is the engine's (stack S-11, stage 2).
 */

/** Mirrors the Prisma enum `ReviewStepType`. */
export const REVIEW_STEP_TYPES = ['peer_review', 'skill'] as const;
export type ReviewStepType = (typeof REVIEW_STEP_TYPES)[number];

/** The name the built-in step is created with. */
export const PEER_REVIEW_STEP_NAME = 'Peer review';

export const REVIEW_STEP_NAME_MAX = 80;
/** A step's Markdown instructions, in characters. */
export const REVIEW_INSTRUCTIONS_MAX = 20_000;
/** A skill invocation, as the skill inventory stores it. */
export const REVIEW_SKILL_NAME_MAX = 200;
/** Steps one project may have, the peer review step included. */
export const REVIEW_STEPS_MAX = 20;
/** ADR-0084 §3: automatic review fix rounds per pull request. */
export const REVIEW_FIX_ROUNDS_MAX = 3;

export interface ReviewStepView {
  id: string;
  projectId: string;
  /** 0-based; steps are served and run in this order. */
  position: number;
  enabled: boolean;
  name: string;
  type: ReviewStepType;
  /** `peer_review` only: Markdown; null on a `skill` step. */
  instructions: string | null;
  /** `skill` only: a skill invocation of the project; null on `peer_review`. */
  skillName: string | null;
  /** When the instructions were last generated; null while they are the built-in default. */
  instructionsGeneratedAt: string | null;
  /** When a person last edited the instructions. */
  instructionsEditedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /projects/:projectId/review`. */
export interface ReviewSettingsView {
  projectId: string;
  /** Off for every project until a person turns it on. */
  reviewEnabled: boolean;
  /** Mirror findings as GitHub PR comments; off by default. */
  publishReviewComments: boolean;
  steps: ReviewStepView[];
}

/** Why generating the peer review instructions did not succeed. */
export interface ReviewGenerationError {
  code: string;
  message: string;
}

/**
 * `PUT /projects/:projectId/review` (project admin). Absent keeps the stored
 * value. Turning review on the first time creates the peer review step and
 * generates its instructions; a step that already exists is kept as it is.
 */
export interface UpdateReviewSettingsRequest {
  reviewEnabled?: boolean;
  publishReviewComments?: boolean;
}

/**
 * The answer to `PUT /projects/:projectId/review`. When the peer review step
 * was just created and generation failed, it holds the built-in default
 * instructions and `generationError` says why; Regenerate can try again.
 */
export interface ReviewSettingsUpdateResult extends ReviewSettingsView {
  generationError: ReviewGenerationError | null;
}

/** `POST /projects/:projectId/review/steps`: a `skill` step, appended last. */
export interface CreateReviewStepRequest {
  name: string;
  /** A skill invocation from `GET /projects/:projectId/skills`. */
  skillName: string;
  /** Default true. */
  enabled?: boolean;
}

/**
 * `PATCH /projects/:projectId/review/steps/:stepId`. `instructions` is for
 * the `peer_review` step and `skillName` for a `skill` step; the other is
 * refused. Instructions are stored exactly as sent.
 */
export interface UpdateReviewStepRequest {
  name?: string;
  enabled?: boolean;
  instructions?: string;
  skillName?: string;
}

/** `PUT /projects/:projectId/review/steps/order`: every step, once each. */
export interface ReorderReviewStepsRequest {
  stepIds: string[];
}

/**
 * `POST /projects/:projectId/review/peer-review/regenerate` takes no body:
 * the UI asks the person to confirm before it calls, because the answer
 * replaces the instructions, edits included.
 */

/** How much a finding holds a card back. */
export const REVIEW_FINDING_SEVERITIES = ['blocking', 'nit'] as const;
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export const REVIEW_FINDING_TITLE_MAX = 200;
export const REVIEW_FINDING_BODY_MAX = 8_000;

/**
 * One finding of a review step, as the engine stores it on a card. A
 * `blocking` finding starts a fix round; a `nit` never does.
 */
export interface ReviewFinding {
  /** The `ProjectReviewStep` that reported it. */
  stepId: string;
  severity: ReviewFindingSeverity;
  /** Relative to the repository root. */
  file?: string;
  /** 1-based, in `file`. */
  line?: number;
  title: string;
  /** Markdown. */
  body: string;
}

export const isReviewFindingSeverity = (
  value: unknown,
): value is ReviewFindingSeverity =>
  typeof value === 'string' &&
  (REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value);

export const REVIEW_ERROR = {
  notFound: 'not_found',
  /** A reorder that does not list every step of the project exactly once. */
  orderMismatch: 'review_step_order_mismatch',
  /** The peer review step cannot be deleted; it can be disabled. */
  builtinStep: 'review_step_builtin',
  /** `instructions` on a skill step, or `skillName` on the peer review step. */
  wrongType: 'review_step_wrong_type',
  /** A `skillName` the project's runner does not report. */
  unknownSkill: 'review_skill_unknown',
  tooManySteps: 'review_steps_limit',
  /** Regenerate before review was ever enabled: there is no peer review step. */
  noPeerReview: 'review_no_peer_review',
  runnerOffline: 'review_runner_offline',
  runnerUnsupported: 'review_runner_unsupported',
  runnerNoAnswer: 'review_runner_no_answer',
  /** No instance default model is set (Admin › AI providers). */
  noModel: 'review_no_model',
  /** The model answered with nothing usable. */
  generationEmpty: 'review_generation_empty',
} as const;
export type ReviewErrorCode = (typeof REVIEW_ERROR)[keyof typeof REVIEW_ERROR];

export interface ReviewErrorBody {
  statusCode: number;
  error: ReviewErrorCode;
  message: string;
}

/**
 * #884 (ADR-0084 §4): the MCP tool a review session calls once, with every
 * finding, the way a card worker calls `finish_card`.
 */
export const REVIEW_REPORT_TOOL = 'report_review';

/** #884: findings one review step may report; more are refused. */
export const REVIEW_FINDINGS_MAX = 50;

/** #884: the one-paragraph summary a review step reports beside its findings. */
export const REVIEW_SUMMARY_MAX = 2_000;

/**
 * #884: how long a review step may run before it counts as failed — the
 * session never called `report_review`, and the card needs a person.
 */
export const REVIEW_STEP_TIMEOUT_MS = 60 * 60_000;

/**
 * #884: one run of one review step on a card's pull request head.
 * - `running` — the session is reviewing;
 * - `passed` — it reported no blocking finding (nits allowed);
 * - `blocked` — it reported a blocking finding;
 * - `failed` — it could not start, timed out or ended without a report.
 * Mirrors the Prisma enum `CardReviewRunState`.
 */
export const CARD_REVIEW_RUN_STATES = [
  'running',
  'passed',
  'blocked',
  'failed',
] as const;
export type CardReviewRunState = (typeof CARD_REVIEW_RUN_STATES)[number];

/** #884: a step of the card's current review pass; `pending` has not run yet. */
export type CardReviewStepState = 'pending' | CardReviewRunState;

/**
 * #884: where the card's review gate stands.
 * - `idle` — CI is not green yet, so no step has run on this head;
 * - `running` — a step is reviewing;
 * - `fixing` — a `review_fix` round is working on blocking findings;
 * - `passed` — every enabled step passed on the head;
 * - `needs_person` — the fix budget is spent or a step failed.
 */
export const CARD_REVIEW_STATES = [
  'idle',
  'running',
  'fixing',
  'passed',
  'needs_person',
] as const;
export type CardReviewState = (typeof CARD_REVIEW_STATES)[number];

export interface CardReviewStepView {
  /** The `ProjectReviewStep`. */
  id: string;
  name: string;
  state: CardReviewStepState;
  blockingCount: number;
  nitCount: number;
}

/**
 * #884: the review strip of a board card. `null` on the card when review is
 * off for the project or no step is enabled.
 */
export interface CardReviewView {
  state: CardReviewState;
  /** The name of the step that is running; absent when none is. */
  currentStep?: string;
  /** 0-based index of the running step, else of the last step that ran. */
  stepIndex: number;
  stepCount: number;
  /** `review_fix` rounds already started on the card's pull request. */
  fixRound: number;
  fixLimit: number;
  steps: CardReviewStepView[];
}

/** #884: a finding as the card detail serves it, with its step's name. */
export interface CardReviewFindingView extends ReviewFinding {
  stepName: string;
}
