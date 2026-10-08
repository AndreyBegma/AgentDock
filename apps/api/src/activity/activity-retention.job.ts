import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../database/prisma.service';
import { ACTIVITY_OPTIONS, type ActivityOptions } from './activity-options';

/** Daily, after the nightly audit verification. */
const RETENTION_CRON = '30 4 * * *';
const JOB_NAME = 'activity-retention';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes feed items older than `ACTIVITY_RETENTION_DAYS` (spec 21 D6). Only
 * `activity_items`: audit records are never deleted, so the feed stays
 * rebuildable from its sources.
 */
@Injectable()
export class ActivityRetentionJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ActivityRetentionJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(ACTIVITY_OPTIONS) private readonly options: ActivityOptions,
  ) {}

  onApplicationBootstrap(): void {
    const job = CronJob.from({
      cronTime: RETENTION_CRON,
      onTick: () => this.run(),
    });
    this.scheduler.addCronJob(JOB_NAME, job);
    job.start();
  }

  /** One sweep; returns how many items it deleted. */
  async sweep(now: Date = new Date()): Promise<number> {
    const before = new Date(
      now.getTime() - this.options.retentionDays * DAY_MS,
    );
    const { count } = await this.prisma.activityItem.deleteMany({
      where: { ts: { lt: before } },
    });
    return count;
  }

  private async run(): Promise<void> {
    try {
      const count = await this.sweep();
      if (count > 0) this.logger.log(`deleted ${count} old activity items`);
    } catch (error) {
      this.logger.error(
        `activity retention failed: ${(error as Error).message}`,
      );
    }
  }
}
