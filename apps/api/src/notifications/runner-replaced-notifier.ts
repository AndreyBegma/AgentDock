import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  type RunnerReplacement,
  type RunnerReplacementListener,
  RunnerReplacements,
} from '../runners/runner-replacements';
import { NotificationWriter } from './notification-writer';
import { NotificationsService } from './notifications.service';

const RUNNERS_LINK = '/admin/runners';

/**
 * C-108: one `runner.connection_replaced` per active admin, Telegram included,
 * when another connection with a runner's token took over its live socket.
 * Not folded: each takeover is its own alert.
 */
@Injectable()
export class RunnerReplacedNotifier
  implements RunnerReplacementListener, OnModuleInit
{
  readonly name = 'notifications';

  constructor(
    private readonly prisma: PrismaService,
    private readonly replacements: RunnerReplacements,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.replacements.register(this);
  }

  async replaced({
    runnerId,
    previous,
    next,
    at,
  }: RunnerReplacement): Promise<void> {
    const written = await this.prisma.$transaction(async (tx) => {
      const runner = await tx.runner.findUnique({
        where: { id: runnerId },
        select: { name: true },
      });
      return this.writer.write(
        tx,
        {
          kind: 'runner.connection_replaced',
          projectId: null,
          runnerId,
          slot: null,
          issue: null,
          title: `Runner ${runner?.name ?? runnerId}: another connection took over`,
          body: `A connection from ${next.ip ?? 'an unknown address'} used its token and replaced the one from ${previous.ip ?? 'an unknown address'}, which was stopped. If this was not you, revoke the runner and pair it again.`,
          link: RUNNERS_LINK,
          eventId: null,
          at,
          fold: false,
        },
        await this.writer.adminRecipients(tx),
      );
    });
    await this.notifications.publish(written);
  }
}
