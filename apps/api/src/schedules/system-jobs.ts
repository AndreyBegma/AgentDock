import type { SystemJobView } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

/**
 * D13: the API's own jobs, read-only from `@nestjs/schedule`. The modules
 * that own them are not touched; a job outside the registry (a plain
 * `setInterval`) is not listed (spec 25 notes, Q3).
 */
@Injectable()
export class SystemJobs {
  constructor(private readonly registry: SchedulerRegistry) {}

  list(): SystemJobView[] {
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
    return [...crons, ...intervals].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
}
