import { describe, expect, test } from 'bun:test';
import type { PaneFrame } from '@agentdock/shared/protocol';
import { applyFrame, EMPTY_PANE, type PaneState } from './reducer';

const full = (lines: string[], y = 0): PaneFrame => ({
  type: 'full',
  lines,
  cursor: { x: 0, y },
});
const patch = (from: number, lines: string[]): PaneFrame => ({
  type: 'patch',
  from,
  lines,
});

const run = (frames: PaneFrame[], from: PaneState = EMPTY_PANE) =>
  frames.reduce(applyFrame, from);

describe('applyFrame', () => {
  test('full replaces the content', () => {
    const state = run([full(['a', 'b']), full(['c'])]);
    expect(state.lines).toEqual(['c']);
  });

  test('patch replaces from the index to the end', () => {
    const state = run([full(['a', 'b', 'c']), patch(1, ['B'])]);
    expect(state.lines).toEqual(['a', 'B']);
  });

  test('patch at the end appends', () => {
    const state = run([full(['a']), patch(1, ['b', 'c'])]);
    expect(state.lines).toEqual(['a', 'b', 'c']);
  });

  test('an empty patch truncates', () => {
    const state = run([full(['a', 'b']), patch(1, [])]);
    expect(state.lines).toEqual(['a']);
  });

  test('a patch past the end appends without a hole', () => {
    const state = run([full(['a']), patch(9, ['b'])]);
    expect(state.lines).toEqual(['a', 'b']);
  });

  test('a chunked frame (full then patches) equals the original', () => {
    const original = Array.from({ length: 10 }, (_, i) => `line ${i}`);
    const chunked = run([
      full(original.slice(0, 4), 9),
      patch(4, original.slice(4, 7)),
      patch(7, original.slice(7)),
    ]);
    expect(chunked.lines).toEqual(original);
    expect(chunked).toEqual(run([full(original, 9)]));
  });

  test('ended keeps the last frame and marks the pane', () => {
    const state = run([full(['a', 'b']), { type: 'ended' }]);
    expect(state.ended).toBe(true);
    expect(state.lines).toEqual(['a', 'b']);
  });

  test('a late joiner full after ended starts a live pane again', () => {
    const state = run([full(['a']), { type: 'ended' }, full(['x', 'y'])]);
    expect(state.ended).toBe(false);
    expect(state.lines).toEqual(['x', 'y']);
  });

  test('a late joiner full replaces what patches built', () => {
    const state = run([full(['a']), patch(1, ['b']), full(['z'])]);
    expect(state.lines).toEqual(['z']);
  });

  test('does not mutate the previous state', () => {
    const before = run([full(['a', 'b'])]);
    applyFrame(before, patch(0, ['x']));
    expect(before.lines).toEqual(['a', 'b']);
  });
});
