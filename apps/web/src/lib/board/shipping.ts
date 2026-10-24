import {
  type BoardCardDetail,
  type BoardCardView,
  type BoardSettingsView,
  CARD_CI_FIX_ATTEMPTS_MAX,
  type CardCiCheck,
  type CardCiState,
  type CardNeedsPersonReason,
  type CardPullRequestRef,
  type CardReviewStepState,
  type CardReviewView,
  type CardRoundView,
  REVIEW_FIX_ROUNDS_MAX,
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

/** C-182: auto-merge refused a head whose checks did not all pass. */
export const CI_NOT_GREEN_TEXT = 'Not every check passed; not merged';

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

/** #884 (ADR-0084): the review gate stopped. */
export const REVIEW_STILL_BLOCKING_TEXT = `Review still blocking after ${REVIEW_FIX_ROUNDS_MAX} fixes`;
export const REVIEW_FAILED_TEXT = 'A review step did not finish';

/** C-148 (ADR-0077): a push changed CI, deploy or plugin files. */
export const PROTECTED_PATHS_TEXT = 'Protected paths changed; a person merges';

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
    case 'ci_not_green':
      return CI_NOT_GREEN_TEXT;
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
    case 'review_still_blocking':
      return REVIEW_STILL_BLOCKING_TEXT;
    case 'review_failed':
      return REVIEW_FAILED_TEXT;
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
  /** #891: the review chip, whose step name truncates on a phone. */
  review?: true;
}

/**
 * #891: the review chip of an In progress card, in the family of the CI one.
 * Only a running or fixing gate has one; a stopped gate is the needs-person
 * badge (`needsPersonText`), a passed or idle one shows nothing.
 */
export function reviewChip(
  review: CardReviewView | null,
): ShippingBadge | null {
  if (review === null) return null;
  if (review.state === 'running') {
    const step = review.currentStep ?? review.steps[review.stepIndex]?.name;
    const n = Math.min(review.stepIndex + 1, review.stepCount);
    return {
      tone: 'warn',
      label: step
        ? `Reviewing · ${step} (${n}/${review.stepCount})`
        : `Reviewing (${n}/${review.stepCount})`,
      review: true,
    };
  }
  if (review.state === 'fixing') {
    const n = Math.min(Math.max(review.fixRound, 1), review.fixLimit);
    return {
      tone: 'warn',
      label: `Fixing review (${n}/${review.fixLimit})`,
      review: true,
    };
  }
  return null;
}

/**
 * #891: the readiness line of a Finished card whose project reviews: what it
 * passed. `null` while review is off or the gate did not pass (an accepted
 * card never ran it).
 */
export function readinessLine(
  card: Pick<BoardCardView, 'column' | 'ciState' | 'review'>,
): string[] | null {
  const { review } = card;
  if (card.column !== 'finished' || review === null) return null;
  if (review.state !== 'passed') return null;
  const parts = [];
  if (card.ciState === 'green') parts.push('CI passed');
  parts.push('Review passed');
  if (review.fixRound > 0) parts.push('Fixes done');
  return parts;
}

/** #891: one stop of the sheet's tracker: CI → each step → Finished. */
export interface TrackerStep {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'passed' | 'blocked' | 'failed';
  blocking: number;
  nits: number;
}

const stepState = (state: CardReviewStepState): TrackerStep['state'] => state;

export function reviewTracker(
  card: Pick<BoardCardView, 'ciState' | 'review'>,
): TrackerStep[] {
  const { review } = card;
  if (review === null) return [];
  const ci: TrackerStep['state'] =
    card.ciState === 'green'
      ? 'passed'
      : card.ciState === 'red'
        ? 'failed'
        : card.ciState === 'pending'
          ? 'running'
          : 'pending';
  return [
    { key: 'ci', label: 'CI', state: ci, blocking: 0, nits: 0 },
    ...review.steps.map((s) => ({
      key: s.id,
      label: s.name,
      state: stepState(s.state),
      blocking: s.blockingCount,
      nits: s.nitCount,
    })),
    {
      key: 'finished',
      label: 'Finished',
      state: review.state === 'passed' ? 'passed' : 'pending',
      blocking: 0,
      nits: 0,
    },
  ];
}

export const TRACKER_STATE_LABEL: Record<TrackerStep['state'], string> = {
  pending: 'Waiting',
  running: 'Running',
  passed: 'Passed',
  blocked: 'Blocking',
  failed: 'Did not finish',
};

/** #891: "2 blocking · 1 nit", or `null` when the step reported nothing. */
export function findingCounts(blocking: number, nits: number): string | null {
  const parts = [];
  if (blocking > 0) parts.push(`${blocking} blocking`);
  if (nits > 0) parts.push(`${nits} ${nits === 1 ? 'nit' : 'nits'}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** #891: "src/a.ts:12", "src/a.ts", or `null` for a finding about no file. */
export function findingPlace(finding: {
  file?: string;
  line?: number;
}): string | null {
  if (!finding.file) return null;
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

/** #891: the card's review fix rounds, oldest first, each linking to its round. */
export const reviewFixRounds = (
  rounds: readonly Pick<CardRoundView, 'round' | 'trigger'>[],
): { round: number; label: string }[] =>
  rounds
    .filter((r) => r.trigger === 'review_fix')
    .sort((a, b) => a.round - b.round)
    .map((r, i) => ({
      round: r.round,
      label: `Review fix ${i + 1} · Round ${r.round}`,
    }));

/**
 * #359 D6–D8: the one sub-state a card shows next to its PR chip.
 * - `needsPerson` beats everything: automation stopped (D6);
 * - a merged card is "Merged" and stays in Finished (D8);
 * - an unmerged card whose push changed a protected path is never
 *   auto-merged (C-148);
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
    | 'protectedPaths'
    | 'review'
  >,
): ShippingBadge | null {
  if (card.needsPerson) return { tone: 'danger', label: needsPersonText(card) };
  if (card.mergedAt !== null) return { tone: 'ok', label: 'Merged' };
  if (card.protectedPaths.length > 0) {
    return { tone: 'warn', label: PROTECTED_PATHS_TEXT };
  }
  if (card.column !== 'in_progress') return null;
  const review = reviewChip(card.review);
  if (review) return review;
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

/**
 * C-148 (ADR-0077): the sheet's banner while the card's latest push changed
 * a protected path and its PR is not merged — never auto-merged, whatever
 * the project's switch; `null` otherwise.
 */
export function protectedPathsBanner(
  card: Pick<BoardCardView, 'protectedPaths' | 'mergedAt'>,
): { title: string; paths: string[]; hint: string } | null {
  if (card.protectedPaths.length === 0 || card.mergedAt !== null) return null;
  return {
    title: PROTECTED_PATHS_TEXT,
    paths: card.protectedPaths,
    hint: 'These files run in CI, deploys or plugins, so the board never merges this card on its own. Review the changes, then Accept.',
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
