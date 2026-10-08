import {
  NOTIFICATION_NEW_EVENT,
  NOTIFICATION_PAGE_DEFAULT,
  NOTIFICATION_READ_EVENT,
  type NotificationNewLive,
  type NotificationPage,
  type NotificationReadLive,
  type NotificationReadResult,
} from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { notificationError, notificationNotFound } from './notification-error';
import {
  NOTIFICATION_INCLUDE,
  toNotificationView,
} from './notification-mapper';
import type { WrittenNotification } from './notification-writer';

export interface ListQuery {
  unread?: boolean;
  cursor?: string;
  limit?: number;
}

/** `<lastAt ms>:<id>` — the keyset of the newest-first order. */
const encodeCursor = (lastAt: Date, id: bigint): string =>
  Buffer.from(`${lastAt.getTime()}:${id}`).toString('base64url');

const decodeCursor = (cursor: string): { lastAt: Date; id: bigint } | null => {
  const match = /^(\d+):(\d+)$/.exec(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  );
  if (!match) return null;
  return { lastAt: new Date(Number(match[1])), id: BigInt(match[2]) };
};

/** Not read and not muted: what the bell counts (D3). */
const unreadWhere = (userId: string): Prisma.NotificationWhereInput => ({
  userId,
  readAt: null,
  muted: false,
});

/**
 * The in-app notification centre (spec 22 D11): a user reads and marks only
 * their own rows — another user's id answers 404 like a missing one.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
  ) {}

  async list(userId: string, query: ListQuery): Promise<NotificationPage> {
    const limit = query.limit ?? NOTIFICATION_PAGE_DEFAULT;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !after) {
      throw notificationError(400, 'invalid_cursor', 'Malformed cursor');
    }
    const where: Prisma.NotificationWhereInput = {
      ...(query.unread ? unreadWhere(userId) : { userId }),
      ...(after
        ? {
            OR: [
              { lastAt: { lt: after.lastAt } },
              { lastAt: after.lastAt, id: { lt: after.id } },
            ],
          }
        : {}),
    };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        include: NOTIFICATION_INCLUDE,
        orderBy: [{ lastAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.unreadCount(userId),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toNotificationView),
      unreadCount,
      nextCursor:
        rows.length > limit && last ? encodeCursor(last.lastAt, last.id) : null,
    };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: unreadWhere(userId) });
  }

  async markRead(userId: string, id: string): Promise<NotificationReadResult> {
    if (!/^\d{1,19}$/.test(id)) throw notificationNotFound();
    const { count } = await this.prisma.notification.updateMany({
      where: { id: BigInt(id), userId },
      data: { readAt: new Date() },
    });
    if (count === 0) throw notificationNotFound();
    return this.publishRead(userId, [id]);
  }

  async markAllRead(userId: string): Promise<NotificationReadResult> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return this.publishRead(userId, null);
  }

  /** `notification.new` on `user:<id>` for rows written by a committed transaction. */
  async publish(written: WrittenNotification[]): Promise<void> {
    if (written.length === 0) return;
    const rows = await this.prisma.notification.findMany({
      where: { id: { in: written.map((w) => w.notificationId) } },
      include: NOTIFICATION_INCLUDE,
    });
    for (const row of rows) {
      try {
        const data: NotificationNewLive = {
          notification: toNotificationView(row),
          unreadCount: await this.unreadCount(row.userId),
        };
        this.live.publish(`user:${row.userId}`, NOTIFICATION_NEW_EVENT, data);
      } catch (error) {
        // Live is best effort (#9 D14): the row is stored; the bell catches up on reload.
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`notification ${row.id} not published: ${reason}`);
      }
    }
  }

  private async publishRead(
    userId: string,
    ids: string[] | null,
  ): Promise<NotificationReadResult> {
    const unreadCount = await this.unreadCount(userId);
    const data: NotificationReadLive = { ids, unreadCount };
    this.live.publish(`user:${userId}`, NOTIFICATION_READ_EVENT, data);
    return { unreadCount };
  }
}
