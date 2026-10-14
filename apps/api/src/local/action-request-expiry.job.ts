import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ActionRequestsService } from './action-requests.service';
import { LOCAL_OPTIONS, type LocalOptions } from './local-options';

export const ACTION_REQUEST_EXPIRY_JOB = 'action-request-expiry';

/**
 * Expires pending action requests past `expiresAt`, every minute (spec 201
 * D18). A named interval in `SchedulerRegistry`, like the API's other
 * periodic jobs (#119), so the admin's system-jobs list shows it. Reads
 * (`action.status`, the list) expire due rows themselves too, so a waiting
 * hook never sees a stale `pending`.
 */
@Injectable()
export class ActionRequestExpiryJob
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ActionRequestExpiryJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly requests: ActionRequestsService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(LOCAL_OPTIONS) private readonly options: LocalOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.options.expiryIntervalMs,
    );
    this.timer.unref();
    this.scheduler.addInterval(ACTION_REQUEST_EXPIRY_JOB, this.timer);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    if (this.scheduler.doesExist('interval', ACTION_REQUEST_EXPIRY_JOB)) {
      this.scheduler.deleteInterval(ACTION_REQUEST_EXPIRY_JOB);
    }
  }

  /** One sweep; returns how many requests expired. */
  sweep(now: Date = new Date()): Promise<number> {
    return this.requests.expire(now);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const count = await this.sweep();
      if (count > 0) this.logger.log(`expired ${count} action requests`);
    } catch (error) {
      this.logger.error(
        `action request expiry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
