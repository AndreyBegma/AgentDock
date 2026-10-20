/** The product site: what Nautelle is, for someone who has not met it yet. */
export const PRODUCT_SITE_URL = 'https://nautelle.luna-realm.com/';

/**
 * The quiet footer line on the pages without a shell (sign in, register,
 * pending, install) that points a newcomer at the product site.
 */
export function SiteLink() {
  return (
    <p className="text-center text-sm text-ink-3">
      New to Nautelle?{' '}
      <a
        href={PRODUCT_SITE_URL}
        target="_blank"
        rel="noreferrer"
        className="text-ink-2 underline underline-offset-2 hover:text-ink"
      >
        See what it does
      </a>
    </p>
  );
}
