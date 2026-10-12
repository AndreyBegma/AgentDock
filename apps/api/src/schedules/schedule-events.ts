import {
  SCHEDULE_DISABLED_LIVE_EVENT,
  SCHEDULE_FAILED_LIVE_EVENT,
  SCHEDULE_FIRED_LIVE_EVENT,
  SCHEDULE_SKIPPED_LIVE_EVENT,
  type ScheduleDisabledReason,
  type ScheduleEventData,
  type ScheduleEventType,
} from '@agentdock/shared';
import { API_EVENT_SOURCE } from '@agentdock/shared/protocol';
import type { Prisma, ScheduleFiring } from '@prisma/client';
import { recordServerEvent } from '../server-events';

type Tx = Prisma.TransactionClient;

/** The `schedule.*` type a firing's status is announced and recorded as (D17). */
export const FIRING_EVENT: Partial<
  Record<ScheduleFiring['status'], ScheduleEventType>
> = {
  started: SCHEDULE_FIRED_LIVE_EVENT,
  succeeded: SCHEDULE_FIRED_LIVE_EVENT,
  noop: SCHEDULE_FIRED_LIVE_EVENT,
  skipped: SCHEDULE_SKIPPED_LIVE_EVENT,
  failed: SCHEDULE_FAILED_LIVE_EVENT,
};

const record = async (
  tx: Tx,
  scheduleId: string,
  type: ScheduleEventType,
  firingId: bigint,
  ts: Date,
  data: Omit<ScheduleEventData, 'scheduleId' | 'scheduleName' | 'firingId'>,
): Promise<void> => {
  const schedule = await tx.schedule.findUnique({
    where: { id: scheduleId },
    select: {
      name: true,
      project: { select: { runnerId: true, rootPath: true, repo: true } },
    },
  });
  if (!schedule) return;
  const payload: ScheduleEventData = {
    scheduleId,
    scheduleName: schedule.name,
    firingId: firingId.toString(),
    ...data,
  };
  await recordServerEvent(tx, {
    source: API_EVENT_SOURCE,
    type,
    ts,
    project: schedule.project,
    data: { ...payload },
    // A `started` firing that later succeeds is one `schedule.fired`.
    dedupeKey: `${type}:${firingId}`,
  });
};

/**
 * Records the `schedule.*` event of a firing that just reached `firing.status`
 * (D17, ADR-0014), in the transaction that moved it there. Nothing for `due`.
 */
export const recordFiringEvent = async (
  tx: Tx,
  firing: ScheduleFiring,
  now: Date,
): Promise<void> => {
  const type = FIRING_EVENT[firing.status];
  if (!type) return;
  await record(tx, firing.scheduleId, type, firing.id, now, {
    status: firing.status,
    ...(firing.reason ? { reason: firing.reason } : {}),
    kind: firing.kind,
    scheduledFor: firing.scheduledFor.toISOString(),
    ...(firing.missedCount > 0 ? { missedCount: firing.missedCount } : {}),
    ...(firing.runId ? { runId: firing.runId } : {}),
  });
};

/** Records `schedule.disabled`, caused by `firingId`, in the transaction that disabled it. */
export const recordDisabledEvent = (
  tx: Tx,
  scheduleId: string,
  firingId: bigint,
  reason: ScheduleDisabledReason,
  now: Date,
): Promise<void> =>
  record(tx, scheduleId, SCHEDULE_DISABLED_LIVE_EVENT, firingId, now, {
    disabledReason: reason,
  });
