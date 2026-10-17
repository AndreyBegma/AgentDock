import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AuditService, FOLD_WINDOW_MS } from './audit.service';

const JOB_NAME = 'audit-fold-flush';

/**
 * Writes folded repeats once their minute is over (C-109). Off under
 * `APP_ENV=test`: the e2e suite calls `flushFolds` itself.
 */
@Injectable()
export class AuditFoldJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuditFoldJob.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly audit: AuditService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.APP_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.audit.flushFolds().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`audit fold flush failed: ${reason}`);
      });
    }, FOLD_WINDOW_MS);
    this.timer.unref();
    this.scheduler.addInterval(JOB_NAME, this.timer);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    if (this.scheduler.doesExist('interval', JOB_NAME)) {
      this.scheduler.deleteInterval(JOB_NAME);
    }
  }
}
