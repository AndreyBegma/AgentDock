import type {
  AcceptBoardCardRequest,
  AcceptBoardCardResponse,
  AcceptSuggestionRequest,
  AddCardDependencyRequest,
  AddStackCardRequest,
  BoardCardDetail,
  BoardCardView,
  BoardSettingsView,
  BoardStackDetail,
  BoardView,
  BulkBoardCardsRequest,
  BulkBoardCardsResponse,
  CardCapturePage,
  CardDependenciesView,
  CardFeedbackRequest,
  CardPullRequestView,
  ClaimAttachmentsRequest,
  CollectBoardCardResponse,
  CreateBoardCardRequest,
  CreateBoardStackRequest,
  DismissAllResult,
  MoveBoardCardRequest,
  RunBoardCardRequest,
  UpdateBoardCardRequest,
  UpdateBoardSettingsRequest,
  UpdateBoardStackRequest,
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

/** #452: one action for up to `BULK_CARDS_MAX` cards; each card's outcome is in the answer. */
export const bulkCards = (projectId: string, body: BulkBoardCardsRequest) =>
  api<BulkBoardCardsResponse>(`${base(projectId)}/cards/bulk`, {
    method: 'POST',
    body,
  });

export const runCard = (
  projectId: string,
  number: number,
  body: RunBoardCardRequest = {},
) => api(`${cardPath(projectId, number)}/run`, { method: 'POST', body });

/** #337 D8: the cards this one runs after, with their columns. */
export const fetchDependencies = (projectId: string, number: number) =>
  api<CardDependenciesView>(`${cardPath(projectId, number)}/dependencies`);

export const addDependency = (
  projectId: string,
  number: number,
  body: AddCardDependencyRequest,
) =>
  api<CardDependenciesView>(`${cardPath(projectId, number)}/dependencies`, {
    method: 'POST',
    body,
  });

export const removeDependency = (
  projectId: string,
  number: number,
  dependsOn: number,
) =>
  api<CardDependenciesView>(
    `${cardPath(projectId, number)}/dependencies/${dependsOn}`,
    { method: 'DELETE' },
  );

export const sendFeedback = (
  projectId: string,
  number: number,
  body: CardFeedbackRequest,
) => api(`${cardPath(projectId, number)}/feedback`, { method: 'POST', body });

/** #309: claims finished uploads onto an existing card (operator). */
export const claimCardAttachments = (
  projectId: string,
  number: number,
  body: ClaimAttachmentsRequest,
) =>
  api(`${cardPath(projectId, number)}/attachments`, {
    method: 'POST',
    body,
  });

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

/** #329 D5: Create pull request — collects the card's work now; a failed collect is an answer, not an error. */
export const collectCard = (projectId: string, number: number) =>
  api<CollectBoardCardResponse>(`${cardPath(projectId, number)}/collect`, {
    method: 'POST',
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

// ─── Stacks (#480, ADR-0044) ─────────────────────────────────────────────────

const stackPath = (projectId: string, number: number) =>
  `${base(projectId)}/stacks/${number}`;

/** #588: cards grouped by hand into a new one-stage stack. */
export const createStack = (projectId: string, body: CreateBoardStackRequest) =>
  api<BoardStackDetail>(`${base(projectId)}/stacks`, { method: 'POST', body });

export const fetchStack = (projectId: string, number: number) =>
  api<BoardStackDetail>(stackPath(projectId, number));

export const updateStack = (
  projectId: string,
  number: number,
  body: UpdateBoardStackRequest,
) =>
  api<BoardStackDetail>(stackPath(projectId, number), {
    method: 'PATCH',
    body,
  });

/** A card of the project joins a stage; `stage` = the stage count adds one. */
export const addStackCard = (
  projectId: string,
  number: number,
  body: AddStackCardRequest,
) =>
  api<BoardStackDetail>(`${stackPath(projectId, number)}/cards`, {
    method: 'POST',
    body,
  });

export const removeStackCard = (
  projectId: string,
  number: number,
  card: number,
) =>
  api<BoardStackDetail>(`${stackPath(projectId, number)}/cards/${card}`, {
    method: 'DELETE',
  });

/** #652: queues the stack's To Do cards and starts what is ready. */
export const runStack = (projectId: string, number: number) =>
  api<BoardStackDetail>(`${stackPath(projectId, number)}/run`, {
    method: 'POST',
  });

/** #652: removes the stack run's queue; running cards keep running. */
export const stopStack = (projectId: string, number: number) =>
  api<BoardStackDetail>(`${stackPath(projectId, number)}/stop`, {
    method: 'POST',
  });
