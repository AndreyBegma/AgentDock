import {
  SCHEDULE_DISABLED_LIVE_EVENT,
  SCHEDULE_FAILED_LIVE_EVENT,
  SCHEDULE_FIRED_LIVE_EVENT,
  SCHEDULE_FIRING_UPDATED_LIVE_EVENT,
  SCHEDULE_SKIPPED_LIVE_EVENT,
  SCHEDULE_UPDATED_LIVE_EVENT,
  type ScheduleDisabledLiveEvent,
  type ScheduleDisabledReason,
  type ScheduleFiringLiveChange,
  type ScheduleLiveChange,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { ScheduleFiring } from '@prisma/client';
import { LiveService } from '../live/live.service';

/** What a firing's status is announced as, beyond `schedule_firing.updated` (D17). */
const ANNOUNCED: Partial<Record<ScheduleFiring['status'], string>> = {
  started: SCHEDULE_FIRED_LIVE_EVENT,
  succeeded: SCHEDULE_FIRED_LIVE_EVENT,
  noop: SCHEDULE_FIRED_LIVE_EVENT,
  skipped: SCHEDULE_SKIPPED_LIVE_EVENT,
  failed: SCHEDULE_FAILED_LIVE_EVENT,
};

/**
 * D17: schedule changes on `project:<id>` through `LiveService`. The
 * `schedule.*` events are live only — the `events` table is runner-scoped
 * (spec 25 notes); `schedule_firings` is their durable record.
 */
@Injectable()
export class ScheduleLive {
  private readonly logger = new Logger(ScheduleLive.name);

  constructor(private readonly live: LiveService) {}

  schedule(projectId: string, change: ScheduleLiveChange): void {
    this.publish(projectId, SCHEDULE_UPDATED_LIVE_EVENT, change);
  }

  /** `schedule_firing.updated`, plus `schedule.fired|skipped|failed` when it lands there. */
  firing(projectId: string, row: ScheduleFiring, announce = true): void {
    const change: ScheduleFiringLiveChange = {
      scheduleId: row.scheduleId,
      firingId: row.id.toString(),
      status: row.status,
      reason: row.reason,
    };
    this.publish(projectId, SCHEDULE_FIRING_UPDATED_LIVE_EVENT, change);
    const type = announce ? ANNOUNCED[row.status] : undefined;
    if (type) this.publish(projectId, type, change);
  }

  disabled(
    projectId: string,
    scheduleId: string,
    reason: ScheduleDisabledReason,
  ): void {
    const event: ScheduleDisabledLiveEvent = { scheduleId, reason };
    this.publish(projectId, SCHEDULE_DISABLED_LIVE_EVENT, event);
    this.schedule(projectId, { id: scheduleId });
  }

  private publish(projectId: string, type: string, data: unknown): void {
    try {
      this.live.publish(`project:${projectId}`, type, data);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${type} not published: ${reason}`);
    }
  }
}
