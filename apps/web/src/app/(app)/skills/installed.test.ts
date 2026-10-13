import { describe, expect, test } from 'bun:test';
import type { InstalledSkillView } from '@agentdock/shared';
import { installedEntries, whereInstalled } from './installed';

const skill = (patch: Partial<InstalledSkillView>): InstalledSkillView => ({
  id: 'x',
  scope: 'profile',
  runtime: 'claude',
  name: 'review',
  invocation: 'code-sentinel:review',
  path: '/p',
  projectId: null,
  profileKey: 'a',
  description: null,
  argumentHint: null,
  source: null,
  commit: null,
  contentHash: null,
  pluginVersion: null,
  runnable: true,
  seenAt: '2026-10-13T10:00:00.000Z',
  ...patch,
});

describe('installedEntries', () => {
  test('a plugin skill from several profiles is listed once', () => {
    const entries = installedEntries([
      skill({ profileKey: 'a' }),
      skill({ profileKey: 'b', description: 'Reviews code' }),
      skill({ profileKey: 'c' }),
      skill({ profileKey: 'c' }),
      skill({
        name: 'deploy',
        invocation: 'deploy',
        scope: 'project',
        profileKey: null,
      }),
    ]);
    expect(entries).toEqual([
      {
        invocation: 'deploy',
        name: 'deploy',
        description: null,
        inProject: true,
        profiles: 0,
      },
      {
        invocation: 'code-sentinel:review',
        name: 'review',
        description: 'Reviews code',
        inProject: false,
        profiles: 3,
      },
    ]);
  });

  test('where it is installed, in words', () => {
    const base = {
      invocation: 'x',
      name: 'x',
      description: null,
    };
    expect(whereInstalled({ ...base, inProject: false, profiles: 5 })).toBe(
      'in 5 profiles',
    );
    expect(whereInstalled({ ...base, inProject: true, profiles: 0 })).toBe(
      'in this project',
    );
    expect(whereInstalled({ ...base, inProject: true, profiles: 1 })).toBe(
      'in this project and 1 profile',
    );
  });
});
