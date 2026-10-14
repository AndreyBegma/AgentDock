import type { OrchestratorPermissionMode } from '../protocol';
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
  /** Sum over every round's run, a decimal string; `null` when nothing is priced. */
  costUsd: string | null;
  movedAt: string;
  completedAt: string | null;
  updatedAt: string;
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
  /** Every column of `BOARD_COLUMNS`, in that order. */
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
}

/** `GET /board-settings`; with no row, the defaults and `isDefault: true`. */
export interface BoardSettingsView {
  projectId: string;
  issueOnRun: boolean;
  specOnRun: boolean;
  maxRunning: number;
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
  /** 422: the profile is Codex (D12). */
  unsupportedRuntime: 'unsupported_runtime',
  /** 503: the runner is offline or does not serve `card.*`. */
  commandUnavailable: 'command_unavailable',
} as const;
export type BoardErrorCode = (typeof BOARD_ERROR)[keyof typeof BOARD_ERROR];

export interface BoardErrorBody {
  statusCode: number;
  error: BoardErrorCode;
  message: string;
  /** `move_refused`: the `BoardMoveRefusal`. */
  reason?: string;
}

/** Live: on `project:<id>` whenever a card or its round changes. */
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
