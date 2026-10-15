import { describe, expect, test } from 'bun:test';
import { buildNameIndex, runnerActorName, targetDisplay } from './targets';

const index = buildNameIndex({
  user: [{ id: 'u1', email: 'a@x.dev', name: null }],
  runner: [{ id: 'r1', name: 'build-box' }],
  project: [{ id: 'p1', displayName: 'AgentDock' }],
});

describe('targetDisplay', () => {
  test('resolves a known target to its name and keeps the id as the tooltip', () => {
    expect(
      targetDisplay({ targetType: 'runner', targetId: 'r1' }, index),
    ).toEqual({ text: 'runner · build-box', title: 'r1' });
    expect(
      targetDisplay({ targetType: 'user', targetId: 'u1' }, index).text,
    ).toBe('user · a@x.dev');
  });

  test('never prints an id it cannot resolve', () => {
    expect(
      targetDisplay({ targetType: 'project', targetId: 'gone' }, index),
    ).toEqual({ text: 'project', title: 'gone' });
  });

  test('a target without an id is just its type', () => {
    expect(
      targetDisplay({ targetType: 'setting', targetId: null }, index),
    ).toEqual({ text: 'setting', title: undefined });
  });
});

describe('runnerActorName', () => {
  test('names the runner, or says only "runner"', () => {
    expect(runnerActorName({ actorRunnerId: 'r1' }, index)).toBe(
      'runner build-box',
    );
    expect(runnerActorName({ actorRunnerId: 'zzz' }, index)).toBe('runner');
  });
});
