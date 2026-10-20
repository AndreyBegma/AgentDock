import { SCHEDULE_FIRING_REASONS } from '@nautelle/shared';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ScheduleFirer } from './schedule-firer';
import { SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler-options';

/**
 * The `settle` job (spec 123 B10), every 15 s: the two passes the scheduler
 * tick ran before claiming, unchanged.
 */
@Injectable()
export class ScheduleMaintenance {
  constructor(
    private readonly prisma: PrismaService,
    private readonly firer: ScheduleFirer,
    @Inject(SCHEDULER_OPTIONS) private readonly options: SchedulerOptions,
  ) {}

  async settle(now = new Date()): Promise<void> {
    await this.settleFinishedRuns();
    await this.failStaleDue(now);
  }

  /** D8: a `started` firing ends with its run (#21). */
  async settleFinishedRuns(): Promise<void> {
    const firings = await this.prisma.scheduleFiring.findMany({
      where: {
        status: 'started',
        run: { status: { in: ['succeeded', 'failed', 'abandoned'] } },
      },
      include: { run: { select: { status: true, outcome: true } } },
      take: 100,
    });
    for (const { run, ...firing } of firings) {
      if (!run) continue;
      await this.firer.settle(
        firing,
        run.status === 'succeeded'
          ? { status: 'succeeded', sent: false }
          : {
              status: 'failed',
              reason: SCHEDULE_FIRING_REASONS.runFailed,
              ...(run.outcome
                ? { error: { code: run.status, message: run.outcome } }
                : {}),
              sent: false,
            },
      );
    }
  }

  /** A `due` firing whose API died before sending it: failed, never resent (at-most-once, B6). */
  async failStaleDue(now: Date): Promise<void> {
    const stale = await this.prisma.scheduleFiring.findMany({
      where: {
        status: 'due',
        scheduledFor: { lt: new Date(now.getTime() - this.options.staleDueMs) },
      },
      take: 100,
    });
    for (const firing of stale) {
      await this.firer.settle(firing, {
        status: 'failed',
        reason: SCHEDULE_FIRING_REASONS.commandFailed,
        error: {
          code: 'not_sent',
          message: 'The API stopped before sending it',
        },
        sent: false,
      });
    }
  }
}
