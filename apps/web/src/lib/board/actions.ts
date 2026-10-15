import type {
  AcceptBoardCardRequest,
  AcceptBoardCardResponse,
  AcceptSuggestionRequest,
  BoardCardDetail,
  BoardCardView,
  BoardSettingsView,
  BoardView,
  CardCapturePage,
  CardFeedbackRequest,
  CardPullRequestView,
  CreateBoardCardRequest,
  DismissAllResult,
  MoveBoardCardRequest,
  RunBoardCardRequest,
  UpdateBoardCardRequest,
  UpdateBoardSettingsRequest,
} from '@agentdock/shared';
import { api } from '../api';

/** The Board's routes (issue #242 "API"); a card is addressed by its number. */
const base = (projectId: string) => `/projects/${projectId}/board`;
const cardPath = (projectId: string, number: number) =>
  `${base(projectId)}/cards/${number}`;

export const fetchBoard = (projectId: string, completedBefore?: string) =>
  api<BoardView>(
    completedBefore
      ? `${base(projectId)}?completedBefore=${encodeURIComponent(completedBefore)}`
      : base(projectId),
  );

export const fetchCard = (projectId: string, number: number) =>
  api<BoardCardDetail>(cardPath(projectId, number));

export const createCard = (projectId: string, body: CreateBoardCardRequest) =>
  api<BoardCardView>(`${base(projectId)}/cards`, { method: 'POST', body });

export const updateCard = (
  projectId: string,
  number: number,
  body: UpdateBoardCardRequest,
) =>
  api<BoardCardDetail>(cardPath(projectId, number), { method: 'PATCH', body });

export const deleteCard = (projectId: string, number: number) =>
  api(cardPath(projectId, number), { method: 'DELETE' });

export const moveCard = (
  projectId: string,
  number: number,
  body: MoveBoardCardRequest,
) => api(`${cardPath(projectId, number)}/move`, { method: 'POST', body });

export const runCard = (
  projectId: string,
  number: number,
  body: RunBoardCardRequest = {},
) => api(`${cardPath(projectId, number)}/run`, { method: 'POST', body });

export const sendFeedback = (
  projectId: string,
  number: number,
  body: CardFeedbackRequest,
) => api(`${cardPath(projectId, number)}/feedback`, { method: 'POST', body });

export const finishCard = (projectId: string, number: number) =>
  api(`${cardPath(projectId, number)}/finish`, { method: 'POST' });

/** #273 D13: with `merge` the PR is merged first; without it, the card only moves (D14). */
export const acceptCard = (
  projectId: string,
  number: number,
  body: AcceptBoardCardRequest = {},
) =>
  api<AcceptBoardCardResponse>(`${cardPath(projectId, number)}/accept`, {
    method: 'POST',
    body,
  });

/** #273 D10: the card's pull request as Accept would merge it. */
export const fetchPullRequest = (projectId: string, number: number) =>
  api<CardPullRequestView>(`${cardPath(projectId, number)}/pull-request`);

export const stopCard = (projectId: string, number: number) =>
  api(`${cardPath(projectId, number)}/stop`, { method: 'POST' });

/** #244 D9: Accept (or Edit & accept) an Inbox card; it lands at the top of To Do. */
export const acceptSuggestion = (
  projectId: string,
  number: number,
  body: AcceptSuggestionRequest = {},
) =>
  api(`${cardPath(projectId, number)}/accept-suggestion`, {
    method: 'POST',
    body,
  });

/** #244 D9: Dismiss deletes the card and remembers its fingerprint. */
export const dismissSuggestion = (projectId: string, number: number) =>
  api(`${cardPath(projectId, number)}/dismiss`, { method: 'POST' });

export const dismissAllSuggestions = (projectId: string) =>
  api<DismissAllResult>(`${base(projectId)}/inbox/dismiss-all`, {
    method: 'POST',
  });

export const fetchCaptures = (projectId: string, cursor?: string) =>
  api<CardCapturePage>(
    cursor
      ? `${base(projectId)}/captures?cursor=${encodeURIComponent(cursor)}`
      : `${base(projectId)}/captures`,
  );

export const fetchBoardSettings = (projectId: string) =>
  api<BoardSettingsView>(`/projects/${projectId}/board-settings`);

export const saveBoardSettings = (
  projectId: string,
  body: UpdateBoardSettingsRequest,
) =>
  api<BoardSettingsView>(`/projects/${projectId}/board-settings`, {
    method: 'PUT',
    body,
  });
