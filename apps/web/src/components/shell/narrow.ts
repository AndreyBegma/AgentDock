import { BREAKPOINTS } from '@andrewbehma/glass-ui/breakpoints';
import { useSyncExternalStore } from 'react';

/**
 * The shell's phone edge, glass-ui's tablet breakpoint (`sm`, C-282): below it
 * the floating `BottomCapsule` replaces the rail, and the Board lays out for a
 * phone. A tablet (640–1023 px) keeps the rail, folded to its icon strip.
 */
export const NARROW_MAX_WIDTH_PX = BREAKPOINTS.tablet;

export const NARROW_QUERY = `(max-width: ${NARROW_MAX_WIDTH_PX - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** True below the phone edge (the capsule shows); false on the server. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}
