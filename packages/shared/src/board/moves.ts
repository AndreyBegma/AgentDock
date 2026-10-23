import {
  type BoardCardSource,
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
 * - `collect` — send `card.collect`: entering Finished with work to collect
 *   (D8) — a card worker's round, or a `terminal` card with `autoCollect`
 *   on (#282 D3), collected in its session's cwd;
 * - `accept` — set `completedAt`/`completedById`, send `card.close` (D10);
 * - `reopen` — clear `completedAt`/`completedById`: leaving Completed;
 * - `accept_suggestion` — a person dragged an Inbox card to To Do: what
 *   Accept does (#244 D9) — evidence stripped, `card.inbox_accepted`.
 */
export type BoardMoveEffect =
  | 'stop'
  | 'finish'
  | 'collect'
  | 'accept'
  | 'reopen'
  | 'accept_suggestion';

/**
 * - `card_running` — a round is active and the move would take the card out
 *   of In progress, not to Finished and without `stopWorker`;
 * - `automatic_to_completed` — only a person completes a card;
 * - `card_completed` — automation never moves a Completed card, so a late
 *   event cannot pull back a card the person accepted;
 * - `invalid_move` — into or out of Inbox other than a person's Inbox → To Do
 *   (#244 D9): a suggestion enters To Do only by Accept, and nothing else
 *   enters the Inbox;
 * - `plan_task_derived` — the item is a plan task projected onto the board
 *   (#270 D5, ADR-0028): its column follows its plan and its issue, so no
 *   move, reorder or column change of it is ever allowed;
 * - `fleet_slot` — a person moved a `fleet` card (#282 D4, ADR-0030 §4):
 *   its column follows the slot, so the one move a person makes is Finished
 *   → Completed (Accept). A reorder inside a column is not a move. Once the
 *   slot is gone (#424) a person may also move the card to To Do or
 *   Finished, never into In progress.
 */
export type BoardMoveRefusal =
  | 'card_running'
  | 'automatic_to_completed'
  | 'card_completed'
  | 'invalid_move'
  | 'plan_task_derived'
  | 'fleet_slot';

/** #270 D5: what is being moved. A plan task is on the board read-only. */
export type BoardMoveItem = 'card' | 'plan_task';

export interface BoardMoveInput {
  /** Default `card`. */
  item?: BoardMoveItem;
  from: BoardColumn;
  to: BoardColumn;
  /** The phase of the card's latest round; `null` before its first Run. */
  roundPhase: CardRoundPhase | null;
  source: BoardMoveSource;
  /** The person confirmed stopping the worker (`ConfirmDialog`). */
  stopWorker?: boolean;
  /** #282 D6: the card's `source`. Default `manual`. */
  cardSource?: BoardCardSource;
  /** #282 D3: a `terminal` card's Automatic work. Default `false`. */
  autoCollect?: boolean;
  /**
   * #282 D1: a `terminal` card's tracked session is alive — it is the
   * worker, so no Run is offered. #845 D10: the same for a card a manual
   * session took (`card.take`), whatever its source; once that session is
   * gone, Run is offered again. Default `false`.
   */
  trackingAlive?: boolean;
  /**
   * #424: a `fleet` card's slot ended without a PR of its own — nothing
   * moves the card any more, so a person may. Default `false`.
   */
  slotGone?: boolean;
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

const WORK_COLUMNS: readonly BoardColumn[] = [
  'todo',
  'in_progress',
  'finished',
];

/** #282 D4 / #424: the moves a person makes of a `fleet` card. */
const personMovesFleetCard = (
  from: BoardColumn,
  to: BoardColumn,
  slotGone: boolean,
): boolean => {
  if (from === 'finished' && to === 'completed') return true;
  return (
    slotGone &&
    WORK_COLUMNS.includes(from) &&
    (to === 'todo' || to === 'finished')
  );
};

/**
 * D8 / #282 D3: a card worker's work is always collected; a terminal
 * session's only with Automatic work on; a fleet slot's never — the
 * orchestrator owns its pull request.
 */
const collects = (
  cardSource: BoardCardSource,
  roundPhase: CardRoundPhase | null,
  autoCollect: boolean | undefined,
): boolean => {
  if (cardSource === 'fleet') return false;
  if (cardSource === 'terminal' && roundPhase === null) {
    return autoCollect === true;
  }
  return roundPhase !== null;
};

export const boardMoveRule = (move: BoardMoveInput): BoardMoveDecision => {
  const { from, to, roundPhase, source } = move;
  if (move.item === 'plan_task') return refuse('plan_task_derived');
  if (source === 'automatic' && to === 'completed') {
    return refuse('automatic_to_completed');
  }
  if (source === 'automatic' && from === 'completed') {
    return refuse('card_completed');
  }
  if (from === to) return { allowed: true, effects: [], offerRun: false };
  const cardSource = move.cardSource ?? 'manual';
  if (
    cardSource === 'fleet' &&
    source === 'person' &&
    !personMovesFleetCard(from, to, move.slotGone === true)
  ) {
    return refuse('fleet_slot');
  }
  if (from === 'inbox' || to === 'inbox') {
    return from === 'inbox' && to === 'todo' && source === 'person'
      ? { allowed: true, effects: ['accept_suggestion'], offerRun: false }
      : refuse('invalid_move');
  }

  const active = isActiveRoundPhase(roundPhase);
  const effects: BoardMoveEffect[] = [];
  // Moving into In progress is what a Run does, so only leaving it is held.
  if (active && to !== 'in_progress') {
    if (to === 'finished') effects.push('finish');
    else if (move.stopWorker === true) effects.push('stop');
    else return refuse('card_running');
  }
  if (to === 'finished' && collects(cardSource, roundPhase, move.autoCollect)) {
    effects.push('collect');
  }
  if (to === 'completed') effects.push('accept');
  if (from === 'completed') effects.push('reopen');

  const offerRun =
    source === 'person' &&
    cardSource !== 'fleet' &&
    move.trackingAlive !== true &&
    to === 'in_progress' &&
    (from === 'todo' || from === 'finished') &&
    !active;
  return { allowed: true, effects, offerRun };
};
