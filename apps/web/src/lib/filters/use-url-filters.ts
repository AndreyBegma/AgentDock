'use client';

import type { ToolbarFilter } from '@andrewbehma/glass-ui/toolbar';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activeChips,
  type ChipDef,
  clearAll,
  type FilterCodec,
  mergeSearch,
  SEARCH_DEBOUNCE_MS,
} from './url-filters';

export interface UrlFilters<F> {
  /** What the URL says now. */
  filters: F;
  /** Writes a change over the current filters. */
  set: (patch: Partial<F>) => void;
  /** Writes the filters as given. */
  replace: (next: F) => void;
}

/**
 * A page's filters, read from and written to the URL (#213). A change
 * replaces the history entry and keeps the scroll position, so a filter
 * applies instantly and Back leaves the page rather than undoing a click.
 * Needs a `Suspense` boundary above it, as `useSearchParams` does.
 */
export function useUrlFilters<F>(codec: FilterCodec<F>): UrlFilters<F> {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();
  const filters = useMemo(
    () => codec.parse(new URLSearchParams(search)),
    [codec, search],
  );

  const replace = useCallback(
    (next: F) => {
      const query = mergeSearch(search, codec.keys, codec.search(next));
      router.replace(`${pathname}${query}`, { scroll: false });
    },
    [codec, pathname, router, search],
  );
  const set = useCallback(
    (patch: Partial<F>) => replace({ ...filters, ...patch }),
    [filters, replace],
  );
  return { filters, set, replace };
}

/** The `Toolbar`'s `activeFilters` and `onClearAll` for a page's chips. */
export function useFilterChips<F>(
  { filters, set }: UrlFilters<F>,
  defs: readonly ChipDef<F>[],
): { activeFilters: ToolbarFilter[]; onClearAll?: () => void } {
  const activeFilters = activeChips(filters, defs).map((chip) => ({
    key: chip.key,
    label: chip.label,
    onRemove: () => set(chip.clear),
  }));
  return {
    activeFilters,
    onClearAll:
      activeFilters.length > 0 ? () => set(clearAll(defs)) : undefined,
  };
}

/**
 * A search field's text, applied once typing pauses (or at once with
 * `flush`, on Enter). The URL is the truth: a Back or a "Clear all"
 * rewrites the field.
 */
export function useSearchDraft(
  value: string,
  commit: (value: string) => void,
): { draft: string; setDraft: (value: string) => void; flush: () => void } {
  const [draft, setDraftState] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  // Our own commit comes back as `value`: keep the field's trailing space.
  useEffect(() => {
    setDraftState((current) => {
      if (current.trim() === value.trim()) return current;
      clearTimeout(timer.current);
      return value;
    });
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const setDraft = useCallback(
    (next: string) => {
      setDraftState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        if (next.trim() !== value.trim()) commitRef.current(next.trim());
      }, SEARCH_DEBOUNCE_MS);
    },
    [value],
  );
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (draft.trim() !== value.trim()) commitRef.current(draft.trim());
  }, [draft, value]);
  return { draft, setDraft, flush };
}
