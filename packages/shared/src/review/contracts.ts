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
