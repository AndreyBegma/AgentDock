import { isRoundActive, ownsWorker } from './card-rules';
import type { BoardCardDetail, BoardCardView } from './contracts';

/**
 * #578: which of a card's actions its state allows — the one copy the web's
 * card sheet and the Telegram bot both read. Role is not part of it: every
 * action here needs operator or higher, and each surface checks that itself.
 * Pure: no clock, no I/O.
 */

type Card = Pick<
  BoardCardView,
  'column' | 'round' | 'source' | 'tracking' | 'fleet' | 'design'
>;

const roundActive = (card: Pick<BoardCardView, 'round'>): boolean =>
  isRoundActive(card.round);

/** #244 D9: an Inbox card is accepted or dismissed, never run. */
export const isSuggestion = (card: Pick<BoardCardView, 'column'>): boolean =>
  card.column === 'inbox';

export const canGiveFeedback = (card: Card): boolean =>
  ownsWorker(card) && card.column === 'finished' && !roundActive(card);

export const canAccept = (card: Card): boolean =>
  card.column === 'finished' && !roundActive(card);

export const canMarkFinished = (card: Card): boolean =>
  ownsWorker(card) && card.column === 'in_progress' && roundActive(card);

/**
 * #489: a message goes to the card's running round; #578: or, for a `fleet`
 * card at work, to its slot's worker — the runner tells the orchestrator
 * (ADR-0045 §5).
 */
export const canMessageSession = (card: Card): boolean =>
  roundActive(card) ||
  (card.source === 'fleet' &&
    card.column === 'in_progress' &&
    card.fleet?.slot != null &&
    !card.fleet.slotGone);

/**
 * #329 D5: Create pull request is offered in Finished or Completed, with a
 * `branch`, no `prUrl`, and a collect that did not find "nothing to push".
 */
export const canCreatePr = (
  card: Pick<BoardCardDetail, 'column' | 'branch' | 'prUrl' | 'collectState'>,
): boolean =>
  (card.column === 'finished' || card.column === 'completed') &&
  card.branch !== null &&
  card.prUrl === null &&
  card.collectState !== 'no_changes';

/** #395: the runner's `not_found` for a card whose worktree is gone (it names internal ids). */
export const isWorktreeGoneError = (error: string | null): boolean =>
  /not found on the runner.*has no worktree/.test(error ?? '');

/**
 * #395: Create pull request can be pressed — not while a collect is under
 * way, nor once the worktree is gone.
 */
export const canCollect = (
  card: Pick<
    BoardCardDetail,
    'column' | 'branch' | 'prUrl' | 'collectState' | 'collectError'
  >,
): boolean =>
  canCreatePr(card) &&
  card.collectState !== 'pending' &&
  !(card.collectState === 'failed' && isWorktreeGoneError(card.collectError));

/** #578: the review-side actions of a card, in the order a surface offers them. */
export const CARD_REVIEW_ACTIONS = [
  'message',
  'finish',
  'accept',
  'feedback',
  'collect',
  'accept_suggestion',
  'dismiss',
] as const;
export type CardReviewAction = (typeof CARD_REVIEW_ACTIONS)[number];

/** The review-side actions `card`'s state allows, in `CARD_REVIEW_ACTIONS` order. */
export const cardReviewActions = (
  card: Card &
    Pick<BoardCardDetail, 'branch' | 'prUrl' | 'collectState' | 'collectError'>,
): CardReviewAction[] => {
  if (isSuggestion(card)) return ['accept_suggestion', 'dismiss'];
  const allowed: Record<CardReviewAction, boolean> = {
    message: canMessageSession(card),
    finish: canMarkFinished(card),
    accept: canAccept(card),
    feedback: canGiveFeedback(card),
    collect: canCollect(card),
    accept_suggestion: false,
    dismiss: false,
  };
  return CARD_REVIEW_ACTIONS.filter((action) => allowed[action]);
};
