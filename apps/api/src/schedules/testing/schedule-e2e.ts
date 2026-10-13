import type { PrismaService } from '../../database/prisma.service';
import type { ScheduleFireProcessor } from '../schedule-fire.processor';
import type { ScheduleMaintenance } from '../schedule-maintenance';

/**
 * What the worker does by `now`, without Redis or a clock: one `settle`, then
 * the `fire` job of every schedule whose `nextRunAt` has come — the job its
 * timer would deliver. Returns the firings sent. A D9 re-delay sends nothing;
 * the next call delivers the same job again.
 */
export const dueTick =
  (
    prisma: PrismaService,
    processor: ScheduleFireProcessor,
    maintenance: ScheduleMaintenance,
  ) =>
  async (now: Date): Promise<bigint[]> => {
    await maintenance.settle(now);
    const due = await prisma.schedule.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      select: { id: true, nextRunAt: true },
      orderBy: { nextRunAt: 'asc' },
    });
    const fired: bigint[] = [];
    for (const row of due) {
      if (!row.nextRunAt) continue;
      const result = await processor.handle(
        { scheduleId: row.id, scheduledFor: row.nextRunAt.toISOString() },
        now,
      );
      if (result.kind === 'fired') fired.push(...result.fired);
    }
    return fired;
  };
