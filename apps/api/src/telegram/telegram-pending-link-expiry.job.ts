import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TelegramLinkingService } from './telegram-linking.service';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';

export const TELEGRAM_PENDING_LINK_EXPIRY_JOB = 'telegram-pending-link-expiry';
const SWEEP_EVERY_MS = 60_000;

/**
 * C-147: removes the pending Telegram links nobody confirmed within the link
 * code's lifetime, every minute. A named interval in `SchedulerRegistry`,
 * like the API's other periodic jobs (#119). Reads and the confirmation skip
 * an expired row themselves, so a sweep that is late changes nothing.
 */
@Injectable()
export class TelegramPendingLinkExpiryJob
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramPendingLinkExpiryJob.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly linking: TelegramLinkingService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_EVERY_MS);
    this.timer.unref();
    this.scheduler.addInterval(TELEGRAM_PENDING_LINK_EXPIRY_JOB, this.timer);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    if (this.scheduler.doesExist('interval', TELEGRAM_PENDING_LINK_EXPIRY_JOB)) {
      this.scheduler.deleteInterval(TELEGRAM_PENDING_LINK_EXPIRY_JOB);
    }
  }

  /** One sweep; returns how many pending links were removed. */
  sweep(now: Date = new Date()): Promise<number> {
    return this.linking.expirePending(now);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const count = await this.sweep();
      if (count > 0) this.logger.log(`expired ${count} pending Telegram links`);
    } catch (error) {
      this.logger.error(
        `pending Telegram link expiry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
