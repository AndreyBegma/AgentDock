import type { BoardCardView } from '@nautelle/shared';
import { sessionHref } from './format';

/** A session id as people read it: its first 8 characters. */
export const shortSessionId = (sessionId: string): string =>
  sessionId.slice(0, 8);

export const SESSION_ENDED_TEXT = 'session ended';

export type TakenState =
  | { kind: 'taken'; text: string; sessionId: string; alive: boolean }
  | { kind: 'queued'; text: string; sessionId: string };

/**
 * #845 D2, D10: how a card a manual session took reads — "taken by <session>",
 * "queued for <session>"; `null` for any other card. Whether the taking session
 * ended is the `alive` flag (the face adds "session ended").
 */
export const takenState = (
  card: Pick<BoardCardView, 'taken' | 'queuedForSessionId'>,
): TakenState | null => {
  if (card.taken) {
    return {
      kind: 'taken',
      text: `taken by ${shortSessionId(card.taken.sessionId)}`,
      sessionId: card.taken.sessionId,
      alive: card.taken.alive,
    };
  }
  if (card.queuedForSessionId) {
    return {
      kind: 'queued',
      text: `queued for ${shortSessionId(card.queuedForSessionId)}`,
      sessionId: card.queuedForSessionId,
    };
  }
  return null;
};

/** The session page of the session that took or queued the card. */
export const takenSessionHref = (
  card: Pick<BoardCardView, 'taken' | 'queuedForSessionId'>,
): string | null => {
  const state = takenState(card);
  return state ? sessionHref(state.sessionId) : null;
};
