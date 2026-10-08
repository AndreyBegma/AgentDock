import { describe, expect, test } from 'bun:test';
import type { CommandRunLiveEvent } from '@agentdock/shared';
import {
  applyRunEvent,
  isPending,
  NO_PENDING_RUNS,
  parseRunEvent,
} from './pending';

const run = (over: Partial<CommandRunLiveEvent>): CommandRunLiveEvent => ({
  id: 'r1',
  projectId: 'p1',
  command: 'slot.stop',
  slot: 'i42',
  status: 'requested',
  result: null,
  error: null,
  user: null,
  requestedAt: '2026-10-08T12:00:00.000Z',
  finishedAt: null,
  ...over,
});

describe('applyRunEvent', () => {
  test('a requested run becomes pending', () => {
    const state = applyRunEvent(NO_PENDING_RUNS, run({}));
    expect(isPending(state, 'slot.stop', 'i42')).toBe(true);
  });

  test('the finishing frame removes it', () => {
    const pending = applyRunEvent(NO_PENDING_RUNS, run({}));
    const done = applyRunEvent(pending, run({ status: 'ok' }));
    expect(done).toEqual({});
  });

  test('a finish for a run never seen leaves the state as it was', () => {
    const state = applyRunEvent(NO_PENDING_RUNS, run({ status: 'error' }));
    expect(state).toBe(NO_PENDING_RUNS);
  });

  test('runs are tracked per slot', () => {
    const state = applyRunEvent(NO_PENDING_RUNS, run({}));
    expect(isPending(state, 'slot.stop', 'i43')).toBe(false);
    expect(isPending(state, 'slot.stop')).toBe(true);
    expect(isPending(state, 'slot.message', 'i42')).toBe(false);
  });
});

describe('parseRunEvent', () => {
  test('rejects what is not a run', () => {
    expect(parseRunEvent(null)).toBeNull();
    expect(parseRunEvent('x')).toBeNull();
    expect(parseRunEvent({ id: 1 })).toBeNull();
  });

  test('accepts a run frame', () => {
    expect(parseRunEvent(run({}))?.id).toBe('r1');
  });
});
