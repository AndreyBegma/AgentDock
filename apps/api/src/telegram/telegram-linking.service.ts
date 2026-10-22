import { createHash, randomBytes } from 'node:crypto';
import type {
  Role,
  TelegramLinkCode,
  TelegramLinkRequest,
  TelegramLinkStatus,
} from '@nautelle/shared';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit';
import { type AuditContext, userActor } from '../audit/audit.types';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { BotTokenStore, NotificationsService } from '../notifications';
import { NotificationWriter } from '../notifications/notification-writer';
import { TelegramClient, type TelegramMessage } from './telegram-client';
import {
  telegramChatTaken,
  telegramLinkRequestNotFound,
  telegramNotConfigured,
} from './telegram-error';

/** D9: a link code is good for this long, once. */
export const TELEGRAM_LINK_CODE_TTL_MS = 10 * 60_000;
/** 24 random bytes → 32 base64url characters; Telegram allows 64 in `start`. */
const CODE_BYTES = 24;
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** `/start`, `/start <code>`, `/start@SomeBot <code>`, `/stop`. */
const COMMAND = /^\/(start|stop)(?:@\w+)?(?:\s+(\S+))?\s*$/;
/** Where the user confirms a waiting chat (C-147). */
const CONFIRM_LINK = '/account/notifications#telegram';

export const hashLinkCode = (code: string): string =>
  createHash('sha256').update(code).digest('hex');

/** What the bot answers. Fixed text: nothing from the chat is echoed back. */
export const LINK_REPLIES = {
  linked:
    'Linked to Nautelle. Notifications you turn on for Telegram arrive here. Send /stop to unlink.',
  pending:
    'Almost there. Confirm this chat in Nautelle → Account → Notifications before the link expires. Until then nothing is sent here.',
  invalidCode:
    'This link has expired or was already used. Create a new one in Nautelle → Account → Notifications.',
  noCode:
    'Open the link from Nautelle → Account → Notifications to connect this chat.',
  notPrivate: 'Nautelle links only in a private chat with the bot.',
  chatTaken:
    'This chat is already linked to another Nautelle account. Send /stop there first.',
  unlinked: 'Unlinked. Nautelle will send nothing more to this chat.',
  notLinked: 'This chat is not linked to Nautelle.',
} as const;

export type LinkReply = keyof typeof LINK_REPLIES;

/** A reply the poller sends for an update. */
export interface UpdateReply {
  chatId: number;
  reply: LinkReply;
}

type StartOutcome =
  | { reply: 'pending'; userId: string; role: Role }
  | { reply: Exclude<LinkReply, 'pending'> };

type ConfirmOutcome =
  | { ok: true; chatId: bigint; username: string | null; replaced: boolean }
  | { ok: false; reason: 'not_found' | 'chat_taken' };

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

const chatName = (username: string | null): string =>
  username ? `@${username}` : 'A Telegram chat without a username';

/**
 * Account linking (spec 22 D9). The app hands out a one-time code — only its
 * SHA-256 is stored — and the private chat that sends `/start <code>` waits
 * as a pending link until the code's user confirms it in the app (C-147,
 * D-16): whoever saw the code first cannot take the user's notifications or
 * buttons. One chat per user, one user per chat; `/stop` in the chat or
 * `DELETE /notifications/telegram/link` unlinks.
 */
@Injectable()
export class TelegramLinkingService {
  private readonly logger = new Logger(TelegramLinkingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BotTokenStore,
    private readonly audit: AuditService,
    private readonly client: TelegramClient,
    private readonly writer: NotificationWriter,
    private readonly notifications: NotificationsService,
  ) {}

  async status(userId: string, now = new Date()): Promise<TelegramLinkStatus> {
    const [link, pending, bot] = await Promise.all([
      this.prisma.telegramLink.findUnique({ where: { userId } }),
      this.pendingOf(userId, now),
      this.tokens.status(),
    ]);
    return {
      linked: link !== null,
      username: link?.username ?? null,
      linkedAt: link?.linkedAt.toISOString() ?? null,
      botConfigured: bot.configured,
      pending,
    };
  }

  /** A fresh code for `user`; any older unused code of theirs stops working. */
  async createCode(
    user: AuthUser,
    now = new Date(),
  ): Promise<TelegramLinkCode> {
    const bot = await this.tokens.read();
    if (!bot.ok) throw telegramNotConfigured();
    const code = randomBytes(CODE_BYTES).toString('base64url');
    const expiresAt = new Date(now.getTime() + TELEGRAM_LINK_CODE_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.telegramLinkCode.deleteMany({
        where: { userId: user.id, usedAt: null },
      }),
      this.prisma.telegramLinkCode.create({
        data: { userId: user.id, codeHash: hashLinkCode(code), expiresAt },
      }),
    ]);
    return {
      url: `https://t.me/${encodeURIComponent(bot.botUsername)}?start=${code}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * C-147: the user confirms the chat waiting under `id`, and only then is it
   * linked — replacing a chat linked before. Refused once it expired, was
   * declined or replaced (404), and when the chat is another user's (409).
   */
  async confirm(
    user: AuthUser,
    id: string,
    ctx: AuditContext,
    now = new Date(),
  ): Promise<TelegramLinkStatus> {
    let outcome: ConfirmOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const pending = await tx.telegramPendingLink.findFirst({
          where: { id, userId: user.id, expiresAt: { gt: now } },
        });
        if (!pending) return { ok: false, reason: 'not_found' };
        // The conditional delete is the single use: of two racing
        // confirmations, one sees count 1.
        const claimed = await tx.telegramPendingLink.deleteMany({
          where: { id, userId: user.id },
        });
        if (claimed.count === 0) return { ok: false, reason: 'not_found' };
        const { chatId, username } = pending;
        const holder = await tx.telegramLink.findUnique({ where: { chatId } });
        if (holder && holder.userId !== user.id) {
          return { ok: false, reason: 'chat_taken' };
        }
        const previous = await tx.telegramLink.findUnique({
          where: { userId: user.id },
          select: { chatId: true },
        });
        await tx.telegramLink.upsert({
          where: { userId: user.id },
          create: { userId: user.id, chatId, username, linkedAt: now },
          update: { chatId, username, linkedAt: now },
        });
        return {
          ok: true,
          chatId,
          username,
          replaced: previous !== null && previous.chatId !== chatId,
        };
      });
    } catch (error) {
      // Another user bound this chat between the check and the write.
      if (!isUniqueViolation(error)) throw error;
      await this.prisma.telegramPendingLink.deleteMany({
        where: { id, userId: user.id },
      });
      outcome = { ok: false, reason: 'chat_taken' };
    }
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw telegramLinkRequestNotFound();
      throw telegramChatTaken();
    }
    await this.audit.record({
      ...ctx,
      action: 'telegram.link',
      target: { type: 'user', id: user.id },
      after: {
        linked: true,
        username: outcome.username,
        replacedChat: outcome.replaced,
      },
      result: 'ok',
      meta: { via: 'app', confirmed: true },
    });
    this.logger.log(`Telegram linked for user ${user.id}`);
    await this.tellChat(outcome.chatId, LINK_REPLIES.linked);
    return this.status(user.id, now);
  }

  /** C-147: the user turns the waiting chat away. Idempotent. */
  async decline(user: AuthUser, ctx: AuditContext): Promise<void> {
    const pending = await this.prisma.telegramPendingLink.findUnique({
      where: { userId: user.id },
    });
    if (!pending) return;
    const removed = await this.prisma.telegramPendingLink.deleteMany({
      where: { id: pending.id },
    });
    if (removed.count === 0) return;
    await this.audit.record({
      ...ctx,
      action: 'telegram.link_decline',
      target: { type: 'user', id: user.id },
      before: { username: pending.username },
      result: 'ok',
      meta: { via: 'app' },
    });
  }

  /** C-147: removes the pending links past their expiry; returns how many. */
  async expirePending(now = new Date()): Promise<number> {
    const removed = await this.prisma.telegramPendingLink.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return removed.count;
  }

  async unlink(user: AuthUser, ctx: AuditContext): Promise<void> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { userId: user.id },
    });
    if (!link) return;
    await this.prisma.telegramLink.deleteMany({ where: { userId: user.id } });
    await this.recordUnlink(user.id, link.username, ctx, 'app');
  }

  /** The bot's side: `/start <code>` and `/stop`. Anything else is ignored. */
  async handleMessage(
    message: TelegramMessage,
    now = new Date(),
  ): Promise<UpdateReply | null> {
    const match = message.text?.trim().match(COMMAND);
    if (!match) return null;
    const chatId = message.chat.id;
    if (message.chat.type !== 'private') {
      return { chatId, reply: 'notPrivate' };
    }
    if (match[1] === 'stop') return { chatId, reply: await this.stop(chatId) };
    const code = match[2];
    if (!code) return { chatId, reply: 'noCode' };
    return { chatId, reply: await this.start(message, code, now) };
  }

  private async pendingOf(
    userId: string,
    now: Date,
  ): Promise<TelegramLinkRequest | null> {
    const pending = await this.prisma.telegramPendingLink.findFirst({
      where: { userId, expiresAt: { gt: now } },
    });
    return pending
      ? {
          id: pending.id,
          username: pending.username,
          createdAt: pending.createdAt.toISOString(),
          expiresAt: pending.expiresAt.toISOString(),
        }
      : null;
  }

  /**
   * Redeems the code into a pending link (C-147) — never an active one. The
   * code's user is told in the app and confirms there.
   */
  private async start(
    message: TelegramMessage,
    code: string,
    now: Date,
  ): Promise<LinkReply> {
    if (!CODE_SHAPE.test(code)) return 'invalidCode';
    const chatId = BigInt(message.chat.id);
    const username = message.from?.username ?? null;
    const outcome: StartOutcome = await this.prisma.$transaction(async (tx) => {
      const codeHash = hashLinkCode(code);
      // The conditional update is the single use: of two racing `/start`s,
      // one sees count 1.
      const claimed = await tx.telegramLinkCode.updateMany({
        where: { codeHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count === 0) return { reply: 'invalidCode' };
      const { user, expiresAt } = await tx.telegramLinkCode.findUniqueOrThrow({
        where: { codeHash },
        select: {
          expiresAt: true,
          user: { select: { id: true, status: true, role: true } },
        },
      });
      // A user disabled since the code was made: the same answer as a bad code.
      if (user.status !== 'active') return { reply: 'invalidCode' };
      const holder = await tx.telegramLink.findUnique({ where: { chatId } });
      if (holder && holder.userId !== user.id) return { reply: 'chatTaken' };
      // This very chat is the user's link already: nothing to confirm.
      if (holder) return { reply: 'linked' };
      // The pending link lives as long as the code would have.
      await tx.telegramPendingLink.upsert({
        where: { userId: user.id },
        create: { userId: user.id, chatId, username, expiresAt },
        update: { chatId, username, createdAt: now, expiresAt },
      });
      return { reply: 'pending', userId: user.id, role: user.role };
    });
    if (outcome.reply !== 'pending') return outcome.reply;
    await this.audit.record({
      actor: userActor(outcome.userId),
      action: 'telegram.link_request',
      target: { type: 'user', id: outcome.userId },
      after: { pending: true, username },
      result: 'ok',
      meta: { via: 'telegram' },
    });
    await this.notifyPending(outcome.userId, outcome.role, username, now);
    this.logger.log(`Telegram link pending for user ${outcome.userId}`);
    return 'pending';
  }

  /** C-147: the in-app notice of a waiting chat, to its user only. */
  private async notifyPending(
    userId: string,
    role: Role,
    username: string | null,
    at: Date,
  ): Promise<void> {
    const written = await this.prisma.$transaction((tx) =>
      this.writer.write(
        tx,
        {
          kind: 'telegram.link_pending',
          projectId: null,
          runnerId: null,
          slot: null,
          issue: null,
          title: `Confirm the Telegram chat ${chatName(username)}`,
          body: `${chatName(username)} used your Telegram link code. Confirm it in Account → Notifications if the chat is yours; otherwise turn it away. It receives nothing until you confirm.`,
          link: CONFIRM_LINK,
          eventId: null,
          at,
          fold: false,
        },
        [{ userId, role }],
      ),
    );
    await this.notifications.publish(written);
  }

  /** A fixed message to `chatId`; a failure is logged, never thrown. */
  private async tellChat(chatId: bigint, text: string): Promise<void> {
    const bot = await this.tokens.read();
    if (!bot.ok) return;
    await this.client
      .sendMessage(bot.token, chatId, text, true)
      .catch((error: unknown) => {
        this.logger.warn(
          `Telegram confirmation message not sent: ${error instanceof Error ? error.name : 'error'}`,
        );
      });
  }

  private async stop(chatId: number): Promise<LinkReply> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { chatId: BigInt(chatId) },
    });
    if (!link) {
      // A chat that only waits for confirmation withdraws it (C-147).
      const withdrawn = await this.prisma.telegramPendingLink.deleteMany({
        where: { chatId: BigInt(chatId) },
      });
      return withdrawn.count > 0 ? 'unlinked' : 'notLinked';
    }
    const removed = await this.prisma.telegramLink.deleteMany({
      where: { chatId: BigInt(chatId), userId: link.userId },
    });
    if (removed.count === 0) return 'notLinked';
    await this.recordUnlink(
      link.userId,
      link.username,
      { actor: userActor(link.userId) },
      'telegram',
    );
    return 'unlinked';
  }

  private recordUnlink(
    userId: string,
    username: string | null,
    ctx: AuditContext,
    via: 'app' | 'telegram',
  ): Promise<void> {
    return this.audit.record({
      ...ctx,
      action: 'telegram.unlink',
      target: { type: 'user', id: userId },
      before: { linked: true, username },
      after: { linked: false },
      result: 'ok',
      meta: { via },
    });
  }
}
