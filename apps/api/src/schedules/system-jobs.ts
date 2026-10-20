import type { SystemJobView } from '@nautelle/shared';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  SCHEDULES_QUEUE,
  type SchedulesQueue,
  within,
} from './schedule-timers';
import { RECONCILE_SCHEDULER, SETTLE_SCHEDULER } from './schedule-worker';
import { SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler-options';

const QUEUE_JOBS = new Set([SETTLE_SCHEDULER, RECONCILE_SCHEDULER]);

/**
 * D13: the API's own jobs, read-only from `@nestjs/schedule`. The modules
 * that own them register their interval timers by name (#101, #119); a timer
 * outside the registry is not listed (spec 25 notes, Q3). The schedules queue's
 * two job schedulers are listed too (spec 123 B20), unless Redis does not
 * answer — then the rest still list.
 */
@Injectable()
export class SystemJobs {
  private readonly logger = new Logger(SystemJobs.name);

  constructor(
    private readonly registry: SchedulerRegistry,
    @Inject(SCHEDULER_OPTIONS) private readonly options: SchedulerOptions,
    @Optional()
    @InjectQueue(SCHEDULES_QUEUE)
    private readonly queue?: SchedulesQueue,
  ) {}

  async list(): Promise<SystemJobView[]> {
    const crons = [...this.registry.getCronJobs()].map(
      ([name, job]): SystemJobView => {
        const source = job.cronTime.source;
        let nextRunAt: string | null = null;
        try {
          nextRunAt = job.isActive
            ? job.nextDate().toJSDate().toISOString()
            : null;
        } catch {
          // A one-off date in the past has no next date.
        }
        return {
          name: name || 'unnamed',
          kind: 'cron',
          cron: typeof source === 'string' ? source : null,
          nextRunAt,
          lastRunAt: job.lastDate()?.toISOString() ?? null,
        };
      },
    );
    const intervals = this.registry.getIntervals().map(
      (name): SystemJobView => ({
        name: name || 'unnamed',
        kind: 'interval',
        cron: null,
        nextRunAt: null,
        lastRunAt: null,
      }),
    );
    return [...crons, ...intervals, ...(await this.queueJobs())].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** B20: `schedules.settle` and `schedules.reconcile`, from BullMQ. */
  private async queueJobs(): Promise<SystemJobView[]> {
    if (!this.queue) return [];
    try {
      const schedulers = await within(
        this.queue.getJobSchedulers(),
        this.options.syncTimeoutMs,
      );
      return schedulers.flatMap((scheduler): SystemJobView[] => {
        const name = scheduler.id ?? scheduler.key;
        if (!QUEUE_JOBS.has(name)) return [];
        return [
          {
            name,
            kind: 'interval',
            cron: null,
            nextRunAt: scheduler.next
              ? new Date(scheduler.next).toISOString()
              : null,
            lastRunAt: null,
          },
        ];
      });
    } catch (error) {
      this.logger.warn(
        `schedules queue jobs not listed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
