import { describe, expect, test } from 'bun:test';
import type { CardReviewView } from '@nautelle/shared';
import { card } from './fixtures';
import {
  autoMergeHint,
  ciBanner,
  ciDot,
  effectiveAutoMerge,
  findingCounts,
  findingPlace,
  protectedPathsBanner,
  pullRequestRows,
  readinessLine,
  reviewFixRounds,
  reviewTracker,
  shippingBadge,
} from './shipping';

describe('ciDot (#359 D5)', () => {
  test('none shows no dot', () => {
    expect(ciDot({ ciState: 'none' })).toBeNull();
  });
  test('pending, green and red', () => {
    expect(ciDot({ ciState: 'pending' })?.tone).toBe('warn');
    expect(ciDot({ ciState: 'green' })?.tone).toBe('ok');
    expect(ciDot({ ciState: 'red' })?.tone).toBe('danger');
  });
});

describe('shippingBadge (#359 D6–D8)', () => {
  test('red with spent rounds is Fixing CI (n/3)', () => {
    const c = card(1, 'in_progress', { ciState: 'red', ciFixAttempts: 2 });
    expect(shippingBadge(c)?.label).toBe('Fixing CI (2/3)');
  });
  test('pending in In progress is Checks running; in Finished nothing', () => {
    expect(
      shippingBadge(card(1, 'in_progress', { ciState: 'pending' }))?.label,
    ).toBe('Checks running');
    expect(
      shippingBadge(card(1, 'finished', { ciState: 'pending' })),
    ).toBeNull();
  });
  test('merged stays in Finished as Merged', () => {
    const c = card(1, 'finished', { mergedAt: '2026-10-16T10:00:00.000Z' });
    expect(shippingBadge(c)).toEqual({ tone: 'ok', label: 'Merged' });
  });
  test('needsPerson beats the rest', () => {
    const c = card(1, 'in_progress', {
      needsPerson: true,
      ciState: 'red',
      ciFixAttempts: 3,
    });
    expect(shippingBadge(c)?.label).toBe('CI still failing after 3 fixes');
  });
  test('needsPerson on a head CI never reported on says so (#484)', () => {
    const c = card(1, 'finished', { needsPerson: true, ciState: 'none' });
    expect(shippingBadge(c)?.label).toBe('CI reported no checks');
    expect(ciBanner(c)?.title).toBe('CI reported no checks');
  });
  test('needsPerson on a head the latest round did not work on names the round (#542)', () => {
    const c = card(1, 'finished', {
      needsPerson: true,
      needsPersonReason: 'round_pushed_nothing',
      ciState: 'green',
    });
    expect(shippingBadge(c)?.label).toBe(
      'Last round pushed no commit; not merged',
    );
    expect(ciBanner(c)?.title).toBe('Last round pushed no commit; not merged');
    expect(
      shippingBadge({ ...c, needsPersonReason: 'round_failed' })?.label,
    ).toBe('Last round failed; not merged');
  });
  test('needsPerson on a diverged branch says nothing was pushed and how to fix it (#630)', () => {
    const c = card(1, 'finished', {
      needsPerson: true,
      needsPersonReason: 'branch_diverged',
    });
    expect(shippingBadge(c)?.label).toBe(
      'Branch diverged on origin; not pushed',
    );
    expect(ciBanner(c)?.hint).toContain('Merge them into the branch');
  });
  test('needsPerson on a head whose checks did not all pass says it was not merged (C-182)', () => {
    const c = card(1, 'finished', {
      needsPerson: true,
      needsPersonReason: 'ci_not_green',
      ciState: 'green',
    });
    expect(shippingBadge(c)?.label).toBe('Not every check passed; not merged');
    expect(ciBanner(c)?.title).toBe('Not every check passed; not merged');
  });
  test('a plain card has no badge', () => {
    expect(shippingBadge(card(1, 'in_progress'))).toBeNull();
  });
});

describe('ciBanner', () => {
  test('only when automation stopped', () => {
    expect(ciBanner(card(1, 'in_progress'))).toBeNull();
    const checks = [{ name: 'lint', link: 'https://ci.example/1' }];
    const b = ciBanner(
      card(1, 'in_progress', { needsPerson: true, ciChecks: checks }),
    );
    expect(b?.checks).toEqual(checks);
  });
});

describe('protected paths (C-148)', () => {
  const paths = ['.woodpecker/pipeline.yml'];
  test('an unmerged card says a person merges it, with the paths', () => {
    const c = card(1, 'finished', { protectedPaths: paths });
    expect(shippingBadge(c)).toEqual({
      tone: 'warn',
      label: 'Protected paths changed; a person merges',
    });
    expect(protectedPathsBanner(c)).toMatchObject({
      title: 'Protected paths changed; a person merges',
      paths,
    });
  });
  test('merged, or without protected paths, nothing is said', () => {
    const merged = card(1, 'finished', {
      protectedPaths: paths,
      mergedAt: '2026-10-16T10:00:00.000Z',
    });
    expect(shippingBadge(merged)?.label).toBe('Merged');
    expect(protectedPathsBanner(merged)).toBeNull();
    expect(protectedPathsBanner(card(1, 'finished'))).toBeNull();
  });
  test('needsPerson still beats it', () => {
    const c = card(1, 'finished', {
      protectedPaths: paths,
      needsPerson: true,
      needsPersonReason: 'branch_diverged',
    });
    expect(shippingBadge(c)?.label).toBe(
      'Branch diverged on origin; not pushed',
    );
  });
});

describe('pullRequestRows (#359 D8)', () => {
  test('newest round first', () => {
    const rows = pullRequestRows({
      pullRequests: [
        {
          number: 5,
          url: 'https://github.com/o/r/pull/5',
          branch: 'card/c1-x',
          state: 'merged',
          round: 1,
          createdAt: '2026-10-16T10:00:00.000Z',
        },
        {
          number: 9,
          url: 'https://github.com/o/r/pull/9',
          branch: 'card/c1-x-2',
          state: 'draft',
          round: 2,
          createdAt: '2026-10-16T11:00:00.000Z',
        },
      ],
    });
    expect(rows.map((r) => r.number)).toEqual([9, 5]);
    expect(rows[0]?.state).toBe('Draft');
  });
});

describe('effectiveAutoMerge (#359 D7)', () => {
  test('null follows the default, a stored value wins', () => {
    expect(
      effectiveAutoMerge({ autoMergeCards: null, autoMergeCardsDefault: true }),
    ).toBe(true);
    expect(
      effectiveAutoMerge({
        autoMergeCards: false,
        autoMergeCardsDefault: true,
      }),
    ).toBe(false);
  });
});

describe('autoMergeHint (#359 D7)', () => {
  test('names the default', () => {
    const s = { autoMergeCards: null, autoMergeCardsDefault: true };
    expect(autoMergeHint(s, true, true)).toContain('default for this base: on');
    expect(autoMergeHint(s, false, false)).toContain('waits for Accept');
  });
});

const review = (over: Partial<CardReviewView> = {}): CardReviewView => ({
  state: 'running',
  currentStep: 'Security',
  stepIndex: 1,
  stepCount: 3,
  fixRound: 0,
  fixLimit: 3,
  steps: [
    {
      id: 'a',
      name: 'Peer review',
      state: 'passed',
      blockingCount: 0,
      nitCount: 2,
    },
    {
      id: 'b',
      name: 'Security',
      state: 'running',
      blockingCount: 0,
      nitCount: 0,
    },
    { id: 'c', name: 'Docs', state: 'pending', blockingCount: 0, nitCount: 0 },
  ],
  ...over,
});

describe('review states (#891)', () => {
  test('a running step names itself and its position', () => {
    const c = card(1, 'in_progress', { ciState: 'green', review: review() });
    expect(shippingBadge(c)).toEqual({
      tone: 'warn',
      label: 'Reviewing · Security (2/3)',
      review: true,
    });
  });
  test('a fixing card shows the fix round and limit', () => {
    const c = card(1, 'in_progress', {
      ciState: 'green',
      review: review({ state: 'fixing', fixRound: 1 }),
    });
    expect(shippingBadge(c)?.label).toBe('Fixing review (1/3)');
  });
  test('an exhausted fix budget is a needs-person badge, not the CI one', () => {
    const c = card(1, 'in_progress', {
      ciState: 'green',
      needsPerson: true,
      needsPersonReason: 'review_still_blocking',
      review: review({ state: 'needs_person', fixRound: 3 }),
    });
    expect(shippingBadge(c)?.label).toBe('Review still blocking after 3 fixes');
    expect(shippingBadge(c)?.label).not.toBe('CI still failing after 3 fixes');
  });
  test('review off changes nothing', () => {
    const c = card(1, 'in_progress', { ciState: 'pending', review: null });
    expect(shippingBadge(c)?.label).toBe('Checks running');
    expect(readinessLine(card(1, 'finished', { review: null }))).toBeNull();
  });
  test('a passed Finished card lists what it passed', () => {
    const passed = review({ state: 'passed', fixRound: 2 });
    expect(
      readinessLine(card(1, 'finished', { ciState: 'green', review: passed })),
    ).toEqual(['CI passed', 'Review passed', 'Fixes done']);
    expect(
      readinessLine(
        card(1, 'finished', {
          ciState: 'green',
          review: { ...passed, fixRound: 0 },
        }),
      ),
    ).toEqual(['CI passed', 'Review passed']);
    expect(
      readinessLine(
        card(1, 'in_progress', { ciState: 'green', review: passed }),
      ),
    ).toBeNull();
  });
  test('the tracker runs CI, each step, Finished', () => {
    const steps = reviewTracker(
      card(1, 'in_progress', { ciState: 'green', review: review() }),
    );
    expect(steps.map((s) => [s.label, s.state])).toEqual([
      ['CI', 'passed'],
      ['Peer review', 'passed'],
      ['Security', 'running'],
      ['Docs', 'pending'],
      ['Finished', 'pending'],
    ]);
    expect(steps[1].nits).toBe(2);
    expect(reviewTracker(card(1, 'todo', { review: null }))).toEqual([]);
  });
  test('finding counts and places', () => {
    expect(findingCounts(0, 0)).toBeNull();
    expect(findingCounts(2, 1)).toBe('2 blocking · 1 nit');
    expect(findingCounts(0, 3)).toBe('3 nits');
    expect(findingPlace({ file: 'a.ts', line: 4 })).toBe('a.ts:4');
    expect(findingPlace({ file: 'a.ts' })).toBe('a.ts');
    expect(findingPlace({})).toBeNull();
  });
  test('review fix rounds are numbered in order', () => {
    expect(
      reviewFixRounds([
        { round: 3, trigger: 'review_fix' },
        { round: 1, trigger: 'run' },
        { round: 2, trigger: 'review_fix' },
      ]).map((r) => r.label),
    ).toEqual(['Review fix 1 · Round 2', 'Review fix 2 · Round 3']);
  });
});
