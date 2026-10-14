import { describe, expect, test } from 'bun:test';
import {
  BOARD_CHANGED_EVENT,
  DESIGN_LIVE_EVENT,
  PLANNER_LIVE_EVENT,
} from '@agentdock/shared';
import { isCardDesignChange, isDesignChange } from './use-design';

describe('isCardDesignChange (#243)', () => {
  test("this card's design and board pushes", () => {
    expect(
      isCardDesignChange(DESIGN_LIVE_EVENT, { cardId: 'card-1' }, 'card-1'),
    ).toBe(true);
    expect(
      isCardDesignChange(BOARD_CHANGED_EVENT, { cardId: 'card-1' }, 'card-1'),
    ).toBe(true);
  });

  test('before the design loaded any card push counts', () => {
    expect(
      isCardDesignChange(DESIGN_LIVE_EVENT, { cardId: 'card-9' }, undefined),
    ).toBe(true);
  });

  test("not another card, a task's design push, another event or junk", () => {
    expect(
      isCardDesignChange(DESIGN_LIVE_EVENT, { cardId: 'card-2' }, 'card-1'),
    ).toBe(false);
    expect(
      isCardDesignChange(
        DESIGN_LIVE_EVENT,
        { planId: 'p', taskKey: 't1' },
        'card-1',
      ),
    ).toBe(false);
    expect(isCardDesignChange('run', { cardId: 'card-1' }, 'card-1')).toBe(
      false,
    );
    expect(isCardDesignChange(DESIGN_LIVE_EVENT, null, 'card-1')).toBe(false);
  });
});

/** Whether a push concerns task `t1` of plan `p`. */
const concernsT1 = (event: string, data: unknown) =>
  isDesignChange(event, data, 'p', 't1');

describe('isDesignChange', () => {
  test("this task's design pushes, and plan-wide ones", () => {
    expect(concernsT1(DESIGN_LIVE_EVENT, { planId: 'p', taskKey: 't1' })).toBe(
      true,
    );
    expect(concernsT1(DESIGN_LIVE_EVENT, { planId: 'p', taskKey: null })).toBe(
      true,
    );
    expect(concernsT1(PLANNER_LIVE_EVENT, { planId: 'p' })).toBe(true);
  });

  test('not another task, another plan, another event or junk', () => {
    expect(concernsT1(DESIGN_LIVE_EVENT, { planId: 'p', taskKey: 't2' })).toBe(
      false,
    );
    expect(concernsT1(DESIGN_LIVE_EVENT, { planId: 'q' })).toBe(false);
    expect(concernsT1('run', { planId: 'p' })).toBe(false);
    expect(concernsT1(DESIGN_LIVE_EVENT, null)).toBe(false);
  });
});
