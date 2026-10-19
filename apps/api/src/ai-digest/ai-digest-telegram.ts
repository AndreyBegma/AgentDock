import type { AiDigestView } from '@agentdock/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BotTokenStore } from '../notifications';
import { TelegramApiError, TelegramClient } from '../telegram/telegram-client';
import {
  TELEGRAM_OPTIONS,
  type TelegramOptions,
} from '../telegram/telegram-options';
import { aiDigestTelegramText } from './ai-digest-format';

/**
 * Sends a digest to the linked Telegram chats of the people who can see the
 * project: active admins and its members (#658). The digest is stored before
 * this runs, so a refused send loses nothing the web activity view does not
 * still show; it is logged without the token and not retried.
 */
@Injectable()
export class AiDigestTelegram {
  private readonly logger = new Logger(AiDigestTelegram.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BotTokenStore,
    private readonly client: TelegramClient,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  /** Returns how many chats it reached. */
  async send(view: AiDigestView, projectName: string): Promise<number> {
    const bot = await this.tokens.read();
    if (!bot.ok) return 0;
    const links = await this.prisma.telegramLink.findMany({
      where: {
        user: {
          status: 'active',
          OR: [
            { role: 'admin' },
            { memberships: { some: { projectId: view.projectId } } },
          ],
        },
      },
      select: { userId: true, chatId: true },
      orderBy: { linkedAt: 'asc' },
    });
    if (links.length === 0) return 0;
    const text = aiDigestTelegramText(
      view,
      projectName,
      this.options.appUrl
        ? `${this.options.appUrl}/projects/${view.projectId}/activity`
        : null,
    );
    let sent = 0;
    for (const link of links) {
      try {
        await this.client.sendMessage(bot.token, link.chatId, text);
        sent += 1;
      } catch (error) {
        this.logger.warn(
          `AI digest ${view.id} not sent to user ${link.userId}: ${
            error instanceof TelegramApiError
              ? error.message
              : 'internal error while sending'
          }`,
        );
        // A refused token fails every send; do not try the rest.
        if (error instanceof TelegramApiError && error.tokenRejected) break;
      }
    }
    return sent;
  }
}
