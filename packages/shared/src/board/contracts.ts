import type {
  CardDesignRecommendableModel,
  CardRecommendableModel,
} from '../assess/limits';
import type { AttachmentRefusal, AttachmentView } from '../attachments';
import type { TaskDesignSummary, TaskDesignView } from '../design';
import type { FleetStage } from '../fleet';
import type {
  CardMergeMethod,
  CardRunWiring,
  CardRunWiringReason,
  OrchestratorPermissionMode,
  PrChecks,
  PrInspectState,
} from '../protocol';
import type { ProfileSource } from '../readiness';
import type { CardKindSource } from '../text/limits';
import type {
  CaptureModel,
  CaptureSkipReason,
  CaptureStatus,
} from './capture-limits';
import type { CardCiCheck } from './shipping';
import type {
  BoardCardKind,
  BoardCardSource,
  BoardColumn,
  CardCiState,
  CardCollectState,
  CardFinishedBy,
  CardPrState,
  CardRoundPhase,
  CardRoundTrigger,
} from './types';
import type { CardChange } from './worker-prompt';

/**
 * HTTP contracts of the Board (issue #242 "API"). Every route is under
 * `/projects/:projectId`, behind the project guard; a card is addressed by
 * its per-project `number`.
 */

export interface BoardUserRef {
  id: string;
  email: string;
}

/** #348 D1: why a round's session sent no hook events. */
export type CardHooksCause = 'no_plugin' | 'session_predates' | 'unknown';

/** The latest round as a card on the board shows it. */
export interface CardRoundBrief {
  round: number;
  phase: CardRoundPhase;
  finishedBy: CardFinishedBy | null;
  /** When Claude stopped and is waiting for the person (`hook.stopped`). */
  waitingAt: string | null;
  /** D6: no hook event within `CARD_HOOKS_GRACE_MS` of the start. */
  hooksMissing: boolean;
  /**
   * #348 D1: why hooks are missing; `null` when `hooksMissing` is false. The
   * API always sends both; optional so older fixtures stay valid.
   */
  hooksCause?: CardHooksCause | null;
  /** #348 D1: the round's profile key, when known. */
  hooksProfile?: string | null;
  /**
   * #367 D3: how the round's session reports; `null` before it started. The
   * API always sends both; optional so older fixtures stay valid.
   */
  wiring?: CardRunWiring | null;
  /** #367 D3: with `wiring: 'none'`, why. */
  wiringReason?: CardRunWiringReason | null;
}

/**
 * #282 D1: a `terminal` card's session — "Tracked from a terminal session".
 * While `alive`, Run, Stop and feedback are hidden: the session is the work.
 */
export interface CardTrackingView {
  /** The tracked session (`sessions.id`): the card links to its timeline. */
  sessionId: string;
  /** Not ended and not stale (ADR-0024 D6). */
  alive: boolean;
}

/** #282 D4: a `fleet` card's slot (ADR-0030 §4). */
export interface CardFleetView {
  /** The GitHub issue the slot works; the card's `issueUrl` links it. */
  issue: number;
  /**
   * The slot's name — the Fleet node to link; `null` for a `cs:ready` issue
   * no slot has picked up yet (the card is in To Do).
   */
  slot: string | null;
  /** How far the slot got (`FLEET_STAGES`); `null` before its first checkpoint. */
  stage: FleetStage | null;
  /** The slot left the projection: the card keeps its last column ("Slot gone"). */
  slotGone: boolean;
}

/** One card on the board. */
export interface BoardCardView {
  id: string;
  number: number;
  /** `C-<number>`. */
  label: string;
  title: string;
  kind: BoardCardKind;
  /** #271 D9: `auto` while the model may still set kind ("Auto" badge). */
  kindSource: CardKindSource;
  column: BoardColumn;
  position: number;
  source: BoardCardSource;
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  /**
   * #329 D6: the PR's state as last seen; `null` without a PR, or before
   * anything has read its state.
   */
  prState: CardPrState | null;
  /** #329 D2: how the last `card.collect` went; `none` before the first. */
  collectState: CardCollectState;
  /**
   * #329 D2: the runner's one line when `collectState` is `failed` — the
   * sheet's "No pull request: <error>"; `null` otherwise.
   */
  collectError: string | null;
  /** #359 D5: the checks on the PR's head — the CI dot beside the PR chip. */
  ciState: CardCiState;
  /** #359 D5: the failed checks while `ciState` is `red`; empty otherwise. */
  ciChecks: CardCiCheck[];
  /**
   * #359 D6: `ci_fix` rounds on the current PR, of `CARD_CI_FIX_ATTEMPTS_MAX`
   * — "Fixing CI (2/3)".
   */
  ciFixAttempts: number;
  /**
   * #359 D6: CI still failing after the budget — "CI still failing after 3
   * fixes"; nothing is automated until a person acts.
   */
  needsPerson: boolean;
  /** #359 D8: the latest PR merged (ISO) — the Merged badge; `null` otherwise. */
  mergedAt: string | null;
  /** The latest round; `null` before the first Run. */
  round: CardRoundBrief | null;
  /** #243: the Design chip; `null` when the card has no design (off). */
  design: TaskDesignSummary | null;
  /** #243 D5: approving the design starts round 1. */
  continueAfterDesign: boolean;
  /** Sum over every round's run, a decimal string; `null` when nothing is priced. */
  costUsd: string | null;
  /** #244: why capture suggested the card; `null` for a manual card. */
  captureWhy: string | null;
  /** #244: 0–1; `null` for a manual card. */
  captureConfidence: number | null;
  /**
   * #244: the manual session it was captured from (opens its content
   * timeline); kept after Accept. `null` for a manual card, or once the
   * session is gone.
   */
  sourceSessionId: string | null;
  /** #273 D9: approving the design did not start the worker; `null` otherwise. */
  autoRunFailure: CardAutoRunFailure | null;
  /** #282 D1: set for a `terminal` card, `null` for any other source. */
  tracking: CardTrackingView | null;
  /** #282 D4: set for a `fleet` card, `null` for any other source. */
  fleet: CardFleetView | null;
  /**
   * #282 D3: Automatic work — push and open a pull request when the tracked
   * session finishes. Meaningful for a `terminal` card only; `false` otherwise.
   */
  autoCollect: boolean;
  /** #309: attachments of the card and its rounds — the paperclip on the face when above 0. */
  attachmentCount: number;
  /**
   * #337 D8: the cards this one runs after — "after C-12" on the face.
   * Optional until every route that answers a card fills it; absent reads as
   * none.
   */
  dependsOn?: CardDependencyRef[];
  /**
   * #337 D6, D7: the plan the card came from (a New Card intake or Create
   * cards). Optional like `dependsOn`; absent reads as null.
   */
  planId?: string | null;
  movedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

/** #337 D8: a card another one depends on, as the face and Run's warning name it. */
export interface CardDependencyRef {
  number: number;
  /** `C-<number>`. */
  label: string;
  /** Open while not `completed`. */
  column: BoardColumn;
}

/** #337 D8: one dependency as the card sheet lists it. */
export interface CardDependencyView extends CardDependencyRef {
  title: string;
}

/** `GET /board/cards/:number/dependencies` (#337 D8): number order. */
export interface CardDependenciesView {
  dependsOn: CardDependencyView[];
}

/**
 * `POST /board/cards/:number/dependencies` (#337 D8, operator): the card runs
 * after card `dependsOn` of the same project. Itself, a number that names no
 * card of the project, or a link that closes a cycle is refused —
 * `invalid_dependency` (400) or `dependency_cycle` (409). An existing link is
 * kept as it is. Answers with `CardDependenciesView`; `DELETE
 * …/dependencies/:dependsOn` removes one the same way.
 */
export interface AddCardDependencyRequest {
  dependsOn: number;
}

/** #244 D8: one evidence excerpt of an Inbox card, at most `CAPTURE_EVIDENCE_EXCERPT_MAX` characters. */
export interface CardEvidenceView {
  /** `session_contents.id`, a decimal string. */
  contentId: string;
  kind: 'prompt' | 'response';
  excerpt: string;
}

export interface BoardColumnView {
  column: BoardColumn;
  /** Ascending `position`. Completed holds at most `BOARD_COMPLETED_PAGE_SIZE`, newest first. */
  cards: BoardCardView[];
  /** Completed only: pass the last card's `completedAt` as `?completedBefore=`. */
  hasMore: boolean;
}

/** `GET /board`. */
export interface BoardView {
  projectId: string;
  /**
   * Every column of `BOARD_COLUMNS`, in that order — except `inbox` for a
   * viewer (#244 D8: Inbox cards are content-derived).
   */
  columns: BoardColumnView[];
  /** Active rounds now, against `settings.maxRunning`. */
  running: number;
  settings: BoardSettingsView;
}

/** One round (D4) of a card. */
export interface CardRoundView {
  id: string;
  round: number;
  runId: string;
  trigger: CardRoundTrigger;
  /** The person's text, for a `feedback` round. */
  feedback: string | null;
  author: BoardUserRef | null;
  phase: CardRoundPhase;
  tmuxSession: string | null;
  finishedBy: CardFinishedBy | null;
  /** From `finish_card` (D6). */
  summary: string | null;
  exitCode: number | null;
  error: string | null;
  hooksMissing: boolean;
  /** #348 D1: as on `CardRoundBrief`. */
  hooksCause: CardHooksCause | null;
  hooksProfile: string | null;
  /** #367 D3: as on `CardRoundBrief`. */
  wiring: CardRunWiring | null;
  wiringReason: CardRunWiringReason | null;
  /** This round's run, a decimal string. */
  costUsd: string | null;
  startedAt: string;
  waitingAt: string | null;
  finishedAt: string | null;
  endedAt: string | null;
}

/** #322 D6: one recommended model, with its one-line reason. */
export interface CardModelRecommendation<
  M extends CardRecommendableModel = CardRecommendableModel,
> {
  model: M;
  reason: string;
}

/**
 * #322 D6, D7: a card's recommendations for its work and its design. Each is
 * `null` until an assessment applied — runner offline or too old, no Claude
 * profile, a budget stop, an answer out of contract: the popover shows "No
 * recommendation yet" and launch does not wait.
 */
export interface CardRecommendationView {
  work: CardModelRecommendation | null;
  design: CardModelRecommendation<CardDesignRecommendableModel> | null;
  /** When the last assessment applied (ISO); `null` before the first. */
  assessedAt: string | null;
}

/** `GET /board/cards/:number`. */
export interface BoardCardDetail extends BoardCardView {
  /** Markdown. */
  body: string;
  issueOnRun: boolean;
  specOnRun: boolean;
  /**
   * Overrides the project's model from the next round (D12). #322 D3: the
   * work model the person chose, kept only when it differed from the default.
   */
  model: string | null;
  /**
   * #322 D3: the Claude profile the person chose for the card's work and
   * design, kept only when it differed from the resolver's pick; `null`
   * follows the resolver.
   */
  profileKey: string | null;
  /** #322 D3: the design turns' model override; `null` follows the default. */
  designModel: string | null;
  /** #322 D6: the last applied assessment; its parts are `null` without one (D7). */
  recommendation: CardRecommendationView;
  /** Fixed at the first Run (D5). */
  branch: string | null;
  /** Display only: the runner owns the path. */
  worktree: string | null;
  specPath: string | null;
  /** The card's Claude session (D6); `null` before the first Run. */
  sessionId: string | null;
  createdBy: BoardUserRef | null;
  movedBy: BoardUserRef | null;
  completedBy: BoardUserRef | null;
  createdAt: string;
  /** Oldest first. */
  rounds: CardRoundView[];
  /** #359 D8: every PR the card opened, oldest first; the last is `prUrl`'s. */
  pullRequests: CardPullRequestRef[];
  /**
   * #244 D8: an Inbox card's evidence, operators only (the card sheet).
   * `null` once accepted — Accept strips it — and for a manual card.
   */
  evidence: CardEvidenceView[] | null;
  /**
   * #309: the card's and its rounds' attachments, oldest first. A round's
   * own carry its `roundId`.
   */
  attachments: AttachmentView[];
}

/** #359 D8: one PR of a card, as the card sheet lists it. */
export interface CardPullRequestRef {
  number: number;
  url: string;
  /** Its head branch: the card's, then `<branch>-<k>` for a follow-up. */
  branch: string;
  state: CardPrState;
  /** The round that opened it. */
  round: number;
  createdAt: string;
}

/** `GET /board-settings`; with no row, the defaults and `isDefault: true`. */
export interface BoardSettingsView {
  projectId: string;
  issueOnRun: boolean;
  specOnRun: boolean;
  maxRunning: number;
  /**
   * #244 D10: on only while the project's `shipSessionContent` (on the
   * project view) is on.
   */
  captureEnabled: boolean;
  captureModel: CaptureModel;
  /** #282 D3: the `autoCollect` a new `terminal` card starts with; off by default. */
  autoCollectTracked: boolean;
  /**
   * #359 D7: merge a card's PR when it enters Finished green; `null` follows
   * `autoMergeCardsDefault`.
   */
  autoMergeCards: boolean | null;
  /** #359 D7: `cardAutoMergeDefault` of the project's base — on for develop, off for main. */
  autoMergeCardsDefault: boolean;
  isDefault: boolean;
  updatedAt: string | null;
}

/** `POST /board/cards`: lands at the top of To Do. Absent toggles take the settings. */
export interface CreateBoardCardRequest {
  title: string;
  body?: string;
  kind?: BoardCardKind;
  issueOnRun?: boolean;
  specOnRun?: boolean;
  /**
   * #309 D3: pending uploads to claim, at most `ATTACHMENTS_PER_CARD_MAX`.
   * Each must be pending, in this project and uploaded by the caller, else
   * 422 `attachment_error` `not_claimable`.
   */
  attachmentIds?: string[];
}

/**
 * `PATCH /board/cards/:number`: applies from the next round. `null` clears an
 * override — `model`, `designModel`, `profileKey` — which is what choosing the
 * default option in the card form sends (#322 D3).
 */
export interface UpdateBoardCardRequest {
  title?: string;
  body?: string;
  kind?: BoardCardKind;
  issueOnRun?: boolean;
  specOnRun?: boolean;
  model?: string | null;
  /** #322 D3: the design turns' model override. */
  designModel?: string | null;
  /** #322 D3, D9: a Claude profile of the project's runner. */
  profileKey?: string | null;
  /** #243 D5: refused with `design_approved` once the design is approved. */
  continueAfterDesign?: boolean;
  /** #282 D3: a `terminal` card only; any other card is refused `not_tracked`. */
  autoCollect?: boolean;
}

/** `POST /board/cards/:number/move` (D7). `index` is the drop index in `column`. */
export interface MoveBoardCardRequest {
  column: BoardColumn;
  index: number;
  stopWorker?: boolean;
}

/**
 * `POST /board/cards/:number/run`: round 1, or a retry; `model` overrides for
 * this card (D12). #322 D3: the popover sends `profileKey` and `model`; each is
 * stored on the card only when it differs from what the default would have
 * picked without the card's override.
 */
export interface RunBoardCardRequest {
  model?: string;
  /**
   * #322 D9: a Claude profile of the project's runner (`profileKeySchema`); an
   * unknown or non-Claude key is 422 `no_profile`.
   */
  profileKey?: string;
  permissionMode?: OrchestratorPermissionMode;
  /**
   * #337 D8: run although a dependency is not in Completed. Without it, such
   * a Run is 409 `dependency_open` naming the open ones.
   */
  ignoreDependencies?: boolean;
}

/** `POST /board/cards/:number/feedback` (D9). */
export interface CardFeedbackRequest {
  text: string;
  /** #309 D3: pending uploads claimed onto the card and the new round. */
  attachmentIds?: string[];
}

/** `PUT /board-settings` (project admin). */
export interface UpdateBoardSettingsRequest {
  issueOnRun: boolean;
  specOnRun: boolean;
  maxRunning: number;
  /**
   * #244 D10: `true` while the project's content is off is refused with
   * `capture_needs_content`. Absent keeps the stored value.
   */
  captureEnabled?: boolean;
  /** Absent keeps the stored value. */
  captureModel?: CaptureModel;
  /** #282 D3. Absent keeps the stored value. */
  autoCollectTracked?: boolean;
  /** #359 D7. Absent keeps the stored value; `null` returns to the default. */
  autoMergeCards?: boolean | null;
}

/**
 * `POST /board/cards/:number/accept-suggestion` (#244 D9, operator): the
 * Inbox card moves to the top of To Do, its evidence stripped. The fields
 * edit it on the way (Edit & accept).
 */
export interface AcceptSuggestionRequest {
  title?: string;
  body?: string;
  kind?: BoardCardKind;
}

/** `POST /board/inbox/dismiss-all` (#244, operator). */
export interface DismissAllResult {
  dismissed: number;
}

/** One extraction (`card_captures`), as `GET /board/captures` lists it (operator). */
export interface CardCaptureView {
  id: string;
  /** The manual session it read. */
  sessionId: string;
  status: CaptureStatus;
  skipReason: CaptureSkipReason | null;
  /** Why it failed — `contract_violation: …` included; never content. */
  error: string | null;
  /** Cards it put in the Inbox. */
  suggested: number;
  inputChars: number;
  /** The `card_capture` run; `null` for an extraction skipped before it ran. */
  runId: string | null;
  /** The run's cost, a decimal string; `null` when nothing is priced. */
  costUsd: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** `GET /board/captures?cursor=`: newest first, `CAPTURE_PAGE_SIZE` per page. */
export interface CardCapturePage {
  items: CardCaptureView[];
  /** Pass as `?cursor=` for the next page; `null` on the last. */
  nextCursor: string | null;
}

/** Stable codes in the `error` field of a board route's error body. */
export const BOARD_ERROR = {
  notFound: 'not_found',
  /** 409: a round is active (D7, D9, delete). */
  cardRunning: 'card_running',
  /** 409: `maxRunning` active rounds in the project already (D13). */
  maxRunning: 'max_running',
  /** 409: a hard-stop budget refuses the round (D13). */
  budgetExceeded: 'budget_exceeded',
  /** 409: the move is not allowed (`boardMoveRule`), with `reason`. */
  moveRefused: 'move_refused',
  /** 409: stop or Mark finished with no active round. */
  notRunning: 'not_running',
  /** 409: feedback outside Finished, or Accept of a card not in Finished. */
  wrongColumn: 'wrong_column',
  /** 422: `specOnRun` and the project has no `specDir` (D2). */
  noSpecDir: 'no_spec_dir',
  /**
   * 422: the runner refused a non-Claude profile. Profile selection itself
   * answers `no_profile` (#272 D2).
   */
  unsupportedRuntime: 'unsupported_runtime',
  /** 503: the runner is offline or does not serve `card.*`. */
  commandUnavailable: 'command_unavailable',
  /** 409 (#243 D6): Run on a card whose design is needed and not approved. */
  designNotApproved: 'design_not_approved',
  /** 409 (#243 D5): `continueAfterDesign` changed after the design was approved. */
  designApproved: 'design_approved',
  /** 409 (#244 D9): a move into or out of Inbox other than Inbox → To Do. */
  invalidMove: 'invalid_move',
  /** 422 (#244 D10): `captureEnabled: true` while the project ships no session content. */
  captureNeedsContent: 'capture_needs_content',
  /** 422 (#272 D2): no usable runtime profile; `reason`, `source`, `profileKey`. */
  noProfile: 'no_profile',
  /** 409 (#273 D13): the runner refused the merge, with `reason` (`CardMergeFailReason`). */
  mergeFailed: 'merge_failed',
  /** 409 / 404 (#273 D13): the card has no pull request. */
  noPullRequest: 'no_pull_request',
  /** 422 (#282 D3): `autoCollect` on a card that is not a `terminal` card. */
  notTracked: 'not_tracked',
  /** 422 (#309): an attachment refused on create, feedback or claim, with `code`. */
  attachmentError: 'attachment_error',
  /** 409 (#309): attachments of a card in Completed do not change. */
  cardCompleted: 'card_completed',
  /** 502 (#309 D9): the runner could not download or verify an attachment for `card.run`. */
  attachmentsUnavailable: 'attachments_unavailable',
  /** 409 (#329 D5): Create pull request on a card with no `branch` — it never ran. */
  noBranch: 'no_branch',
  /**
   * 409 (#329 D8): the runner refused to close the PR, with `reason`
   * (`CardPrCloseFailReason`); the card stays in Finished.
   */
  prCloseFailed: 'pr_close_failed',
  /** 422 (#329 D7/D8): `deleteBranch: true` on a `terminal` card. */
  branchDeleteRefused: 'branch_delete_refused',
  /**
   * 409 (#337 D8): Run on a card with a dependency not in Completed, without
   * `ignoreDependencies`; `dependencies` names the open ones.
   */
  dependencyOpen: 'dependency_open',
  /** 409 (#337 D8): the dependency would close a cycle. */
  dependencyCycle: 'dependency_cycle',
  /** 400 (#337 D8): the card itself, or a number that is no card of this project. */
  invalidDependency: 'invalid_dependency',
} as const;
export type BoardErrorCode = (typeof BOARD_ERROR)[keyof typeof BOARD_ERROR];

export interface BoardErrorBody {
  statusCode: number;
  error: BoardErrorCode;
  message: string;
  /**
   * `move_refused`: the `BoardMoveRefusal`; `no_profile`: the
   * `NoProfileReason`; `merge_failed`: the `CardMergeFailReason`;
   * `pr_close_failed`: the `CardPrCloseFailReason`.
   */
  reason?: string;
  /** `no_profile`: the setting that named the profile (#272 D2). */
  source?: ProfileSource | null;
  /** `no_profile`: the unusable profile's key. */
  profileKey?: string;
  /** `attachment_error`: why the attachment was refused (#309). */
  code?: AttachmentRefusal;
  /** `dependency_open` (#337 D8): the open dependencies — "C-12 is not completed yet". */
  dependencies?: CardDependencyRef[];
}

/** #273 D9: why approving the design did not start round 1. */
export interface CardAutoRunFailure {
  /** The refusal's `BoardErrorCode`, or `unknown` for any other exception. */
  code: BoardErrorCode | 'unknown';
  /** At most 500 characters. */
  message: string;
  at: string;
}

const BOARD_ERROR_CODES: ReadonlySet<string> = new Set(
  Object.values(BOARD_ERROR),
);

/** #273 D9: a stored `board_cards.autoRunError` that is a code this build knows. */
export const isCardAutoRunCode = (
  value: string,
): value is CardAutoRunFailure['code'] =>
  value === 'unknown' || BOARD_ERROR_CODES.has(value);

/** #273 D8: what Continue after design did when the design was approved. */
export type CardAutoRun =
  | { status: 'started'; round: number }
  | {
      status: 'run_failed';
      code: CardAutoRunFailure['code'];
      message: string;
    };

/**
 * `POST /board/cards/:number/design/approve` (#273 D8): never fails because
 * the worker could not start. `run` is `null` when Continue after design is off.
 */
export type CardDesignApproveResponse = TaskDesignView & {
  run: CardAutoRun | null;
};

/**
 * `GET /board/cards/:number/pull-request` (#273 D10, operator): the card's
 * PR as `pr.inspect` reads it, and how Accept would merge it.
 */
export interface CardPullRequestView {
  number: number;
  url: string;
  state: PrInspectState;
  /** What `AcceptBoardCardRequest.merge.headSha` binds to. */
  headSha: string;
  mergeable: string;
  mergeStateStatus: string;
  checks: PrChecks;
  /** The project's `orchestrator.mergeMethod`; `null` is the repository default (D12). */
  method: CardMergeMethod | null;
  /** The PR is open and the runner serves `card.merge`. */
  canMerge: boolean;
}

/**
 * `POST /board/cards/:number/accept` (#273 D13). Neither `merge` nor
 * `closePr`: move only, the PR left open (D14, #329 D8). `merge` and
 * `closePr` together are refused with 400.
 */
export interface AcceptBoardCardRequest {
  merge?: {
    /** The head the person saw in the dialog, 40 lower-case hex. */
    headSha: string;
    /**
     * #329 D7: delete the PR's head branch on GitHub after the merge. Absent
     * is `false`. `true` on a `terminal` card is refused with 422
     * `branch_delete_refused`: its branch is the person's session branch.
     */
    deleteBranch?: boolean;
  };
  /**
   * #329 D8: Accept without merging, and close the card's PR through
   * `card.prClose`. The card moves to Completed only when the command
   * succeeds.
   */
  closePr?: {
    /** Delete the PR's head branch on GitHub after closing it; `terminal`: 422 as above. */
    deleteBranch: boolean;
    /** Close the linked issue as `not planned`; off in the dialog by default. */
    closeIssue: boolean;
  };
}

/** #273 D13: how the merge on Accept went. */
export interface CardMergeOutcome {
  merged: true;
  /** The PR was merged before Accept; nothing was merged now. */
  alreadyMerged: boolean;
  method: CardMergeMethod;
  mergeCommit: string | null;
  issueClosed: boolean;
  /** Why closing the issue failed; the card is accepted anyway. */
  issueError?: string;
  /** #329 D7: the head branch was deleted on GitHub; `false` when not asked or it failed. */
  branchDeleted: boolean;
  /** #329 D7: why deleting the branch failed; the merge stands. */
  branchError?: string;
}

/** #329 D8: how closing the PR on Accept went. */
export interface CardPrCloseOutcome {
  closed: true;
  /** The PR was closed before Accept; nothing was closed now. */
  alreadyClosed: boolean;
  /** The head branch was deleted on GitHub; `false` when not asked or it failed. */
  branchDeleted: boolean;
  /** Why deleting the branch failed; the card is accepted anyway. */
  branchError?: string;
  /** The issue was closed as `not planned`; `false` when not asked or it failed. */
  issueClosed: boolean;
  /** Why closing the issue failed; the card is accepted anyway. */
  issueError?: string;
}

/**
 * `merge` is `null` for an Accept without merging; `prClose` (#329 D8) is
 * `null` unless the Accept closed the PR.
 */
export type AcceptBoardCardResponse = BoardCardDetail & {
  merge: CardMergeOutcome | null;
  prClose: CardPrCloseOutcome | null;
};

/**
 * #329 D5: what a manual collect did. `failed` is an answer, not an error
 * status: the card stores it and shows "No pull request: <error>".
 */
export interface CardCollectOutcome {
  state: Extract<CardCollectState, 'ok' | 'no_changes' | 'failed'>;
  /** The runner's one line for `failed`; `null` otherwise. */
  error: string | null;
  /** Commits ahead of the base; `null` when the collect failed. */
  ahead: number | null;
  /** The open PR, new or existing; `null` for `no_changes` and `failed`. */
  prNumber: number | null;
  prUrl: string | null;
}

/**
 * `POST /board/cards/:number/collect` (#329 D5, operator): Create pull
 * request. Runs `card.collect` now, resets the automatic attempts, and
 * answers with the stored card and the outcome. Offered for a card in
 * Finished or Completed with a `branch`, no `prUrl`, and a `collectState`
 * other than `no_changes`; otherwise 409 `wrong_column` / `no_branch`.
 */
export type CollectBoardCardResponse = BoardCardDetail & {
  collect: CardCollectOutcome;
};

/**
 * #282 D4: a person changed a `fleet` card's text. The edit is stored like
 * any card's; the GitHub issue is not rewritten.
 */
export interface FleetCardEdit {
  projectId: string;
  cardId: string;
  number: number;
  /** `C-<number>`. */
  label: string;
  /** What changed, as `cardChange` reports it — never `null` here. */
  change: CardChange;
  /** #282: who edited; slot.message needs the sender. */
  editor: { userId: string; email: string };
}

/**
 * #282 D4: the one seam between the board and the fleet. `BoardService.update`
 * calls it, when provided, after storing an edit of a `fleet` card; the fleet
 * module implements it by sending the running slot one `slot.message`
 * worded by `cardNextRoundPrompt({ label, change, feedback: null })`. A slot
 * that is not running is not messaged. It must not throw for an offline
 * runner: the edit is stored either way.
 */
export interface FleetCardEdits {
  cardEdited(edit: FleetCardEdit): Promise<void>;
}

/** Live: on `project:<id>` whenever a card, its round or its design changes. */
export const BOARD_CHANGED_EVENT = 'board.changed';
export interface BoardChangedData {
  cardId: string;
}

/**
 * Server events (ADR-0014) the notifications come from (D15). They name the
 * project, the card and the PR — never prompt or summary text.
 */
export const CARD_FINISHED_EVENT = 'card.finished';
export const CARD_WAITING_EVENT = 'card.waiting';

export interface CardFinishedEventData {
  cardId: string;
  number: number;
  title: string;
  round: number;
  finishedBy: CardFinishedBy;
  prNumber: number | null;
  prUrl: string | null;
}

export interface CardWaitingEventData {
  cardId: string;
  number: number;
  title: string;
  round: number;
}

/**
 * #244 D11: an extraction put cards in the Inbox. Folds per spec 22 D6. It
 * carries counts and ids only — never a title, which is content-derived.
 */
export const CARDS_SUGGESTED_EVENT = 'cards.suggested';

export interface CardsSuggestedEventData {
  captureId: string;
  sessionId: string;
  count: number;
  cardIds: string[];
}
