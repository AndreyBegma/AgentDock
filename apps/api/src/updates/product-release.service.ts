import {
  APP_VERSION,
  type ProductRelease,
  type ProductUpdateView,
  productUpdateView,
} from '@nautelle/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { SettingsService } from '../settings/settings.service';
import {
  PRODUCT_RELEASE_OPTIONS,
  type ProductReleaseOptions,
} from './product-release';

/** The last check, kept in `settings` so a restart does not check again. */
export const LATEST_RELEASE_SETTING_KEY = 'updates.latestRelease';

interface StoredCheck {
  /** When GitHub was last asked, answered or not; ISO 8601. */
  checkedAt: string;
  /** The last answer; a failed check keeps the one before it. */
  latest: ProductRelease | null;
}

const isRelease = (value: unknown): value is ProductRelease =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ProductRelease).version === 'string' &&
  typeof (value as ProductRelease).url === 'string';

const readStored = (value: Prisma.JsonValue | null): StoredCheck | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const { checkedAt, latest } = value as Record<string, unknown>;
  if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) {
    return null;
  }
  return { checkedAt, latest: isRelease(latest) ? latest : null };
};

/**
 * C-374: the latest Nautelle release, read from GitHub at most once a day
 * (ADR-0090). Every attempt counts toward the day, a failed one too, so an
 * install without internet access asks once a day and not on every start.
 * With `NAUTELLE_UPDATE_CHECK=false` GitHub is never asked.
 */
@Injectable()
export class ProductReleaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductReleaseService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    @Inject(PRODUCT_RELEASE_OPTIONS)
    private readonly options: ProductReleaseOptions,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    if (this.options.autoStart && this.options.enabled) void this.tick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** What admins see: the version this install runs and the latest release. */
  async view(): Promise<ProductUpdateView> {
    if (!this.options.enabled) {
      return productUpdateView(APP_VERSION, null, false, null);
    }
    const stored = await this.stored();
    return productUpdateView(
      APP_VERSION,
      stored?.latest ?? null,
      true,
      stored?.checkedAt ?? null,
    );
  }

  /**
   * Asks GitHub unless the last check is less than a day old; returns when
   * the next check is due. Never asks with the check turned off.
   */
  async check(): Promise<Date | null> {
    if (!this.options.enabled) return null;
    const stored = await this.stored();
    const now = this.options.now();
    if (stored) {
      const due = Date.parse(stored.checkedAt) + this.options.intervalMs;
      if (due > now.getTime()) return new Date(due);
    }
    let latest = stored?.latest ?? null;
    try {
      latest = await this.options.fetchLatest();
    } catch (error) {
      this.logger.warn(
        `update check failed, keeping ${latest?.version ?? 'none'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const next: StoredCheck = { checkedAt: now.toISOString(), latest };
    await this.settings.set(
      LATEST_RELEASE_SETTING_KEY,
      next as unknown as Prisma.InputJsonValue,
      null,
    );
    return new Date(now.getTime() + this.options.intervalMs);
  }

  private async stored(): Promise<StoredCheck | null> {
    return readStored(await this.settings.get(LATEST_RELEASE_SETTING_KEY));
  }

  private async tick(): Promise<void> {
    let due: Date | null;
    try {
      due = await this.check();
    } catch (error) {
      // The settings row could not be read or written: try again in a day.
      this.logger.warn(
        `update check could not run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      due = new Date(this.options.now().getTime() + this.options.intervalMs);
    }
    if (this.stopped || !due) return;
    const delay = Math.max(0, due.getTime() - this.options.now().getTime());
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref();
  }
}
