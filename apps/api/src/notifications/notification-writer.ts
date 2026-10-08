import {
  type DeliverySkipReason,
  effectiveProjectRole,
  kindAllowsChannel,
  NOTIFICATION_FOLD_WINDOW_MS,
  type NotificationKind,
  type Role,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { channelsFor, muteActive } from './notification-rules.service';

type Tx = Prisma.TransactionClient;

/** Someone a notification goes to, with their role where it applies. */
export interface Recipient {
  userId: string;
  role: Role;
}

export interface NotificationInput {
  kind: NotificationKind;
  projectId: string | null;
  runnerId: string | null;
  slot: string | null;
  issue: number | null;
  title: string;
  body: string;
  link: string | null;
  /** The event it came from; null for the runner watcher. */
  eventId: bigint | null;
  /** When it happened — the event's `ts`. */
  at: Date;
  /** D6 folding; off for the runner watcher, whose items are one per incident. */
  fold: boolean;
}

/** A row created or folded into — published once the transaction commits. */
export interface WrittenNotification {
  userId: string;
  notificationId: bigint;
}

const ACTIVE = 'active' as const;

/**
 * Recipients (D2), rules and mutes (D3), folding (D6) and the Telegram
 * delivery bookkeeping, inside the caller's transaction. Sending is not here:
 * a `pending` delivery is what the Telegram module picks up.
 */
@Injectable()
export class NotificationWriter {
  /** D2: every active member of the project and every active admin. */
  async projectRecipients(tx: Tx, projectId: string): Promise<Recipient[]> {
    const [admins, members] = await Promise.all([
      tx.user.findMany({
        where: { role: 'admin', status: ACTIVE },
        select: { id: true },
      }),
      tx.projectMember.findMany({
        where: { projectId, user: { status: ACTIVE, role: { not: 'admin' } } },
        select: {
          roleOverride: true,
          user: { select: { id: true, role: true } },
        },
      }),
    ]);
    return [
      ...admins.map((a) => ({ userId: a.id, role: 'admin' as Role })),
      ...members.map((m) => ({
        userId: m.user.id,
        role: effectiveProjectRole(m.user.role, m.roleOverride),
      })),
    ];
  }

  /** D2: `runner.*` goes to active admins only. */
  async adminRecipients(tx: Tx): Promise<Recipient[]> {
    const admins = await tx.user.findMany({
      where: { role: 'admin', status: ACTIVE },
      select: { id: true },
    });
    return admins.map((a) => ({ userId: a.id, role: 'admin' }));
  }

  async write(
    tx: Tx,
    input: NotificationInput,
    recipients: Recipient[],
  ): Promise<WrittenNotification[]> {
    if (recipients.length === 0) return [];
    const userIds = recipients.map((r) => r.userId);
    const [rules, mutes, links] = await Promise.all([
      tx.notificationRule.findMany({
        where: { userId: { in: userIds }, kind: input.kind },
      }),
      input.projectId
        ? tx.notificationMute.findMany({
            where: { userId: { in: userIds }, projectId: input.projectId },
          })
        : Promise.resolve([]),
      tx.telegramLink.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true },
      }),
    ]);
    const ruleOf = new Map(rules.map((r) => [r.userId, r]));
    const muteOf = new Map(mutes.map((m) => [m.userId, m]));
    const linked = new Set(links.map((l) => l.userId));

    const written: WrittenNotification[] = [];
    for (const recipient of recipients) {
      const channels = channelsFor(
        input.kind,
        recipient.role,
        ruleOf.get(recipient.userId),
      );
      if (!channels.inApp && !channels.telegram) continue;
      const mute = muteOf.get(recipient.userId);
      const muted = mute !== undefined && muteActive(mute.until, input.at);

      const folded = input.fold
        ? await this.fold(tx, input, recipient.userId, channels.inApp)
        : null;
      if (folded !== null) {
        written.push({ userId: recipient.userId, notificationId: folded });
        continue;
      }

      const [created] = await tx.notification.createManyAndReturn({
        data: [
          {
            userId: recipient.userId,
            kind: input.kind,
            projectId: input.projectId,
            runnerId: input.runnerId,
            slot: input.slot,
            issue: input.issue,
            title: input.title,
            body: input.body,
            link: input.link,
            eventId: input.eventId,
            firstAt: input.at,
            lastAt: input.at,
            muted,
            // In-app off, Telegram on: the row exists for its delivery, read.
            readAt: channels.inApp ? null : input.at,
          },
        ],
        // A replayed event: the unique (eventId, userId, kind) already has it (D4).
        skipDuplicates: true,
        select: { id: true },
      });
      if (!created) continue;
      written.push({ userId: recipient.userId, notificationId: created.id });

      if (
        linked.has(recipient.userId) &&
        kindAllowsChannel(input.kind, 'telegram')
      ) {
        const skip: DeliverySkipReason | null = muted
          ? 'muted'
          : channels.telegram
            ? null
            : 'rule_off';
        await tx.notificationDelivery.create({
          data: {
            notificationId: created.id,
            userId: recipient.userId,
            channel: 'telegram',
            status: skip ? 'skipped' : 'pending',
            lastError: skip,
            nextAttemptAt: skip ? null : input.at,
          },
        });
      }
    }
    return written;
  }

  /**
   * D6: the same `(user, kind, project, slot)` whose `firstAt` is within 15
   * minutes takes the event — `count + 1`, `lastAt`, and unread again. No
   * second delivery: Telegram heard about it with the first.
   */
  private async fold(
    tx: Tx,
    input: NotificationInput,
    userId: string,
    inApp: boolean,
  ): Promise<bigint | null> {
    const existing = await tx.notification.findFirst({
      where: {
        userId,
        kind: input.kind,
        projectId: input.projectId,
        slot: input.slot,
        firstAt: {
          gt: new Date(input.at.getTime() - NOTIFICATION_FOLD_WINDOW_MS),
          lte: input.at,
        },
      },
      orderBy: { firstAt: 'desc' },
      select: { id: true, lastAt: true },
    });
    if (!existing) return null;
    await tx.notification.update({
      where: { id: existing.id },
      data: {
        count: { increment: 1 },
        lastAt: existing.lastAt > input.at ? existing.lastAt : input.at,
        ...(inApp ? { readAt: null } : {}),
      },
    });
    return existing.id;
  }
}
