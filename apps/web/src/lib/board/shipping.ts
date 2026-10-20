import {
  type BoardCardDetail,
  type BoardCardView,
  type BoardSettingsView,
  CARD_CI_FIX_ATTEMPTS_MAX,
  type CardCiCheck,
  type CardCiState,
  type CardNeedsPersonReason,
  type CardPullRequestRef,
} from '@nautelle/shared';
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

/**
 * #542: why auto-merge refused the head the latest round left — the round
 * did not do the card's work.
 */
export const NEEDS_PERSON_ROUND_TEXT: Record<
  Extract<
    CardNeedsPersonReason,
    'round_failed' | 'round_pushed_nothing' | 'round_ended_at_once'
  >,
  string
> = {
  round_failed: 'Last round failed; not merged',
  round_pushed_nothing: 'Last round pushed no commit; not merged',
  round_ended_at_once: 'Last round ended at once; not merged',
};

/** #630: the runner pushed nothing — `origin/<branch>` has somebody else's commits. */
export const BRANCH_DIVERGED_TEXT = 'Branch diverged on origin; not pushed';

/** #709: the forward PR of a merge into a dead dependency branch. */
export const FORWARD_CONFLICT_TEXT = 'Forward PR conflicts with the base';
export const FORWARD_FAILED_TEXT =
  'Merged into a dead branch; forward PR not opened';

/**
 * Why automation stopped: the stored reason, else — a card marked before
 * #542 — no checks at all (#484), or red ones (#359 D6).
 */
const needsPersonText = (
  card: Pick<BoardCardView, 'ciState' | 'needsPersonReason'>,
): string => {
  switch (card.needsPersonReason) {
    case 'ci_still_failing':
      return CI_STILL_FAILING_TEXT;
    case 'ci_not_reported':
      return CI_NOT_REPORTED_TEXT;
    case 'round_failed':
    case 'round_pushed_nothing':
    case 'round_ended_at_once':
      return NEEDS_PERSON_ROUND_TEXT[card.needsPersonReason];
    case 'branch_diverged':
      return BRANCH_DIVERGED_TEXT;
    case 'forward_conflict':
      return FORWARD_CONFLICT_TEXT;
    case 'forward_failed':
      return FORWARD_FAILED_TEXT;
    case null:
      return card.ciState === 'none'
        ? CI_NOT_REPORTED_TEXT
        : CI_STILL_FAILING_TEXT;
  }
};

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
    | 'column'
    | 'ciState'
    | 'ciFixAttempts'
    | 'needsPerson'
    | 'needsPersonReason'
    | 'mergedAt'
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
 * The sheet's banner when automation stopped on a red CI (#359 D6), on a
 * head CI never reported on, even after a retrigger (#484), or on a head
 * the latest round did not work on (#542), or on a branch whose remote
 * diverged (#630); `null` otherwise.
 */
export function ciBanner(
  card: Pick<
    BoardCardView,
    'needsPerson' | 'needsPersonReason' | 'ciChecks' | 'ciState'
  >,
): { title: string; checks: CardCiCheck[]; hint: string } | null {
  if (!card.needsPerson) return null;
  return {
    title: needsPersonText(card),
    checks: card.ciChecks,
    hint:
      card.needsPersonReason === 'branch_diverged'
        ? 'Nothing was pushed: the remote branch has commits the card’s branch never had. Merge them into the branch — yourself, or by Send feedback — then Create pull request.'
        : 'Nothing runs on its own now. Send feedback, Run again, or Accept.',
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
