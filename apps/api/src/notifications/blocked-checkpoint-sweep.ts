import { NOTIFICATION_KIND_SPECS } from '@nautelle/shared';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { blockedCheckpointDraft, projectLink } from './event-mapping';
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

const JOB_NAME = 'blocked-checkpoint-sweep';
const LOCK_KEY = 'notifications:blocked';
const TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Blocked checkpoints that still need a person (spec 22 note 23). Most are
 * questions to the orchestrator, answered within minutes, so a checkpoint
 * notifies only if it is still its slot's latest `blockedDelayMs` after it
 * arrived and the slot has not ended — and then once.
 *
 * "Once" hangs off the projected `slot_checkpoints` row, one per
 * `(slot, position)`: a runner restart re-emitting the reply file or an edited
 * body lands on the same row and changes nothing here. Only a new heading at
 * that position (the reply file started over) is a new checkpoint, standing
 * from when the sweep first sees it. An advisory lock keeps the decision to
 * one pass, as in `RunnerWatcher`.
 */
@Injectable()
export class BlockedCheckpointSweep
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BlockedCheckpointSweep.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(NOTIFICATION_OPTIONS) private readonly options: NotificationOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoStart) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.error(`blocked checkpoint sweep failed: ${reason}`);
      });
    }, this.options.blockedSweepIntervalMs);
    this.timer.unref();
    this.scheduler.addInterval(JOB_NAME, this.timer);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    if (this.scheduler.doesExist('interval', JOB_NAME)) {
      this.scheduler.deleteInterval(JOB_NAME);
    }
  }

  /** One look at every standing blocked checkpoint. False when another pass holds the lock. */
  async tick(now = new Date()): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const written = await this.prisma.$transaction(
        (tx) => this.pass(tx, now),
        { timeout: TRANSACTION_TIMEOUT_MS },
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

    const blocked = await tx.slotCheckpoint.findMany({
      where: { kind: 'blocked', slot: { status: { not: 'ended' } } },
      select: {
        id: true,
        slotId: true,
        position: true,
        heading: true,
        at: true,
        notice: { select: { heading: true, since: true, notifiedAt: true } },
        slot: {
          select: {
            name: true,
            issue: true,
            projectId: true,
            project: { select: { runnerId: true } },
          },
        },
      },
    });
    if (blocked.length === 0) return [];

    const latest = await tx.slotCheckpoint.groupBy({
      by: ['slotId'],
      where: { slotId: { in: [...new Set(blocked.map((c) => c.slotId))] } },
      _max: { position: true },
    });
    const last = new Map(latest.map((l) => [l.slotId, l._max.position]));

    const due = now.getTime() - this.options.blockedDelayMs;
    const written: WrittenNotification[] = [];
    for (const checkpoint of blocked) {
      // Superseded: the worker moved on, so nobody is waiting on this one.
      if (last.get(checkpoint.slotId) !== checkpoint.position) continue;

      let notice = checkpoint.notice;
      if (!notice) {
        notice = {
          heading: checkpoint.heading,
          since: checkpoint.at,
          notifiedAt: null,
        };
        await tx.blockedCheckpointNotice.create({
          data: { checkpointId: checkpoint.id, ...notice },
        });
      } else if (notice.heading !== checkpoint.heading) {
        notice = { heading: checkpoint.heading, since: now, notifiedAt: null };
        await tx.blockedCheckpointNotice.update({
          where: { checkpointId: checkpoint.id },
          data: notice,
        });
      }
      if (notice.notifiedAt || notice.since.getTime() > due) continue;

      await tx.blockedCheckpointNotice.update({
        where: { checkpointId: checkpoint.id },
        data: { notifiedAt: now },
      });
      written.push(...(await this.notify(tx, checkpoint, now)));
    }
    return written;
  }

  private async notify(
    tx: Tx,
    checkpoint: {
      heading: string;
      slot: {
        name: string;
        issue: number | null;
        projectId: string;
        project: { runnerId: string };
      };
    },
    now: Date,
  ): Promise<WrittenNotification[]> {
    const { slot } = checkpoint;
    const draft = blockedCheckpointDraft(
      slot.name,
      slot.issue,
      checkpoint.heading,
    );
    const everyone = await this.writer.projectRecipients(tx, slot.projectId);
    const recipients = NOTIFICATION_KIND_SPECS[draft.kind].adminsOnly
      ? everyone.filter((r) => r.role === 'admin')
      : everyone;
    return this.writer.write(
      tx,
      {
        kind: draft.kind,
        projectId: slot.projectId,
        runnerId: slot.project.runnerId,
        slot: draft.slot,
        issue: draft.issue,
        title: draft.title,
        body: draft.body,
        link: projectLink(slot.projectId, draft.page),
        eventId: null,
        at: now,
        // One item per checkpoint: the notice row already makes it once.
        fold: false,
      },
      recipients,
    );
  }
}
