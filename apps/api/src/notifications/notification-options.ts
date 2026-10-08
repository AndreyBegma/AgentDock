import { RUNNER_OFFLINE_AFTER_MS } from '@agentdock/shared';

/** Timings of the notification loops; e2e tests override the provider. */
export interface NotificationOptions {
  /** Start the matcher and watcher timers at bootstrap. Tests drive `tick()` themselves. */
  autoStart: boolean;
  /** D4: how often the matcher reads new events. */
  matcherIntervalMs: number;
  /** Events read per matcher transaction. */
  matcherBatch: number;
  /**
   * How long a hole in `events.id` is waited for before it is taken as a
   * rolled-back insert (spec 22 notes). Ids come from a sequence and two
   * concurrent inserts can commit out of order.
   */
  holeWaitMs: number;
  /** D5: how often the runner watcher looks. */
  watcherIntervalMs: number;
  /** D5: a runner away this long opens an incident. */
  offlineAfterMs: number;
}

export const NOTIFICATION_OPTIONS = Symbol('NOTIFICATION_OPTIONS');

export const defaultNotificationOptions: NotificationOptions = {
  autoStart: true,
  matcherIntervalMs: 2_000,
  matcherBatch: 500,
  holeWaitMs: 10_000,
  watcherIntervalMs: 60_000,
  offlineAfterMs: RUNNER_OFFLINE_AFTER_MS,
};
