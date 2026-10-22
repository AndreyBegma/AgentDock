import {
  compareVersions,
  parseVersion,
  RUNNER_NPM_PACKAGE,
  RUNNER_NPM_PLATFORM_PACKAGES,
} from '@nautelle/shared';
import { guardedGet, TargetAllowlist } from '../webhooks/common/ssrf-guard';

/**
 * The version a package's `latest` dist-tag points at. Throws when the
 * registry gives no usable answer. Tests inject a fake: none of them reaches
 * the real registry.
 */
export type FetchLatestVersion = (pkg: string) => Promise<string>;

/** How the release check reaches npm and paces itself (C-328). */
export interface RunnerReleaseOptions {
  fetchLatest: FetchLatestVersion;
  /** Between two reads of the registry. */
  refreshMs: number;
  /** After a failed read: sooner than `refreshMs`, so a boot before the network is up recovers. */
  retryMs: number;
  /** Read at bootstrap and on the timer. Never under `APP_ENV=test`: suites call `refresh()`. */
  autoStart: boolean;
}

export const RUNNER_RELEASE_OPTIONS = Symbol('RUNNER_RELEASE_OPTIONS');

export const NPM_REGISTRY = 'https://registry.npmjs.org';

/** A version manifest is a few KB; anything far larger is not one. */
const MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * `GET <registry>/<pkg>/latest` through the outbound webhooks' SSRF guard:
 * the host is resolved and checked, the connection pinned, redirects refused
 * and the body capped. No private target is allowlisted.
 */
export const npmLatestVersion =
  (registry = NPM_REGISTRY): FetchLatestVersion =>
  async (pkg) => {
    const result = await guardedGet({
      url: `${registry}/${encodeURIComponent(pkg)}/latest`,
      headers: { Accept: 'application/json' },
      allowlist: new TargetAllowlist([]),
      maxResponseBytes: MANIFEST_MAX_BYTES,
    });
    if (!result.succeeded || result.body === null) {
      throw new Error(
        `${pkg}: ${result.error ?? 'no answer'}${result.status ? ` (HTTP ${result.status})` : ''}`,
      );
    }
    const { version } = JSON.parse(result.body) as { version?: unknown };
    if (typeof version !== 'string') throw new Error(`${pkg}: no version`);
    return version;
  };

export const runnerReleaseOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): RunnerReleaseOptions => ({
  fetchLatest: npmLatestVersion(),
  refreshMs: 60 * 60_000,
  retryMs: 5 * 60_000,
  autoStart: env.APP_ENV !== 'test',
});

/**
 * The newest version every package — the meta package and each platform
 * binary — has published: the lowest of their `latest` tags. The meta
 * package can be published minutes before the binaries, and until they land
 * the release is not installable. Throws when any package gives no answer or
 * its `latest` is not a release (a prerelease is never offered).
 */
export const latestReleased = async (
  fetchLatest: FetchLatestVersion,
): Promise<string> => {
  const packages = [RUNNER_NPM_PACKAGE, ...RUNNER_NPM_PLATFORM_PACKAGES];
  const versions = await Promise.all(
    packages.map(async (pkg) => {
      const raw = await fetchLatest(pkg);
      const parsed = parseVersion(raw);
      if (!parsed || parsed.prerelease !== null) {
        throw new Error(`${pkg}: latest is not a release (${raw})`);
      }
      return { raw: raw.replace(/^v/, ''), parsed };
    }),
  );
  return versions.reduce((lowest, each) =>
    compareVersions(each.parsed, lowest.parsed) < 0 ? each : lowest,
  ).raw;
};
