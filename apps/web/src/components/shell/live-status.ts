'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { LiveStatus } from '../../lib/live/client';
import { reachability } from '../../lib/live/reachability';
import { useLiveStatus } from '../../lib/live/use-live';

/** A first connect or a short blip is not worth a banner. */
export const LIVE_PAUSED_AFTER_MS = 5_000;

/** The words for the live socket, wherever a page shows them. */
export function liveStatusLabel(status: LiveStatus, paused: boolean): string {
  if (status === 'connected') return 'Live';
  // `offline` means the client gave up: it is not reconnecting.
  return paused || status === 'offline'
    ? 'Live updates paused'
    : 'Reconnecting…';
}

/** The header dot has no text beside it, so its label says what it is about. */
export function liveDotLabel(status: LiveStatus, paused: boolean): string {
  if (status === 'connected') return 'Live updates connected';
  const label = liveStatusLabel(status, paused);
  return label === 'Reconnecting…' ? 'Live updates reconnecting' : label;
}

/** The words of the restart banner (spec 353 D2). */
export const RESTARTING_BANNER_TEXT =
  'Reconnecting to AgentDock… (the server may be restarting)';

/** True once the API has been unreachable for 1.5 s; false on the first success. */
export function useServerRestarting(): boolean {
  return useSyncExternalStore(
    reachability.onChange,
    () => reachability.getSnapshot().bannerVisible,
    () => false,
  );
}

/** True once the live socket has been down for more than `afterMs`. */
export function useLivePaused(afterMs = LIVE_PAUSED_AFTER_MS): {
  status: LiveStatus;
  paused: boolean;
} {
  const { status } = useLiveStatus();
  const [paused, setPaused] = useState(false);
  const connected = status === 'connected';

  useEffect(() => {
    if (connected) {
      setPaused(false);
      return;
    }
    const timer = setTimeout(() => setPaused(true), afterMs);
    return () => clearTimeout(timer);
  }, [connected, afterMs]);

  return { status, paused: !connected && paused };
}
