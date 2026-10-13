import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import { PrismaService } from '../database/prisma.service';
import { SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler-options';

/** The queue every schedule timer and maintenance job lives on (spec 123). */
export const SCHEDULES_QUEUE = 'schedules';

export const FIRE_JOB = 'fire';
export const SETTLE_JOB = 'settle';
export const RECONCILE_JOB = 'reconcile';

/** B3: "check schedule `scheduleId` for occurrence `scheduledFor`". */
export interface FireJobData {
  scheduleId: string;
  /** ISO timestamp of the occurrence. */
  scheduledFor: string;
  /** D9 re-delays already taken by this job (B7). */
  retry?: number;
}

/** `settle` and `reconcile` carry nothing. */
export type MaintenanceJobData = Record<string, never>;

export type SchedulesQueue = Queue<FireJobData | MaintenanceJobData>;

/** B12: retries for errors before commit; bounded retention. */
export const FIRE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 604_800 },
} satisfies JobsOptions;

/** B3: the deterministic id of an occurrence's job; BullMQ forbids `:`. */
export const fireJobId = (scheduleId: string, at: Date): string =>
  `fire-${scheduleId}-${at.getTime()}`;

/**
 * B9(a): whether an existing job in `state` will still run. A `completed` or
 * `failed` job — or one BullMQ cannot place — counts as missing.
 */
export const jobWillRun = (state: string): boolean =>
  !['completed', 'failed', 'unknown'].includes(state);

export class TimeoutError extends Error {}

/** Resolves as `work` does, or rejects after `ms`. `work` is left running. */
export const within = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(`no answer from Redis in ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The delayed `fire` job of each enabled schedule (spec 123 B3, B8). Redis is
 * advisory: `schedules.nextRunAt` stays the only next-run time, and a job only
 * asks the processor to look at it. A sync that cannot reach Redis is logged
 * and dropped, never thrown — the reconciler (B9) repairs it.
 *
 * Without `REDIS_URL` (scheduler off, B19) no queue is registered and every
 * method is a no-op.
 */
@Injectable()
export class ScheduleTimers {
  private readonly logger = new Logger(ScheduleTimers.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SCHEDULER_OPTIONS) private readonly options: SchedulerOptions,
    @Optional()
    @InjectQueue(SCHEDULES_QUEUE)
    private readonly queue?: SchedulesQueue,
  ) {
    // An `error` event with no listener would crash the process (B18).
    this.queue?.on('error', (error) => {
      this.logger.debug(`schedules queue: ${error.message}`);
    });
  }

  get available(): boolean {
    return this.queue !== undefined;
  }

  /**
   * Brings the job of `scheduleId` in step with its row, after the change
   * that moved `nextRunAt` away from `previous` has committed. Never throws.
   */
  async sync(scheduleId: string, previous?: Date | null): Promise<void> {
    if (!this.queue) return;
    try {
      await within(
        this.syncNow(scheduleId, previous),
        this.options.syncTimeoutMs,
      );
    } catch (error) {
      this.logger.warn(
        `schedule ${scheduleId}: timer sync failed (${message(error)}); the reconciler repairs it`,
      );
    }
  }

  /** Removes the job for `(scheduleId, at)`, like `sync`: never throws. */
  async drop(scheduleId: string, at: Date): Promise<void> {
    if (!this.queue) return;
    try {
      await within(this.remove(scheduleId, at), this.options.syncTimeoutMs);
    } catch (error) {
      this.logger.warn(
        `schedule ${scheduleId}: timer removal failed (${message(error)}); the reconciler repairs it`,
      );
    }
  }

  private async syncNow(
    scheduleId: string,
    previous: Date | null | undefined,
  ): Promise<void> {
    const row = await this.prisma.schedule.findUnique({
      where: { id: scheduleId },
      select: { enabled: true, nextRunAt: true },
    });
    const current = row?.enabled ? row.nextRunAt : null;
    if (previous && previous.getTime() !== current?.getTime()) {
      await this.remove(scheduleId, previous);
    }
    if (current) await this.ensure(scheduleId, current);
  }

  /**
   * Makes sure the job for `(scheduleId, at)` will run: added if missing,
   * re-added if it already finished (B9a). A waiting, delayed or active job is
   * left alone, and a racing double add is a no-op on the deterministic id.
   * Throws when Redis does; callers decide.
   */
  async ensure(scheduleId: string, at: Date): Promise<'added' | 'kept'> {
    const queue = this.required();
    const id = fireJobId(scheduleId, at);
    const existing = await queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (jobWillRun(state)) return 'kept';
      await queue.remove(id);
    }
    const data: FireJobData = { scheduleId, scheduledFor: at.toISOString() };
    await queue.add(FIRE_JOB, data, {
      ...FIRE_JOB_OPTIONS,
      jobId: id,
      delay: Math.max(0, at.getTime() - Date.now()),
    });
    return 'added';
  }

  /** Removes the job for `(scheduleId, at)`; an active one stays and B2 drops it. Throws when Redis does. */
  async remove(scheduleId: string, at: Date): Promise<void> {
    const removed = await this.required().remove(fireJobId(scheduleId, at));
    if (removed === 0) {
      this.logger.debug(
        `schedule ${scheduleId}: timer ${at.toISOString()} not removed (absent or running)`,
      );
    }
  }

  private required(): SchedulesQueue {
    if (!this.queue) throw new Error('the schedules queue is not registered');
    return this.queue;
  }
}
