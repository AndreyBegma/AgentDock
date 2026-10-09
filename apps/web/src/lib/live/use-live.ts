'use client';

import type {
  LiveErrorCode,
  LiveEventMessage,
  LiveTopic,
} from '@agentdock/shared';
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
  options?: {
    /** The server refused the topic (`forbidden`, `not_found`, …) or dropped it. */
    onError?: (code: LiveErrorCode) => void;
  },
): void {
  const latest = useRef(onMessage);
  const latestError = useRef(options?.onError);
  useEffect(() => {
    latest.current = onMessage;
    latestError.current = options?.onError;
  });
  const wantsErrors = options?.onError !== undefined;

  useEffect(() => {
    if (!topic) return;
    return getLiveClient().subscribe(
      topic,
      (message) => latest.current(message),
      wantsErrors ? (code) => latestError.current?.(code) : undefined,
    );
  }, [topic, wantsErrors]);
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
