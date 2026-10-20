import type {
  BoardAskQuery,
  BoardAskResponse,
  BoardSearchResponse,
  BoardTriageCounts,
  CardTriageView,
  TriageHint,
} from '@nautelle/shared';
import { api } from '../api';

/** #660: one question, turned into a query and answered. */
export const askBoard = (question: string): Promise<BoardAskResponse> =>
  api('/board/ask', { method: 'POST', body: { question } });

/** The query again, without a model call — after a chip was removed. */
export const searchBoard = (
  query: BoardAskQuery,
): Promise<BoardSearchResponse> =>
  api('/board/search', { method: 'POST', body: { query } });

const triagePath = (projectId: string, number: number) =>
  `/projects/${projectId}/board/cards/${number}/triage`;

export const fetchTriageCounts = (
  projectId: string,
): Promise<BoardTriageCounts> => api(`/projects/${projectId}/board/triage`);

export const fetchTriage = (
  projectId: string,
  number: number,
): Promise<CardTriageView> => api(triagePath(projectId, number));

export const dismissHint = (
  projectId: string,
  number: number,
  hint: TriageHint,
): Promise<CardTriageView> =>
  api(`${triagePath(projectId, number)}/dismiss`, {
    method: 'POST',
    body: { hint },
  });

export const applyHint = (
  projectId: string,
  number: number,
  hint: TriageHint,
): Promise<CardTriageView> =>
  api(`${triagePath(projectId, number)}/apply`, {
    method: 'POST',
    body: { hint },
  });
