import type { NoProfileReason, ProfileSource } from '../readiness';
import type {
  DesignBatchMode,
  DesignFailureReason,
  DesignProgressPhase,
  DesignProgressStage,
} from './progress';
import type {
  DesignCommentKind,
  DesignTheme,
  TaskDesignStatus,
  UiProfileSnippet,
  UiProfileSource,
  UiProfileStatus,
  ViewportPreset,
} from './types';

/**
 * HTTP contracts of the design stage (docs/specs/223-design-stage.md
 * "API"): the UI profile, design settings, a task's design, its revisions
 * and comments. Dates are ISO strings.
 */

export interface DesignUserRef {
  id: string;
  name: string;
}

// UI profile (D12–D14)

/** One version of a project's profile (`ui_profiles` row). */
export interface UiProfileVersionView {
  id: string;
  projectId: string;
  version: number;
  source: UiProfileSource;
  hasUi: boolean;
  summary: string;
  kit: string;
  snippets: UiProfileSnippet[];
  fingerprintGlobs: string[];
  fingerprint: string;
  /** D14: the manual edits the build that wrote this version had to keep. */
  obligations: string | null;
  /** The `ui_profile` run that built it; null for a manual version. */
  runId: string | null;
  /** The person behind a manual version. */
  author: DesignUserRef | null;
  createdAt: string;
}

/** A row of the version list, without the heavy fields. */
export interface UiProfileVersionSummary {
  id: string;
  version: number;
  source: UiProfileSource;
  hasUi: boolean;
  author: DesignUserRef | null;
  createdAt: string;
}

/** `GET /projects/:id/ui-profile`. */
export interface UiProfileView {
  status: UiProfileStatus;
  /** Null with status `none`. */
  current: UiProfileVersionView | null;
  /** The running build's run, with status `building`. */
  buildRunId: string | null;
}

/** `GET /projects/:id/ui-profile/versions`; `?version=` reads one as `UiProfileVersionView`. */
export interface UiProfileVersionsView {
  items: UiProfileVersionSummary[];
}

/** `PUT /projects/:id/ui-profile` (project admin): a `manual` version (D14). */
export interface UiProfileUpdateRequest {
  summary: string;
  kit: string;
  snippets: UiProfileSnippet[];
  /** Default: the current version's. */
  hasUi?: boolean;
}

/** `POST /projects/:id/ui-profile/rebuild` (operator). */
export interface UiProfileRebuildResult {
  runId: string;
}

// Design settings (D11, D15)

/** `GET /projects/:id/design-settings`. No row: `DEFAULT_VIEWPORTS` and no skills. */
export interface DesignSettingsView {
  viewports: ViewportPreset[];
  defaultSkills: string[];
  /** False when no row exists and the defaults are shown. */
  saved: boolean;
  updatedBy: DesignUserRef | null;
  updatedAt: string | null;
}

/** `PUT /projects/:id/design-settings` (project admin). */
export interface DesignSettingsUpdateRequest {
  viewports: ViewportPreset[];
  defaultSkills: string[];
}

// A task's design (D1–D4, D9, D10)

/**
 * #441: one frame of a revision, without its HTML. A revision stored before
 * frames existed reads as one frame named `DESIGN_LEGACY_FRAME_NAME`.
 */
export interface DesignFrameView {
  /** 0-based, in the order the turn drew the frames. */
  position: number;
  name: string;
  /** The published file's stem: `design/<variant>/<slug>.html`. */
  slug: string;
  /** `GET /design-revisions/:id/frames/:position/html`, through the web's `/api` rewrite. */
  htmlUrl: string;
}

/** A design revision of one variant (`design_revisions` row), without its HTML. */
export interface DesignRevisionView {
  id: string;
  variant: number;
  revision: number;
  title: string;
  rationale: string;
  turnId: string;
  /** D4: a variant not picked on approve — readable, never published. */
  archived: boolean;
  /** The first frame's mockup, `GET /design-revisions/:id/html`. Prefer `frames`. */
  htmlUrl: string;
  /** #441: one or more, in order. */
  frames: DesignFrameView[];
  createdAt: string;
}

/** A comment (`design_comments` row). `screen` and `pin` carry their anchor. */
export interface DesignCommentView {
  id: string;
  revisionId: string;
  /** #441: the position of the frame it was left on, in its revision. */
  frame: number;
  kind: DesignCommentKind;
  viewport: string | null;
  theme: DesignTheme | null;
  x: number | null;
  y: number | null;
  selector: string | null;
  body: string;
  author: DesignUserRef | null;
  /** D10: set once a revision lists it in `addressed`. */
  addressedInRevisionId: string | null;
  createdAt: string;
}

/** A design skill that is set but no longer installed (D15): skipped, shown as a warning. */
export interface DesignSkillWarning {
  skill: string;
  message: string;
}

/** The design's state on a Planner task card (spec "UI"). */
export interface TaskDesignSummary {
  needed: boolean;
  /** Whether the planner suggested it, and why (D2). */
  suggested: boolean;
  suggestionWhy: string | null;
  variantCount: number;
  status: TaskDesignStatus;
  approvedRevisionId: string | null;
  /**
   * #275 D2, D8: when the current Generate or Revise started (ISO); null at
   * rest. The card face chip counts the whole job from it.
   */
  busySince: string | null;
}

/**
 * ADR-0025: a design has exactly one owner — a plan task or a board card
 * (#243). `number` is the card's per-project number (`C-<number>`).
 */
export type DesignOwnerView =
  | { kind: 'task'; planId: string; taskKey: string }
  | { kind: 'card'; cardId: string; number: number };
export type DesignOwnerKind = DesignOwnerView['kind'];

/**
 * `GET /plans/:planId/tasks/:key/design` (plan reader) and
 * `GET /projects/:projectId/board/cards/:number/design` (project viewer).
 */
export interface TaskDesignView extends TaskDesignSummary {
  id: string;
  owner: DesignOwnerView;
  /** The task owner's; `null` for a card's design. Prefer `owner`. */
  planId: string | null;
  /** The task owner's; `null` for a card's design. Prefer `owner`. */
  taskKey: string | null;
  skills: string[];
  /** The profile version the latest revisions were drawn from. */
  profileId: string | null;
  approvedBy: DesignUserRef | null;
  approvedAt: string | null;
  /** Every revision of every variant, oldest first. */
  revisions: DesignRevisionView[];
  comments: DesignCommentView[];
  warnings: DesignSkillWarning[];
  /** The viewer's presets: the project's settings, or the defaults. */
  viewports: ViewportPreset[];
  /** A design turn queued or running. */
  activeTurnId: string | null;
  /** #275 D1: what the busy design is doing; null at rest. */
  progress: DesignProgressView | null;
  /** #275 D6: why the last batch ended without a revision; only at rest. */
  lastFailure: DesignFailureView | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * #275 D1: the step a busy design is on. `profile` is the `ui_profile` run
 * whose `args.waiting` holds this design; `draw` / `revise` is its queued or
 * running design turn.
 */
export interface DesignProgressView {
  stage: DesignProgressStage;
  /** `queued` reads "Waiting for a free runner slot…" and never stalls (D4). */
  phase: DesignProgressPhase;
  /** The build's or the turn's run: the `run_log` topic (D3). */
  runId: string;
  /** The design turn; null on the profile stage. Stop cancels it (D5). */
  turnId: string | null;
  /** The variant being drawn or revised; null on the profile stage. */
  variant: number | null;
  variantCount: number;
  /** 1 on the profile stage, 2 for a turn of a batch that began with a build, else null. */
  step: 1 | 2 | null;
  /** `task_designs.busySince`: the whole job's clock (D2), ISO. */
  startedAt: string;
}

/** #275 D6: the last batch's failure, derived at read time. */
export interface DesignFailureView {
  stage: DesignProgressStage;
  /** The failed batch's mode: Retry calls Generate or Revise with it. */
  mode: DesignBatchMode;
  reason: DesignFailureReason;
  /** The turn's error or the build's outcome; empty when none was recorded. */
  message: string;
  /** The variant whose turn failed; null on the profile stage. */
  variant: number | null;
  at: string;
}

/** `PATCH /plans/:planId/tasks/:key/design` and `PATCH …/board/cards/:number/design` (operator). */
export interface TaskDesignPatchRequest {
  needed?: boolean;
  variantCount?: number;
  skills?: string[];
}

/** `POST /plans/:planId/tasks/:key/design/comments` (operator). */
export interface DesignCommentRequest {
  /** The revision in view; the comment records it (D10). */
  revisionId: string;
  /** #441: the frame in view, by position. Default 0, the first. */
  frame?: number;
  kind: DesignCommentKind;
  /** `screen` and `pin`. */
  viewport?: string;
  theme?: DesignTheme;
  /** `pin` only, from the helper's `pin` message. */
  x?: number;
  y?: number;
  selector?: string;
  body: string;
}

/**
 * `POST …/board/cards/:number/design/generate` and `…/design/revise`
 * (operator), from the card's launch popover (#322 D1). Both are optional: an
 * empty body starts as before. Each is stored on the card only when it
 * differs from the default (D3) — `profileKey` as the card's, shared with its
 * work; `model` as its `designModel`. Plan-task designs take no body
 * (ADR-0025: the Planner owns them).
 */
export interface CardDesignLaunchRequest {
  /**
   * A Claude profile of the project's runner (`profileKeySchema`); an
   * unknown or non-Claude key is 422 `no_profile` (D9).
   */
  profileKey?: string;
  /** A model alias or id (`orchestratorModelSchema`). */
  model?: string;
}

/** `POST /plans/:planId/tasks/:key/design/approve` (operator): picks one variant (D4). */
export interface DesignApproveRequest {
  revisionId: string;
}

// Live

/**
 * Design writes push on the plan's channel, as the Planner's do
 * (`PLANNER_LIVE_EVENT`); a card's design on the project's, alongside
 * `board.changed` (#243).
 */
export const DESIGN_LIVE_EVENT = 'design';

export interface DesignLiveChange {
  kind: 'design';
  projectId: string;
  /** `null` for a card's design. */
  planId: string | null;
  taskKey: string | null;
  /** Set for a card's design (#243). */
  cardId?: string;
}

// Errors

/** Stable codes in the `error` field of a design route's error body. */
export const DESIGN_ERROR = {
  notFound: 'not_found',
  forbidden: 'forbidden',
  invalidArgs: 'invalid_args',
  /** Approve of a task whose design is on and not approved (D1). */
  designNotApproved: 'design_not_approved',
  /** Generate, comment or revise on a task whose design is off. */
  designOff: 'design_off',
  /** A design turn or a profile build of this design is queued or running. */
  designBusy: 'design_busy',
  /** Revise with no open comment (D10). */
  noOpenComments: 'no_open_comments',
  /** The design is approved; it takes no more turns or comments. */
  designApproved: 'design_approved',
  /**
   * The task is approved and frozen, or the plan is sent; for a card, a
   * round exists (#243: designs freeze once Run has started).
   */
  taskFrozen: 'task_frozen',
  profileBuildFailed: 'profile_build_failed',
  contractViolation: 'contract_violation',
  unsupportedRuntime: 'unsupported_runtime',
  budgetExceeded: 'budget_exceeded',
  commandUnavailable: 'command_unavailable',
  commandFailed: 'command_failed',
  runnerTimeout: 'runner_timeout',
  /** 409: the runner's advert does not list the command (#233); nothing was sent or written. */
  runnerOutdated: 'runner_outdated',
  /** #275 D5: Stop with no build or design turn of this design running. */
  designNotRunning: 'design_not_running',
  /** 422 (#272 D2): no usable runtime profile; `reason`, `source`, `profileKey`. */
  noProfile: 'no_profile',
} as const;
export type DesignErrorCode = (typeof DESIGN_ERROR)[keyof typeof DESIGN_ERROR];

export interface DesignErrorBody {
  statusCode: number;
  error: DesignErrorCode;
  message: string;
  /** `no_profile` (#272 D2): why no profile can run it. */
  reason?: NoProfileReason;
  /** `no_profile`: the setting that named the profile. */
  source?: ProfileSource | null;
  /** `no_profile`: the unusable profile's key. */
  profileKey?: string;
}
