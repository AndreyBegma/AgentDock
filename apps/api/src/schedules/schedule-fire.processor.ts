import {
  SCHEDULE_CATCH_UP_MAX_MS,
  SCHEDULE_FIRING_REASONS,
} from '@nautelle/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, ScheduleMissedPolicy } from '@prisma/client';
import { DelayedError, type Job } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { RunnerPresence } from '../runners/runner-presence';
import { CronSchedule } from './cron';
import { planClaim } from './missed';
import { recordFiringEvent } from './schedule-events';
import { ScheduleFirer } from './schedule-firer';
import { ScheduleLive } from './schedule-live';
import { type FireJobData, ScheduleTimers } from './schedule-timers';

const TRANSACTION_TIMEOUT_MS = 30_000;

/** B7: 30 s, 60 s, 120 s, 240 s, then every 300 s. */
export const redelayMs = (retry: number): number =>
  Math.min(30_000 * 2 ** Math.max(0, retry), 300_000);

export interface LockedRow {
  id: string;
  projectId: string;
  runnerId: string;
  cron: string;
  timezone: string;
  missedPolicy: ScheduleMissedPolicy;
  enabled: boolean;
  nextRunAt: Date | null;
}

/**
 * B2, B5 steps 2–3: what one `fire` job does with the locked row. `stale`
 * when the row no longer points at this occurrence; `wait` when a `catch_up`
 * occurrence that failed with the runner offline waits for it (D9), within
 * 24 hours; otherwise `claim`.
 */
export const decideFire = (input: {
  row: LockedRow | null;
  scheduledFor: Date;
  offlineRecorded: boolean;
  runnerConnected: boolean;
  now: Date;
}): 'stale' | 'wait' | 'claim' => {
  const { row, scheduledFor, now } = input;
  if (!row?.enabled || row.nextRunAt?.getTime() !== scheduledFor.getTime()) {
    return 'stale';
  }
  if (
    input.offlineRecorded &&
    row.missedPolicy === 'catch_up' &&
    !input.runnerConnected &&
    now.getTime() - scheduledFor.getTime() <= SCHEDULE_CATCH_UP_MAX_MS
  ) {
    return 'wait';
  }
  return 'claim';
};

/** What one `fire` job came to. */
export type FireResult =
  | { kind: 'stale' }
  /** B7: move this same job back to delayed for `delayMs`. */
  | { kind: 'redelay'; delayMs: number }
  /** Claimed; `fired` holds the firings sent. */
  | { kind: 'fired'; fired: bigint[] };

/** Firings a claim wrote, for publishing and firing after commit. */
interface Claimed {
  projectId: string;
  due: bigint[];
  skipped: bigint[];
  nextRunAt: Date | null;
}

/**
 * The `fire` job (spec 123 B5), replacing the scheduler tick. Any instance
 * may process it: two workers on one row serialize on its row lock, and only
 * the one that finds `nextRunAt` still at this occurrence writes anything
 * (B2). The firings, the next `nextRunAt` and #99's `schedule.skipped` events
 * are written in one transaction, exactly as the tick wrote them; the command
 * is sent after commit, at most once (B6).
 */
@Injectable()
export class ScheduleFireProcessor {
  private readonly logger = new Logger(ScheduleFireProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: RunnerPresence,
    private readonly firer: ScheduleFirer,
    private readonly live: ScheduleLive,
    private readonly timers: ScheduleTimers,
  ) {}

  /** The worker's entry: a re-delay moves this job back to delayed (B7). */
  async process(job: Job<FireJobData>, token?: string): Promise<void> {
    const result = await this.handle(job.data);
    if (result.kind !== 'redelay') return;
    await job.updateData({ ...job.data, retry: (job.data.retry ?? 0) + 1 });
    await job.moveToDelayed(Date.now() + result.delayMs, token);
    throw new DelayedError();
  }

  /** One `fire` job at `now`, without BullMQ: what tests drive. */
  async handle(data: FireJobData, now = new Date()): Promise<FireResult> {
    const scheduledFor = new Date(data.scheduledFor);
    const retry = redelayMs(data.retry ?? 0);
    const claimed = await this.prisma.$transaction(
      (tx) => this.claim(tx, data.scheduleId, scheduledFor, now),
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    if (claimed === 'stale') {
      this.logger.debug(
        `stale timer: schedule ${data.scheduleId} at ${data.scheduledFor}`,
      );
      return { kind: 'stale' };
    }
    if (claimed === 'wait') return { kind: 'redelay', delayMs: retry };

    // Step 5: the timer for the next occurrence, after commit (B8).
    await this.timers.sync(data.scheduleId);

    // Step 6.
    for (const id of claimed.skipped) {
      const row = await this.prisma.scheduleFiring.findUnique({
        where: { id },
      });
      if (row) this.live.firing(claimed.projectId, row);
    }
    const fired: bigint[] = [];
    for (const id of claimed.due) {
      try {
        await this.firer.fire(id);
        fired.push(id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`firing ${id} failed to fire: ${reason}`);
      }
    }

    // Step 7: D9 rewound `nextRunAt` to this occurrence — retry it here.
    const after = await this.prisma.schedule.findUnique({
      where: { id: data.scheduleId },
      select: { enabled: true, nextRunAt: true },
    });
    if (
      after?.enabled &&
      after.nextRunAt?.getTime() === scheduledFor.getTime()
    ) {
      if (claimed.nextRunAt) {
        await this.timers.drop(data.scheduleId, claimed.nextRunAt);
      }
      return { kind: 'redelay', delayMs: retry };
    }
    return { kind: 'fired', fired };
  }

  /** B5 steps 1–4, under the row lock. */
  private async claim(
    tx: Prisma.TransactionClient,
    scheduleId: string,
    scheduledFor: Date,
    now: Date,
  ): Promise<Claimed | 'stale' | 'wait'> {
    // Waits for the lock and never skips: two workers on one row serialize.
    const [row] = await tx.$queryRaw<LockedRow[]>`
      SELECT s.id, s."projectId", p."runnerId", s.cron, s.timezone,
             s."missedPolicy", s.enabled, s."nextRunAt"
        FROM schedules s
        JOIN projects p ON p.id = s."projectId"
       WHERE s.id = ${scheduleId}
         FOR UPDATE OF s`;
    const offline =
      row?.enabled && row.nextRunAt?.getTime() === scheduledFor.getTime()
        ? await tx.scheduleFiring.findFirst({
            where: {
              scheduleId,
              scheduledFor,
              kind: 'cron',
              status: 'failed',
              reason: SCHEDULE_FIRING_REASONS.runnerOffline,
            },
            select: { id: true },
          })
        : null;
    const decision = decideFire({
      row: row ?? null,
      scheduledFor,
      offlineRecorded: offline !== null,
      runnerConnected: row ? this.presence.isConnected(row.runnerId) : false,
      now,
    });
    if (decision !== 'claim' || !row)
      return decision === 'wait' ? 'wait' : 'stale';

    let schedule: CronSchedule;
    try {
      schedule = CronSchedule.parse(row.cron, row.timezone, now);
    } catch (error) {
      // Validated on save; a stored row that no longer parses stops here.
      this.logger.error(`schedule ${row.id}: ${(error as Error).message}`);
      await tx.schedule.update({
        where: { id: row.id },
        data: { nextRunAt: null },
      });
      return 'stale';
    }

    const plan = planClaim({
      schedule,
      due: scheduledFor,
      now,
      policy: row.missedPolicy,
      dueRecorded: offline !== null,
    });
    const skipped = plan.skipped
      ? await tx.scheduleFiring.createManyAndReturn({
          data: [
            {
              scheduleId: row.id,
              scheduledFor: plan.skipped.scheduledFor,
              kind: 'cron',
              status: 'skipped',
              reason: plan.skipped.reason,
              missedCount: plan.skipped.missedCount,
              finishedAt: now,
            },
          ],
          skipDuplicates: true,
        })
      : [];
    for (const firing of skipped) await recordFiringEvent(tx, firing, now);
    const due = plan.fire
      ? await tx.scheduleFiring.createManyAndReturn({
          data: [
            {
              scheduleId: row.id,
              scheduledFor: plan.fire.scheduledFor,
              kind: plan.fire.kind,
              status: 'due',
            },
          ],
          // The unique key: an occurrence already written never fires twice.
          skipDuplicates: true,
          select: { id: true },
        })
      : [];
    await tx.schedule.update({
      where: { id: row.id },
      data: { nextRunAt: plan.nextRunAt },
    });
    return {
      projectId: row.projectId,
      due: due.map((f) => f.id),
      skipped: skipped.map((f) => f.id),
      nextRunAt: plan.nextRunAt,
    };
  }
}
