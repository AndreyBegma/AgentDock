'use client';

import {
  type LiveErrorCode,
  type LiveTopic,
  runTopic,
} from '@agentdock/shared';
import {
  RUN_LOG_LIVE_EVENTS,
  runLogFrameSchema,
} from '@agentdock/shared/protocol';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { useLive, useLiveStatus } from '../live/use-live';
import {
  applyRunLogFrame,
  beginReplay,
  EMPTY_RUN_LOG,
  type RunLogState,
} from './run-log';

type Action =
  | { type: 'frame'; frame: Parameters<typeof applyRunLogFrame>[1] }
  | { type: 'replay' }
  | { type: 'reset' };

function reduce(state: RunLogState, action: Action): RunLogState {
  switch (action.type) {
    case 'frame':
      return applyRunLogFrame(state, action.frame);
    case 'replay':
      return beginReplay(state);
    case 'reset':
      return EMPTY_RUN_LOG;
  }
}

const ERROR_SENTENCE: Partial<Record<LiveErrorCode, string>> = {
  forbidden: 'You are not a member of this project, so you cannot watch it.',
  not_found: 'This run does not belong to this project.',
};

export interface RunLogView {
  log: RunLogState;
  connected: boolean;
  /** A sentence when the server refused the topic. */
  error: string | undefined;
}

/**
 * Streams a skill run's rendered log while `enabled` (the run is not over):
 * the topic is subscribed on enable and unsubscribed on disable or unmount.
 * A reconnect makes the server replay the backlog, so the next backlog frame
 * replaces the lines instead of appending to them. Nothing is stored.
 */
export function useRunLog(
  projectId: string,
  runId: string,
  enabled: boolean,
): RunLogView {
  const [log, dispatch] = useReducer(reduce, EMPTY_RUN_LOG);
  const [error, setError] = useState<string>();
  const status = useLiveStatus();
  const topic = enabled ? (runTopic(projectId, runId) as LiveTopic) : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: topic is the reset trigger
  useEffect(() => {
    dispatch({ type: 'reset' });
    setError(undefined);
  }, [topic]);

  useEffect(() => {
    if (status.status !== 'connected') dispatch({ type: 'replay' });
  }, [status.status]);

  const onMessage = useCallback((message: { event: string; data: unknown }) => {
    if (
      message.event !== RUN_LOG_LIVE_EVENTS.lines &&
      message.event !== RUN_LOG_LIVE_EVENTS.ended
    ) {
      return;
    }
    const parsed = runLogFrameSchema.safeParse(message.data);
    if (parsed.success) dispatch({ type: 'frame', frame: parsed.data });
  }, []);

  useLive(topic, onMessage, {
    onError: (code) =>
      setError(ERROR_SENTENCE[code] ?? 'The live log could not be opened.'),
  });

  return { log, connected: status.status === 'connected', error };
}
