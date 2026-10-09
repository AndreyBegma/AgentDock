import { describe, expect, test } from 'bun:test';
import type { RunLogFrame } from '@agentdock/shared/protocol';
import {
  applyRunLogFrame,
  beginReplay,
  EMPTY_RUN_LOG,
  RUN_LOG_KEEP_LINES,
  rowText,
} from './run-log';

const lines = (backlog: boolean, ...texts: string[]): RunLogFrame => ({
  type: 'lines',
  backlog,
  lines: texts.map((text) => ({ kind: 'assistant' as const, text })),
});

const texts = (state: ReturnType<typeof applyRunLogFrame>) =>
  state.rows.map((r) => r.text);

describe('applyRunLogFrame', () => {
  test('split backlog frames append, live frames append', () => {
    let state = applyRunLogFrame(EMPTY_RUN_LOG, lines(true, 'a', 'b'));
    state = applyRunLogFrame(state, lines(true, 'c'));
    state = applyRunLogFrame(state, lines(false, 'd'));
    expect(texts(state)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a replay after a reconnect replaces instead of duplicating', () => {
    let state = applyRunLogFrame(EMPTY_RUN_LOG, lines(true, 'a', 'b'));
    state = applyRunLogFrame(state, lines(false, 'c'));
    state = beginReplay(state);
    state = applyRunLogFrame(state, lines(true, 'a', 'b'));
    state = applyRunLogFrame(state, lines(true, 'c'));
    expect(texts(state)).toEqual(['a', 'b', 'c']);
  });

  test('ids keep growing within one replay', () => {
    let state = applyRunLogFrame(EMPTY_RUN_LOG, lines(true, 'a'));
    state = applyRunLogFrame(state, lines(false, 'b'));
    expect(state.rows.map((r) => r.id)).toEqual([0, 1]);
  });

  test('ended keeps the lines and records the phase', () => {
    let state = applyRunLogFrame(EMPTY_RUN_LOG, lines(false, 'a'));
    state = applyRunLogFrame(state, { type: 'ended', phase: 'cancelled' });
    expect(state.endedPhase).toBe('cancelled');
    expect(texts(state)).toEqual(['a']);
  });

  test('the head is trimmed past the keep limit and flagged', () => {
    const many = Array.from({ length: RUN_LOG_KEEP_LINES + 3 }, (_, i) => `l${i}`);
    const state = applyRunLogFrame(EMPTY_RUN_LOG, lines(false, ...many));
    expect(state.rows).toHaveLength(RUN_LOG_KEEP_LINES);
    expect(state.rows[0]?.text).toBe('l3');
    expect(state.trimmed).toBe(true);
  });
});

describe('rowText', () => {
  test('prefixes by kind', () => {
    expect(rowText({ kind: 'tool', text: 'Read x' })).toBe('› Read x');
    expect(rowText({ kind: 'assistant', text: 'hi' })).toBe('hi');
  });
});
