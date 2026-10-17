import type {
  AcceptCandidatesRequest,
  AcceptCandidatesResponse,
  PlanCandidateView,
  UpdatePlanCandidateRequest,
} from '@agentdock/shared';
import { api } from '../api';
import { planApi } from '../planner/href';

/** #592 (ADR-0058): the candidate routes. */
const candidateApi = (
  projectId: string,
  candidate: Pick<PlanCandidateView, 'id' | 'planId'>,
): string =>
  `${planApi(projectId, candidate.planId)}/candidates/${candidate.id}`;

export const updateCandidate = (
  projectId: string,
  candidate: Pick<PlanCandidateView, 'id' | 'planId'>,
  body: UpdatePlanCandidateRequest,
) =>
  api<PlanCandidateView>(candidateApi(projectId, candidate), {
    method: 'PATCH',
    body,
  });

export const rejectCandidate = (
  projectId: string,
  candidate: Pick<PlanCandidateView, 'id' | 'planId'>,
) =>
  api<PlanCandidateView>(`${candidateApi(projectId, candidate)}/reject`, {
    method: 'POST',
  });

export const acceptCandidates = (
  projectId: string,
  body: AcceptCandidatesRequest,
) =>
  api<AcceptCandidatesResponse>(`/projects/${projectId}/candidates/accept`, {
    method: 'POST',
    body,
  });
