import type {
  TextNormalizationsResponse,
  TextSettingsView,
  UpdateTextSettingsBody,
} from '@agentdock/shared';
import { api } from '../api';

const base = (projectId: string) => `/projects/${projectId}/text-normalizations`;

/** Exactly one of `cardId` / `planId` (else 400). */
export const fetchTextNotes = (
  projectId: string,
  owner: { cardId: string } | { planId: string },
) => {
  const query =
    'cardId' in owner
      ? `cardId=${encodeURIComponent(owner.cardId)}`
      : `planId=${encodeURIComponent(owner.planId)}`;
  return api<TextNormalizationsResponse>(`${base(projectId)}?${query}`);
};

export const retryTextNormalization = (projectId: string, id: string) =>
  api(`${base(projectId)}/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  });

export const fetchTextSettings = (projectId: string) =>
  api<TextSettingsView>(`/projects/${projectId}/text-settings`);

export const updateTextSettings = (
  projectId: string,
  body: UpdateTextSettingsBody,
) =>
  api<TextSettingsView>(`/projects/${projectId}/text-settings`, {
    method: 'PUT',
    body,
  });
