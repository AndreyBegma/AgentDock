import type { CardMergeOutcome, CardPullRequestView } from '@agentdock/shared';

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
): AcceptChoice {
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
): { text: string; warn: boolean } {
  if (merge === null) return { text: `${label} accepted.`, warn: false };
  if (merge.merged && !merge.issueClosed) {
    return {
      text: `${label} accepted and merged, but its issue stayed open${
        merge.issueError ? `: ${merge.issueError}` : '.'
      }`,
      warn: true,
    };
  }
  return {
    text: merge.alreadyMerged
      ? `${label} accepted. Its pull request was already merged.`
      : `${label} accepted and its pull request merged.`,
    warn: false,
  };
}
