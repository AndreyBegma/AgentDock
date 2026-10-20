import { describe, expect, test } from 'bun:test';
import { BOARD_ERROR, STACK_GATE_REASON } from '@nautelle/shared';
import { ApiError } from '../../lib/api';
import { card } from '../../lib/board/fixtures';
import { planGroup } from '../../lib/board/stacks';
import { bulkBarActions, GROUP_ACTION } from './bulk-action-bar';
import { groupRefusalOf } from './group-stack-dialog';

const stacked = (number: number) =>
  card(number, 'todo', {
    stack: {
      number: 3,
      label: 'S-3',
      title: 'Audit',
      stage: 0,
      stageTitle: '',
      gate: STACK_GATE_REASON,
    },
  });

/** #588: select cards, press Group into stack, and group the ones that can join. */
describe('Group into stack', () => {
  const selection = [
    card(211, 'todo'),
    card(214, 'todo'),
    card(219, 'todo'),
    card(207, 'in_progress'),
    stacked(140),
  ];

  test('the bar offers it first, counting the cards that can join: "4 of 5"', () => {
    let opened = 0;
    const actions = bulkBarActions(
      selection,
      false,
      () => undefined,
      () => {
        opened += 1;
      },
    );
    const group = actions[0];
    expect(group.id).toBe(GROUP_ACTION);
    expect(group.label).toBe('Group into stack');
    expect([group.count, group.of, group.disabled]).toEqual([4, 5, false]);
    group.onSelect();
    expect(opened).toBe(1);
  });

  test('is disabled below two cards that can join, and absent without onGroup', () => {
    const group = bulkBarActions(
      [card(1, 'todo'), stacked(2)],
      false,
      () => undefined,
      () => undefined,
    )[0];
    expect([group.count, group.disabled]).toEqual([1, true]);
    expect(
      bulkBarActions(selection, false, () => undefined).some(
        (a) => a.id === GROUP_ACTION,
      ),
    ).toBe(false);
  });

  test('a card in a stack or in Inbox is left out, and says why', () => {
    const plan = planGroup([...selection, card(241, 'inbox')]);
    expect(plan.joins.map((c) => c.number)).toEqual([211, 214, 219, 207]);
    expect(plan.left.map((l) => [l.card.label, l.why])).toEqual([
      ['C-140', 'it is already in S-3'],
      ['C-241', 'it is a suggestion in Inbox'],
    ]);
    expect(plan.ready).toBe(true);
  });

  test('after a 409 the refused card is left out, so a second press groups the rest', () => {
    const refusal = groupRefusalOf(
      new ApiError(409, undefined, 'C-219 is in S-11 already', undefined, {
        error: BOARD_ERROR.stackRefused,
        cards: [219],
      }),
    );
    expect(refusal).toEqual({
      cards: [219],
      message: 'C-219 is in S-11 already',
    });
    const plan = planGroup(selection, new Set(refusal?.cards));
    expect(plan.joins.map((c) => c.number)).toEqual([211, 214, 207]);
    expect(plan.ready).toBe(true);
    expect(planGroup(selection.slice(0, 2), new Set([211])).ready).toBe(false);
  });

  test('any other error is not a refusal', () => {
    expect(groupRefusalOf(new ApiError(500, undefined, 'boom'))).toBeNull();
    expect(
      groupRefusalOf(
        new ApiError(409, undefined, 'x', undefined, {
          error: BOARD_ERROR.dependencyCycle,
        }),
      ),
    ).toBeNull();
  });
});
