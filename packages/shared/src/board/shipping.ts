import { z } from 'zod';
import type {
  CardCheck,
  CardDraftPullRequest,
} from '../protocol/commands/cards';
import { CARD_PR_MARKER, cardLabel } from './naming';
import type { CardCiState } from './types';

/**
 * A card ships itself (issue #359, ADR-0035): the pure rules the runner, the
 * API and the web share — the draft PR (D1), the CI state (D5), the
 * auto-merge default (D7) and the follow-up branch (D8).
 */

/** #359 D5: failed checks a card keeps in `ciChecks`, at most. */
export const CARD_CI_CHECKS_STORED_MAX = 20;

/** #359 D5: one failed check as the card stores and shows it. */
export const cardCiCheckSchema = z.object({
  name: z.string().min(1).max(200),
  /** The check's details page; `null` when GitHub gives none. */
  link: z.url({ protocol: /^https$/ }).nullable(),
});
export type CardCiCheck = z.infer<typeof cardCiCheckSchema>;

/**
 * Checks that say nothing about the head: CI cancels a superseded pipeline on
 * every push, and a skipped check did not run.
 */
const IGNORED_BUCKETS: ReadonlySet<CardCheck['bucket']> = new Set([
  'cancel',
  'skipping',
]);

/**
 * #359 D5: the head's checks as one state. Cancelled and skipped checks are
 * ignored. No other check is `none` — the repository has none, or they have
 * not registered yet. A failed check is `red` even while others still run,
 * so a fix round does not wait for the slowest check; otherwise a running
 * one is `pending`; when every one passed, `green`.
 */
export const cardCiStateOf = (checks: readonly CardCheck[]): CardCiState => {
  const counted = checks.filter((c) => !IGNORED_BUCKETS.has(c.bucket));
  if (counted.length === 0) return 'none';
  if (counted.some((c) => c.bucket === 'fail')) return 'red';
  if (counted.some((c) => c.bucket === 'pending')) return 'pending';
  return 'green';
};

/**
 * #837: the head's checks as a round counts them — passed, of those
 * `cardCiStateOf` counts (cancelled and skipped ones left out).
 */
export const cardCheckCounts = (
  checks: readonly CardCheck[],
): { passed: number; total: number } => {
  const counted = checks.filter((c) => !IGNORED_BUCKETS.has(c.bucket));
  return {
    passed: counted.filter((c) => c.bucket === 'pass').length,
    total: counted.length,
  };
};

/** `https://github.com/<owner>/<repo>` of a pull request's URL. */
const PR_URL = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+\/?$/;

/**
 * #837: GitHub's checks page of `sha`, in the repository of `prUrl`; the PR's
 * own URL when `prUrl` is not a pull request's.
 */
export const commitChecksUrl = (prUrl: string, sha: string): string => {
  const repo = PR_URL.exec(prUrl)?.[1];
  return repo ? `${repo}/commit/${sha}/checks` : prUrl;
};

/**
 * C-182 (D-12, ADR-0080): whether the head's checks let auto-merge ship it —
 * stricter than `cardCiStateOf`'s `green`. At least one check, and every one
 * passed: no checks, a cancelled or a skipped check is not proof that CI ran
 * on the head, so only a person merges it.
 */
export const cardCiMergeable = (checks: readonly CardCheck[]): boolean =>
  checks.length > 0 && checks.every((c) => c.bucket === 'pass');

/** #359 D5: the failed checks, in the order `gh` listed them, as `ciChecks` keeps them. */
export const failedCardChecks = (checks: readonly CardCheck[]): CardCiCheck[] =>
  checks
    .filter((c) => c.bucket === 'fail')
    .slice(0, CARD_CI_CHECKS_STORED_MAX)
    .map(({ name, link }) => ({ name, link }));

/** #359 D5: a stored `board_cards.ciChecks`; anything malformed is dropped. */
export const cardCiChecksOf = (json: unknown): CardCiCheck[] =>
  Array.isArray(json)
    ? json.flatMap((item) => {
        const parsed = cardCiCheckSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

/**
 * #359 D7: auto-merge is on by default for an integration base (develop),
 * off for the repository's default branch. C-148 (ADR-0077): an unknown
 * default branch is off too — a name like `trunk` is no proof of anything.
 */
export const cardAutoMergeDefault = (
  base: string,
  defaultBranch: string | null = null,
): boolean => defaultBranch !== null && base !== defaultBranch;

/** #359 D7: the project's switch, `null` following `cardAutoMergeDefault`. */
export const cardAutoMergeEnabled = (
  stored: boolean | null,
  base: string,
  defaultBranch: string | null = null,
): boolean => stored ?? cardAutoMergeDefault(base, defaultBranch);

/**
 * #359 D8: the branch of a card's `k`-th PR. The first is the card's own
 * branch (`cardBranch`); a follow-up after a merge appends `-<k>` —
 * `card/c<n>-<slug>-2`.
 */
export const cardFollowUpBranch = (first: string, k: number): string => {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`PR ordinal must be a positive integer, got ${k}`);
  }
  return k === 1 ? first : `${first}-${k}`;
};

/** `gh pr create --title`, at most 256 characters on one line. */
const PR_TITLE_MAX = 256;

export interface CardDraftPullRequestInput {
  number: number;
  title: string;
  /** Set for a bug card (D4): the body then says `Closes #n`. */
  issueNumber: number | null;
}

/**
 * #359 D1: the draft PR `card.run` asks the runner to open — titled
 * `C-<n>: <title>`, its body a placeholder until the worker's description
 * (D3), with `Closes #n` and the card marker. The runner leads it with the
 * spec link, as for every PR body it opens.
 */
export const cardDraftPullRequest = (
  card: CardDraftPullRequestInput,
): CardDraftPullRequest => {
  const label = cardLabel(card.number);
  const oneLine = card.title.replace(/\s+/g, ' ').trim();
  const full = `${label}: ${oneLine}`;
  const title =
    full.length > PR_TITLE_MAX ? `${full.slice(0, PR_TITLE_MAX - 1)}…` : full;
  const parts = [
    `Work in progress on Nautelle board card ${label}. The description is written when the worker finishes.`,
  ];
  if (card.issueNumber !== null) parts.push(`Closes #${card.issueNumber}`);
  parts.push(`${CARD_PR_MARKER}: ${label}`);
  return { title, body: parts.join('\n\n') };
};
