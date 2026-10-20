import { describe, expect, test } from 'bun:test';
import type { AdminRunner } from '@nautelle/shared';
import {
  gitHubAppFact,
  profileFact,
  projectRunnerFact,
  readyValue,
  runnersFact,
} from './facts';

const runner = (overrides: Partial<AdminRunner>): AdminRunner => ({
  id: 'r1',
  name: 'laptop',
  status: 'offline',
  hostname: 'laptop.local',
  version: null,
  protocolVersion: null,
  os: null,
  arch: null,
  profilesCount: 0,
  pairedAt: '2026-10-01T00:00:00.000Z',
  lastSeenAt: null,
  revokedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
});

describe('runnersFact', () => {
  test('no runner at all is none paired', () => {
    expect(runnersFact([])).toEqual({ kind: 'none' });
  });

  test('a runner that never paired, or was revoked, does not count', () => {
    expect(
      runnersFact([
        runner({ id: 'a', pairedAt: null }),
        runner({ id: 'b', status: 'revoked' }),
      ]),
    ).toEqual({ kind: 'none' });
  });

  test('paired but none online names the idle runners', () => {
    expect(
      runnersFact([
        runner({ id: 'a', name: 'laptop', status: 'offline' }),
        runner({ id: 'b', name: 'server', status: 'stale', hostname: null }),
        runner({ id: 'c', status: 'revoked' }),
      ]),
    ).toEqual({
      kind: 'offline',
      runners: [
        { id: 'a', name: 'laptop', hostname: 'laptop.local' },
        { id: 'b', name: 'server', hostname: null },
      ],
    });
  });

  test('any online runner is online, with the count', () => {
    expect(
      runnersFact([
        runner({ id: 'a', status: 'online' }),
        runner({ id: 'b', status: 'offline' }),
        runner({ id: 'c', status: 'online' }),
      ]),
    ).toEqual({ kind: 'online', online: 2 });
  });
});

describe('project facts', () => {
  test('only `online` is online; `stale` is not', () => {
    expect(
      projectRunnerFact({ runnerName: 'laptop', runnerStatus: 'online' }),
    ).toEqual({ name: 'laptop', status: 'online', online: true });
    expect(
      projectRunnerFact({ runnerName: 'laptop', runnerStatus: 'stale' }).online,
    ).toBe(false);
  });

  test('the effective profile decides whether one is set', () => {
    expect(profileFact({ effectiveProfile: null })).toEqual({
      set: false,
      label: null,
    });
    expect(
      profileFact({
        effectiveProfile: {
          id: 'p1',
          key: 'claude',
          label: 'Claude',
          runtime: 'claude',
        },
      }),
    ).toEqual({ set: true, label: 'Claude' });
  });

  test('the GitHub App is installed when it covers the repository', () => {
    expect(gitHubAppFact({ covered: true })).toEqual({ installed: true });
    expect(gitHubAppFact({ covered: false })).toEqual({ installed: false });
  });

  test('readyValue is undefined until the fact is ready', () => {
    expect(readyValue({ state: 'loading' })).toBeUndefined();
    expect(
      readyValue({ state: 'error', error: new Error('x') }),
    ).toBeUndefined();
    expect(readyValue({ state: 'ready', value: 3 })).toBe(3);
  });
});
