import { describe, expect, test } from 'bun:test';
import type { LocalRunner, RunnerUpdate } from '@nautelle/shared';
import {
  DISMISSED_RELEASE_KEY,
  readDismissedRelease,
  runnerUpdateCommand,
  runnerUpdateNotice,
  storeDismissedRelease,
} from './update';

const runner = (
  update: RunnerUpdate | null,
  overrides: Partial<LocalRunner> = {},
): LocalRunner => ({
  id: 'r1',
  name: 'desk',
  localUserId: 'u1',
  awayMode: false,
  hostname: 'desk.local',
  version: update?.current ?? null,
  update,
  ...overrides,
});

const behind = (current = '0.14.0', latest = '0.15.0'): RunnerUpdate => ({
  current,
  latest,
  outdated: true,
});

describe('runnerUpdateNotice (C-328)', () => {
  test('shows when the user’s runner is behind the release', () => {
    expect(runnerUpdateNotice([runner(behind())], null)).toEqual({
      latest: '0.15.0',
      lines: ['Your runner desk.local is on 0.14.0 — 0.15.0 is out.'],
    });
  });

  test('names the runner when it never reported a hostname', () => {
    expect(
      runnerUpdateNotice([runner(behind(), { hostname: null })], null)?.lines,
    ).toEqual(['Your runner desk is on 0.14.0 — 0.15.0 is out.']);
  });

  test('lists every outdated runner, and only those', () => {
    expect(
      runnerUpdateNotice(
        [
          runner(behind()),
          runner(
            { current: '0.15.0', latest: '0.15.0', outdated: false },
            { id: 'r2', hostname: 'ci' },
          ),
          runner(behind('0.13.1'), { id: 'r3', hostname: 'build' }),
        ],
        null,
      )?.lines,
    ).toEqual([
      'Your runner desk.local is on 0.14.0 — 0.15.0 is out.',
      'Your runner build is on 0.13.1 — 0.15.0 is out.',
    ]);
  });

  test('is hidden when the runner is current', () => {
    expect(
      runnerUpdateNotice(
        [runner({ current: '0.15.0', latest: '0.15.0', outdated: false })],
        null,
      ),
    ).toBeNull();
  });

  test('is hidden when the version or the release is unknown, or there is no runner', () => {
    expect(runnerUpdateNotice([runner(null)], null)).toBeNull();
    expect(
      runnerUpdateNotice([runner(null, { version: '0.14.0' })], null),
    ).toBeNull();
    expect(runnerUpdateNotice([], null)).toBeNull();
  });

  test('a dismissal hides it for that release only', () => {
    expect(runnerUpdateNotice([runner(behind())], '0.15.0')).toBeNull();
    expect(
      runnerUpdateNotice([runner(behind('0.14.0', '0.16.0'))], '0.15.0')
        ?.latest,
    ).toBe('0.16.0');
  });
});

describe('the dismissed release (C-328)', () => {
  const memory = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    };
  };

  test('is stored per release and read back', () => {
    const storage = memory();
    expect(readDismissedRelease(storage)).toBeNull();
    storeDismissedRelease('0.15.0', storage);
    expect(storage.items.get(DISMISSED_RELEASE_KEY)).toBe('0.15.0');
    expect(readDismissedRelease(storage)).toBe('0.15.0');
  });

  test('blocked storage forgets it and never throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readDismissedRelease(blocked)).toBeNull();
    expect(() => storeDismissedRelease('0.15.0', blocked)).not.toThrow();
    expect(readDismissedRelease(null)).toBeNull();
  });
});

describe('runnerUpdateCommand (C-328)', () => {
  test('pins the release the notice names', () => {
    expect(runnerUpdateCommand('0.15.0')).toBe(
      'npm i -g nautelle-runner@0.15.0',
    );
  });
});
