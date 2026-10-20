import type { StewardDigestView } from '@nautelle/shared';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BotTokenStore } from '../notifications';
import { TelegramApiError, TelegramClient } from '../telegram/telegram-client';
import { digestTelegramText } from './steward-digest-format';

export interface TelegramDigestResult {
  sent: number;
  failed: number;
  /** No bot token is configured (or it cannot be read): nothing was attempted. */
  skipped: boolean;
}

/**
 * Delivers a digest to the people who can see the project and have linked
 * Telegram (D14). The digest is already stored when this runs, so a failed or
 * refused send loses nothing the Overview panel does not still show; it is
 * logged without the token (`TelegramApiError`'s message never carries it) and
 * not retried — the next digest is a day away at most.
 */
@Injectable()
export class StewardDigestTelegram {
  private readonly logger = new Logger(StewardDigestTelegram.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BotTokenStore,
    private readonly client: TelegramClient,
  ) {}

  /**
   * Active, linked users who can see `projectId`: admins and its members. For
   * an `away_off` digest, `preferUserId` (the person who switched away mode
   * off) receives it alone when they are among them.
   */
  async recipients(
    projectId: string,
    preferUserId: string | null,
  ): Promise<{ userId: string; chatId: bigint }[]> {
    const links = await this.prisma.telegramLink.findMany({
      where: {
        user: {
          status: 'active',
          OR: [{ role: 'admin' }, { memberships: { some: { projectId } } }],
        },
      },
      select: { userId: true, chatId: true },
      orderBy: { linkedAt: 'asc' },
    });
    const preferred = links.filter((l) => l.userId === preferUserId);
    return preferred.length > 0 ? preferred : links;
  }

  async send(
    view: StewardDigestView,
    projectName: string,
    preferUserId: string | null = null,
  ): Promise<TelegramDigestResult> {
    const result: TelegramDigestResult = { sent: 0, failed: 0, skipped: false };
    const bot = await this.tokens.read();
    if (!bot.ok) return { ...result, skipped: true };
    const to = await this.recipients(view.projectId, preferUserId);
    if (to.length === 0) return { ...result, skipped: true };
    const text = digestTelegramText(view, projectName);
    for (const recipient of to) {
      try {
        await this.client.sendMessage(bot.token, recipient.chatId, text);
        result.sent += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.warn(
          `digest ${view.id} not sent to user ${recipient.userId}: ${
            error instanceof TelegramApiError
              ? error.message
              : 'internal error while sending'
          }`,
        );
        // A refused token fails every send; do not try the rest.
        if (error instanceof TelegramApiError && error.tokenRejected) break;
      }
    }
    return result;
  }
}
