import {
  SCHEDULE_CATCH_UP_MAX_MS,
  SCHEDULE_FIRING_REASONS,
  SCHEDULE_MISSED_GRACE_MS,
  type ScheduleFiringReason,
  type ScheduleMissedPolicy,
} from '@agentdock/shared';
import type { CronSchedule } from './cron';

/** Caps the walk over missed occurrences; `missedCount` saturates there. */
export const MISSED_COUNT_CAP = 10_000;

export interface ClaimPlan {
  /** The occurrence to fire now, if any. */
  fire: { scheduledFor: Date; kind: 'cron' | 'catch_up' } | null;
  /** One row standing for occurrences not fired. */
  skipped: {
    scheduledFor: Date;
    missedCount: number;
    reason: ScheduleFiringReason;
  } | null;
  /** The next occurrence after `now`; null when the expression never fires again. */
  nextRunAt: Date | null;
}

export interface ClaimInput {
  schedule: CronSchedule;
  /** The schedule's due `nextRunAt`. */
  due: Date;
  now: Date;
  policy: ScheduleMissedPolicy;
  /**
   * `due` already has a firing row — a `catch_up` occurrence retried after
   * the runner was offline (D9). It is not counted again as missed.
   */
  dueRecorded?: boolean;
}

/**
 * What a claimed schedule does (D6). On time — `due` at most the grace period
 * ago — it fires `due`. Later than that, the newest occurrence up to `now`
 * decides: still within the grace it fires as `cron`; else `catch_up` fires it
 * once, if it is at most 24 hours old, and `skip` (or an older one) records it
 * as `skipped`. Older missed occurrences become one `skipped` row with their
 * count. Never more than one command per claim.
 */
export const planClaim = ({
  schedule,
  due,
  now,
  policy,
  dueRecorded = false,
}: ClaimInput): ClaimPlan => {
  const nextRunAt = schedule.after(now);
  const newest = schedule.atOrBefore(now) ?? due;
  const firstUnrecorded = dueRecorded ? schedule.after(due) : due;
  // Occurrences before `newest` that have no row yet.
  const older =
    firstUnrecorded && firstUnrecorded < newest
      ? schedule.countBetween(
          firstUnrecorded,
          new Date(newest.getTime() - 1),
          MISSED_COUNT_CAP,
        )
      : 0;
  const olderSkipped =
    older > 0 && firstUnrecorded
      ? {
          scheduledFor: firstUnrecorded,
          missedCount: older,
          reason: SCHEDULE_FIRING_REASONS.missed,
        }
      : null;

  // A retried occurrence already holds its `cron` row; it fires as `catch_up`.
  const newestRecorded = dueRecorded && newest.getTime() === due.getTime();
  const late = now.getTime() - newest.getTime();
  if (late <= SCHEDULE_MISSED_GRACE_MS) {
    return {
      fire: {
        scheduledFor: newest,
        kind: newestRecorded ? 'catch_up' : 'cron',
      },
      skipped: olderSkipped,
      nextRunAt,
    };
  }
  if (policy === 'catch_up' && late <= SCHEDULE_CATCH_UP_MAX_MS) {
    return {
      fire: { scheduledFor: newest, kind: 'catch_up' },
      skipped: olderSkipped,
      nextRunAt,
    };
  }
  const missedCount = older + (newestRecorded ? 0 : 1);
  return {
    fire: null,
    skipped:
      missedCount > 0
        ? {
            scheduledFor: olderSkipped?.scheduledFor ?? newest,
            missedCount,
            reason:
              late > SCHEDULE_CATCH_UP_MAX_MS
                ? SCHEDULE_FIRING_REASONS.missedOver24h
                : SCHEDULE_FIRING_REASONS.missed,
          }
        : null,
    nextRunAt,
  };
};
