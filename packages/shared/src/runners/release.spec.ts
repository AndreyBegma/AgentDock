import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareVersions,
  parseVersion,
  type ReleaseVersion,
  RUNNER_NPM_PLATFORM_PACKAGES,
  runnerUpdate,
} from './release';

const v = (raw: string): ReleaseVersion => {
  const parsed = parseVersion(raw);
  if (!parsed) throw new Error(`not a version: ${raw}`);
  return parsed;
};

describe('parseVersion (C-328)', () => {
  it('reads a release, a leading v, a prerelease and build metadata', () => {
    expect(parseVersion('0.15.0')).toEqual({
      major: 0,
      minor: 15,
      patch: 0,
      prerelease: null,
    });
    expect(parseVersion('v1.2.3')?.major).toBe(1);
    expect(parseVersion('0.15.0-rc.1+abc')?.prerelease).toBe('rc.1');
  });

  it('refuses what is not semver', () => {
    for (const raw of ['', 'dev', '1.2', '1.2.3.4', '1.x.0']) {
      expect(parseVersion(raw)).toBeNull();
    }
  });
});

describe('compareVersions (C-328)', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions(v('0.9.0'), v('0.10.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0'), v('0.99.99'))).toBeGreaterThan(0);
    expect(compareVersions(v('0.14.2'), v('0.14.10'))).toBeLessThan(0);
  });

  it('ignores a prerelease tag', () => {
    expect(compareVersions(v('0.15.0-rc.1'), v('0.15.0'))).toBe(0);
    expect(compareVersions(v('0.15.0-dev'), v('0.14.0'))).toBeGreaterThan(0);
  });
});

describe('runnerUpdate (C-328)', () => {
  it('is outdated when the runner is older than the release', () => {
    expect(runnerUpdate('0.14.0', '0.15.0')).toEqual({
      current: '0.14.0',
      latest: '0.15.0',
      outdated: true,
    });
  });

  it('is current on the release, a newer build, or its prerelease', () => {
    expect(runnerUpdate('0.15.0', '0.15.0')?.outdated).toBe(false);
    expect(runnerUpdate('0.16.0', '0.15.0')?.outdated).toBe(false);
    expect(runnerUpdate('0.15.0-rc.2', '0.15.0')?.outdated).toBe(false);
  });

  it('is unknown without a reported version, a known release, or semver', () => {
    expect(runnerUpdate(null, '0.15.0')).toBeNull();
    expect(runnerUpdate('0.14.0', null)).toBeNull();
    expect(runnerUpdate('dev', '0.15.0')).toBeNull();
  });
});

describe('RUNNER_NPM_PLATFORM_PACKAGES (C-328)', () => {
  it('lists every optional dependency of the published meta package', () => {
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), '../../apps/runner/npm/package.json'),
        'utf8',
      ),
    ) as { optionalDependencies: Record<string, string> };
    const listed: string[] = [...RUNNER_NPM_PLATFORM_PACKAGES];
    expect(listed.sort()).toEqual(
      Object.keys(manifest.optionalDependencies).sort(),
    );
  });
});
