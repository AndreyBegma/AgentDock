import {
  type AcceptBoardCardRequest,
  BOARD_ERROR,
  type BoardCardView,
  type CardMergeOutcome,
  type CardPrCloseOutcome,
  type CardPullRequestView,
} from '@agentdock/shared';
import type { RunnerCommands } from '@agentdock/shared/protocol';
import { ApiError } from '../api';

// `CardMergeMethod` is not exported from the package root; it is the view's.
type CardMergeMethod = NonNullable<CardPullRequestView['method']>;

/**
 * The accept dialog (#273 D10): what Accept offers, from the card's pull
 * request as `GET …/pull-request` reads it.
 */
export type AcceptChoice =
  /** Open and mergeable here: both actions. */
  | { kind: 'merge'; headSha: string }
  /** Merged before: Accept only, and it closes the issue. */
  | { kind: 'already_merged'; headSha: string }
  /** Accept without merging, with the reason it is the only action. */
  | { kind: 'accept_only'; reason: string };

export function acceptChoice(
  prNumber: number | null,
  pr: CardPullRequestView | null,
  options: { fleet?: boolean } = {},
): AcceptChoice {
  // #282 D4: Accept on a fleet card never merges; the orchestrator does.
  if (options.fleet) {
    return {
      kind: 'accept_only',
      reason: 'The orchestrator merges a fleet pull request, not this page.',
    };
  }
  if (prNumber === null) {
    return { kind: 'accept_only', reason: 'This card has no pull request.' };
  }
  if (pr === null) {
    return {
      kind: 'accept_only',
      reason:
        'The pull request could not be read, so it cannot be merged here.',
    };
  }
  if (pr.state === 'merged') {
    return { kind: 'already_merged', headSha: pr.headSha };
  }
  if (pr.state === 'closed') {
    return {
      kind: 'accept_only',
      reason: `PR #${pr.number} is closed, so there is nothing to merge.`,
    };
  }
  if (!pr.canMerge) {
    return {
      kind: 'accept_only',
      reason:
        'The runner is offline or too old to merge. Update it to merge from here.',
    };
  }
  return { kind: 'merge', headSha: pr.headSha };
}

export const MERGE_METHOD_LABEL: Record<CardMergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
};

/** D12: the project's method, or what GitHub's own default will be. */
export const mergeMethodText = (method: CardMergeMethod | null): string =>
  method === null ? 'Repository default' : MERGE_METHOD_LABEL[method];

export const CHECKS_PILL = {
  green: { status: 'done', label: 'Checks passed' },
  pending: { status: 'running', label: 'Checks running' },
  red: { status: 'error', label: 'Checks failing' },
} as const satisfies Record<
  CardPullRequestView['checks'],
  { status: string; label: string }
>;

/** What the toast says once Accept went through (D13). */
export function acceptedMessage(
  label: string,
  merge: CardMergeOutcome | null,
  prClose: CardPrCloseOutcome | null = null,
): { text: string; warn: boolean } {
  if (prClose) return closedMessage(label, prClose);
  if (merge === null) return { text: `${label} accepted.`, warn: false };
  if (merge.merged && !merge.issueClosed) {
    return {
      text: `${label} accepted and merged, but its issue stayed open${
        merge.issueError ? `: ${merge.issueError}` : '.'
      }`,
      warn: true,
    };
  }
  // #329 D7: a failed deletion does not undo the merge; say so.
  if (merge.branchError) {
    return {
      text: `${label} accepted and its pull request merged, but its branch was not deleted: ${merge.branchError}`,
      warn: true,
    };
  }
  return {
    text: merge.alreadyMerged
      ? `${label} accepted. Its pull request was already merged.`
      : `${label} accepted and its pull request merged${
          merge.branchDeleted ? ', and its branch deleted' : ''
        }.`,
    warn: false,
  };
}

/** #329 D8: the toast after Accept closed the pull request. */
function closedMessage(
  label: string,
  closed: CardPrCloseOutcome,
): { text: string; warn: boolean } {
  const problems = [
    closed.branchError && `its branch was not deleted: ${closed.branchError}`,
    closed.issueError && `its issue stayed open: ${closed.issueError}`,
  ].filter((x): x is string => Boolean(x));
  if (problems.length > 0) {
    return {
      text: `${label} accepted and its pull request closed, but ${problems.join('; ')}`,
      warn: true,
    };
  }
  return {
    text: `${label} accepted and its pull request closed${
      closed.branchDeleted ? ', and its branch deleted' : ''
    }.`,
    warn: false,
  };
}

/** #329 D7: a terminal card's branch is the person's session branch. */
export const isTerminalCard = (card: Pick<BoardCardView, 'source'>): boolean =>
  card.source === 'terminal';

/** What the dialog's branch and close choices are set to. */
export interface AcceptOptions {
  /** After a merge: delete the PR's branch on GitHub. */
  deleteBranch: boolean;
  /** Accept without merging closes the PR (and deletes its branch). */
  closePr: boolean;
  /** With `closePr`: close the issue as not planned. */
  closeIssue: boolean;
}

/** D7: checked by default, unchecked for a terminal card. D8: leave the PR open. */
export const defaultAcceptOptions = (
  card: Pick<BoardCardView, 'source'>,
): AcceptOptions => ({
  deleteBranch: !isTerminalCard(card),
  closePr: false,
  closeIssue: false,
});

/** D9: what the runner's advert says about `card.prClose` (and so `deleteBranch`). */
export type BranchCleanupGate = 'ok' | 'outdated' | 'disabled';

export function branchCleanupGate(
  advert: RunnerCommands | null | undefined,
): BranchCleanupGate {
  // No advert is unknown, never none: the API answers `command_unavailable`.
  if (!advert) return 'ok';
  // By name: the allowlist entry lands with the runner slot (i329-runner), and
  // `commandsSupport` takes only names the allowlist already has.
  const has = (list: readonly string[]) => list.includes(PR_CLOSE_COMMAND);
  if (!has(advert.commands)) return 'outdated';
  return has(advert.disabled) ? 'disabled' : 'ok';
}

const PR_CLOSE_COMMAND = 'card.prClose';

export const BRANCH_CLEANUP_HINT: Record<
  Exclude<BranchCleanupGate, 'ok'>,
  string
> = {
  outdated:
    'Update the runner to delete branches and close pull requests from here.',
  disabled:
    'The runner has closing pull requests switched off (disabledCommands).',
};

/** The shown state of the “Delete the branch” checkbox. */
export function deleteBranchControl(
  card: Pick<BoardCardView, 'source'>,
  options: AcceptOptions,
  gate: BranchCleanupGate,
): { checked: boolean; disabled: boolean; hint: string | null } {
  if (isTerminalCard(card)) {
    return {
      checked: false,
      disabled: true,
      hint: 'A terminal card’s branch is your session branch, so it is kept.',
    };
  }
  if (gate !== 'ok') {
    return { checked: false, disabled: true, hint: BRANCH_CLEANUP_HINT[gate] };
  }
  return { checked: options.deleteBranch, disabled: false, hint: null };
}

/**
 * The body of Accept with a merge. `deleteBranch` is sent only when it is
 * true, so a runner older than the arg never sees it.
 */
export function mergeRequest(
  card: Pick<BoardCardView, 'source'>,
  headSha: string,
  options: AcceptOptions,
  gate: BranchCleanupGate,
): AcceptBoardCardRequest {
  const del = deleteBranchControl(card, options, gate).checked;
  return { merge: del ? { headSha, deleteBranch: true } : { headSha } };
}

/**
 * The body of Accept without merging: `{}` leaves the PR open; with the
 * close choice it carries `closePr`.
 */
export function noMergeRequest(
  card: Pick<BoardCardView, 'source'>,
  options: AcceptOptions,
  gate: BranchCleanupGate,
): AcceptBoardCardRequest {
  if (!options.closePr || gate !== 'ok') return {};
  return {
    closePr: {
      deleteBranch: !isTerminalCard(card),
      closeIssue: options.closeIssue,
    },
  };
}

/**
 * #709: Accept refused because the card's work has not landed in the base —
 * the API's sentence naming the missing landing; null for any other error.
 */
export function notLandedReason(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code: string | undefined = error.code;
  return code === BOARD_ERROR.notLanded ? error.message : null;
}

/** #709: the same Accept, sent again once the person confirms it. */
export const confirmUnlanded = (
  request: AcceptBoardCardRequest,
): AcceptBoardCardRequest => ({ ...request, confirmUnlanded: true });
