import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { AuditVerificationService } from './audit-verification.service';

export const DEFAULT_AUDIT_VERIFY_CRON = '0 3 * * *';
const JOB_NAME = 'audit-verification';

/**
 * Nightly chain verification (spec D6). Registered at bootstrap rather than
 * with `@Cron()`, so `AUDIT_VERIFY_CRON` is read after the env is loaded.
 */
@Injectable()
export class AuditVerificationJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditVerificationJob.name);

  constructor(
    private readonly verification: AuditVerificationService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const schedule = process.env.AUDIT_VERIFY_CRON || DEFAULT_AUDIT_VERIFY_CRON;
    const job = CronJob.from({
      cronTime: schedule,
      onTick: () => this.run(),
    });
    this.scheduler.addCronJob(JOB_NAME, job);
    job.start();
  }

  /** One verification; the result lands in `settings` either way. */
  async run(): Promise<void> {
    try {
      await this.verification.verifyAndStore();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`audit verification failed to run: ${reason}`);
    }
  }
}
