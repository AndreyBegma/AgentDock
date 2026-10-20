'use client';

import { type LiveTopic, runTopic } from '@nautelle/shared';
import { useCallback, useSyncExternalStore } from 'react';
import { getLiveClient } from '../live/client';
import {
  EMPTY_RUN_LOG_VIEW,
  RunLogRegistry,
  type RunLogView,
} from './run-log-store';

export type { RunLogView } from './run-log-store';

let registry: RunLogRegistry | null = null;

/** The tab's run-log stores; browser only. */
const getRegistry = (): RunLogRegistry => {
  registry ??= new RunLogRegistry(getLiveClient());
  return registry;
};

const NO_TOPIC_SUBSCRIBE = () => () => {};

/**
 * Streams a skill run's rendered log while `enabled` (the run is not over).
 * Every caller of the same run shares one store, so one that mounts late (the
 * Run log panel opened over the progress card) sees the lines already received
 * instead of waiting for new ones. The topic is subscribed while at least one
 * caller is enabled. A reconnect makes the server replay the backlog, so the
 * next backlog frame replaces the lines instead of appending. Nothing is stored
 * once the last caller is gone.
 */
export function useRunLog(
  projectId: string,
  runId: string,
  enabled: boolean,
): RunLogView {
  const topic = enabled ? (runTopic(projectId, runId) as LiveTopic) : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      topic ? getRegistry().attach(topic, listener) : NO_TOPIC_SUBSCRIBE(),
    [topic],
  );
  const getSnapshot = useCallback(
    () => (topic ? getRegistry().getView(topic) : EMPTY_RUN_LOG_VIEW),
    [topic],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_RUN_LOG_VIEW);
}
