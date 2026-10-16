import type { BulkCardAction, BulkCardSkipReason } from './contracts';
import { boardMoveRule } from './moves';
import {
  type BoardCardSource,
  type BoardColumn,
  type CardRoundPhase,
  isActiveRoundPhase,
} from './types';

/**
 * #452: whether a bulk action applies to a card. The API runs it before every
 * card of a batch; the web runs it for the "N of M" on the action bar, so the
 * count is what the server will do. Pure: no clock, no I/O.
 */
export interface BulkCardFacts {
  column: BoardColumn;
  /** The phase of the card's latest round; `null` before its first Run. */
  roundPhase: CardRoundPhase | null;
  source: BoardCardSource;
  autoCollect: boolean;
  /** #424 / #433: nothing follows the card's slot any more. */
  slotGone: boolean;
  trackingAlive?: boolean;
}

export type BulkCardDecision =
  | { applies: true }
  | { applies: false; reason: BulkCardSkipReason };

const TARGET: Record<Exclude<BulkCardAction, 'delete'>, BoardColumn> = {
  complete: 'completed',
  todo: 'todo',
  finished: 'finished',
};

const skip = (reason: BulkCardSkipReason): BulkCardDecision => ({
  applies: false,
  reason,
});

export const bulkCardRule = (
  action: BulkCardAction,
  card: BulkCardFacts,
): BulkCardDecision => {
  // A suggestion leaves the Inbox by Accept or Dismiss, never in bulk.
  if (card.column === 'inbox') return skip('invalid_move');
  const running = isActiveRoundPhase(card.roundPhase);
  if (action === 'delete')
    return running ? skip('card_running') : { applies: true };

  const to = TARGET[action];
  if (card.column === to) return skip('already_in_column');
  if (action === 'complete' && card.column !== 'finished') {
    return skip('wrong_column');
  }
  if (action === 'finished' && !running) return skip('not_running');

  const decision = boardMoveRule({
    from: card.column,
    to,
    roundPhase: card.roundPhase,
    source: 'person',
    cardSource: card.source,
    autoCollect: card.autoCollect,
    trackingAlive: card.trackingAlive,
    slotGone: card.slotGone,
  });
  return decision.allowed ? { applies: true } : skip(decision.error);
};
