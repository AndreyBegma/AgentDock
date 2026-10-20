import type {
  ActionRequestSummary,
  ApprovalItemView,
  ApprovalsView,
} from '@nautelle/shared';
import { pendingRequests } from './action-requests';

/**
 * One row of the Queue page's Approvals tab (C-284): a pull request waiting
 * for a merge approval, or an action request a Claude Code session is waiting
 * on. `key` is unique across both kinds.
 */
export type NeedsYouItem =
  | { kind: 'pr'; key: string; item: ApprovalItemView }
  | { kind: 'request'; key: string; request: ActionRequestSummary };

export const prKey = (pr: number): string => `pr:${pr}`;
export const requestKey = (id: string): string => `request:${id}`;

/**
 * What waits on a person: action requests first (each expires, soonest
 * first), then the pull requests, longest waiting first. Either side may not
 * have loaded yet.
 */
export function needsYouItems(
  view: ApprovalsView | undefined,
  requests: readonly ActionRequestSummary[] | undefined,
): NeedsYouItem[] {
  const asked = pendingRequests(requests ?? []).map(
    (request): NeedsYouItem => ({
      kind: 'request',
      key: requestKey(request.id),
      request,
    }),
  );
  const prs = [...(view?.waiting ?? [])]
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince))
    .map((item): NeedsYouItem => ({ kind: 'pr', key: prKey(item.pr), item }));
  return [...asked, ...prs];
}

/** The count on the Approvals tab: everything `needsYouItems` lists. */
export const pendingApprovalCount = (
  view: ApprovalsView | undefined,
  requests: readonly ActionRequestSummary[] | undefined,
): number =>
  (view?.waiting.length ?? 0) + pendingRequests(requests ?? []).length;
