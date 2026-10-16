import {
  type BoardCardDetail,
  type BoardCardView,
  type BoardSettingsView,
  CARD_CI_FIX_ATTEMPTS_MAX,
  type CardCiCheck,
  type CardCiState,
  type CardPullRequestRef,
} from '@agentdock/shared';
import { PR_STATE_LABEL } from './pull-request';

/** #359 D5: the CI dot beside the PR chip. `null` while the PR has no checks to show. */
export interface CiDot {
  tone: 'ok' | 'warn' | 'danger';
  label: string;
}

const CI_DOT: Record<Exclude<CardCiState, 'none'>, CiDot> = {
  pending: { tone: 'warn', label: 'Checks running' },
  green: { tone: 'ok', label: 'Checks passed' },
  red: { tone: 'danger', label: 'Checks failed' },
};

export function ciDot(card: Pick<BoardCardView, 'ciState'>): CiDot | null {
  return card.ciState === 'none' ? null : CI_DOT[card.ciState];
}

/** #359 D6: the text of the budget stop, also the sheet banner's headline. */
export const CI_STILL_FAILING_TEXT = `CI still failing after ${CARD_CI_FIX_ATTEMPTS_MAX} fixes`;

/** #484: the budget stop's text when CI never reported on the head. */
export const CI_NOT_REPORTED_TEXT = 'CI reported no checks';

/** Why automation stopped: no checks at all (#484), or red ones (#359 D6). */
const needsPersonText = (card: Pick<BoardCardView, 'ciState'>): string =>
  card.ciState === 'none' ? CI_NOT_REPORTED_TEXT : CI_STILL_FAILING_TEXT;

/** #359 D7/D8: a sub-state badge on the card face. */
export interface ShippingBadge {
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  label: string;
}

/**
 * #359 D6–D8: the one sub-state a card shows next to its PR chip.
 * - `needsPerson` beats everything: automation stopped (D6);
 * - a merged card is "Merged" and stays in Finished (D8);
 * - an In progress card with red CI and fix rounds spent is "Fixing CI (n/3)";
 * - an In progress card whose checks are running is "Checks running" (D7).
 */
export function shippingBadge(
  card: Pick<
    BoardCardView,
    'column' | 'ciState' | 'ciFixAttempts' | 'needsPerson' | 'mergedAt'
  >,
): ShippingBadge | null {
  if (card.needsPerson) return { tone: 'danger', label: needsPersonText(card) };
  if (card.mergedAt !== null) return { tone: 'ok', label: 'Merged' };
  if (card.column !== 'in_progress') return null;
  if (card.ciState === 'red' && card.ciFixAttempts > 0) {
    const n = Math.min(card.ciFixAttempts, CARD_CI_FIX_ATTEMPTS_MAX);
    return {
      tone: 'warn',
      label: `Fixing CI (${n}/${CARD_CI_FIX_ATTEMPTS_MAX})`,
    };
  }
  if (card.ciState === 'pending') {
    return { tone: 'warn', label: 'Checks running' };
  }
  return null;
}

/**
 * The sheet's banner when automation stopped on a red CI (#359 D6) or on a
 * head CI never reported on, even after a retrigger (#484); `null` otherwise.
 */
export function ciBanner(
  card: Pick<BoardCardView, 'needsPerson' | 'ciChecks' | 'ciState'>,
): { title: string; checks: CardCiCheck[]; hint: string } | null {
  if (!card.needsPerson) return null;
  return {
    title: needsPersonText(card),
    checks: card.ciChecks,
    hint: 'Nothing runs on its own now. Send feedback, Run again, or Accept.',
  };
}

/** One row of the card's PR list. */
export interface PullRequestRow {
  number: number;
  url: string;
  branch: string;
  state: string;
  round: number;
}

/** #359 D8: every PR of the card, newest first; the first row is the one `prUrl` points at. */
export const pullRequestRows = (
  card: Pick<BoardCardDetail, 'pullRequests'>,
): PullRequestRow[] =>
  [...card.pullRequests]
    .sort(
      (a: CardPullRequestRef, b: CardPullRequestRef) =>
        b.round - a.round || b.number - a.number,
    )
    .map((pr) => ({
      number: pr.number,
      url: pr.url,
      branch: pr.branch,
      state: PR_STATE_LABEL[pr.state],
      round: pr.round,
    }));

/** #359 D7: the stored switch, or the base's default while the project never set one. */
export const effectiveAutoMerge = (
  settings: Pick<BoardSettingsView, 'autoMergeCards' | 'autoMergeCardsDefault'>,
): boolean => settings.autoMergeCards ?? settings.autoMergeCardsDefault;

export const AUTO_MERGE_LABEL = 'Merge finished cards automatically';

/** #359 D7: what the switch's current value means, naming the default when it follows it. */
export function autoMergeHint(
  settings: Pick<BoardSettingsView, 'autoMergeCards' | 'autoMergeCardsDefault'>,
  checked: boolean,
  followsDefault: boolean,
): string {
  const effect = checked
    ? 'A card whose worker is done and whose checks are green is merged and its branch deleted. It stays in Finished as Merged.'
    : 'A finished card waits for Accept.';
  const dflt = settings.autoMergeCardsDefault ? 'on' : 'off';
  return followsDefault
    ? `${effect} Following the default for this base: ${dflt}.`
    : `${effect} The default for this base is ${dflt}.`;
}
