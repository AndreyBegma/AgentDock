import type { PrChecks } from '../protocol';
import type { PrInspection } from '../protocol/commands/approvals';

/**
 * The merge approval queue (docs/specs/20-merge-approval-queue.md).
 *
 * A row is the approval state of one pull request at one head. At most one
 * row per PR is *current* — `waiting` or `approved`; the others are history.
 */
export const APPROVAL_STATUSES = [
  'waiting',
  'approved',
  'changes_requested',
  'stale',
  'merged',
  'closed',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The statuses of a PR's current row. */
export const CURRENT_APPROVAL_STATUSES = [
  'waiting',
  'approved',
] as const satisfies readonly ApprovalStatus[];

/** `orchestrator`: the plugin emitted `pr.awaiting_approval`; `derived`: D2's fallback. */
export const APPROVAL_SOURCES = ['orchestrator', 'derived'] as const;
export type ApprovalSource = (typeof APPROVAL_SOURCES)[number];

/** What a decision or a void did to the signal (D5, D6). */
export const APPROVAL_DECISIONS = [
  'approved',
  'changes_requested',
  'stale',
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalUserRef {
  id: string;
  name: string | null;
  email: string;
}

export interface ApprovalItemView {
  id: string;
  pr: number;
  /** From the issue cache or the slot; null when neither has seen the PR. */
  title: string | null;
  url: string | null;
  slot: string | null;
  issue: number | null;
  /** The slot's check rollup (#11); null without a slot. */
  checks: PrChecks | null;
  mergeable: boolean | null;
  /** D3: the slot's latest `pull request open` checkpoint; null — "no summary written". */
  summary: string | null;
  source: ApprovalSource;
  status: ApprovalStatus;
  /** The head a decision binds to; null on a row nobody has decided. */
  headSha: string | null;
  waitingSince: string;
  decidedBy: ApprovalUserRef | null;
  decidedAt: string | null;
  note: string | null;
  updatedAt: string;
}

/** D1: what AgentDock intends, and what the project's config asks of the orchestrator. */
export interface MergeApprovalFlags {
  /** `projects.mergeApproval`. */
  agentdock: boolean;
  /** `orchestrator.mergeApproval` of the config snapshot; null when unread or unparsable. */
  config: boolean | null;
}

/** `GET /projects/:id/approvals`. */
export interface ApprovalsView {
  mergeApproval: MergeApprovalFlags;
  configMismatch: boolean;
  /** Current rows, oldest wait first. */
  waiting: ApprovalItemView[];
  /** Decided and closed rows, newest first. */
  recent: ApprovalItemView[];
}

/** Why `inspection` is null on a detail. */
export interface ApprovalInspectionError {
  code: string;
  message: string;
}

/** `GET /projects/:id/approvals/:pr`: the PR's current row, else its latest. */
export interface ApprovalDetail extends ApprovalItemView {
  /** `pr.inspect` (D4), cached 60 s; null when the runner could not answer. */
  inspection: PrInspection | null;
  inspectionError: ApprovalInspectionError | null;
  /** Earlier rows of the same PR, newest first. */
  history: ApprovalItemView[];
}

/** `POST /projects/:id/approvals/:pr/approve`. */
export interface ApproveRequest {
  headSha: string;
}

/** `POST /projects/:id/approvals/:pr/request-changes`. */
export interface RequestChangesRequest {
  headSha: string;
  note: string;
}

/** `GET /projects/:id/approvals?status=` keeps rows of these statuses only. */
export type ApprovalsListFilter = ApprovalStatus;

/** Recent decisions a listing returns. */
export const APPROVALS_RECENT_LIMIT = 50;

/** D4: how long a `pr.inspect` result is reused. */
export const PR_INSPECTION_CACHE_MS = 60_000;

/** Live event on topic `project:<id>` (D10). Clients refetch on it. */
export const APPROVALS_LIVE_EVENT = 'approvals';

export interface ApprovalsLiveChange {
  kind: 'approvals';
  projectId: string;
}

/**
 * Live event on topic `project:<id>` for every decision and void (D10), read
 * by #21's activity feed and #22's notifications. The `merge_approvals` row
 * is its durable record: the `events` table holds runner events only.
 */
export const APPROVAL_DECIDED_LIVE_EVENT = 'pr.approval_decided';

export interface ApprovalDecidedEvent {
  projectId: string;
  pr: number;
  headSha: string;
  decision: ApprovalDecision;
  /** The deciding user; null for a void (the system). */
  by: ApprovalUserRef | null;
  at: string;
  note: string | null;
}

/** The body of an approvals route's error. */
export interface ApprovalsErrorBody {
  statusCode: number;
  error: ApprovalsErrorCode;
  message: string;
  /** With `head_moved`: the PR's head now. */
  headSha?: string;
}

/** Stable codes in the `error` field of an approvals route's error body. */
export const APPROVALS_ERROR = {
  /** The PR has no approval row on this project. */
  approvalNotFound: 'approval_not_found',
  /** The PR is not waiting for a decision. */
  notWaiting: 'not_waiting',
  /** The PR is merged or closed on GitHub. */
  prNotOpen: 'pr_not_open',
  /** D6: the `headSha` sent is not the PR's head. */
  headMoved: 'head_moved',
  /** D7. */
  noteRequired: 'note_required',
  noteTooLong: 'note_too_long',
  /** The runner command is not wired yet, or the runner is unreachable. */
  commandUnavailable: 'command_unavailable',
  commandFailed: 'command_failed',
} as const;
export type ApprovalsErrorCode =
  (typeof APPROVALS_ERROR)[keyof typeof APPROVALS_ERROR];

/**
 * D1: `orchestrator.mergeApproval` of a config snapshot — true or false when
 * the key holds a boolean, false when the block was read without it, null
 * when there is no snapshot or it did not parse.
 */
export const configMergeApproval = (
  codeSentinelConfig: {
    orchestrator?: Record<string, unknown>;
    error?: string;
  } | null,
): boolean | null => {
  if (!codeSentinelConfig || codeSentinelConfig.error) return null;
  return codeSentinelConfig.orchestrator?.mergeApproval === true;
};

/**
 * D1: whether AgentDock's flag and the project's config disagree. An unread
 * config is a mismatch only when AgentDock expects approval — nothing then
 * says the orchestrator will wait.
 */
export const mergeApprovalMismatch = (project: {
  mergeApproval: boolean;
  codeSentinelConfig: {
    orchestrator?: Record<string, unknown>;
    error?: string;
  } | null;
}): boolean => {
  const config = configMergeApproval(project.codeSentinelConfig);
  return (config ?? false) !== project.mergeApproval;
};
