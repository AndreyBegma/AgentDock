import { describe, expect, test } from 'bun:test';
import type { ProjectRuntimeProfile } from '@nautelle/shared';
import { initialProfileKey, planProfileReason } from './profile';

const profile = (
  over: Partial<ProjectRuntimeProfile> = {},
): ProjectRuntimeProfile => ({
  key: 'work',
  runtime: 'claude',
  label: 'work',
  authenticated: true,
  isDefault: false,
  ...over,
});

describe('initialProfileKey', () => {
  test('preselects the project default', () => {
    expect(
      initialProfileKey([
        profile({ key: 'a' }),
        profile({ key: 'b', isDefault: true }),
      ]),
    ).toBe('b');
  });

  test('preselects the only profile when there is no default', () => {
    expect(initialProfileKey([profile({ key: 'solo' })])).toBe('solo');
  });

  test('leaves the choice to the person among several without a default', () => {
    expect(
      initialProfileKey([profile({ key: 'a' }), profile({ key: 'b' })]),
    ).toBe('');
  });

  test('is empty with no profile at all', () => {
    expect(initialProfileKey([])).toBe('');
  });
});

describe('planProfileReason', () => {
  test('nothing stops a plan once a profile is picked', () => {
    expect(planProfileReason('a', [profile({ key: 'a' })], 'p1')).toBeNull();
  });

  test('no profile at all links to the project settings', () => {
    expect(planProfileReason('', [], 'p1')).toEqual({
      text: 'The project’s runner has no Claude runtime profile to plan with.',
      href: '/projects/p1/settings?tab=general',
      cta: 'Open project settings',
    });
  });

  test('several and none picked asks for a pick or a default', () => {
    expect(
      planProfileReason(
        '',
        [profile({ key: 'a' }), profile({ key: 'b' })],
        'p1',
      )?.cta,
    ).toBe('Set a default profile');
  });

  test('a failed load is not "there are none"', () => {
    const reason = planProfileReason('', 'failed', 'p1');
    expect(reason?.text).toMatch(/could not be loaded/);
    expect(reason?.href).toBeUndefined();
  });
});
