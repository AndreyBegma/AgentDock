import {
  APP_VERSION,
  compareVersions,
  type ProductRelease,
  parseVersion,
} from '@nautelle/shared';
import { guardedGet, TargetAllowlist } from '../webhooks/common/ssrf-guard';

/**
 * The latest Nautelle release on GitHub. Throws when GitHub gives no usable
 * answer. Tests inject a fake: none of them reaches GitHub.
 */
export type FetchProductRelease = () => Promise<ProductRelease>;

/** How the update check reaches GitHub and paces itself (C-374, ADR-0090). */
export interface ProductReleaseOptions {
  fetchLatest: FetchProductRelease;
  /** False when `NAUTELLE_UPDATE_CHECK=false`: GitHub is never asked. */
  enabled: boolean;
  /** Between two checks, answered or not: once a day. */
  intervalMs: number;
  /** Check at bootstrap and on the timer. Never under `APP_ENV=test`: suites call `check()`. */
  autoStart: boolean;
  now: () => Date;
}

export const PRODUCT_RELEASE_OPTIONS = Symbol('PRODUCT_RELEASE_OPTIONS');

/** Product and runner releases share the repository; `latestProductRelease` tells them apart. */
export const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/AndreyBegma/Nautelle/releases?per_page=30';

/** Thirty releases with their notes stay well under this. */
const RELEASES_MAX_BYTES = 2 * 1024 * 1024;

const PRODUCT_TAG = /^v\d+\.\d+\.\d+$/;
const RELEASE_PAGE = /^https:\/\/github\.com\//;

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * The newest published product release in a GitHub releases list: a `vX.Y.Z`
 * tag that is neither a draft nor a prerelease. `runner-v*` releases are
 * skipped. Throws when the list holds none.
 */
export const latestProductRelease = (releases: unknown): ProductRelease => {
  if (!Array.isArray(releases)) throw new Error('not a release list');
  let newest: ProductRelease | null = null;
  for (const each of releases as GitHubRelease[]) {
    const { tag_name: tag, html_url: url, draft, prerelease } = each ?? {};
    if (typeof tag !== 'string' || !PRODUCT_TAG.test(tag)) continue;
    if (draft !== false || prerelease !== false) continue;
    if (typeof url !== 'string' || !RELEASE_PAGE.test(url)) continue;
    const version = parseVersion(tag);
    if (!version) continue;
    const known = newest ? parseVersion(newest.version) : null;
    if (!known || compareVersions(version, known) > 0) {
      newest = { version: tag.slice(1), url };
    }
  }
  if (!newest) throw new Error('no product release');
  return newest;
};

/**
 * `GET` the releases list through the outbound webhooks' SSRF guard: the host
 * is resolved and checked, the connection pinned, redirects refused and the
 * body capped. GitHub refuses a request without a User-Agent.
 */
export const githubLatestRelease =
  (url = GITHUB_RELEASES_URL): FetchProductRelease =>
  async () => {
    const result = await guardedGet({
      url,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Nautelle/${APP_VERSION}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      allowlist: new TargetAllowlist([]),
      maxResponseBytes: RELEASES_MAX_BYTES,
    });
    if (!result.succeeded || result.body === null) {
      throw new Error(
        `${result.error ?? 'no answer'}${result.status ? ` (HTTP ${result.status})` : ''}`,
      );
    }
    return latestProductRelease(JSON.parse(result.body));
  };

/** Off only when `NAUTELLE_UPDATE_CHECK` is `false` or `0`. */
export const updateCheckEnabled = (env: NodeJS.ProcessEnv): boolean => {
  const value = env.NAUTELLE_UPDATE_CHECK?.trim().toLowerCase();
  return value !== 'false' && value !== '0';
};

export const productReleaseOptionsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): ProductReleaseOptions => ({
  fetchLatest: githubLatestRelease(),
  enabled: updateCheckEnabled(env),
  intervalMs: 24 * 60 * 60_000,
  autoStart: env.APP_ENV !== 'test',
  now: () => new Date(),
});
