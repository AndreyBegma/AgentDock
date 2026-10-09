import {
  APPROVALS_ERROR,
  type ApprovalItemView,
  type ApprovalSource,
  type ApprovalStatus,
  type MergeApprovalFlags,
} from '@agentdock/shared';
import { APPROVAL_NOTE_MAX_BYTES } from '@agentdock/shared/protocol';
import { ApiError, describeError } from '../api';

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export const STATUS_LABEL: Record<ApprovalStatus, string> = {
  waiting: 'waiting',
  approved: 'approved',
  changes_requested: 'changes requested',
  stale: 'voided (new push)',
  merged: 'merged',
  closed: 'closed',
};

export const STATUS_TONE: Record<ApprovalStatus, Tone> = {
  waiting: 'warn',
  approved: 'ok',
  changes_requested: 'danger',
  stale: 'neutral',
  merged: 'ok',
  closed: 'neutral',
};

export const SOURCE_LABEL: Record<ApprovalSource, string> = {
  orchestrator: 'orchestrator',
  derived: 'derived',
};

export const SOURCE_TOOLTIP: Record<ApprovalSource, string> = {
  orchestrator: 'The orchestrator announced that this pull request waits.',
  derived:
    'No plugin events: AgentDock derived this from a green, mergeable slot with an open pull request.',
};

/** The sidebar label: `Approvals`, or `Approvals · 3` while PRs wait. */
export const navLabel = (base: string, waiting: number): string =>
  waiting > 0 ? `${base} · ${waiting}` : base;

/** `+12 −3` */
export const formatDiffStat = (additions: number, deletions: number): string =>
  `+${additions} −${deletions}`;

/** Who decided, as the list shows it. */
export const deciderLabel = (
  item: Pick<ApprovalItemView, 'decidedBy'>,
): string =>
  item.decidedBy ? (item.decidedBy.name ?? item.decidedBy.email) : '—';

const encoder = new TextEncoder();
export const noteBytes = (note: string): number => encoder.encode(note).length;

/** D7, the same rule the API applies; null when the note may be sent. */
export function noteError(note: string): string | null {
  if (note.trim() === '') return 'Say what the worker has to change.';
  if (noteBytes(note) > APPROVAL_NOTE_MAX_BYTES) {
    return `The note is over ${APPROVAL_NOTE_MAX_BYTES / 1024} KB.`;
  }
  return null;
}

/** D1: the banner text when the two flags disagree; null when they agree. */
export function mismatchSentence(
  flags: MergeApprovalFlags,
  mismatch: boolean,
): string | null {
  if (!mismatch) return null;
  if (flags.agentdock && flags.config !== true) {
    return flags.config === null
      ? 'AgentDock expects approval, but the project config could not be read, so the orchestrator may merge on its own. Set orchestrator.mergeApproval to true in .code-analyzer-config.json.'
      : 'AgentDock expects approval, but the project config does not ask for it, so the orchestrator will merge on its own. Set orchestrator.mergeApproval to true in .code-analyzer-config.json.';
  }
  return 'The project config asks the orchestrator to wait for approval, but AgentDock’s merge approval is off. Turn it on in the project settings so the queue is not forgotten.';
}

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

const errorCode = (error: unknown): string | undefined =>
  error instanceof ApiError ? (error.code as string | undefined) : undefined;

/** The head a `head_moved` refusal reports; undefined for any other error. */
export function movedHead(error: unknown): string | undefined {
  if (errorCode(error) !== APPROVALS_ERROR.headMoved) return undefined;
  const head = error instanceof ApiError ? error.body?.headSha : undefined;
  return typeof head === 'string' ? head : undefined;
}

export const isCommandUnavailable = (error: unknown): boolean =>
  errorCode(error) === APPROVALS_ERROR.commandUnavailable;

export const COMMAND_UNAVAILABLE_TEXT =
  'The runner does not handle approvals yet, so nothing was sent. Nothing was decided.';

/** Every approvals error as a sentence for the person. */
export function describeApprovalError(error: unknown): string {
  switch (errorCode(error)) {
    case APPROVALS_ERROR.headMoved:
      return 'The pull request has a newer commit than the one you reviewed. Nothing was sent; review the new head and decide again.';
    case APPROVALS_ERROR.notWaiting:
      return 'This pull request is no longer waiting for a decision.';
    case APPROVALS_ERROR.prNotOpen:
      return 'This pull request is merged or closed on GitHub.';
    case APPROVALS_ERROR.approvalNotFound:
      return 'This pull request has no approval record.';
    case APPROVALS_ERROR.noteRequired:
      return 'Say what the worker has to change.';
    case APPROVALS_ERROR.noteTooLong:
      return `The note is over ${APPROVAL_NOTE_MAX_BYTES / 1024} KB.`;
    case APPROVALS_ERROR.commandUnavailable:
      return COMMAND_UNAVAILABLE_TEXT;
    case APPROVALS_ERROR.commandFailed:
      return `The runner could not complete the request: ${error instanceof ApiError ? error.message : 'unknown error'}`;
    default:
      break;
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'This project no longer exists, or you are not a member of it.';
  }
  if (error instanceof ApiError && error.status === 403) {
    return 'Only operators can decide on a pull request.';
  }
  return describeError(error);
}
