/**
 * C-328: whether a runner is older than the latest published `nautelle-runner`.
 * The API learns the latest release from the npm registry; these helpers
 * compare it with the version a runner reported in its `hello`.
 */

/** The meta package a person installs (`npm i -g nautelle-runner`). */
export const RUNNER_NPM_PACKAGE = 'nautelle-runner';

/**
 * The prebuilt binaries the meta package pulls in as optional dependencies
 * (ADR-0017). A version counts as released only once every one of them is
 * published too: the meta package can land minutes before them.
 */
export const RUNNER_NPM_PLATFORM_PACKAGES = [
  'nautelle-runner-darwin-arm64',
  'nautelle-runner-darwin-x64',
  'nautelle-runner-linux-arm64',
  'nautelle-runner-linux-x64',
] as const;

/** A runner's version against the latest release, on the runner reads. */
export interface RunnerUpdate {
  /** The version the runner last reported. */
  current: string;
  /** The latest released `nautelle-runner`. */
  latest: string;
  /** `current` is older than `latest`. */
  outdated: boolean;
}

export interface ReleaseVersion {
  major: number;
  minor: number;
  patch: number;
  /** `rc.1` in `0.15.0-rc.1`; null for a release. */
  prerelease: string | null;
}

const SEMVER =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `0.15.0`, `v0.15.0`, `0.15.0-rc.1+build`; null for anything else. */
export const parseVersion = (raw: string): ReleaseVersion | null => {
  const match = SEMVER.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
};

/**
 * Orders two versions by major, minor and patch only: a prerelease tag is
 * ignored, so `0.15.0-rc.1` and `0.15.0` compare equal. Negative when `a` is
 * older.
 */
export const compareVersions = (a: ReleaseVersion, b: ReleaseVersion): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * The update a runner on `current` has, or null when either side is unknown:
 * a runner that never reported a version (or reported one that is not
 * semver) shows nothing, and so does every runner before the API has read
 * the registry once.
 */
export const runnerUpdate = (
  current: string | null,
  latest: string | null,
): RunnerUpdate | null => {
  if (!current || !latest) return null;
  const ours = parseVersion(current);
  const theirs = parseVersion(latest);
  if (!ours || !theirs) return null;
  return { current, latest, outdated: compareVersions(ours, theirs) < 0 };
};
