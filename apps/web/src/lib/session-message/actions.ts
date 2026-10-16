import type {
  SessionMessageRequest,
  SessionMessageView,
} from '@agentdock/shared';
import { api } from '../api';

/** #489: a send function for one session — a card round or a fleet slot. */
export type SendSessionMessage = (
  input: SessionMessageRequest,
) => Promise<SessionMessageView>;

/** Text or an answer to the card's running round (operator). */
export const cardSessionMessenger =
  (projectId: string, number: number): SendSessionMessage =>
  (body) =>
    api<SessionMessageView>(
      `/projects/${projectId}/board/cards/${number}/message`,
      { method: 'POST', body },
    );

/** Text or an answer typed into a fleet worker's own session (operator). */
export const slotSessionMessenger =
  (projectId: string, slot: string): SendSessionMessage =>
  (body) =>
    api<SessionMessageView>(
      `/projects/${projectId}/slots/${encodeURIComponent(slot)}/session-message`,
      { method: 'POST', body },
    );
