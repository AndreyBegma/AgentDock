import type { ProductRelease, ProductUpdateView } from '@nautelle/shared';

/**
 * C-374: the notice admins see when a newer Nautelle release is out. The API
 * checks GitHub once a day and compares the versions (`GET /admin/updates`);
 * this module only decides what to show and remembers a dismissal.
 */

/** The release the admin dismissed the notice for, per browser. */
export const DISMISSED_PRODUCT_RELEASE_KEY = 'nautelle.productUpdate.dismissed';

/** How to upgrade an install (the docs site). */
export const UPGRADE_GUIDE_URL =
  'https://andreybegma.github.io/Nautelle/operations/upgrade/';

/** `Nautelle 0.16.0 is available` — the banner's title. */
export const productUpdateTitle = (latest: ProductRelease): string =>
  `Nautelle ${latest.version} is available`;

/**
 * The release to tell the admin about, or null when there is none newer, the
 * check is off or never answered, or the admin dismissed this release. A
 * dismissal lasts until the next release.
 */
export function productUpdateNotice(
  view: ProductUpdateView | null,
  dismissed: string | null,
): ProductRelease | null {
  if (!view?.available || !view.latest) return null;
  if (view.latest.version === dismissed) return null;
  return view.latest;
}

type DismissStorage = Pick<Storage, 'getItem' | 'setItem'>;

const localStorageOrNull = (): DismissStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The dismissed release; null when none was, or storage is blocked. */
export function readDismissedProductRelease(
  storage: DismissStorage | null = localStorageOrNull(),
): string | null {
  try {
    return storage?.getItem(DISMISSED_PRODUCT_RELEASE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Remembers the dismissal; when storage is blocked it lasts for this page. */
export function storeDismissedProductRelease(
  version: string,
  storage: DismissStorage | null = localStorageOrNull(),
): void {
  try {
    storage?.setItem(DISMISSED_PRODUCT_RELEASE_KEY, version);
  } catch {
    // Not remembered: the notice comes back on the next load.
  }
}
