import { describe, expect, test } from 'bun:test';
import type { BoardPlanTaskView } from '@nautelle/shared';
import { matchesFilter, NO_FILTER } from './filter';
import { card, round } from './fixtures';
import { toItem } from './format';
import { toPlanItem } from './plan-tasks';
import {
  columnSelection,
  leftAfter,
  openPullRequests,
  planBulk,
  pruned,
  selectableNumbers,
  summarizeBulk,
  toggled,
  toggledColumn,
  withRange,
} from './selection';

const set = (...n: number[]) => new Set(n);

describe('selectableNumbers', () => {
  test('skips plan tasks and Inbox suggestions', () => {
    const task = {
      taskId: 't1',
      key: 'T1',
      title: 'x',
      planTitle: 'Plan',
    } as BoardPlanTaskView;
    expect(
      selectableNumbers([
        toItem(card(1, 'todo')),
        toPlanItem(task),
        toItem(card(2, 'inbox')),
        toItem(card(3, 'todo')),
      ]),
    ).toEqual([1, 3]);
  });

  test('a filter narrows what "Select all" takes', () => {
    const items = [1, 2, 3, 4].map((n) =>
      toItem(card(n, 'finished', { title: n % 2 ? 'odd one' : 'even one' })),
    );
    const shown = items.filter((i) =>
      matchesFilter(i, { ...NO_FILTER, text: 'even' }),
    );
    expect(selectableNumbers(shown)).toEqual([2, 4]);
  });
});

describe('toggled', () => {
  test('adds and removes', () => {
    expect([...toggled(set(1), 2)]).toEqual([1, 2]);
    expect([...toggled(set(1, 2), 1)]).toEqual([2]);
  });
});

describe('withRange', () => {
  const order = [10, 11, 12, 13, 14];
  test('selects from the anchor to the target, either way', () => {
    expect([...withRange(set(), order, 11, 13)]).toEqual([11, 12, 13]);
    expect([...withRange(set(), order, 14, 12)].sort()).toEqual([12, 13, 14]);
  });

  test('keeps what was selected', () => {
    expect(withRange(set(99), order, 10, 11).has(99)).toBe(true);
  });

  test('without an anchor in the column it selects the card alone', () => {
    expect([...withRange(set(), order, null, 12)]).toEqual([12]);
    expect([...withRange(set(), order, 77, 12)]).toEqual([12]);
  });
});

describe('column selection', () => {
  test('reads none, some and all', () => {
    const order = [1, 2, 3];
    expect(columnSelection(order, set(9))).toEqual({
      selected: 0,
      total: 3,
      state: 'none',
    });
    expect(columnSelection(order, set(1, 9)).state).toBe('some');
    expect(columnSelection(order, set(1, 2, 3)).state).toBe('all');
  });

  test('"Select all" selects the column, and clears it when all are selected', () => {
    expect([...toggledColumn(set(9), [1, 2])].sort()).toEqual([1, 2, 9]);
    expect([...toggledColumn(set(1, 2, 9), [1, 2])]).toEqual([9]);
    expect([...toggledColumn(set(1), [1, 2])].sort()).toEqual([1, 2]);
  });
});

describe('pruned', () => {
  test('drops a card that left the board', () => {
    expect([...pruned(set(1, 2, 3), set(1, 3))]).toEqual([1, 3]);
  });

  test('is the same set when nothing left', () => {
    const selection = set(1, 2);
    expect(pruned(selection, set(1, 2, 3))).toBe(selection);
  });
});

describe('planBulk', () => {
  const cards = [
    card(1, 'finished'),
    card(2, 'finished', {
      source: 'fleet',
      fleet: { issue: 1, slot: 'i1', stage: null, slotGone: false },
    }),
    card(3, 'in_progress', { round: round('running') }),
    card(4, 'completed'),
  ];

  test('counts what applies to each action', () => {
    expect(planBulk('complete', cards).applies.map((c) => c.number)).toEqual([
      1, 2,
    ]);
    expect(planBulk('todo', cards).applies.map((c) => c.number)).toEqual([
      1, 4,
    ]);
    expect(planBulk('finished', cards).applies.map((c) => c.number)).toEqual([
      3,
    ]);
    expect(planBulk('delete', cards).applies.map((c) => c.number)).toEqual([
      1, 2, 4,
    ]);
  });

  test('says why a card is skipped', () => {
    expect(
      planBulk('complete', cards).skipped.map((s) => [s.card.number, s.reason]),
    ).toEqual([
      [3, 'wrong_column'],
      [4, 'already_in_column'],
    ]);
  });

  test('none applying disables the action', () => {
    expect(planBulk('finished', [card(1, 'todo')]).applies).toHaveLength(0);
  });
});

describe('openPullRequests', () => {
  test('counts open and draft pull requests', () => {
    expect(
      openPullRequests([
        card(1, 'finished', { prNumber: 1, prState: 'open' }),
        card(2, 'finished', { prNumber: 2, prState: 'merged' }),
        card(3, 'finished', { prNumber: 3, prState: 'draft' }),
        card(4, 'finished'),
      ]),
    ).toBe(2);
  });
});

describe('summarizeBulk', () => {
  const label = (n: number) => `C-${n}`;

  test('all done', () => {
    const out = summarizeBulk(
      {
        action: 'complete',
        results: [
          { number: 1, status: 'done' },
          { number: 2, status: 'done' },
        ],
      },
      label,
    );
    expect(out).toEqual({
      text: '2 cards moved to Completed. No pull request was merged or closed.',
      warn: false,
    });
  });

  test('skipped cards are grouped by reason and stay selected', () => {
    const response = {
      action: 'todo' as const,
      results: [
        { number: 1, status: 'done' as const },
        {
          number: 2,
          status: 'skipped' as const,
          reason: 'card_running' as const,
        },
        {
          number: 3,
          status: 'skipped' as const,
          reason: 'card_running' as const,
        },
        {
          number: 4,
          status: 'error' as const,
          code: 'unknown' as const,
          message: 'boom',
        },
      ],
    };
    const out = summarizeBulk(response, label);
    expect(out.warn).toBe(true);
    expect(out.text).toBe(
      '1 card moved to To Do. 3 left alone — C-2, C-3: running; C-4: boom. They stay selected.',
    );
    expect([...leftAfter(response.results)]).toEqual([2, 3, 4]);
  });
});
