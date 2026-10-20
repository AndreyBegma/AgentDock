import {
  BOARD_COLUMNS,
  type BoardCardView,
  type BoardColumn,
  type BoardMoveRefusal,
  type BoardView,
  boardMoveRule,
  isBoardColumn,
  type MoveBoardCardRequest,
} from '@nautelle/shared';
import { findCard, MOVE_REFUSAL_TEXT } from './format';
import { isPlanTaskItemId } from './plan-tasks';

/** What glass-ui's `Board` reports for a drop (or a menu command). */
export interface DropMove {
  id: string;
  fromColumnId: string;
  toColumnId: string;
  index: number;
}

/**
 * What the page does with a drop (D7). `boardMoveRule` is the same function
 * the API enforces; this pre-check only saves a round trip, the server stays
 * the authority.
 */
export type DropDecision =
  /** Nothing to do: an unknown card or column, or no change. */
  | { kind: 'ignore' }
  /** Decline in `onMove`: the board is controlled, so nothing moved. */
  | { kind: 'refused'; error: BoardMoveRefusal; text: string }
  /** A round is active and the card leaves In progress: ask to stop the worker. */
  | { kind: 'confirm-stop'; card: BoardCardView; move: DropMove }
  /** To Do or Finished onto In progress: Run / Just move / Cancel. */
  | { kind: 'offer-run'; card: BoardCardView; move: DropMove }
  | { kind: 'move'; card: BoardCardView; move: DropMove };

export function decideDrop(
  view: BoardView,
  move: DropMove,
  options: { stopWorker?: boolean; skipRunOffer?: boolean } = {},
): DropDecision {
  if (
    isPlanTaskItemId(move.id) &&
    isBoardColumn(move.fromColumnId) &&
    isBoardColumn(move.toColumnId)
  ) {
    // D5: a plan task is on the board read-only; the rule refuses every move.
    const refusal = boardMoveRule({
      item: 'plan_task',
      from: move.fromColumnId,
      to: move.toColumnId,
      roundPhase: null,
      source: 'person',
    });
    return refusal.allowed
      ? { kind: 'ignore' }
      : {
          kind: 'refused',
          error: refusal.error,
          text: MOVE_REFUSAL_TEXT[refusal.error],
        };
  }
  const card = findCard(view, move.id);
  return card ? decideCardMove(card, move, options) : { kind: 'ignore' };
}

/** `decideDrop` for a card already in hand — the card page has no board view. */
export function decideCardMove(
  card: BoardCardView,
  move: DropMove,
  options: { stopWorker?: boolean; skipRunOffer?: boolean } = {},
): DropDecision {
  if (!isBoardColumn(move.fromColumnId) || !isBoardColumn(move.toColumnId)) {
    return { kind: 'ignore' };
  }
  const decision = boardMoveRule({
    from: move.fromColumnId,
    to: move.toColumnId,
    roundPhase: card.round?.phase ?? null,
    source: 'person',
    stopWorker: options.stopWorker,
    cardSource: card.source,
    autoCollect: card.autoCollect,
    trackingAlive: card.tracking?.alive === true,
  });
  if (!decision.allowed) {
    if (decision.error === 'card_running') {
      return { kind: 'confirm-stop', card, move };
    }
    return {
      kind: 'refused',
      error: decision.error,
      text: MOVE_REFUSAL_TEXT[decision.error],
    };
  }
  if (decision.offerRun && !options.skipRunOffer) {
    return { kind: 'offer-run', card, move };
  }
  return { kind: 'move', card, move };
}

/** The index of "last in the column"; the API clamps it, as the menu's own move does. */
export const MOVE_TO_END = 1_000_000;

/**
 * The columns the card's Move picker offers: every other column the board
 * rule does not refuse. Leaving In progress is offered — it asks to stop the
 * worker, as a drag does.
 */
export function moveTargets(card: BoardCardView): BoardColumn[] {
  return BOARD_COLUMNS.filter((to) => {
    if (to === card.column) return false;
    const { kind } = decideCardMove(card, {
      id: card.id,
      fromColumnId: card.column,
      toColumnId: to,
      index: MOVE_TO_END,
    });
    return kind !== 'ignore' && kind !== 'refused';
  });
}

/**
 * D4: plan tasks sit after the cards of a column and cannot be reordered, so
 * a drop index counted among everything on the board is clamped to the
 * column's cards (the moved card excluded).
 */
export function clampDropIndex(view: BoardView, move: DropMove): DropMove {
  if (!isBoardColumn(move.toColumnId)) return move;
  const target = view.columns.find((c) => c.column === move.toColumnId);
  const cards = (target?.cards ?? []).filter((c) => c.id !== move.id).length;
  return move.index <= cards ? move : { ...move, index: cards };
}

/** The body of `POST /board/cards/:number/move`. */
export function moveRequest(
  move: DropMove,
  stopWorker = false,
): MoveBoardCardRequest {
  return {
    column: move.toColumnId as BoardColumn,
    index: move.index,
    ...(stopWorker ? { stopWorker: true } : {}),
  };
}

/**
 * The board as it looks once the server accepts `move`: remove-then-insert,
 * `index` counted among the destination's other cards. Applied before the
 * answer arrives; a refusal drops it and the page reloads (rollback).
 */
export function applyDrop(view: BoardView, move: DropMove): BoardView {
  const card = findCard(view, move.id);
  if (!card || !isBoardColumn(move.toColumnId)) return view;
  const to = move.toColumnId;
  const moved: BoardCardView = { ...card, column: to };
  return {
    ...view,
    columns: view.columns.map((column) => {
      const rest = column.cards.filter((c) => c.id !== move.id);
      if (column.column !== to) return { ...column, cards: rest };
      const at = Math.min(Math.max(move.index, 0), rest.length);
      return {
        ...column,
        cards: [...rest.slice(0, at), moved, ...rest.slice(at)],
      };
    }),
  };
}
