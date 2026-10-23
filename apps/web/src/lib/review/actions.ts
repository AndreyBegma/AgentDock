import type {
  CreateReviewStepRequest,
  InstalledSkillsView,
  ReorderReviewStepsRequest,
  ReviewSettingsUpdateResult,
  ReviewSettingsView,
  ReviewStepView,
  UpdateReviewSettingsRequest,
  UpdateReviewStepRequest,
} from '@nautelle/shared';
import { api } from '../api';

/** The review routes of a project (#862, ADR-0084). */
const base = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/review`;
const stepPath = (projectId: string, stepId: string) =>
  `${base(projectId)}/steps/${encodeURIComponent(stepId)}`;

export const fetchReview = (projectId: string) =>
  api<ReviewSettingsView>(base(projectId));

export const updateReview = (
  projectId: string,
  body: UpdateReviewSettingsRequest,
) => api<ReviewSettingsUpdateResult>(base(projectId), { method: 'PUT', body });

export const createReviewStep = (
  projectId: string,
  body: CreateReviewStepRequest,
) => api<ReviewStepView>(`${base(projectId)}/steps`, { method: 'POST', body });

export const updateReviewStep = (
  projectId: string,
  stepId: string,
  body: UpdateReviewStepRequest,
) =>
  api<ReviewStepView>(stepPath(projectId, stepId), { method: 'PATCH', body });

export const deleteReviewStep = (projectId: string, stepId: string) =>
  api(stepPath(projectId, stepId), { method: 'DELETE' });

export const reorderReviewSteps = (
  projectId: string,
  body: ReorderReviewStepsRequest,
) =>
  api<ReviewStepView[]>(`${base(projectId)}/steps/order`, {
    method: 'PUT',
    body,
  });

/** Replaces the peer review instructions, edits included; slow (a model writes them). */
export const regeneratePeerReview = (projectId: string) =>
  api<ReviewStepView>(`${base(projectId)}/peer-review/regenerate`, {
    method: 'POST',
  });

/** The skills the project's runner reports: the picker's options. */
export const fetchReviewSkills = (projectId: string) =>
  api<InstalledSkillsView>(`/projects/${encodeURIComponent(projectId)}/skills`);
