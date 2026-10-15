'use client';

import { useSyncExternalStore } from 'react';

/** Where the canvas is drawn; below it a phone gets the list (and the panel a sheet). */
const DESKTOP_QUERY = '(min-width: 1024px)';

function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** True at the canvas's width. False on the server: the first paint is the list. */
export function useDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}
