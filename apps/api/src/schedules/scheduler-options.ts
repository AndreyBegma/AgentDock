import type { ConfigService } from '@nestjs/config';

/** Timings of the schedules queue (spec 123 B9–B12, spec 25 notes). */
export interface SchedulerOptions {
  /** Whether this instance runs the `schedules` worker and its repeatables. */
  enabled: boolean;
  /** `fire` jobs one worker processes at a time (B11). */
  concurrency: number;
  /** How often `settle` runs: finished runs and stale `due` firings (B10). */
  settleMs: number;
  /** How often `reconcile` rebuilds timers from PostgreSQL (B9). */
  reconcileMs: number;
  /** A firing left `due` this long (the API died before sending) is failed. */
  staleDueMs: number;
  /** How long a timer sync may wait on Redis before it gives up (B8). */
  syncTimeoutMs: number;
}

export const SCHEDULER_OPTIONS = Symbol('SCHEDULER_OPTIONS');

export const schedulerOptions = (config: ConfigService): SchedulerOptions => ({
  // Every e2e suite boots the whole app; tests drive the processor themselves.
  enabled:
    config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
    config.get<string>('APP_ENV') !== 'test',
  concurrency: 5,
  settleMs: 15_000,
  reconcileMs: 60_000,
  staleDueMs: 10 * 60_000,
  syncTimeoutMs: 2_000,
});
