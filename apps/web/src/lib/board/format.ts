import {
  BOARD_COLUMNS,
  BOARD_ERROR,
  BOARD_MAX_RUNNING_MAX,
  BOARD_MAX_RUNNING_MIN,
  type BoardCardView,
  type BoardColumn,
  type BoardMoveRefusal,
  type BoardView,
  type CardRoundBrief,
  type CardRoundPhase,
  isActiveRoundPhase,
} from '@agentdock/shared';
import type { Status } from '@andrewbehma/glass-ui/status-pill';
import { ApiError, describeError } from '../api';

export const COLUMN_TITLE: Record<BoardColumn, string> = {
  todo: 'To Do',
  in_progress: 'In progress',
  finished: 'Finished',
  completed: 'Completed',
};

export const COLUMN_HINT: Record<BoardColumn, string> = {
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

/** Every column in `BOARD_COLUMNS` order, even if the API left one out. */
export const columnsOf = (view: BoardView) =>
  BOARD_COLUMNS.map(
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
};

export const canRun = (card: BoardCardView): boolean =>
  (card.column === 'todo' || card.column === 'finished') &&
  !isRoundActive(card.round);

export const canGiveFeedback = (card: BoardCardView): boolean =>
  card.column === 'finished' && !isRoundActive(card.round);

export const canAccept = (card: BoardCardView): boolean =>
  card.column === 'finished' && !isRoundActive(card.round);

/** A retry after a failed, ended or stopped round resumes the same session. */
export const canRetry = (card: BoardCardView): boolean =>
  card.column === 'in_progress' &&
  card.round !== null &&
  !isRoundActive(card.round);

export const canStop = (card: BoardCardView): boolean =>
  isRoundActive(card.round);

export const canMarkFinished = (card: BoardCardView): boolean =>
  card.column === 'in_progress' && isRoundActive(card.round);

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? error.code : undefined;

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

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
      return 'Card workers run on Claude profiles only; this project’s profile is Codex.';
    case BOARD_ERROR.commandUnavailable:
      return `The runner${runnerName ? ` ${runnerName}` : ''} is offline or too old to run card workers.`;
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

/** D6: shown when no hook event arrived after the start. */
export const hooksHint =
  'The agentdock plugin is not installed in this project, so the card only moves when the session ends or you mark it finished.';
