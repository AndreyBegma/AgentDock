'use client';

import type { LiveEventMessage, LiveTopic } from '@agentdock/shared';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getLiveClient, type LiveSnapshot } from './client';

/**
 * Receives the `event` frames published on `topic` (spec D15). The socket is
 * shared by the whole tab, opened with the first subscriber and closed after
 * the last; a reconnect resubscribes by itself. Pass `null` to stay unsubscribed.
 */
export function useLive(
  topic: LiveTopic | null,
  onMessage: (message: LiveEventMessage) => void,
): void {
  const latest = useRef(onMessage);
  useEffect(() => {
    latest.current = onMessage;
  });

  useEffect(() => {
    if (!topic) return;
    return getLiveClient().subscribe(topic, (message) =>
      latest.current(message),
    );
  }, [topic]);
}

const SERVER_SNAPSHOT: LiveSnapshot = {
  status: 'reconnecting',
  closeCode: null,
};

/** Connection state of the tab's live socket, for the status dot. */
export function useLiveStatus(): LiveSnapshot {
  const client = typeof window === 'undefined' ? null : getLiveClient();
  return useSyncExternalStore(
    (listener) => client?.onChange(listener) ?? (() => {}),
    () => client?.getSnapshot() ?? SERVER_SNAPSHOT,
    () => SERVER_SNAPSHOT,
  );
}
