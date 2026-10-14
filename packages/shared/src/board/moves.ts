import {
  type BoardColumn,
  type CardRoundPhase,
  isActiveRoundPhase,
} from './types';

/**
 * D7: every column move of a card goes through `boardMoveRule`. The API
 * enforces it and carries out its effects; the web pre-checks a drop with it
 * and rolls back on a refusal. Pure: no clock, no I/O.
 */

/**
 * - `person` — a drag, or a button that moves the card (Accept, Mark finished);
 * - `automatic` — the work moving it: Run → In progress, done → Finished.
 */
export type BoardMoveSource = 'person' | 'automatic';

/**
 * What the API does besides writing the new column, in this order:
 * - `stop` — kill the worker (`card.stop`), the active round becomes `cancelled`;
 * - `finish` — the active round becomes `finished` (by the person for a drag);
 * - `collect` — send `card.collect`: entering Finished with work to collect (D8);
 * - `accept` — set `completedAt`/`completedById`, send `card.close` (D10);
 * - `reopen` — clear `completedAt`/`completedById`: leaving Completed.
 */
export type BoardMoveEffect =
  | 'stop'
  | 'finish'
  | 'collect'
  | 'accept'
  | 'reopen';

/**
 * - `card_running` — a round is active and the move would take the card out
 *   of In progress, not to Finished and without `stopWorker`;
 * - `automatic_to_completed` — only a person completes a card;
 * - `card_completed` — automation never moves a Completed card, so a late
 *   event cannot pull back a card the person accepted.
 */
export type BoardMoveRefusal =
  | 'card_running'
  | 'automatic_to_completed'
  | 'card_completed';

export interface BoardMoveInput {
  from: BoardColumn;
  to: BoardColumn;
  /** The phase of the card's latest round; `null` before its first Run. */
  roundPhase: CardRoundPhase | null;
  source: BoardMoveSource;
  /** The person confirmed stopping the worker (`ConfirmDialog`). */
  stopWorker?: boolean;
}

export type BoardMoveDecision =
  | {
      allowed: true;
      effects: BoardMoveEffect[];
      /**
       * A person dropped a To Do or Finished card on In progress: ask "Run the
       * worker?" — Run / Just move / Cancel. A drag never starts a worker.
       */
      offerRun: boolean;
    }
  | { allowed: false; error: BoardMoveRefusal };

const refuse = (error: BoardMoveRefusal): BoardMoveDecision => ({
  allowed: false,
  error,
});

export const boardMoveRule = (move: BoardMoveInput): BoardMoveDecision => {
  const { from, to, roundPhase, source } = move;
  if (source === 'automatic' && to === 'completed') {
    return refuse('automatic_to_completed');
  }
  if (source === 'automatic' && from === 'completed') {
    return refuse('card_completed');
  }
  if (from === to) return { allowed: true, effects: [], offerRun: false };

  const active = isActiveRoundPhase(roundPhase);
  const effects: BoardMoveEffect[] = [];
  // Moving into In progress is what a Run does, so only leaving it is held.
  if (active && to !== 'in_progress') {
    if (to === 'finished') effects.push('finish');
    else if (move.stopWorker === true) effects.push('stop');
    else return refuse('card_running');
  }
  if (to === 'finished' && roundPhase !== null) effects.push('collect');
  if (to === 'completed') effects.push('accept');
  if (from === 'completed') effects.push('reopen');

  const offerRun =
    source === 'person' &&
    to === 'in_progress' &&
    (from === 'todo' || from === 'finished') &&
    !active;
  return { allowed: true, effects, offerRun };
};
