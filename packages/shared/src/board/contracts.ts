import type { TaskDesignSummary } from '../design';
import type { OrchestratorPermissionMode } from '../protocol';
import type { ProfileSource } from '../readiness';
import type {
  CaptureModel,
  CaptureSkipReason,
  CaptureStatus,
} from './capture-limits';
import type {
  BoardCardKind,
  BoardCardSource,
  BoardColumn,
  CardFinishedBy,
  CardRoundPhase,
  CardRoundTrigger,
} from './types';

/**
 * HTTP contracts of the Board (issue #242 "API"). Every route is under
 * `/projects/:projectId`, behind the project guard; a card is addressed by
 * its per-project `number`.
 */

export interface BoardUserRef {
  id: string;
  email: string;
}

/** The latest round as a card on the board shows it. */
export interface CardRoundBrief {
  round: number;
  phase: CardRoundPhase;
  finishedBy: CardFinishedBy | null;
  /** When Claude stopped and is waiting for the person (`hook.stopped`). */
  waitingAt: string | null;
  /** D6: no hook event within `CARD_HOOKS_GRACE_MS` of the start. */
  hooksMissing: boolean;
}

/** One card on the board. */
export interface BoardCardView {
  id: string;
  number: number;
  /** `C-<number>`. */
  label: string;
  title: string;
  kind: BoardCardKind;
  column: BoardColumn;
  position: number;
  source: BoardCardSource;
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
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
  movedAt: string;
  completedAt: string | null;
  updatedAt: string;
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
  /** This round's run, a decimal string. */
  costUsd: string | null;
  startedAt: string;
  waitingAt: string | null;
  finishedAt: string | null;
  endedAt: string | null;
}

/** `GET /board/cards/:number`. */
export interface BoardCardDetail extends BoardCardView {
  /** Markdown. */
  body: string;
  issueOnRun: boolean;
  specOnRun: boolean;
  /** Overrides the project's model from the next round (D12). */
  model: string | null;
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
  /**
   * #244 D8: an Inbox card's evidence, operators only (the card sheet).
   * `null` once accepted — Accept strips it — and for a manual card.
   */
  evidence: CardEvidenceView[] | null;
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
}

/** `PATCH /board/cards/:number`: applies from the next round. `model: null` clears it. */
export interface UpdateBoardCardRequest {
  title?: string;
  body?: string;
  kind?: BoardCardKind;
  issueOnRun?: boolean;
  specOnRun?: boolean;
  model?: string | null;
  /** #243 D5: refused with `design_approved` once the design is approved. */
  continueAfterDesign?: boolean;
}

/** `POST /board/cards/:number/move` (D7). `index` is the drop index in `column`. */
export interface MoveBoardCardRequest {
  column: BoardColumn;
  index: number;
  stopWorker?: boolean;
}

/** `POST /board/cards/:number/run`: round 1, or a retry; `model` overrides for this card (D12). */
export interface RunBoardCardRequest {
  model?: string;
  permissionMode?: OrchestratorPermissionMode;
}

/** `POST /board/cards/:number/feedback` (D9). */
export interface CardFeedbackRequest {
  text: string;
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
} as const;
export type BoardErrorCode = (typeof BOARD_ERROR)[keyof typeof BOARD_ERROR];

export interface BoardErrorBody {
  statusCode: number;
  error: BoardErrorCode;
  message: string;
  /** `move_refused`: the `BoardMoveRefusal`; `no_profile`: the `NoProfileReason`. */
  reason?: string;
  /** `no_profile`: the setting that named the profile (#272 D2). */
  source?: ProfileSource | null;
  /** `no_profile`: the unusable profile's key. */
  profileKey?: string;
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
