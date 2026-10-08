import { randomUUID } from 'node:crypto';
import {
  type DeliverySkipReason,
  type NotificationKind,
  TELEGRAM_RATE_WINDOW_MS,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { planTelegramDeliveries } from './telegram-delivery-plan';

type Tx = Prisma.TransactionClient;

const LOCK_KEY = 'notifications:telegram-ledger';
/** A claimed delivery is not handed out again for this long unless reported. */
export const TELEGRAM_CLAIM_LEASE_MS = 60_000;
/** Attempts before a delivery is `failed` for good. */
export const TELEGRAM_MAX_ATTEMPTS = 5;
/** Backoff when Telegram gave no `retry_after`: 30 s, 1 min, 2 min, … */
const BACKOFF_BASE_MS = 30_000;
const LAST_ERROR_MAX = 500;

/** What a Telegram message is built from (spec 22 D10) — no pane text, no code. */
export interface DeliveryContent {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Path in the web app; prefix with `APP_URL`. */
  link: string | null;
  projectName: string | null;
  slot: string | null;
  issue: number | null;
  count: number;
}

/** One message to send now. */
export interface ClaimedDelivery {
  id: string;
  userId: string;
  chatId: bigint;
  attempts: number;
  content: DeliveryContent;
}

/** One digest message to send now, for the items over the rate limit. */
export interface ClaimedDigest {
  digestId: string;
  userId: string;
  chatId: bigint;
  items: DeliveryContent[];
}

export interface DeliveryClaim {
  messages: ClaimedDelivery[];
  digests: ClaimedDigest[];
}

const CONTENT_SELECT = {
  kind: true,
  title: true,
  body: true,
  link: true,
  slot: true,
  issue: true,
  count: true,
  project: { select: { displayName: true } },
} as const;

type ContentRow = Prisma.NotificationGetPayload<{
  select: typeof CONTENT_SELECT;
}>;

const toContent = (row: ContentRow): DeliveryContent => ({
  kind: row.kind as NotificationKind,
  title: row.title,
  body: row.body,
  link: row.link,
  projectName: row.project?.displayName ?? null,
  slot: row.slot,
  issue: row.issue,
  count: row.count,
});

/** Errors are stored for the admin page; never more than a line of them. */
const clip = (error: string): string => error.slice(0, LAST_ERROR_MAX);

/**
 * The Telegram side of `notification_deliveries` (spec 22 D6): which messages
 * may go out now under the 20-per-10-minutes limit, which wait for a digest,
 * and what happened to each. The Telegram module owns the HTTP: it calls
 * `claim()`, sends, and reports each result back with `markSent` /
 * `markFailed` / `markDigestSent` / `markDigestFailed`.
 *
 * A claim leases its rows for `TELEGRAM_CLAIM_LEASE_MS`, so two pollers (or a
 * poller that died mid-send) never send the same row twice inside the lease.
 */
@Injectable()
export class TelegramDeliveryLedger {
  constructor(private readonly prisma: PrismaService) {}

  async claim(now = new Date()): Promise<DeliveryClaim> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
      return {
        messages: await this.claimMessages(tx, now),
        digests: await this.claimDigests(tx, now),
      };
    });
  }

  async markSent(id: string, at = new Date()): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: 'sent',
        sentAt: at,
        nextAttemptAt: null,
        lastError: null,
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * A send that did not go through. `retryAfterS`: Telegram's 429
   * `retry_after`, honoured exactly. `permanent`: never retry (the chat
   * blocked the bot, the chat is gone).
   */
  async markFailed(
    id: string,
    error: string,
    options: { retryAfterS?: number; permanent?: boolean } = {},
    now = new Date(),
  ): Promise<void> {
    const row = await this.prisma.notificationDelivery.findUniqueOrThrow({
      where: { id },
      select: { attempts: true },
    });
    const attempts = row.attempts + 1;
    const giveUp =
      options.permanent === true || attempts >= TELEGRAM_MAX_ATTEMPTS;
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: {
        attempts,
        lastError: clip(error),
        status: giveUp ? 'failed' : 'pending',
        nextAttemptAt: giveUp
          ? null
          : new Date(
              now.getTime() + this.retryDelayMs(attempts, options.retryAfterS),
            ),
      },
    });
  }

  async markDigestSent(digestId: string, at = new Date()): Promise<void> {
    await this.prisma.notificationDelivery.updateMany({
      where: { digestId, status: 'digested', sentAt: null },
      data: { sentAt: at, nextAttemptAt: null, lastError: null },
    });
  }

  async markDigestFailed(
    digestId: string,
    error: string,
    options: { retryAfterS?: number; permanent?: boolean } = {},
    now = new Date(),
  ): Promise<void> {
    const rows = await this.prisma.notificationDelivery.findMany({
      where: { digestId, status: 'digested', sentAt: null },
      select: { attempts: true },
    });
    const attempts = Math.max(0, ...rows.map((r) => r.attempts)) + 1;
    const giveUp =
      options.permanent === true || attempts >= TELEGRAM_MAX_ATTEMPTS;
    await this.prisma.notificationDelivery.updateMany({
      where: { digestId, status: 'digested', sentAt: null },
      data: {
        attempts,
        lastError: clip(error),
        ...(giveUp
          ? { status: 'failed', nextAttemptAt: null }
          : {
              nextAttemptAt: new Date(
                now.getTime() +
                  this.retryDelayMs(attempts, options.retryAfterS),
              ),
            }),
      },
    });
  }

  private retryDelayMs(attempts: number, retryAfterS?: number): number {
    if (retryAfterS !== undefined && retryAfterS >= 0)
      return retryAfterS * 1000;
    return BACKOFF_BASE_MS * 2 ** (attempts - 1);
  }

  private async claimMessages(tx: Tx, now: Date): Promise<ClaimedDelivery[]> {
    const due = await tx.notificationDelivery.findMany({
      where: {
        channel: 'telegram',
        status: 'pending',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        attempts: true,
        notification: { select: CONTENT_SELECT },
      },
    });
    if (due.length === 0) return [];

    const userIds = [...new Set(due.map((d) => d.userId))];
    const links = new Map(
      (
        await tx.telegramLink.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, chatId: true },
        })
      ).map((l) => [l.userId, l.chatId]),
    );
    const leaseUntil = new Date(now.getTime() + TELEGRAM_CLAIM_LEASE_MS);
    const windowStart = new Date(now.getTime() - TELEGRAM_RATE_WINDOW_MS);
    const claimed: ClaimedDelivery[] = [];

    for (const userId of userIds) {
      const mine = due.filter((d) => d.userId === userId);
      const chatId = links.get(userId);
      if (chatId === undefined) {
        const reason: DeliverySkipReason = 'unlinked';
        await tx.notificationDelivery.updateMany({
          where: { id: { in: mine.map((d) => d.id) } },
          data: { status: 'skipped', lastError: reason, nextAttemptAt: null },
        });
        continue;
      }

      const [sent, leased, oldest, openDigest] = await Promise.all([
        tx.notificationDelivery.count({
          where: {
            userId,
            channel: 'telegram',
            status: 'sent',
            sentAt: { gt: windowStart },
          },
        }),
        // Claimed and not reported yet, or waiting out a 429: already spoken for.
        tx.notificationDelivery.count({
          where: {
            userId,
            channel: 'telegram',
            status: 'pending',
            nextAttemptAt: { gt: now },
          },
        }),
        tx.notificationDelivery.findFirst({
          where: {
            userId,
            channel: 'telegram',
            status: 'sent',
            sentAt: { gt: windowStart },
          },
          orderBy: { sentAt: 'asc' },
          select: { sentAt: true },
        }),
        tx.notificationDelivery.findFirst({
          where: {
            userId,
            channel: 'telegram',
            status: 'digested',
            sentAt: null,
          },
          select: { digestId: true, nextAttemptAt: true },
        }),
      ]);

      const plan = planTelegramDeliveries({
        due: mine.map((d) => d.id),
        usedInWindow: sent + leased,
        oldestSentAt: oldest?.sentAt ?? null,
        now,
      });

      if (plan.digest.length > 0) {
        await tx.notificationDelivery.updateMany({
          where: { id: { in: plan.digest } },
          data: {
            status: 'digested',
            digestId: openDigest?.digestId ?? randomUUID(),
            nextAttemptAt: openDigest?.nextAttemptAt ?? plan.digestAt,
          },
        });
      }
      if (plan.send.length > 0) {
        await tx.notificationDelivery.updateMany({
          where: { id: { in: plan.send } },
          data: { nextAttemptAt: leaseUntil },
        });
      }
      const sendNow = new Set(plan.send);
      for (const row of mine) {
        if (!sendNow.has(row.id)) continue;
        claimed.push({
          id: row.id,
          userId,
          chatId,
          attempts: row.attempts,
          content: toContent(row.notification),
        });
      }
    }
    return claimed;
  }

  private async claimDigests(tx: Tx, now: Date): Promise<ClaimedDigest[]> {
    const due = await tx.notificationDelivery.findMany({
      where: {
        channel: 'telegram',
        status: 'digested',
        sentAt: null,
        nextAttemptAt: { lte: now },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        digestId: true,
        notification: { select: CONTENT_SELECT },
      },
    });
    if (due.length === 0) return [];
    const links = new Map(
      (
        await tx.telegramLink.findMany({
          where: { userId: { in: [...new Set(due.map((d) => d.userId))] } },
          select: { userId: true, chatId: true },
        })
      ).map((l) => [l.userId, l.chatId]),
    );
    const leaseUntil = new Date(now.getTime() + TELEGRAM_CLAIM_LEASE_MS);
    const digests = new Map<string, ClaimedDigest>();
    for (const row of due) {
      const digestId = row.digestId;
      if (!digestId) continue;
      const chatId = links.get(row.userId);
      if (chatId === undefined) {
        await tx.notificationDelivery.update({
          where: { id: row.id },
          data: {
            status: 'skipped',
            lastError: 'unlinked',
            nextAttemptAt: null,
          },
        });
        continue;
      }
      const digest = digests.get(digestId) ?? {
        digestId,
        userId: row.userId,
        chatId,
        items: [],
      };
      digest.items.push(toContent(row.notification));
      digests.set(digestId, digest);
    }
    if (digests.size > 0) {
      await tx.notificationDelivery.updateMany({
        where: {
          digestId: { in: [...digests.keys()] },
          status: 'digested',
          sentAt: null,
        },
        data: { nextAttemptAt: leaseUntil },
      });
    }
    return [...digests.values()];
  }
}
