import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';

/** Failures one source may make against one account before it waits (D-05). */
export const THROTTLE_AFTER = 5;
/** The first wait; it doubles with every further failure. */
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 60_000;
/** A source whose last failure is older than this starts from zero. */
export const FAILURE_WINDOW_MS = 15 * 60_000;

const SWEEP_JOB = 'login-throttle-sweep';

/**
 * The wait after the `failures`-th failure in a row: none below
 * `THROTTLE_AFTER`, then 1 s, 2 s, 4 s … up to `MAX_DELAY_MS`.
 */
export const delayAfter = (failures: number): number =>
  failures < THROTTLE_AFTER
    ? 0
    : Math.min(BASE_DELAY_MS * 2 ** (failures - THROTTLE_AFTER), MAX_DELAY_MS);

export interface FailureOutcome {
  failures: number;
  /** This failure made the account throttled from some source for the first time in the window. */
  accountThrottled: boolean;
}

/**
 * Failed password checks per (email, IP) with an exponential wait for that
 * source only (C-109, D-05). Replaces the hard per-account lock: a stranger's
 * failures never delay the owner signing in from elsewhere. Keyed by the email
 * as typed, so an unknown address throttles exactly like a real one.
 */
@Injectable()
export class LoginThrottle implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LoginThrottle.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.APP_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`login throttle sweep failed: ${reason}`);
      });
    }, FAILURE_WINDOW_MS);
    this.timer.unref();
    this.scheduler.addInterval(SWEEP_JOB, this.timer);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    if (this.scheduler.doesExist('interval', SWEEP_JOB)) {
      this.scheduler.deleteInterval(SWEEP_JOB);
    }
  }

  /** Milliseconds this source must still wait, or 0. */
  async waitMs(email: string, ip: string | undefined, now = new Date()) {
    const row = await this.prisma.loginThrottle.findUnique({
      where: { email_ip: { email, ip: ip ?? '' } },
      select: { blockedUntil: true },
    });
    const until = row?.blockedUntil?.getTime() ?? 0;
    return Math.max(0, until - now.getTime());
  }

  /** Counts one failure and sets the source's wait. */
  async fail(
    email: string,
    ip: string | undefined,
    now = new Date(),
  ): Promise<FailureOutcome> {
    const source = ip ?? '';
    const windowStart = new Date(now.getTime() - FAILURE_WINDOW_MS);
    // One statement, so concurrent failures from one source never lose a count.
    const [{ failures }] = await this.prisma.$queryRaw<{ failures: number }[]>`
      INSERT INTO login_throttles (email, ip, failures, "lastFailureAt")
      VALUES (${email}, ${source}, 1, ${now})
      ON CONFLICT (email, ip) DO UPDATE SET
        failures = CASE
          WHEN login_throttles."lastFailureAt" < ${windowStart} THEN 1
          ELSE login_throttles.failures + 1
        END,
        "lastFailureAt" = ${now}
      RETURNING failures`;
    const delay = delayAfter(failures);
    if (delay > 0) {
      await this.prisma.loginThrottle.update({
        where: { email_ip: { email, ip: source } },
        data: { blockedUntil: new Date(now.getTime() + delay) },
      });
    }
    if (failures !== THROTTLE_AFTER) {
      return { failures, accountThrottled: false };
    }
    // Once per account and window, however many sources cross the threshold.
    const others = await this.prisma.loginThrottle.count({
      where: {
        email,
        ip: { not: source },
        failures: { gte: THROTTLE_AFTER },
        lastFailureAt: { gte: windowStart },
      },
    });
    return { failures, accountThrottled: others === 0 };
  }

  /** A correct password from this source forgets its failures. */
  async clear(email: string, ip: string | undefined): Promise<void> {
    await this.prisma.loginThrottle.deleteMany({
      where: { email, ip: ip ?? '' },
    });
  }

  /** Drops the rows of sources quiet for a whole window. */
  async sweep(now = new Date()): Promise<number> {
    const { count } = await this.prisma.loginThrottle.deleteMany({
      where: {
        lastFailureAt: { lt: new Date(now.getTime() - FAILURE_WINDOW_MS) },
      },
    });
    return count;
  }
}
