import {
  type AiDigestSettingsView,
  type AiDigestView,
  type AiSummaryView,
  aiReaderLanguage,
  type UpdateAiDigestSettings,
} from '@nautelle/shared';
import { ApiError, api } from '../api';

const project = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;

/** `GET/PATCH /projects/:id/ai/digest/settings` (#658): members read, a project admin writes. */
export const fetchAiDigestSettings = (projectId: string) =>
  api<AiDigestSettingsView>(`${project(projectId)}/ai/digest/settings`);

export const saveAiDigestSettings = (
  projectId: string,
  body: UpdateAiDigestSettings,
) =>
  api<AiDigestSettingsView>(`${project(projectId)}/ai/digest/settings`, {
    method: 'PATCH',
    body,
  });

/** The latest sent digest; `null` before the first one (the API answers 404). */
export async function fetchLatestAiDigest(
  projectId: string,
): Promise<AiDigestView | null> {
  try {
    return await api<AiDigestView>(`${project(projectId)}/ai/digest/latest`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** The reader's language: the browser's, as the API expects it. */
export const readerLanguage = (): string =>
  aiReaderLanguage(
    typeof navigator === 'undefined' ? undefined : navigator.language,
  );

/** `POST …/board/cards/:n/summary`: the card and its PR, cached until it changes. */
export const summarizeCard = (
  projectId: string,
  number: number,
  regenerate = false,
) =>
  api<AiSummaryView>(`${project(projectId)}/board/cards/${number}/summary`, {
    method: 'POST',
    body: { language: readerLanguage(), regenerate },
  });

/** `POST …/sessions/:id/summary`: only for a project that stores session content. */
export const summarizeSession = (
  projectId: string,
  sessionId: string,
  regenerate = false,
) =>
  api<AiSummaryView>(
    `${project(projectId)}/sessions/${encodeURIComponent(sessionId)}/summary`,
    {
      method: 'POST',
      body: { language: readerLanguage(), regenerate },
    },
  );
