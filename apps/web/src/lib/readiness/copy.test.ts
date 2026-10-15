import { describe, expect, test } from 'bun:test';
import type { ReadinessBlocker } from '@agentdock/shared';
import { readinessCopy } from './copy';

const suggestion = { id: 'prof-1', key: 'work', label: 'Work' };
const admin = { isAdmin: true, projectId: 'p1', suggestion };
const operator = { isAdmin: false, projectId: 'p1', suggestion };

const none: ReadinessBlocker = {
  code: 'no_profile',
  reason: 'none',
  source: null,
};

describe('readinessCopy (#272 D5)', () => {
  test('an admin with no profile gets "Use <profile>" and the General tab', () => {
    const copy = readinessCopy(none, admin);
    expect(copy.useProfile).toEqual({ id: 'prof-1', label: 'Work' });
    expect(copy.href).toBe('/projects/p1/settings?tab=general');
    expect(copy.cta).toBe('Choose in Settings › General');
  });

  test('an admin with nothing to suggest gets only the link', () => {
    const copy = readinessCopy(none, { ...admin, suggestion: null });
    expect(copy.useProfile).toBeUndefined();
    expect(copy.href).toBe('/projects/p1/settings?tab=general');
  });

  test('an unusable orchestrator profile links the Orchestrator tab', () => {
    const copy = readinessCopy(
      {
        code: 'no_profile',
        reason: 'not_claude',
        source: 'orchestrator',
        profileKey: 'codex',
      },
      admin,
    );
    expect(copy.text).toContain('codex');
    expect(copy.href).toBe('/projects/p1/settings?tab=orchestrator');
  });

  test('an operator is told to ask an admin and gets no fix', () => {
    const copy = readinessCopy(none, operator);
    expect(copy.text).toContain('Ask an admin');
    expect(copy.useProfile).toBeUndefined();
    expect(copy.href).toBeUndefined();
  });

  test('each other blocker links its fix', () => {
    expect(readinessCopy({ code: 'no_spec_dir' }, operator).href).toBe(
      '/projects/p1/settings?tab=docs',
    );
    expect(readinessCopy({ code: 'content_off' }, operator).href).toBe(
      '/projects/p1/settings?tab=sessions',
    );
    expect(readinessCopy({ code: 'runner_offline' }, admin).href).toBe(
      '/admin/runners',
    );
    expect(readinessCopy({ code: 'runner_offline' }, operator).href).toBe(
      undefined,
    );
    expect(
      readinessCopy({ code: 'runner_outdated', commands: ['plan.turn'] }, admin)
        .text,
    ).toContain('plan.turn');
  });
});
