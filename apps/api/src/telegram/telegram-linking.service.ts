import { createHash, randomBytes } from 'node:crypto';
import type { TelegramLinkCode, TelegramLinkStatus } from '@agentdock/shared';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit';
import { type AuditContext, userActor } from '../audit/audit.types';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import { BotTokenStore } from '../notifications';
import type { TelegramMessage, TelegramUpdate } from './telegram-client';
import { telegramNotConfigured } from './telegram-error';

/** D9: a link code is good for this long, once. */
export const TELEGRAM_LINK_CODE_TTL_MS = 10 * 60_000;
/** 24 random bytes → 32 base64url characters; Telegram allows 64 in `start`. */
const CODE_BYTES = 24;
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** `/start`, `/start <code>`, `/start@SomeBot <code>`, `/stop`. */
const COMMAND = /^\/(start|stop)(?:@\w+)?(?:\s+(\S+))?\s*$/;

export const hashLinkCode = (code: string): string =>
  createHash('sha256').update(code).digest('hex');

/** What the bot answers. Fixed text: nothing from the chat is echoed back. */
export const LINK_REPLIES = {
  linked:
    'Linked to AgentDock. Notifications you turn on for Telegram arrive here. Send /stop to unlink.',
  invalidCode:
    'This link has expired or was already used. Create a new one in AgentDock → Account → Notifications.',
  noCode:
    'Open the link from AgentDock → Account → Notifications to connect this chat.',
  notPrivate: 'AgentDock links only in a private chat with the bot.',
  chatTaken:
    'This chat is already linked to another AgentDock account. Send /stop there first.',
  unlinked: 'Unlinked. AgentDock will send nothing more to this chat.',
  notLinked: 'This chat is not linked to AgentDock.',
} as const;

export type LinkReply = keyof typeof LINK_REPLIES;

/** A reply the poller sends for an update. */
export interface UpdateReply {
  chatId: number;
  reply: LinkReply;
}

type StartOutcome =
  | { ok: true; userId: string; replaced: boolean }
  | { ok: false; reply: LinkReply };

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';

/**
 * Account linking (spec 22 D9). The app hands out a one-time code — only its
 * SHA-256 is stored — and the bot binds the private chat that sends
 * `/start <code>` to the code's user. One chat per user, one user per chat;
 * `/stop` in the chat or `DELETE /notifications/telegram/link` unlinks.
 */
@Injectable()
export class TelegramLinkingService {
  private readonly logger = new Logger(TelegramLinkingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BotTokenStore,
    private readonly audit: AuditService,
  ) {}

  async status(userId: string): Promise<TelegramLinkStatus> {
    const [link, bot] = await Promise.all([
      this.prisma.telegramLink.findUnique({ where: { userId } }),
      this.tokens.status(),
    ]);
    return {
      linked: link !== null,
      username: link?.username ?? null,
      linkedAt: link?.linkedAt.toISOString() ?? null,
      botConfigured: bot.configured,
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

  async unlink(user: AuthUser, ctx: AuditContext): Promise<void> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { userId: user.id },
    });
    if (!link) return;
    await this.prisma.telegramLink.deleteMany({ where: { userId: user.id } });
    await this.recordUnlink(user.id, link.username, ctx, 'app');
  }

  /** The bot's side: `/start <code>` and `/stop`. Anything else is ignored. */
  async handleUpdate(
    update: TelegramUpdate,
    now = new Date(),
  ): Promise<UpdateReply | null> {
    const message = update.message;
    const match = message?.text?.trim().match(COMMAND);
    if (!message || !match) return null;
    const chatId = message.chat.id;
    if (message.chat.type !== 'private') {
      return { chatId, reply: 'notPrivate' };
    }
    if (match[1] === 'stop') return { chatId, reply: await this.stop(chatId) };
    const code = match[2];
    if (!code) return { chatId, reply: 'noCode' };
    return { chatId, reply: await this.start(message, code, now) };
  }

  private async start(
    message: TelegramMessage,
    code: string,
    now: Date,
  ): Promise<LinkReply> {
    if (!CODE_SHAPE.test(code)) return 'invalidCode';
    const chatId = BigInt(message.chat.id);
    const username = message.from?.username ?? null;
    let outcome: StartOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const codeHash = hashLinkCode(code);
        // The conditional update is the single use: of two racing `/start`s,
        // one sees count 1.
        const claimed = await tx.telegramLinkCode.updateMany({
          where: { codeHash, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count === 0) return { ok: false, reply: 'invalidCode' };
        const { user } = await tx.telegramLinkCode.findUniqueOrThrow({
          where: { codeHash },
          select: { user: { select: { id: true, status: true } } },
        });
        // A user disabled since the code was made: the same answer as a bad code.
        if (user.status !== 'active')
          return { ok: false, reply: 'invalidCode' };
        const holder = await tx.telegramLink.findUnique({ where: { chatId } });
        if (holder && holder.userId !== user.id) {
          return { ok: false, reply: 'chatTaken' };
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
          userId: user.id,
          replaced: previous !== null && previous.chatId !== chatId,
        };
      });
    } catch (error) {
      // Another user bound this chat between the check and the write.
      if (isUniqueViolation(error)) return 'chatTaken';
      throw error;
    }
    if (!outcome.ok) return outcome.reply;
    await this.audit.record({
      actor: userActor(outcome.userId),
      action: 'telegram.link',
      target: { type: 'user', id: outcome.userId },
      after: { linked: true, username, replacedChat: outcome.replaced },
      result: 'ok',
      meta: { via: 'telegram' },
    });
    this.logger.log(`Telegram linked for user ${outcome.userId}`);
    return 'linked';
  }

  private async stop(chatId: number): Promise<LinkReply> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { chatId: BigInt(chatId) },
    });
    if (!link) return 'notLinked';
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
