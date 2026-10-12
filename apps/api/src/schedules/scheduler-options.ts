import type { ConfigService } from '@nestjs/config';

/** Timings of the scheduler loop (spec 25 D5, "Configuration"). */
export interface SchedulerOptions {
  /** Whether the loop starts on bootstrap. */
  enabled: boolean;
  /** How often the leader ticks. */
  tickMs: number;
  /** How often a follower retries the leader lock. */
  leaderRetryMs: number;
  /** Due schedules claimed per tick. */
  batch: number;
  /** A firing left `due` this long (the API died before sending) is failed. */
  staleDueMs: number;
}

export const SCHEDULER_OPTIONS = Symbol('SCHEDULER_OPTIONS');

export const schedulerOptions = (config: ConfigService): SchedulerOptions => ({
  // Every e2e suite boots the whole app; tests drive `tick()` themselves.
  enabled:
    config.get<string>('SCHEDULER_ENABLED') !== 'false' &&
    config.get<string>('APP_ENV') !== 'test',
  tickMs: 15_000,
  leaderRetryMs: 30_000,
  batch: 20,
  staleDueMs: 10 * 60_000,
});
