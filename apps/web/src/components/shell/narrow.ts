import { useSyncExternalStore } from 'react';

/**
 * The shell's one narrow breakpoint, glass-ui's `lg` (#497): below it the
 * bottom `TabBar` replaces the rail, and the Board lays out for a phone.
 */
export const NARROW_MAX_WIDTH_PX = 1024;

export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH_PX - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** True below the narrow breakpoint (the tab bar shows); false on the server. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}
