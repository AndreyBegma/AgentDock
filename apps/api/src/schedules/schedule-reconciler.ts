import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  FIRE_JOB,
  type FireJobData,
  SCHEDULES_QUEUE,
  type SchedulesQueue,
  ScheduleTimers,
} from './schedule-timers';

/** Rows and delayed jobs read per page (B9). */
export const RECONCILE_PAGE = 500;

/** A delayed `fire` job as the reconciler sees it. */
export interface DelayedFire {
  jobId: string;
  data: FireJobData;
}

/** The occurrence each enabled schedule points at, by schedule id. */
export type CurrentTimers = Map<string, number>;

/**
 * B9(b): a delayed `fire` job no row points at any more — the schedule is
 * gone, disabled, or has moved to another occurrence.
 */
export const isOrphan = (job: DelayedFire, current: CurrentTimers): boolean =>
  current.get(job.data.scheduleId) !== Date.parse(job.data.scheduledFor);

export interface ReconcileCounts {
  added: number;
  removed: number;
}

/**
 * The `reconcile` job (spec 123 B9), every 60 s and once on boot. PostgreSQL
 * is the authority: (a) every enabled schedule gets its `fire` job back if it
 * is missing or already finished; (b) every delayed `fire` job no row points
 * at is removed. Idempotent — deterministic ids make a racing add a no-op, and
 * a job it should not have touched is dropped by the processor's B2 check.
 */
@Injectable()
export class ScheduleReconciler {
  private readonly logger = new Logger(ScheduleReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly timers: ScheduleTimers,
    @Optional()
    @InjectQueue(SCHEDULES_QUEUE)
    private readonly queue?: SchedulesQueue,
  ) {}

  /** Throws when Redis or PostgreSQL does; the next period tries again. */
  async reconcile(): Promise<ReconcileCounts> {
    if (!this.queue) return { added: 0, removed: 0 };
    const added = await this.restoreMissing();
    const removed = await this.removeOrphans(this.queue);
    if (added > 0 || removed > 0) {
      this.logger.log(
        `schedule timers reconciled: added ${added}, removed ${removed}`,
      );
    }
    return { added, removed };
  }

  /** B9(a). */
  private async restoreMissing(): Promise<number> {
    let added = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.schedule.findMany({
        where: { enabled: true, nextRunAt: { not: null } },
        select: { id: true, nextRunAt: true },
        orderBy: { id: 'asc' },
        take: RECONCILE_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) {
        if (!row.nextRunAt) continue;
        if ((await this.timers.ensure(row.id, row.nextRunAt)) === 'added') {
          added += 1;
        }
      }
      if (rows.length < RECONCILE_PAGE) return added;
      cursor = rows[rows.length - 1].id;
    }
  }

  /** B9(b): orphans are collected over the whole delayed set, then removed, so paging never skips one. */
  private async removeOrphans(queue: SchedulesQueue): Promise<number> {
    const orphans: string[] = [];
    for (let start = 0; ; start += RECONCILE_PAGE) {
      const page = await queue.getDelayed(start, start + RECONCILE_PAGE - 1);
      const fires: DelayedFire[] = page.flatMap((job) =>
        job.name === FIRE_JOB && job.id
          ? [{ jobId: job.id, data: job.data as FireJobData }]
          : [],
      );
      if (fires.length > 0) {
        const rows = await this.prisma.schedule.findMany({
          where: {
            id: { in: [...new Set(fires.map((f) => f.data.scheduleId))] },
            enabled: true,
            nextRunAt: { not: null },
          },
          select: { id: true, nextRunAt: true },
        });
        const current: CurrentTimers = new Map(
          rows.flatMap((r) =>
            r.nextRunAt ? [[r.id, r.nextRunAt.getTime()] as const] : [],
          ),
        );
        for (const job of fires) {
          if (isOrphan(job, current)) orphans.push(job.jobId);
        }
      }
      if (page.length < RECONCILE_PAGE) break;
    }
    let removed = 0;
    for (const id of orphans) removed += await queue.remove(id);
    return removed;
  }
}
