import { describe, expect, it } from 'bun:test';
import type { CardCheck } from '../protocol/commands/cards';
import { cardDraftPullRequestSchema } from '../protocol/commands/cards';
import { CARD_PR_MARKER } from './naming';
import {
  CARD_CI_CHECKS_STORED_MAX,
  cardAutoMergeDefault,
  cardAutoMergeEnabled,
  cardCheckCounts,
  cardCiChecksOf,
  cardCiMergeable,
  cardCiStateOf,
  cardDraftPullRequest,
  cardFollowUpBranch,
  commitChecksUrl,
  failedCardChecks,
} from './shipping';
import { CARD_CI_FIX_ATTEMPTS_MAX, CARD_ROUND_TRIGGERS } from './types';
import {
  CARD_CI_FIX_CHECKS_LISTED_MAX,
  CARD_CI_FIX_CHECKS_TEXT_MAX_BYTES,
  cardCiFixPrompt,
  FINISH_CARD_TOOL,
} from './worker-prompt';

const check = (
  name: string,
  bucket: CardCheck['bucket'],
  link: string | null = `https://ci.example/${name}`,
): CardCheck => ({ name, bucket, link });

describe('cardCiStateOf (#359 D5)', () => {
  it('is none without checks, or with only cancelled and skipped ones', () => {
    expect(cardCiStateOf([])).toBe('none');
    expect(cardCiStateOf([check('a', 'cancel'), check('b', 'skipping')])).toBe(
      'none',
    );
  });

  it('is green when every counted check passed', () => {
    expect(cardCiStateOf([check('a', 'pass'), check('b', 'skipping')])).toBe(
      'green',
    );
  });

  it('ignores a cancelled check — a superseded pipeline is not a failure', () => {
    expect(cardCiStateOf([check('a', 'pass'), check('b', 'cancel')])).toBe(
      'green',
    );
    expect(cardCiStateOf([check('a', 'pending'), check('b', 'cancel')])).toBe(
      'pending',
    );
  });

  it('is pending while a check runs and none failed', () => {
    expect(cardCiStateOf([check('a', 'pass'), check('b', 'pending')])).toBe(
      'pending',
    );
  });

  it('is red only on a real failure, even while others run', () => {
    expect(cardCiStateOf([check('a', 'pending'), check('b', 'fail')])).toBe(
      'red',
    );
  });
});

describe('cardCiMergeable (C-182)', () => {
  it('is false without checks', () => {
    expect(cardCiMergeable([])).toBe(false);
  });

  it('is false with a cancelled or skipped check, though the state is green', () => {
    const cancelled = [check('a', 'pass'), check('b', 'cancel')];
    const skipped = [check('a', 'pass'), check('b', 'skipping')];
    expect(cardCiStateOf(cancelled)).toBe('green');
    expect(cardCiMergeable(cancelled)).toBe(false);
    expect(cardCiStateOf(skipped)).toBe('green');
    expect(cardCiMergeable(skipped)).toBe(false);
  });

  it('is false while a check runs or after one failed', () => {
    expect(cardCiMergeable([check('a', 'pass'), check('b', 'pending')])).toBe(
      false,
    );
    expect(cardCiMergeable([check('a', 'pass'), check('b', 'fail')])).toBe(
      false,
    );
  });

  it('is true when every check passed', () => {
    expect(cardCiMergeable([check('a', 'pass'), check('b', 'pass')])).toBe(
      true,
    );
  });
});

describe('a round head’s checks (#837)', () => {
  it('counts passed checks of those that ran, without cancelled and skipped ones', () => {
    expect(cardCheckCounts([])).toEqual({ passed: 0, total: 0 });
    expect(
      cardCheckCounts([
        check('a', 'pass'),
        check('b', 'fail'),
        check('c', 'pending'),
        check('d', 'cancel'),
        check('e', 'skipping'),
      ]),
    ).toEqual({ passed: 1, total: 3 });
  });

  it('links the commit’s checks page in the PR’s repository', () => {
    expect(
      commitChecksUrl('https://github.com/acme/widget/pull/812', 'abc1234'),
    ).toBe('https://github.com/acme/widget/commit/abc1234/checks');
    expect(commitChecksUrl('https://example.com/elsewhere', 'abc1234')).toBe(
      'https://example.com/elsewhere',
    );
  });
});

describe('failedCardChecks and cardCiChecksOf (#359 D5)', () => {
  it('keeps the failed checks, name and link, in order and bounded', () => {
    const checks = [
      check('lint', 'pass'),
      check('test', 'fail'),
      check('stale', 'cancel'),
      check('e2e', 'fail', null),
      ...Array.from({ length: CARD_CI_CHECKS_STORED_MAX + 5 }, (_, i) =>
        check(`x${i}`, 'fail'),
      ),
    ];
    const failed = failedCardChecks(checks);
    expect(failed).toHaveLength(CARD_CI_CHECKS_STORED_MAX);
    expect(failed[0]).toEqual({
      name: 'test',
      link: 'https://ci.example/test',
    });
    expect(failed[1]).toEqual({ name: 'e2e', link: null });
  });

  it('reads stored checks back, dropping anything malformed', () => {
    expect(
      cardCiChecksOf([
        { name: 'test', link: 'https://ci.example/1' },
        { name: '', link: null },
        { name: 'x', link: 'javascript:alert(1)' },
        'junk',
      ]),
    ).toEqual([{ name: 'test', link: 'https://ci.example/1' }]);
    expect(cardCiChecksOf(null)).toEqual([]);
    expect(cardCiChecksOf({ name: 'test' })).toEqual([]);
  });
});

describe('auto-merge default (#359 D7)', () => {
  it('is on for an integration base and off for the default branch', () => {
    expect(cardAutoMergeDefault('develop', 'main')).toBe(true);
    expect(cardAutoMergeDefault('main', 'main')).toBe(false);
    expect(cardAutoMergeDefault('master', 'master')).toBe(false);
  });

  it('follows the repository default branch when it is known', () => {
    expect(cardAutoMergeDefault('develop', 'develop')).toBe(false);
    expect(cardAutoMergeDefault('main', 'trunk')).toBe(true);
  });

  // C-148: a default branch not named main is no longer missed by name.
  it('is off for a trunk default with base trunk', () => {
    expect(cardAutoMergeDefault('trunk', 'trunk')).toBe(false);
  });

  it('is off while the default branch is unknown', () => {
    expect(cardAutoMergeDefault('develop')).toBe(false);
    expect(cardAutoMergeDefault('develop', null)).toBe(false);
    expect(cardAutoMergeEnabled(null, 'develop', null)).toBe(false);
  });

  it('the stored switch wins over the default', () => {
    expect(cardAutoMergeEnabled(null, 'develop', 'main')).toBe(true);
    expect(cardAutoMergeEnabled(false, 'develop')).toBe(false);
    expect(cardAutoMergeEnabled(true, 'main')).toBe(true);
  });
});

describe('cardFollowUpBranch (#359 D8)', () => {
  it('is the card branch for the first PR and -<k> after', () => {
    expect(cardFollowUpBranch('card/c12-add-login', 1)).toBe(
      'card/c12-add-login',
    );
    expect(cardFollowUpBranch('card/c12-add-login', 2)).toBe(
      'card/c12-add-login-2',
    );
  });

  it('refuses an ordinal below 1', () => {
    expect(() => cardFollowUpBranch('card/c12-x', 0)).toThrow(RangeError);
    expect(() => cardFollowUpBranch('card/c12-x', 1.5)).toThrow(RangeError);
  });
});

describe('cardDraftPullRequest (#359 D1)', () => {
  it('is titled C-<n>: <title> and carries the marker', () => {
    const pr = cardDraftPullRequest({
      number: 12,
      title: 'Add  login\nform',
      issueNumber: null,
    });
    expect(pr.title).toBe('C-12: Add login form');
    expect(pr.body).toContain(`${CARD_PR_MARKER}: C-12`);
    expect(pr.body).not.toContain('Closes');
    expect(cardDraftPullRequestSchema.safeParse(pr).success).toBe(true);
  });

  it('closes the issue of a bug card', () => {
    expect(
      cardDraftPullRequest({ number: 3, title: 'Crash', issueNumber: 77 }).body,
    ).toContain('Closes #77');
  });

  it('fits a very long title', () => {
    const pr = cardDraftPullRequest({
      number: 1,
      title: 'x'.repeat(400),
      issueNumber: null,
    });
    expect(pr.title.length).toBeLessThanOrEqual(256);
    expect(cardDraftPullRequestSchema.safeParse(pr).success).toBe(true);
  });
});

describe('ci_fix round (#359 D6)', () => {
  it('is a round trigger with a budget of 3', () => {
    expect(CARD_ROUND_TRIGGERS).toContain('ci_fix');
    expect(CARD_CI_FIX_ATTEMPTS_MAX).toBe(3);
  });

  it('names the head, each failed check and its link, and the project checks', () => {
    const prompt = cardCiFixPrompt({
      reason: 'red',
      headSha: 'c'.repeat(40),
      failed: [
        { name: 'test', link: 'https://ci.example/1' },
        { name: 'lint', link: null },
      ],
      checks: 'bun run check\nbun run test',
    });
    expect(prompt).toContain(`CI failed on ${'c'.repeat(12)}`);
    expect(prompt).toContain('- test — https://ci.example/1');
    expect(prompt).toContain('- lint');
    expect(prompt).toContain('bun run check\nbun run test');
    expect(prompt).toContain(FINISH_CARD_TOOL);
    expect(prompt).toContain('Do not push');
  });

  it('points at CLAUDE.md when the project has no checks', () => {
    const prompt = cardCiFixPrompt({
      reason: 'red',
      headSha: 'c'.repeat(40),
      failed: [{ name: 'test', link: null }],
      checks: '  ',
    });
    expect(prompt).toContain('CLAUDE.md / AGENTS.md');
  });

  it('lists the first checks and counts the rest; long checks text is cut', () => {
    const failed = Array.from(
      { length: CARD_CI_FIX_CHECKS_LISTED_MAX + 3 },
      (_, i) => ({
        name: `check-${i}`,
        link: null,
      }),
    );
    const prompt = cardCiFixPrompt({
      reason: 'red',
      headSha: 'c'.repeat(40),
      failed,
      checks: 'y'.repeat(CARD_CI_FIX_CHECKS_TEXT_MAX_BYTES * 2),
    });
    expect(prompt).toContain(`check-${CARD_CI_FIX_CHECKS_LISTED_MAX - 1}`);
    expect(prompt).not.toContain(`check-${CARD_CI_FIX_CHECKS_LISTED_MAX}\n`);
    expect(prompt).toContain('(and 3 more)');
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(
      CARD_CI_FIX_CHECKS_TEXT_MAX_BYTES + 2048,
    );
  });

  it('asks a conflict round to merge the base, resolve and commit', () => {
    const prompt = cardCiFixPrompt({ reason: 'conflict', base: 'develop' });
    expect(prompt).toContain('conflicts with develop');
    expect(prompt).toContain('git merge origin/develop');
    expect(prompt).toContain('resolve the conflicts');
    expect(prompt).toContain(FINISH_CARD_TOOL);
  });
});
