import type { RailBadge } from '@andrewbehma/glass-ui/nav-rail';
import {
  APPROVALS_ERROR,
  type ApprovalItemView,
  type ApprovalSource,
  type ApprovalStatus,
  type MergeApprovalFlags,
} from '@nautelle/shared';
import { APPROVAL_NOTE_MAX_BYTES } from '@nautelle/shared/protocol';
import { ApiError, describeError, type ErrorHint } from '../api';
import { updateRunnerText } from '../control/format';

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
  derived: 'inferred',
};

export const SOURCE_TOOLTIP: Record<ApprovalSource, string> = {
  orchestrator: 'The orchestrator announced that this pull request waits.',
  derived:
    'The orchestrator did not announce it: Nautelle inferred it from a slot with green checks and an open, mergeable pull request.',
};

/** The rail's count on Approvals while PRs wait; nothing at zero. */
export const approvalsBadge = (waiting: number): RailBadge | undefined =>
  waiting > 0
    ? {
        count: waiting,
        tone: 'warn',
        label:
          waiting === 1 ? '1 waiting approval' : `${waiting} waiting approvals`,
      }
    : undefined;

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
      ? 'Nautelle expects approval, but the project config could not be read, so the orchestrator may merge on its own. Set orchestrator.mergeApproval to true in .code-analyzer-config.json.'
      : 'Nautelle expects approval, but the project config does not ask for it, so the orchestrator will merge on its own. Set orchestrator.mergeApproval to true in .code-analyzer-config.json.';
  }
  return 'The project config asks the orchestrator to wait for approval, but Nautelle’s merge approval is off. Turn it on in the project settings so the queue is not forgotten.';
}

/** Where merge approval is switched on and off. */
export const approvalSettingsHref = (projectId: string): string =>
  `/projects/${projectId}/settings?tab=general`;

/** The empty list, said honestly: with approval off nothing is ever expected here. */
export function emptyWaitingCopy(mergeApproval: boolean): {
  title: string;
  description: string;
} {
  return mergeApproval
    ? {
        title: 'Nothing is waiting',
        description:
          'No pull request waits for approval right now. New ones appear here by themselves.',
      }
    : {
        title: 'Merge approval is off',
        description:
          'The orchestrator merges green pull requests without asking, so nothing waits here. Turn merge approval on in the project settings to review each one first.',
      };
}

/**
 * Why Approve and Request changes are off, in plain words; null when they work.
 * A decision binds to the head commit the runner reports, so no inspection
 * means no decision.
 */
export function decisionDisabledReason(
  inspection: { state: string } | null,
  runnerName?: string | null,
): string | null {
  if (inspection === null) {
    return `Nautelle has not seen this pull request’s latest commit yet. A decision applies to exactly the commit you reviewed, so it waits until the runner${runnerName ? ` on ${runnerName}` : ''} reports it. If this stays, check that the runner is online.`;
  }
  return inspection.state === 'open'
    ? null
    : 'The pull request is no longer open on GitHub.';
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

export const commandUnavailableText = (runnerName?: string | null): string =>
  `This runner is too old to carry out approvals, so nothing was sent and nothing was decided. ${updateRunnerText(runnerName)}`;

export const COMMAND_UNAVAILABLE_TEXT = commandUnavailableText();

/** Every approvals error as a sentence for the person. */
/** `describeApprovalError` with the fix: a runner that is too old points at Runners. */
export function describeApprovalHint(
  error: unknown,
  runnerName?: string | null,
): ErrorHint {
  const text = describeApprovalError(error, runnerName);
  if (errorCode(error) === APPROVALS_ERROR.commandUnavailable) {
    return { text, href: '/admin/runners', cta: 'Open Runners' };
  }
  return { text };
}

export function describeApprovalError(
  error: unknown,
  runnerName?: string | null,
): string {
  switch (errorCode(error)) {
    case APPROVALS_ERROR.headMoved:
      return 'The pull request has a newer commit than the one you reviewed. Nothing was sent; review the new head and decide again.';
    case APPROVALS_ERROR.notWaiting:
      return 'This pull request is no longer waiting for a decision.';
    case APPROVALS_ERROR.approvalClosed:
      return 'This approval was closed while your decision was being sent; it was not recorded.';
    case APPROVALS_ERROR.prNotOpen:
      return 'This pull request is merged or closed on GitHub.';
    case APPROVALS_ERROR.approvalNotFound:
      return 'This pull request has no approval record.';
    case APPROVALS_ERROR.noteRequired:
      return 'Say what the worker has to change.';
    case APPROVALS_ERROR.noteTooLong:
      return `The note is over ${APPROVAL_NOTE_MAX_BYTES / 1024} KB.`;
    case APPROVALS_ERROR.commandUnavailable:
      return commandUnavailableText(runnerName);
    case APPROVALS_ERROR.commandFailed: {
      if (!(error instanceof ApiError)) {
        return 'The runner could not complete the request: unknown error';
      }
      // WI-74: `detail` is the runner's own text, already redacted by the API.
      const detail = error.body?.detail;
      return `The runner could not complete the request: ${error.message}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`;
    }
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
