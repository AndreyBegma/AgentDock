import {
  type ActionRequestKind,
  type ActionRequestStatus,
  type ActionRequestSummary,
  actionRequestArgsSchemas,
  boundPrOf,
  issueQueueArgsOf,
  type PrApproveBoundArgs,
  prDiffUrl,
  shortHeadSha,
} from '@nautelle/shared';
import { ApiError, describeError } from '../api';

/**
 * The live event on `project:<id>` when an action request changes. The API
 * names it (`ACTION_REQUESTS_LIVE_EVENT`, apps/api/src/local); it is not in
 * `@nautelle/shared`, so the name is repeated here.
 */
export const ACTION_REQUESTS_LIVE_EVENT = 'action_requests';

/** `?tab=` values of the Approvals page. */
export const APPROVAL_TABS = ['pull-requests', 'action-requests'] as const;
export type ApprovalTab = (typeof APPROVAL_TABS)[number];

export const KIND_LABEL: Record<ActionRequestKind, string> = {
  tool_use: 'Use a tool',
  orchestrator_start: 'Start the orchestrator',
  orchestrator_stop: 'Stop the orchestrator',
  pr_approve: 'Approve a pull request',
  issue_queue: 'Queue an issue for the fleet',
  card_accept: 'Accept a card',
};

export const STATUS_LABEL: Record<ActionRequestStatus, string> = {
  pending: 'pending',
  approved: 'approved',
  denied: 'denied',
  expired: 'expired',
  executed: 'approved and done',
  failed: 'approved, but failed',
};

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const STATUS_TONE: Record<ActionRequestStatus, Tone> = {
  pending: 'warn',
  approved: 'ok',
  denied: 'danger',
  expired: 'neutral',
  executed: 'ok',
  failed: 'danger',
};

/**
 * A `tool_use` request's tool and redacted input; null for any other kind or bad
 * args. `truncated` is the runner's flag that the input is a head+tail preview
 * (D-08); it is read apart from the strict schema so an older API still parses.
 */
export const toolUseArgs = (
  request: Pick<ActionRequestSummary, 'kind' | 'args'>,
): { toolName: string; input?: string; truncated: boolean } | null => {
  if (request.kind !== 'tool_use') return null;
  const { truncated, ...rest } = request.args;
  const parsed = actionRequestArgsSchemas.tool_use.safeParse(rest);
  return parsed.success
    ? { ...parsed.data, truncated: truncated === true }
    : null;
};

/**
 * A `pr_approve` request's PR as the API read it at creation: the head an
 * approval binds to (C-110), shortened, and its diff. Null for any other kind
 * and for a request stored without a head.
 */
export const prApproveArgs = (
  request: Pick<ActionRequestSummary, 'kind' | 'args'>,
): (PrApproveBoundArgs & { shortHead: string; diffUrl: string }) | null => {
  const pr = boundPrOf(request);
  return pr
    ? { ...pr, shortHead: shortHeadSha(pr.headSha), diffUrl: prDiffUrl(pr) }
    : null;
};

/** An `issue_queue` request's issue (C-112); null for any other kind or bad args. */
export const issueQueueArgs = issueQueueArgsOf;

/** What the request asks for, as a short title. */
export const requestTitle = (request: ActionRequestSummary): string => {
  switch (request.kind) {
    case 'tool_use': {
      const toolName = toolUseArgs(request)?.toolName;
      return toolName ? `Use ${toolName}` : KIND_LABEL.tool_use;
    }
    case 'pr_approve': {
      const pr = request.args.pr;
      return typeof pr === 'number'
        ? `Approve pull request #${pr}`
        : KIND_LABEL.pr_approve;
    }
    case 'issue_queue': {
      const issue = issueQueueArgs(request)?.issue;
      return issue
        ? `Queue issue #${issue} for the fleet`
        : KIND_LABEL.issue_queue;
    }
    case 'orchestrator_start': {
      const start = actionRequestArgsSchemas.orchestrator_start.safeParse(
        request.args,
      );
      return start.success && start.data.mode === 'next'
        ? 'Dispatch the next issue'
        : KIND_LABEL.orchestrator_start;
    }
    default:
      return KIND_LABEL[request.kind];
  }
};

/** Whole seconds until `expiresAt`, never negative. */
export const secondsLeft = (expiresAt: string, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));

/** "4:32" under an hour, "23 h 59 min" above, "Expired" at zero. */
export const formatCountdown = (seconds: number): string => {
  if (seconds <= 0) return 'Expired';
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours} h ${String(minutes).padStart(2, '0')} min`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Requests still waiting for a decision, soonest to expire first. */
export const pendingRequests = (
  rows: readonly ActionRequestSummary[],
): ActionRequestSummary[] =>
  rows
    .filter((row) => row.status === 'pending')
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));

/** Decided or expired requests, newest first. */
export const recentRequests = (
  rows: readonly ActionRequestSummary[],
  limit = 20,
): ActionRequestSummary[] =>
  rows
    .filter((row) => row.status !== 'pending')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);

/** The text an `executed`/`failed` request's `result` carries, when it has one. */
export const resultMessage = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const { message, error } = result as Record<string, unknown>;
  if (typeof message === 'string') return message;
  if (typeof error === 'string') return error;
  return null;
};

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError
    ? (error.body?.error as string | undefined)
    : undefined;

export function describeActionRequestError(error: unknown): string {
  switch (errorCode(error)) {
    case 'not_pending':
      return 'This request was already decided, or it expired. The list is up to date now.';
    case 'self_approval':
      return 'You cannot approve your own request. Another operator or an admin has to.';
    case 'not_found':
      return 'This request no longer exists.';
    default:
      break;
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'Only operators of this project can decide action requests.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'This project no longer exists, or you are not a member of it.';
  }
  return describeError(error);
}
