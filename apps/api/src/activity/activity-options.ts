import { ACTIVITY_RETENTION_DAYS_DEFAULT } from '@agentdock/shared';
import type { ConfigService } from '@nestjs/config';

/** Timings of the activity and run projectors (spec 21 "Configuration"). */
export interface ActivityOptions {
  /** Poll interval of the projector loop; 0 turns the loop off. */
  pollMs: number;
  /** How long a hole in `events.id` is waited on (notes). */
  gapGraceMs: number;
  /** Items older than this are deleted daily (D6). */
  retentionDays: number;
  /** Whether the loop starts on bootstrap: never under `APP_ENV=test`. */
  loop: boolean;
}

export const ACTIVITY_OPTIONS = Symbol('ACTIVITY_OPTIONS');

/** A non-negative integer from the env, else `fallback`. */
const nonNegative = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

export const activityOptions = (config: ConfigService): ActivityOptions => {
  const pollMs = nonNegative(config.get<string>('ACTIVITY_POLL_MS'), 2000);
  return {
    pollMs,
    gapGraceMs: nonNegative(
      config.get<string>('ACTIVITY_GAP_GRACE_MS'),
      10_000,
    ),
    retentionDays:
      nonNegative(config.get<string>('ACTIVITY_RETENTION_DAYS'), 0) ||
      ACTIVITY_RETENTION_DAYS_DEFAULT,
    // Every e2e suite boots the whole app; a background writer would race
    // their TRUNCATEs. Tests drive `tick()` themselves.
    loop: pollMs > 0 && config.get<string>('APP_ENV') !== 'test',
  };
};
