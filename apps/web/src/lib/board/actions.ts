import type {
  BoardCardDetail,
  BoardCardView,
  BoardSettingsView,
  BoardView,
  CardFeedbackRequest,
  CreateBoardCardRequest,
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

export const acceptCard = (projectId: string, number: number) =>
  api(`${cardPath(projectId, number)}/accept`, { method: 'POST' });

export const stopCard = (projectId: string, number: number) =>
  api(`${cardPath(projectId, number)}/stop`, { method: 'POST' });

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
