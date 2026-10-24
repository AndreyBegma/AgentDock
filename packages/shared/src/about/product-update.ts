import { compareVersions, parseVersion } from '../runners/release';

/**
 * C-374: whether a newer Nautelle release is out. The API reads the latest
 * GitHub release at most once a day (ADR-0091); admins see the answer in the
 * web app.
 */

/** A published Nautelle release. */
export interface ProductRelease {
  /** `0.16.0`, without the tag's `v`. */
  version: string;
  /** The release page on GitHub. */
  url: string;
}

/** `GET /admin/updates`. */
export interface ProductUpdateView {
  /** The version this install runs (`APP_VERSION`). */
  current: string;
  /** The latest release, or null when the check is off or never answered. */
  latest: ProductRelease | null;
  /** `latest` is newer than `current`. */
  available: boolean;
  /** False when `NAUTELLE_UPDATE_CHECK=false`. */
  checkEnabled: boolean;
  /** When the API last asked GitHub, answered or not; ISO 8601. */
  checkedAt: string | null;
}

/**
 * The view for an install on `current`. A version that is not semver, on
 * either side, offers no update.
 */
export const productUpdateView = (
  current: string,
  latest: ProductRelease | null,
  checkEnabled: boolean,
  checkedAt: string | null,
): ProductUpdateView => {
  const ours = parseVersion(current);
  const theirs = latest ? parseVersion(latest.version) : null;
  return {
    current,
    latest,
    available:
      ours !== null && theirs !== null && compareVersions(ours, theirs) < 0,
    checkEnabled,
    checkedAt,
  };
};
