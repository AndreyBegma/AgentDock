import { describe, expect, test } from 'bun:test';
import { BANNER_AFTER_MS, Reachability } from './reachability';

function setup() {
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let nextId = 1;
  const reachability = new Reachability({
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return { reachability, timers };
}

describe('Reachability', () => {
  test('the banner appears after 1.5 s of unreachability', () => {
    const { reachability, timers } = setup();
    reachability.markUnreachable();
    expect(reachability.getSnapshot()).toEqual({
      unreachable: true,
      bannerVisible: false,
    });
    expect(timers.map((timer) => timer.ms)).toEqual([BANNER_AFTER_MS]);
    timers[0]?.fn();
    expect(reachability.getSnapshot().bannerVisible).toBe(true);
  });

  test('a 300 ms blip never shows the banner', () => {
    const { reachability, timers } = setup();
    reachability.markUnreachable();
    reachability.markReachable();
    expect(timers).toHaveLength(0);
    expect(reachability.getSnapshot()).toEqual({
      unreachable: false,
      bannerVisible: false,
    });
  });

  test('the first success hides a visible banner', () => {
    const { reachability, timers } = setup();
    reachability.markUnreachable();
    timers[0]?.fn();
    reachability.markReachable();
    expect(reachability.getSnapshot().bannerVisible).toBe(false);
    expect(reachability.isUnreachable()).toBe(false);
  });

  test('repeated failures keep one timer and notify listeners once per change', () => {
    const { reachability, timers } = setup();
    let calls = 0;
    reachability.onChange(() => {
      calls += 1;
    });
    reachability.markUnreachable();
    reachability.markUnreachable();
    expect(timers).toHaveLength(1);
    expect(calls).toBe(1);
    reachability.markReachable();
    reachability.markReachable();
    expect(calls).toBe(2);
  });
});
