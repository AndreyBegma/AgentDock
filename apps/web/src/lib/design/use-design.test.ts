import { describe, expect, test } from 'bun:test';
import { DESIGN_LIVE_EVENT, PLANNER_LIVE_EVENT } from '@agentdock/shared';
import { isDesignChange } from './use-design';

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
