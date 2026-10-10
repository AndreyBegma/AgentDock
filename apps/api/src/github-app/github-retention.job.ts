import { GITHUB_DELIVERY_RETENTION_DAYS } from '@agentdock/shared';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PrismaService } from '../database/prisma.service';

/** Daily, after the webhooks retention. */
const RETENTION_CRON = '50 4 * * *';
const JOB_NAME = 'github-deliveries-retention';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * D17: deletes `github_deliveries` older than 14 days, daily. Registered with
 * `@nestjs/schedule` so #25's system job list shows it.
 */
@Injectable()
export class GitHubRetentionJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(GitHubRetentionJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const job = CronJob.from({
      cronTime: RETENTION_CRON,
      onTick: () => this.run(),
    });
    this.scheduler.addCronJob(JOB_NAME, job);
    job.start();
  }

  /** One sweep; returns how many deliveries it deleted. */
  async sweep(now: Date = new Date()): Promise<number> {
    const before = new Date(
      now.getTime() - GITHUB_DELIVERY_RETENTION_DAYS * DAY_MS,
    );
    const { count } = await this.prisma.gitHubDelivery.deleteMany({
      where: { receivedAt: { lt: before } },
    });
    return count;
  }

  private async run(): Promise<void> {
    try {
      const count = await this.sweep();
      if (count > 0) this.logger.log(`deleted ${count} GitHub deliveries`);
    } catch (error) {
      this.logger.error(`retention failed: ${(error as Error).message}`);
    }
  }
}
