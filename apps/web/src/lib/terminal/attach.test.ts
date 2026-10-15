import { describe, expect, test } from 'bun:test';
import {
  ATTACH_GIVE_UP_MS,
  ATTACH_TIMEOUT_MS,
  type AttachState,
  AttachSupervisor,
  attachRetryDelay,
  isTransientCloseCode,
} from './attach';

/** A manual clock: `advance` fires timers in order of their due time. */
function setup() {
  let now = 0;
  let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const states: AttachState[] = [];
  const starts: number[] = [];
  let aborts = 0;
  const supervisor = new AttachSupervisor({
    start: (n) => starts.push(n),
    abort: () => {
      aborts += 1;
    },
    onState: (state) => states.push(state),
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > target) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = target;
  };
  return {
    supervisor,
    advance,
    states,
    starts,
    aborts: () => aborts,
    last: () => states.at(-1),
  };
}

describe('attachRetryDelay', () => {
  test('0.5, 1, 2, 4, 8 s and then stays at 8 s', () => {
    expect([0, 1, 2, 3, 4, 5].map(attachRetryDelay)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 8_000,
    ]);
  });
});

describe('isTransientCloseCode', () => {
  test('a dropped socket is transient, the server’s own codes are not', () => {
    expect(isTransientCloseCode(1006)).toBe(true);
    expect(isTransientCloseCode(1001)).toBe(true);
    expect(isTransientCloseCode(4401)).toBe(false);
    expect(isTransientCloseCode(4000)).toBe(false);
  });
});

describe('AttachSupervisor', () => {
  test('a socket that never opens leaves Connecting after 10 s and retries', () => {
    const { supervisor, advance, states, starts, aborts, last } = setup();
    supervisor.begin();
    expect(last()).toEqual({ phase: 'connecting', attempt: 1 });
    advance(ATTACH_TIMEOUT_MS - 1);
    expect(starts).toEqual([1]);
    advance(1);
    expect(aborts()).toBe(1);
    expect(states).toContainEqual({ phase: 'reconnecting', attempt: 2 });
    advance(attachRetryDelay(0));
    expect(starts).toEqual([1, 2]);
    expect(last()).toEqual({ phase: 'reconnecting', attempt: 2 });
  });

  test('after 30 s it shows failed and stops retrying', () => {
    const { supervisor, advance, starts, last, aborts } = setup();
    supervisor.begin();
    advance(ATTACH_GIVE_UP_MS - 1);
    expect(last()?.phase).toBe('reconnecting');
    advance(1);
    expect(last()?.phase).toBe('failed');
    const attempts = starts.length;
    expect(attempts).toBeGreaterThan(1);
    expect(aborts()).toBeGreaterThan(0);
    advance(120_000);
    expect(starts).toHaveLength(attempts);
    expect(last()?.phase).toBe('failed');
  });

  test('Retry starts a fresh 30 s window', () => {
    const { supervisor, advance, starts, last } = setup();
    supervisor.begin();
    advance(ATTACH_GIVE_UP_MS);
    const before = starts.length;
    supervisor.retry();
    expect(starts).toHaveLength(before + 1);
    expect(last()).toEqual({ phase: 'connecting', attempt: 1 });
    advance(ATTACH_GIVE_UP_MS - 1);
    expect(last()?.phase).toBe('reconnecting');
    advance(1);
    expect(last()?.phase).toBe('failed');
  });

  test('attaching stops the clocks for good', () => {
    const { supervisor, advance, starts, last } = setup();
    supervisor.begin();
    advance(3_000);
    supervisor.attached();
    advance(120_000);
    expect(starts).toEqual([1]);
    expect(last()?.phase).toBe('attached');
  });

  test('a failed attempt retries after the backoff, not at once', () => {
    const { supervisor, advance, starts, last } = setup();
    supervisor.begin();
    advance(1_000);
    supervisor.attemptFailed();
    expect(last()).toEqual({ phase: 'reconnecting', attempt: 2 });
    advance(attachRetryDelay(0) - 1);
    expect(starts).toEqual([1]);
    advance(1);
    expect(starts).toEqual([1, 2]);
  });

  test('a late failure from an abandoned attempt is ignored', () => {
    const { supervisor, advance, starts } = setup();
    supervisor.begin();
    advance(ATTACH_TIMEOUT_MS);
    supervisor.attemptFailed();
    advance(attachRetryDelay(0));
    expect(starts).toEqual([1, 2]);
  });

  test('dispose stops everything', () => {
    const { supervisor, advance, starts } = setup();
    supervisor.begin();
    supervisor.dispose();
    advance(120_000);
    expect(starts).toEqual([1]);
  });
});
