import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RunnerPresence } from '../runners/runner-presence';
import {
  NOTIFICATION_OPTIONS,
  type NotificationOptions,
} from './notification-options';
import {
  NotificationWriter,
  type WrittenNotification,
} from './notification-writer';
import { NotificationsService } from './notifications.service';

type Tx = Prisma.TransactionClient;

const LOCK_KEY = 'notifications:runners';
const RUNNERS_LINK = '/admin/runners';

const minutes = (ms: number): number => Math.round(ms / 60_000);

/**
 * Runner gone dark (spec 22 D5). Every `watcherIntervalMs` it reads #6's
 * derived status: a paired, unrevoked runner that is not `online` and was last
 * seen more than `offlineAfterMs` ago opens an incident — one `runner.offline`
 * per active admin, Telegram included. Its return to `online` resolves the
 * incident with an in-app `runner.online` item and no Telegram message. One
 * open incident per runner; an advisory lock keeps the decision to one pass.
 */
@Injectable()
export class RunnerWatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunnerWatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly presence: RunnerPresence,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
    @Inject(NOTIFICATION_OPTIONS) private readonly options: NotificationOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`runner watcher failed: ${reason}`);
      });
    }, this.options.watcherIntervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** One look at every runner. False when another pass holds the lock. */
  async tick(now = new Date()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const written = await this.prisma.$transaction((tx) =>
        this.pass(tx, now),
      );
      if (written === null) return false;
      await this.notifications.publish(written);
      return true;
    } finally {
      this.running = false;
    }
  }

  private async pass(tx: Tx, now: Date): Promise<WrittenNotification[] | null> {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS locked`;
    if (!locked) return null;

    const runners = await tx.runner.findMany({
      where: { revokedAt: null, pairedAt: { not: null } },
      select: {
        id: true,
        name: true,
        revokedAt: true,
        pairedAt: true,
        lastSeenAt: true,
        incidents: {
          where: { resolvedAt: null },
          select: { id: true, openedAt: true },
          take: 1,
        },
      },
    });

    const written: WrittenNotification[] = [];
    for (const runner of runners) {
      const status = this.presence.status(runner);
      const open = runner.incidents[0];
      const lastSeen = runner.lastSeenAt ?? runner.pairedAt ?? now;
      const away = now.getTime() - lastSeen.getTime();

      if (!open && status !== 'online' && away >= this.options.offlineAfterMs) {
        await tx.runnerIncident.create({
          data: { runnerId: runner.id, openedAt: now },
        });
        written.push(
          ...(await this.writer.write(
            tx,
            {
              kind: 'runner.offline',
              projectId: null,
              runnerId: runner.id,
              slot: null,
              issue: null,
              title: `Runner ${runner.name} is offline`,
              body: `Not seen for ${minutes(away)} minutes. Its projects get no updates and accept no commands until it reconnects.`,
              link: RUNNERS_LINK,
              eventId: null,
              at: now,
              fold: false,
            },
            await this.writer.adminRecipients(tx),
          )),
        );
      } else if (open && status === 'online') {
        await tx.runnerIncident.update({
          where: { id: open.id },
          data: { resolvedAt: now },
        });
        written.push(
          ...(await this.writer.write(
            tx,
            {
              kind: 'runner.online',
              projectId: null,
              runnerId: runner.id,
              slot: null,
              issue: null,
              title: `Runner ${runner.name} is back online`,
              body: `It was away for ${minutes(now.getTime() - open.openedAt.getTime())} minutes after the alert.`,
              link: RUNNERS_LINK,
              eventId: null,
              at: now,
              fold: false,
            },
            await this.writer.adminRecipients(tx),
          )),
        );
      }
    }
    return written;
  }
}
