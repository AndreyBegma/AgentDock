'use client';

import { useSyncExternalStore } from 'react';

/** Tailwind's `lg`: from here the panel is a column beside the canvas. */
export const PANEL_COLUMN_QUERY = '(min-width: 1024px)';

const subscribe = (listener: () => void) => {
  const query = window.matchMedia(PANEL_COLUMN_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/**
 * Whether the panel is a column (true) or a bottom sheet (false); undefined
 * on the server and in the first client render, so neither shape is drawn
 * and then swapped for the other while it hydrates.
 */
export function useWide(): boolean | undefined {
  return useSyncExternalStore<boolean | undefined>(
    subscribe,
    () => window.matchMedia(PANEL_COLUMN_QUERY).matches,
    () => undefined,
  );
}
