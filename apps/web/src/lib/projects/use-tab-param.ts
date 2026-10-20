'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback } from 'react';

/**
 * The tab a page shows, read from and written to `?tab=` (style system, Tabs).
 * `aliases` maps a retired value to the tab that now holds it, so old links
 * keep working. An unknown or missing value is the first tab. A change
 * replaces the history entry and keeps the scroll. Needs a `Suspense`
 * boundary above it, as `useSearchParams` does.
 */
export function useTabParam<T extends string>(
  tabs: readonly T[],
  aliases?: Readonly<Partial<Record<string, T>>>,
): [T, (next: T) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const wanted = params.get('tab');
  const alias =
    wanted !== null && aliases && Object.hasOwn(aliases, wanted)
      ? aliases[wanted]
      : undefined;
  const tab = tabs.find((id) => id === wanted) ?? alias ?? (tabs[0] as T);
  const search = params.toString();

  const setTab = useCallback(
    (next: T) => {
      const copy = new URLSearchParams(search);
      if (next === tabs[0]) copy.delete('tab');
      else copy.set('tab', next);
      const query = copy.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, search, tabs],
  );
  return [tab, setTab];
}
