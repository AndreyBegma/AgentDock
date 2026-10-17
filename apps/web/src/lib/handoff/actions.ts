import type { CardHandoffView, PutCardHandoffBody } from '@agentdock/shared';
import { api } from '../api';

const base = (projectId: string, card: number) =>
  `/projects/${encodeURIComponent(projectId)}/board/cards/${card}/handoff`;

/** `GET /projects/:id/board/cards/:n/handoff` (#449 D7): members read (D-03). */
export const fetchCardHandoff = (projectId: string, card: number) =>
  api<CardHandoffView>(base(projectId, card));

/** `PUT` (operator): the whole edited note; the API marks the person's lines. */
export const saveCardHandoff = (
  projectId: string,
  card: number,
  content: string,
) =>
  api<CardHandoffView>(base(projectId, card), {
    method: 'PUT',
    body: { content } satisfies PutCardHandoffBody,
  });
