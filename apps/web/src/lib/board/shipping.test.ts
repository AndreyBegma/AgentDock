import { describe, expect, test } from 'bun:test';
import { card } from './fixtures';
import {
  autoMergeHint,
  ciBanner,
  ciDot,
  effectiveAutoMerge,
  pullRequestRows,
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
