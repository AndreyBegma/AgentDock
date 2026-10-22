import type {
  ProjectRuntimeProfile,
  TokenEconomyReport,
  TokenEconomySettingsBody,
  TokenEconomySettingsView,
  TokenEconomyTechniqueBody,
  TokenEconomyTechniqueView,
  TokenSaverSettingsView,
  TokenSaverSummary,
  UpdateTokenSaverSettingsBody,
} from '@nautelle/shared';
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

/** `/projects/:id/token-economy` (#746 "API"): members read, a project admin writes. */
const economy = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/token-economy`;

export const fetchTokenEconomyReport = (
  projectId: string,
  range: { from: string; to: string },
) =>
  api<TokenEconomyReport>(
    `${economy(projectId)}/report?${new URLSearchParams({
      from: range.from,
      to: range.to,
    }).toString()}`,
  );

export const saveTokenEconomySettings = (
  projectId: string,
  body: TokenEconomySettingsBody,
) =>
  api<TokenEconomySettingsView>(`${economy(projectId)}/settings`, {
    method: 'PUT',
    body,
  });

export const setTechniqueMode = (
  projectId: string,
  technique: string,
  body: TokenEconomyTechniqueBody,
) =>
  api<TokenEconomyTechniqueView>(
    `${economy(projectId)}/techniques/${encodeURIComponent(technique)}`,
    { method: 'PUT', body },
  );

/** Operator+ only; the allowlist falls back to its stored names for a viewer. */
export const fetchRuntimeProfiles = (projectId: string) =>
  api<ProjectRuntimeProfile[]>(
    `/projects/${encodeURIComponent(projectId)}/runtime-profiles`,
  );
