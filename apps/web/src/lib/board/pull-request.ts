import type {
  BoardCardView,
  CardCollectOutcome,
  CardPrState,
  CardPrTarget,
} from '@agentdock/shared';

/** #329 D6: the PR's state as the card shows it, next to `PR #n`. */
export const PR_STATE_LABEL: Record<CardPrState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

/** `PR #7` alone while the state is unknown, else `PR #7 · Merged`. */
export function prChipText(
  card: Pick<BoardCardView, 'prNumber' | 'prState'>,
): string | null {
  if (card.prNumber === null) return null;
  return card.prState
    ? `PR #${card.prNumber} · ${PR_STATE_LABEL[card.prState]}`
    : `PR #${card.prNumber}`;
}

/**
 * #636: where the card's PR goes — "into C-1's branch" for a card stacked on
 * its dependency, else "into develop"; null before the card has a branch.
 */
export function prTargetText(target: CardPrTarget | null): string | null {
  if (target === null) return null;
  return target.stackedOn
    ? `into ${target.stackedOn.label}’s branch`
    : `into ${target.branch}`;
}

/** #329 D5: shared with the bot (#578). */
export { canCreatePr } from '@agentdock/shared';

/** The sheet's line above Create pull request. */
export function noPrText(
  card: Pick<BoardCardView, 'collectState' | 'collectError'>,
): { tone: 'warn' | 'info'; text: string } {
  if (card.collectState === 'failed') {
    return {
      tone: 'warn',
      text: `No pull request: ${card.collectError ?? 'collecting the work failed.'}`,
    };
  }
  if (card.collectState === 'pending') {
    return { tone: 'info', text: 'Opening the pull request…' };
  }
  return { tone: 'info', text: 'No pull request yet.' };
}

/** The toast after a manual collect; `failed` is an answer, not an error status. */
export function collectMessage(
  label: string,
  outcome: CardCollectOutcome,
): { text: string; ok: boolean } {
  if (outcome.state === 'ok') {
    return {
      text: outcome.prNumber
        ? `${label}: pull request #${outcome.prNumber} is open.`
        : `${label}: pull request opened.`,
      ok: true,
    };
  }
  if (outcome.state === 'no_changes') {
    return {
      text: `${label} has no commits ahead of the base, so there is nothing to open.`,
      ok: true,
    };
  }
  return {
    text: `No pull request for ${label}: ${outcome.error ?? 'collecting the work failed.'}`,
    ok: false,
  };
}
