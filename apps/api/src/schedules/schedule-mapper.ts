import type {
  ScheduleFiringView,
  ScheduleTarget,
  ScheduleView,
} from '@agentdock/shared';
import type { Schedule, ScheduleFiring } from '@prisma/client';

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export const toFiringView = (row: ScheduleFiring): ScheduleFiringView => ({
  id: row.id.toString(),
  scheduleId: row.scheduleId,
  scheduledFor: row.scheduledFor.toISOString(),
  firedAt: iso(row.firedAt),
  kind: row.kind,
  status: row.status,
  reason: row.reason,
  missedCount: row.missedCount,
  runId: row.runId,
  commandRunId: row.commandRunId,
  error: row.error ?? null,
  finishedAt: iso(row.finishedAt),
});

export const toScheduleView = (
  row: Schedule,
  lastFiring: ScheduleFiring | null,
): ScheduleView => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  // Written only through `parseTarget`.
  target: row.target as unknown as ScheduleTarget,
  cron: row.cron,
  timezone: row.timezone,
  missedPolicy: row.missedPolicy,
  enabled: row.enabled,
  disabledReason: row.disabledReason,
  nextRunAt: iso(row.nextRunAt),
  lastRunAt: iso(row.lastRunAt),
  consecutiveFailures: row.consecutiveFailures,
  createdById: row.createdById,
  updatedById: row.updatedById,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  lastFiring: lastFiring ? toFiringView(lastFiring) : null,
});
