import type {
  ActionRequestKind,
  ActionRequestSummary,
} from '@agentdock/shared';
import type { ActionRequest } from '@prisma/client';

/**
 * Live event on topic `project:<id>` whenever an action request is created
 * or changes status (spec 201 "API"); clients refetch the list on it, as
 * they do on `approvals`.
 */
export const ACTION_REQUESTS_LIVE_EVENT = 'action_requests';

export interface ActionRequestsLiveChange {
  kind: 'action_requests';
  projectId: string;
  id: string;
  status: ActionRequestSummary['status'];
}

/** A request as the web lists it: the shared summary plus its outcome. */
export interface ActionRequestView extends ActionRequestSummary {
  /** What executing it returned or why it failed; null until then. */
  result: unknown;
}

const asArgs = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const toActionRequestSummary = (
  row: ActionRequest,
): ActionRequestSummary => ({
  id: row.id,
  projectId: row.projectId,
  runnerId: row.runnerId,
  sessionId: row.sessionId,
  requestedById: row.requestedById,
  kind: row.kind,
  summary: row.summary,
  args: asArgs(row.args),
  status: row.status,
  decidedById: row.decidedById,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  note: row.note,
  expiresAt: row.expiresAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
});

export const toActionRequestView = (row: ActionRequest): ActionRequestView => ({
  ...toActionRequestSummary(row),
  result: row.result ?? null,
});

const KIND_TITLE: Record<ActionRequestKind, string> = {
  tool_use: 'A session asks to use a tool',
  orchestrator_start: 'A session asks to start the orchestrator',
  orchestrator_stop: 'A session asks to stop the orchestrator',
  pr_approve: 'A session asks to approve a PR',
};

/** The notification's title (spec 22 D10: no prompt or code text). */
export const actionRequestTitle = (
  kind: ActionRequestKind,
  args: Record<string, unknown>,
): string => {
  if (kind === 'tool_use' && typeof args.toolName === 'string') {
    return `A session asks to use ${args.toolName.slice(0, 80)}`;
  }
  if (kind === 'pr_approve' && typeof args.pr === 'number') {
    return `A session asks to approve PR #${args.pr}`;
  }
  return KIND_TITLE[kind];
};

/**
 * The notification's link. It also carries the request's id back to the
 * Telegram buttons: a notification row has no other reference to it.
 */
export const actionRequestLink = (projectId: string, id: string): string =>
  `/projects/${projectId}/approvals?actionRequest=${encodeURIComponent(id)}`;

const LINK =
  /^\/projects\/[^/?]+\/approvals\?actionRequest=([A-Za-z0-9_-]{1,64})$/;

/** The request id of an `action.requested` notification's link; null otherwise. */
export const actionRequestIdOfLink = (link: string | null): string | null => {
  const match = link ? LINK.exec(link) : null;
  return match ? match[1] : null;
};
