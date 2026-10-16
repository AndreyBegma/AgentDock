import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { tempDir } from '../testing/fixtures';
import { HandoffStateStore, keepSession } from './state';

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
});

describe('HandoffStateStore (#449 D4)', () => {
  it('gives every card without state lists of its own', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const store = new HandoffStateStore((id) => join(dir, id));
    const a = store.load('carda');
    keepSession(a, '11111111-1111-4111-8111-111111111111');
    a.asked.push('run_1');
    // Another card, never saved: nothing of card A's leaks into it.
    expect(store.load('cardb')).toEqual({
      note: null,
      asked: [],
      sessions: [],
    });
  });

  it('keeps a session once, oldest first', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const store = new HandoffStateStore((id) => join(dir, id));
    const saved = store.update('carda', (s) => {
      keepSession(s, '11111111-1111-4111-8111-111111111111');
      keepSession(s, '22222222-2222-4222-8222-222222222222');
      keepSession(s, '11111111-1111-4111-8111-111111111111');
    });
    expect(store.load('carda').sessions).toEqual(saved.sessions);
    expect(saved.sessions).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });
});
