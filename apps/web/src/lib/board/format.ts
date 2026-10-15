import {
  BOARD_COLUMNS,
  BOARD_ERROR,
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardCardView,
  type BoardColumn,
  type BoardMoveRefusal,
  type BoardView,
  type CaptureModel,
  type CaptureSkipReason,
  type CaptureStatus,
  type CardCaptureView,
  type CardRoundBrief,
  type CardRoundPhase,
  isActiveRoundPhase,
} from '@agentdock/shared';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import { ApiError, describeError } from '../api';
import { describeNoProfile } from '../readiness/copy';
import {
  PROFILES_LIST_COMMAND,
  SETUP_CLAUDE_COMMAND,
} from '../runners/install';

export const COLUMN_TITLE: Record<BoardColumn, string> = {
  inbox: 'Inbox',
  todo: 'To Do',
  in_progress: 'In progress',
  finished: 'Finished',
  completed: 'Completed',
};

export const COLUMN_HINT: Record<BoardColumn, string> = {
  inbox: 'Suggested from your sessions. Accept or dismiss.',
  todo: 'Waiting for a worker.',
  in_progress: 'A worker is on it.',
  finished: 'Review it, send it back or accept it.',
  completed: 'Accepted.',
};

export interface RoundPill {
  status: Status;
  label: string;
}

const PHASE_PILL: Record<CardRoundPhase, RoundPill> = {
  queued: { status: 'running', label: 'Queued' },
  starting: { status: 'running', label: 'Starting' },
  running: { status: 'running', label: 'Running' },
  waiting: { status: 'waiting', label: 'Waiting for you' },
  finished: { status: 'done', label: 'Finished' },
  ended: { status: 'blocked', label: 'Ended' },
  failed: { status: 'error', label: 'Failed' },
  cancelled: { status: 'idle', label: 'Stopped' },
};

export const phaseLabel = (phase: CardRoundPhase): string =>
  PHASE_PILL[phase].label;

/**
 * The pill a card wears for its latest round; none before the first Run. A
 * finished round is not shown on the board: the column already says it.
 */
export function roundPill(round: CardRoundBrief | null): RoundPill | null {
  if (!round || round.phase === 'finished') return null;
  return PHASE_PILL[round.phase];
}

export const isRoundActive = (round: CardRoundBrief | null): boolean =>
  isActiveRoundPhase(round?.phase);

/** One card as glass-ui's `Board` takes it: `label` is the accessible name. */
export interface BoardItem {
  id: string;
  label: string;
  card: BoardCardView;
}

export const toItem = (card: BoardCardView): BoardItem => ({
  id: card.id,
  label: `${card.label} ${card.title}`,
  card,
});

export const findCard = (
  view: BoardView,
  cardId: string,
): BoardCardView | undefined => {
  for (const column of view.columns) {
    const hit = column.cards.find((card) => card.id === cardId);
    if (hit) return hit;
  }
  return undefined;
};

export const cardByNumber = (
  view: BoardView,
  number: number,
): BoardCardView | undefined => {
  for (const column of view.columns) {
    const hit = column.cards.find((card) => card.number === number);
    if (hit) return hit;
  }
  return undefined;
};

/** The wire name of the `?card=` parameter. */
export const parseCardParam = (raw: string | null): number | undefined => {
  if (raw === null || !/^\d{1,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
};

/**
 * Every column in `BOARD_COLUMNS` order, even if the API left one out — except
 * Inbox, which the API leaves out on purpose for a viewer (#244 D8).
 */
export const columnsOf = (view: BoardView) =>
  BOARD_COLUMNS.filter(
    (column) =>
      column !== 'inbox' || view.columns.some((c) => c.column === column),
  ).map(
    (column) =>
      view.columns.find((c) => c.column === column) ?? {
        column,
        cards: [],
        hasMore: false,
      },
  );

export const MOVE_REFUSAL_TEXT: Record<BoardMoveRefusal, string> = {
  card_running:
    'A worker is running on this card. Stop it first, or mark the card finished.',
  automatic_to_completed: 'Only a person completes a card.',
  card_completed: 'This card is already completed.',
  invalid_move: 'A suggestion leaves the Inbox only by Accept, into To Do.',
};

/** #273 D7: the card's design is on and not approved, so the server would refuse Run. */
export const designBlocksRun = (card: BoardCardView): boolean =>
  card.design?.needed === true && card.design.status !== 'approved';

export const canRun = (card: BoardCardView): boolean =>
  (card.column === 'todo' || card.column === 'finished') &&
  !isRoundActive(card.round) &&
  !designBlocksRun(card);

export const canGiveFeedback = (card: BoardCardView): boolean =>
  card.column === 'finished' && !isRoundActive(card.round);

export const canAccept = (card: BoardCardView): boolean =>
  card.column === 'finished' && !isRoundActive(card.round);

/** A retry after a failed, ended or stopped round resumes the same session. */
export const canRetry = (card: BoardCardView): boolean =>
  card.column === 'in_progress' &&
  card.round !== null &&
  !isRoundActive(card.round) &&
  !designBlocksRun(card);

/** #273 D7: **Approve & run** takes Run's place while the design blocks it. */
export interface ApproveRunOffer {
  enabled: boolean;
  /** Why it is disabled; `null` when enabled. */
  reason: string | null;
}

/**
 * Where Run would be, the card's design is not approved: the offer is a link
 * to the viewer, enabled only once there is a design to approve (`reviewing`).
 */
export function approveRunOffer(card: BoardCardView): ApproveRunOffer | null {
  if (!designBlocksRun(card)) return null;
  const startable =
    (card.column === 'todo' ||
      card.column === 'finished' ||
      (card.column === 'in_progress' && card.round !== null)) &&
    !isRoundActive(card.round);
  if (!startable) return null;
  return card.design?.status === 'reviewing'
    ? { enabled: true, reason: null }
    : { enabled: false, reason: 'The design is being drawn' };
}

export const canStop = (card: BoardCardView): boolean =>
  isRoundActive(card.round);

export const canMarkFinished = (card: BoardCardView): boolean =>
  card.column === 'in_progress' && isRoundActive(card.round);

/** #244 D9: an Inbox card is accepted or dismissed, never run. */
export const isSuggestion = (card: BoardCardView): boolean =>
  card.column === 'inbox';

/** The confidence as a whole percent: `0.74` → `74%`; none for a manual card. */
export const confidenceLabel = (confidence: number | null): string | null =>
  confidence === null || !Number.isFinite(confidence)
    ? null
    : `${Math.round(Math.min(Math.max(confidence, 0), 1) * 100)}%`;

/** The source session's page (its content timeline); none once the session is gone. */
export const sessionHref = (sessionId: string | null): string | null =>
  sessionId === null ? null : `/sessions/${encodeURIComponent(sessionId)}`;

export const CAPTURE_STATUS_PILL: Record<CaptureStatus, RoundPill> = {
  queued: { status: 'idle', label: 'Queued' },
  running: { status: 'running', label: 'Running' },
  succeeded: { status: 'done', label: 'Done' },
  failed: { status: 'error', label: 'Failed' },
  skipped: { status: 'blocked', label: 'Skipped' },
};

export const CAPTURE_SKIP_TEXT: Record<CaptureSkipReason, string> = {
  too_little: 'Too little new content',
  rate_limited: 'Rate limit reached',
  inbox_full: 'Inbox is full',
  budget_exceeded: 'Budget hard stop',
  runner_offline: 'Runner was offline',
  capture_off: 'Capture was turned off',
  no_profile: 'No runtime profile',
};

/** What a capture row says about its outcome: the skip reason, the error, or the count. */
export function captureOutcome(capture: CardCaptureView): string {
  if (capture.status === 'skipped' && capture.skipReason) {
    return CAPTURE_SKIP_TEXT[capture.skipReason];
  }
  if (capture.status === 'failed') return capture.error ?? 'Failed';
  if (capture.status === 'succeeded') {
    return capture.suggested === 1
      ? '1 card suggested'
      : `${capture.suggested} cards suggested`;
  }
  return '';
}

export const CAPTURE_MODEL_LABEL: Record<CaptureModel, string> = {
  haiku: 'Haiku (fast, cheap)',
  sonnet: 'Sonnet (better judgement, dearer)',
};

/** Shown beside the Capture toggle: content goes to a model on the runner. */
export const CAPTURE_WARNING =
  'While capture is on, the prompts and final responses of your manual Claude Code sessions are sent to a small model on this project’s runner, which proposes cards. Tool inputs and outputs are never used. Suggestions are visible to operators only; accepting one drops the evidence and keeps the link to its session.';

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? error.code : undefined;

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

/** #273 D13: a refused merge, by `reason`; `message` is the runner's one line. */
export function describeMergeFailure(
  reason: unknown,
  message?: unknown,
): string {
  switch (reason) {
    case 'head_changed':
      return 'The branch changed since you opened this — review it again.';
    case 'not_mergeable':
      return 'GitHub refuses the merge: checks or branch protection.';
    case 'closed':
      return 'The pull request is closed.';
    default:
      return typeof message === 'string' && message !== ''
        ? `gh failed: ${message}`
        : 'gh failed to merge the pull request.';
  }
}

/**
 * #273 D9: why approving the design did not start the worker. The codes that
 * need no detail read like the same refusal on Run; any other falls back to
 * the server's message.
 */
export function autoRunReason(
  failure: NonNullable<BoardCardView['autoRunFailure']>,
): string {
  switch (failure.code) {
    case BOARD_ERROR.maxRunning:
    case BOARD_ERROR.budgetExceeded:
    case BOARD_ERROR.noSpecDir:
    case BOARD_ERROR.unsupportedRuntime:
    case BOARD_ERROR.cardRunning:
    case BOARD_ERROR.commandUnavailable:
      // `ApiError.code` is typed for auth codes; a board code travels in it too.
      return describeBoardError(
        new ApiError(
          409,
          failure.code as ApiError['code'],
          failure.message,
          undefined,
          null,
        ),
      ).replace(/\.$/, '');
    default:
      return failure.message.replace(/\.$/, '');
  }
}

/** Every board error as a sentence for the person; the server's text last. */
export function describeBoardError(
  error: unknown,
  runnerName?: string | null,
): string {
  switch (errorCode(error)) {
    case BOARD_ERROR.cardRunning:
      return 'A worker is running on this card. Stop it or mark it finished first.';
    case BOARD_ERROR.maxRunning:
      return 'This project already runs its limit of workers. Wait for one to finish, or raise the limit in the project settings.';
    case BOARD_ERROR.budgetExceeded:
      return 'A budget with a hard stop refuses another round.';
    case BOARD_ERROR.moveRefused: {
      const reason = error instanceof ApiError ? error.body?.reason : undefined;
      return typeof reason === 'string' && reason in MOVE_REFUSAL_TEXT
        ? MOVE_REFUSAL_TEXT[reason as BoardMoveRefusal]
        : 'That move is not allowed.';
    }
    case BOARD_ERROR.notRunning:
      return 'No worker is running on this card any more.';
    case BOARD_ERROR.wrongColumn:
      return 'The card is not in the column this needs. Refresh the board.';
    case BOARD_ERROR.noSpecDir:
      return 'This project has no spec directory, so a spec cannot be written. Turn the spec off, or set the docs source in the project settings.';
    case BOARD_ERROR.unsupportedRuntime:
      return 'The runner refused: card workers run on Claude profiles only.';
    case BOARD_ERROR.noProfile:
      return describeNoProfile(error);
    case BOARD_ERROR.designNotApproved:
      return 'This card’s design is on and not approved yet. Open the design and approve it, or approve and run from there.';
    case BOARD_ERROR.designApproved:
      return 'The design is approved, so “Continue after design” can no longer change.';
    case BOARD_ERROR.commandUnavailable:
      return `The runner${runnerName ? ` ${runnerName}` : ''} is offline or too old to run card workers.`;
    case BOARD_ERROR.invalidMove:
      return MOVE_REFUSAL_TEXT.invalid_move;
    case BOARD_ERROR.captureNeedsContent:
      return 'Capture reads session content. Turn on “Keep session content” in the Sessions tab first.';
    case BOARD_ERROR.mergeFailed: {
      const body = error instanceof ApiError ? error.body : null;
      return describeMergeFailure(body?.reason, body?.message);
    }
    case BOARD_ERROR.noPullRequest:
      return 'This card has no pull request to merge.';
    default:
      break;
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'That card or project no longer exists, or you are not a member of it.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'Only operators can do this.';
  }
  return describeError(error);
}

/** The settings field: a whole number in the allowed range, else `null`. */
export function parseMaxRunning(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= BOARD_MAX_RUNNING_MIN && n <= BOARD_MAX_RUNNING_MAX ? n : null;
}

/**
 * #281 D6: shown when no hook event arrived after the start. Names the cause,
 * the profile key and the command; the card does not know its profile, so the
 * key is the one `agentdock-runner profiles` lists.
 */
export const hooksHint = `No hook events from this card's session: the agentdock plugin is not set up for its runtime profile, so the card moves only when the session ends or you mark it finished. Find the profile key with \`${PROFILES_LIST_COMMAND}\` (first column, or Admin → Runners → Profile key), then run \`${SETUP_CLAUDE_COMMAND}\` and restart the session.`;

/** The link text after the hint. */
export const HOOKS_GUIDE_LABEL = 'How to set it up';

/** #281 D6: the Settings › Sessions checklist of the card's project. */
export const hooksGuideHref = (projectId: string): string =>
  `/projects/${projectId}/settings?tab=sessions`;
