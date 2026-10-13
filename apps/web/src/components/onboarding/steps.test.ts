import { describe, expect, test } from 'bun:test';
import { currentStep, gettingStarted } from './steps';

const ids = (state: ReturnType<typeof gettingStarted>, done: boolean) =>
  state.steps.filter((s) => !s.optional && s.done === done).map((s) => s.id);

describe('gettingStarted', () => {
  test('a fresh install: only the admin account is done, 1 of 5', () => {
    const state = gettingStarted({ runners: { kind: 'none' }, projects: 0 });
    expect(state.done).toBe(1);
    expect(state.total).toBe(5);
    expect(state.complete).toBe(false);
    expect(currentStep(state)?.id).toBe('install');
  });

  test('a paired runner that is not running: installed and paired, 3 of 5', () => {
    const state = gettingStarted({
      runners: {
        kind: 'offline',
        runners: [{ id: 'r1', name: 'laptop', hostname: null }],
      },
      projects: 0,
    });
    expect(ids(state, true)).toEqual(['admin', 'install', 'pair']);
    expect(currentStep(state)?.id).toBe('online');
  });

  test('online but no project: 4 of 5, the next step connects one', () => {
    const state = gettingStarted({
      runners: { kind: 'online', online: 1 },
      projects: 0,
    });
    expect(state.done).toBe(4);
    expect(currentStep(state)?.href).toBe('/projects?connect=1');
  });

  test('steps 1–5 done hides it; the optional steps do not count', () => {
    const state = gettingStarted({
      runners: { kind: 'online', online: 2 },
      projects: 3,
    });
    expect(state.complete).toBe(true);
    expect(state.done).toBe(5);
    expect(state.steps.filter((s) => s.optional).map((s) => s.id)).toEqual([
      'github',
      'invite',
    ]);
  });

  test('a project with its runner offline is not complete', () => {
    const state = gettingStarted({
      runners: { kind: 'offline', runners: [] },
      projects: 1,
    });
    expect(state.complete).toBe(false);
    expect(currentStep(state)?.id).toBe('online');
  });

  test('an unknown runner fact is never read as done', () => {
    const state = gettingStarted({ runners: { kind: 'unknown' }, projects: 0 });
    expect(ids(state, false)).toEqual(['install', 'pair', 'online', 'project']);
  });
});
