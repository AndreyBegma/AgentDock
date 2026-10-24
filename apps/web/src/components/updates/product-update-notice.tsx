import { Banner } from '@andrewbehma/glass-ui/banner';
import type { ProductRelease } from '@nautelle/shared';
import {
  productUpdateTitle,
  UPGRADE_GUIDE_URL,
} from '../../lib/updates/product-update';

const LINK = 'text-accent-ink underline underline-offset-2';

/**
 * C-374: "Nautelle X.Y.Z is available — release notes", and how to upgrade.
 * Admins only; dismissing it hides it until the next release.
 */
export function ProductUpdateNotice({
  release,
  onDismiss,
}: {
  release: ProductRelease;
  onDismiss: () => void;
}) {
  return (
    <Banner
      tone="info"
      title={
        <>
          {productUpdateTitle(release)} —{' '}
          <a
            href={release.url}
            target="_blank"
            rel="noreferrer"
            className={LINK}
          >
            release notes
          </a>
        </>
      }
      onDismiss={onDismiss}
    >
      <p>
        Upgrade with{' '}
        <code className="font-mono text-ink">docker compose pull</code> and{' '}
        <code className="font-mono text-ink">docker compose up -d</code>, as{' '}
        <a
          href={UPGRADE_GUIDE_URL}
          target="_blank"
          rel="noreferrer"
          className={LINK}
        >
          Upgrading
        </a>{' '}
        explains.
      </p>
    </Banner>
  );
}
