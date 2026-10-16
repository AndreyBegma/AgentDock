import type {
  StewardDigestView,
  StewardIncidentView,
  StewardSettingsView,
  UpdateStewardSettingsBody,
} from '@agentdock/shared';
import { ApiError, api } from '../api';

const base = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/steward`;

/** `GET/PUT /projects/:id/steward` (#447): members read, a project admin writes. */
export const fetchStewardSettings = (projectId: string) =>
  api<StewardSettingsView>(base(projectId));

export const saveStewardSettings = (
  projectId: string,
  body: UpdateStewardSettingsBody,
) => api<StewardSettingsView>(base(projectId), { method: 'PUT', body });

/** The incidents of one card's rounds, newest first (the card sheet, D15). */
export const fetchCardIncidents = (projectId: string, card: number) =>
  api<StewardIncidentView[]>(
    `${base(projectId)}/incidents?${new URLSearchParams({
      card: String(card),
    }).toString()}`,
  );

/** The latest digest; `null` before the first one (the API answers 404). */
export async function fetchLatestDigest(
  projectId: string,
): Promise<StewardDigestView | null> {
  try {
    return await api<StewardDigestView>(`${base(projectId)}/digest/latest`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * `PATCH /board/cards/:n` with `issueNumber` (D8): a number links an open
 * issue, `null` unlinks. `UpdateBoardCardRequest` predates the field and sits
 * outside this slot, so the body is typed here.
 */
export const linkCardIssue = (
  projectId: string,
  card: number,
  issueNumber: number | null,
) =>
  api(`/projects/${encodeURIComponent(projectId)}/board/cards/${card}`, {
    method: 'PATCH',
    body: { issueNumber },
  });
