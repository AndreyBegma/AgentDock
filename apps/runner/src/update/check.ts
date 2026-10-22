/** The npm package a person installs; the binary comes in a platform package. */
export const PACKAGE_NAME = 'nautelle-runner';

const REGISTRY = 'https://registry.npmjs.org';

/** The registry check gives up after this long (C-327). */
export const CHECK_TIMEOUT_MS = 1_500;

/** The targets with a platform package, as in `npm/bin/nautelle-runner.js`. */
const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

/** `nautelle-runner-<os>-<arch>`, or null when no binary is built for it. */
export const platformPackage = (os: string, arch: string): string | null => {
  const target = `${os}-${arch}`;
  return TARGETS.includes(target) ? `${PACKAGE_NAME}-${target}` : null;
};

/** A release version only: a prerelease is never offered. */
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Plain semver order of two release versions; null when either is not one. */
export const compareVersions = (a: string, b: string): number | null => {
  const x = RELEASE.exec(a);
  const y = RELEASE.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
};

const latestOf = async (
  fetcher: typeof fetch,
  name: string,
  signal: AbortSignal,
): Promise<string | null> => {
  const response = await fetcher(`${REGISTRY}/${name}/latest`, {
    headers: { accept: 'application/json' },
    signal,
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { version?: unknown } | null;
  return typeof body?.version === 'string' ? body.version : null;
};

export interface CheckOptions {
  fetch: typeof fetch;
  current: string;
  /** `nautelle-runner-<os>-<arch>` of this host. */
  platformPackage: string;
  timeoutMs?: number;
}

/**
 * The newer release to offer, or null. It counts only when the platform
 * package has it too: npm publishes the meta package first, and installing
 * it before the binary arrives removes the binary a service unit points at.
 * Any network or parse error is null.
 */
export const availableVersion = async ({
  fetch: fetcher,
  current,
  platformPackage: platform,
  timeoutMs = CHECK_TIMEOUT_MS,
}: CheckOptions): Promise<string | null> => {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const [meta, binary] = await Promise.all([
      latestOf(fetcher, PACKAGE_NAME, signal),
      latestOf(fetcher, platform, signal),
    ]);
    if (meta === null || binary === null) return null;
    if ((compareVersions(meta, current) ?? 0) <= 0) return null;
    return (compareVersions(binary, meta) ?? -1) >= 0 ? meta : null;
  } catch {
    return null;
  }
};
