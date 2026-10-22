import {
  NOTIFICATION_NEW_EVENT,
  NOTIFICATION_PAGE_DEFAULT,
  NOTIFICATION_READ_EVENT,
  type NotificationNewLive,
  type NotificationPage,
  type NotificationReadLive,
  type NotificationReadResult,
} from '@nautelle/shared';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { LiveService } from '../live/live.service';
import { ProjectAccessService } from '../projects';
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

/** The largest PostgreSQL `int8`: a longer id names no notification. */
const INT8_MAX = 9223372036854775807n;

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

type Caller = Pick<AuthUser, 'id' | 'role'>;

/**
 * The in-app notification centre (spec 22 D11): a user reads and marks only
 * their own rows — another user's id answers 404 like a missing one. A row of
 * a project the user can no longer see is hidden the same way (C-149).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveService,
    private readonly access: ProjectAccessService,
  ) {}

  /** The caller's rows of projects they can still see, and project-less ones. */
  private mineWhere(user: Caller): Prisma.NotificationWhereInput {
    return {
      userId: user.id,
      OR: [{ projectId: null }, { project: this.access.visibleWhere(user) }],
    };
  }

  /** Not read and not muted: what the bell counts (D3). */
  private unreadWhere(user: Caller): Prisma.NotificationWhereInput {
    return { ...this.mineWhere(user), readAt: null, muted: false };
  }

  async list(user: Caller, query: ListQuery): Promise<NotificationPage> {
    const limit = query.limit ?? NOTIFICATION_PAGE_DEFAULT;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !after) {
      throw notificationError(400, 'invalid_cursor', 'Malformed cursor');
    }
    const where: Prisma.NotificationWhereInput = {
      AND: [
        query.unread ? this.unreadWhere(user) : this.mineWhere(user),
        after
          ? {
              OR: [
                { lastAt: { lt: after.lastAt } },
                { lastAt: after.lastAt, id: { lt: after.id } },
              ],
            }
          : {},
      ],
    };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        include: NOTIFICATION_INCLUDE,
        orderBy: [{ lastAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.unreadCount(user),
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

  unreadCount(user: Caller): Promise<number> {
    return this.prisma.notification.count({ where: this.unreadWhere(user) });
  }

  async markRead(user: Caller, id: string): Promise<NotificationReadResult> {
    if (!/^\d{1,19}$/.test(id) || BigInt(id) > INT8_MAX)
      throw notificationNotFound();
    const { count } = await this.prisma.notification.updateMany({
      where: { ...this.mineWhere(user), id: BigInt(id) },
      data: { readAt: new Date() },
    });
    if (count === 0) throw notificationNotFound();
    return this.publishRead(user, [id]);
  }

  async markAllRead(user: Caller): Promise<NotificationReadResult> {
    await this.prisma.notification.updateMany({
      where: { ...this.mineWhere(user), readAt: null },
      data: { readAt: new Date() },
    });
    return this.publishRead(user, null);
  }

  /** `notification.new` on `user:<id>` for rows written by a committed transaction. */
  async publish(written: WrittenNotification[]): Promise<void> {
    if (written.length === 0) return;
    const rows = await this.prisma.notification.findMany({
      where: { id: { in: written.map((w) => w.notificationId) } },
      include: { ...NOTIFICATION_INCLUDE, user: { select: { role: true } } },
    });
    for (const row of rows) {
      try {
        const data: NotificationNewLive = {
          notification: toNotificationView(row),
          unreadCount: await this.unreadCount({
            id: row.userId,
            role: row.user.role,
          }),
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
    user: Caller,
    ids: string[] | null,
  ): Promise<NotificationReadResult> {
    const unreadCount = await this.unreadCount(user);
    const data: NotificationReadLive = { ids, unreadCount };
    this.live.publish(`user:${user.id}`, NOTIFICATION_READ_EVENT, data);
    return { unreadCount };
  }
}
