'use client';

import type { LiveTopic } from '@agentdock/shared';
import {
  PANE_LIVE_EVENTS,
  type PaneFrame,
  paneFrameSchema,
  paneTopic,
} from '@agentdock/shared/protocol';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { useLive, useLiveStatus } from '../live/use-live';
import { describePaneError, type PaneConnection } from './format';
import { applyFrame, EMPTY_PANE, type PaneState } from './reducer';

type Action = { type: 'frame'; frame: PaneFrame } | { type: 'reset' };

function reduce(state: PaneState, action: Action): PaneState {
  return action.type === 'reset' ? EMPTY_PANE : applyFrame(state, action.frame);
}

export interface PaneView {
  pane: PaneState;
  connection: PaneConnection;
  /** A sentence when the server refused the topic. */
  error: string | undefined;
}

/**
 * Streams a slot's pane while `enabled` (the tab is open): the topic is
 * subscribed on enable and unsubscribed on disable or unmount. Every
 * `pane.frame` is applied in order — a big frame arrives as a `full` plus
 * `patch`es (spec 18, i18-api notes).
 */
export function usePane(
  projectId: string,
  slot: string,
  enabled: boolean,
): PaneView {
  const [pane, dispatch] = useReducer(reduce, EMPTY_PANE);
  const [error, setError] = useState<string>();
  const status = useLiveStatus();
  const topic = enabled ? (paneTopic(projectId, slot) as LiveTopic) : null;

  // A new topic starts from an empty pane; frames of the old one are not kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: topic is the reset trigger
  useEffect(() => {
    dispatch({ type: 'reset' });
    setError(undefined);
  }, [topic]);

  const onMessage = useCallback((message: { event: string; data: unknown }) => {
    if (message.event === PANE_LIVE_EVENTS.ended) {
      dispatch({ type: 'frame', frame: { type: 'ended' } });
      return;
    }
    if (message.event !== PANE_LIVE_EVENTS.frame) return;
    const parsed = paneFrameSchema.safeParse(message.data);
    if (parsed.success) dispatch({ type: 'frame', frame: parsed.data });
  }, []);

  useLive(topic, onMessage, {
    onError: (code) => setError(describePaneError(code)),
  });

  const connection: PaneConnection = pane.ended
    ? 'ended'
    : status.status === 'connected'
      ? 'connected'
      : 'reconnecting';
  return { pane, connection, error };
}
