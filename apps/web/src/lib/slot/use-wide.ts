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

/** Tailwind's `sm`, glass-ui's tablet edge: from here the Fleet's panel is a column. */
export const TABLET_COLUMN_QUERY = '(min-width: 640px)';

const subscribeTablet = (listener: () => void) => {
  const query = window.matchMedia(TABLET_COLUMN_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
};

/**
 * Like `useWide`, but the column starts at the tablet edge: the Fleet's agent
 * panel is a side panel from tablet up and a bottom sheet on a phone.
 */
export function useTabletUp(): boolean | undefined {
  return useSyncExternalStore<boolean | undefined>(
    subscribeTablet,
    () => window.matchMedia(TABLET_COLUMN_QUERY).matches,
    () => undefined,
  );
}
