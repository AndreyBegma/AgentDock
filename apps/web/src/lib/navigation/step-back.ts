'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

/** The parts of `window` that tell whether one step back stays in the app. */
export type StepBackWindow = {
  history: { length: number };
  /** The Navigation API, where the browser has it: it lists same-origin entries only. */
  navigation?: { currentEntry: { index: number } | null };
};

/**
 * Whether one step back in the history stays in AgentDock. The Navigation API
 * counts same-origin entries only, so a page opened from another site or in a
 * fresh tab is at index 0; without it, any earlier entry counts.
 */
export function canStepBack(win: StepBackWindow): boolean {
  const entry = win.navigation?.currentEntry;
  if (entry) return entry.index > 0;
  return win.history.length > 1;
}

/**
 * Leave a full-screen layer to where it was opened from (#677, stack S-6):
 * one step back in the history — the card, stack or plan, with its state and
 * scroll — or, on a page opened directly, `fallback`. The system back gesture
 * does the same step.
 */
export function stepBack(
  router: { back(): void; push(href: string): void },
  fallback: string,
  win: StepBackWindow,
) {
  if (canStepBack(win)) router.back();
  else router.push(fallback);
}

/** {@link stepBack} bound to the router and the window. */
export function useStepBack(fallback: string): () => void {
  const router = useRouter();
  return useCallback(
    () => stepBack(router, fallback, window as unknown as StepBackWindow),
    [router, fallback],
  );
}
