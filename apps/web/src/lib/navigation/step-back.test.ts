import { describe, expect, test } from 'bun:test';
import { canStepBack, type StepBackWindow, stepBack } from './step-back';

const recorder = () => {
  const calls: string[] = [];
  return {
    calls,
    router: {
      back: () => calls.push('back'),
      push: (href: string) => calls.push(`push ${href}`),
    },
  };
};

describe('stepBack (#677)', () => {
  test('steps back in the history when an in-app entry precedes the page', () => {
    const { calls, router } = recorder();
    const win: StepBackWindow = {
      history: { length: 3 },
      navigation: { currentEntry: { index: 2 } },
    };
    stepBack(router, '/projects/p/board?card=7', win);
    expect(calls).toEqual(['back']);
  });

  test('a page opened from another site goes to the fallback, not out of the app', () => {
    const { calls, router } = recorder();
    // The Navigation API lists same-origin entries only: the other site is not one.
    const win: StepBackWindow = {
      history: { length: 4 },
      navigation: { currentEntry: { index: 0 } },
    };
    stepBack(router, '/projects/p/board?card=7', win);
    expect(calls).toEqual(['push /projects/p/board?card=7']);
  });

  test('without the Navigation API an earlier entry counts', () => {
    expect(canStepBack({ history: { length: 2 } })).toBe(true);
    expect(canStepBack({ history: { length: 1 } })).toBe(false);
    expect(
      canStepBack({
        history: { length: 2 },
        navigation: { currentEntry: null },
      }),
    ).toBe(true);
  });

  test('a fresh tab with only this page goes to the fallback', () => {
    const { calls, router } = recorder();
    stepBack(router, '/projects/p/planner/x', { history: { length: 1 } });
    expect(calls).toEqual(['push /projects/p/planner/x']);
  });
});
