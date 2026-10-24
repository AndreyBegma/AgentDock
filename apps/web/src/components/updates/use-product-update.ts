'use client';

import type { ProductRelease, ProductUpdateView } from '@nautelle/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  productUpdateNotice,
  readDismissedProductRelease,
  storeDismissedProductRelease,
} from '../../lib/updates/product-update';

/**
 * C-374: the newer Nautelle release, for an admin, read once when the shell
 * mounts, and its dismissal. The API answers from its stored daily check: a
 * page view never reaches GitHub. Anyone but an admin never asks.
 */
export function useProductUpdate(admin: boolean): {
  release: ProductRelease | null;
  dismiss: () => void;
} {
  const [view, setView] = useState<ProductUpdateView | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (!admin) return;
    setDismissed(readDismissedProductRelease());
    let cancelled = false;
    api<ProductUpdateView>('/admin/updates')
      .then((answer) => {
        if (!cancelled) setView(answer);
      })
      .catch(() => {
        // No notice; Account › About still says the running version.
      });
    return () => {
      cancelled = true;
    };
  }, [admin]);

  const release = admin ? productUpdateNotice(view, dismissed) : null;
  const version = release?.version ?? null;
  const dismiss = useCallback(() => {
    if (!version) return;
    setDismissed(version);
    storeDismissedProductRelease(version);
  }, [version]);
  return { release, dismiss };
}
