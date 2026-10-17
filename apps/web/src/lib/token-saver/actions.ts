import type {
  ProjectRuntimeProfile,
  TokenSaverSettingsView,
  TokenSaverSummary,
  UpdateTokenSaverSettingsBody,
} from '@agentdock/shared';
import { api } from '../api';

/** `/projects/:id/token-saver` (#445 "API"): members read, a project admin writes. */
const base = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/token-saver`;

export const fetchTokenSaver = (projectId: string) =>
  api<TokenSaverSettingsView>(base(projectId));

export const saveTokenSaver = (
  projectId: string,
  body: UpdateTokenSaverSettingsBody,
) => api<TokenSaverSettingsView>(base(projectId), { method: 'PUT', body });

export const fetchTokenSaverSummary = (
  projectId: string,
  range: { from: string; to: string },
) =>
  api<TokenSaverSummary>(
    `${base(projectId)}/summary?${new URLSearchParams({
      from: range.from,
      to: range.to,
    }).toString()}`,
  );

/** Operator+ only; the allowlist falls back to its stored names for a viewer. */
export const fetchRuntimeProfiles = (projectId: string) =>
  api<ProjectRuntimeProfile[]>(
    `/projects/${encodeURIComponent(projectId)}/runtime-profiles`,
  );
