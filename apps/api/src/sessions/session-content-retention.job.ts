import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { SessionContentService } from './session-content.service';

/** Daily at 03:30 (spec 201 "Jobs"). */
const RETENTION_CRON = '30 3 * * *';
const JOB_NAME = 'session-content-retention';

/** Deletes content past its project's retention; the sessions stay (ADR-0021 §5). */
@Injectable()
export class SessionContentRetentionJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SessionContentRetentionJob.name);

  constructor(
    private readonly content: SessionContentService,
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

  private async run(): Promise<void> {
    try {
      const count = await this.content.sweep();
      if (count > 0) this.logger.log(`deleted ${count} expired content rows`);
    } catch (error) {
      this.logger.error(
        `session content retention failed: ${(error as Error).message}`,
      );
    }
  }
}
