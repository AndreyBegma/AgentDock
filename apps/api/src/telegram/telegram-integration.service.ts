import type { TelegramIntegrationStatus } from '@nautelle/shared';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import {
  BotTokenStore,
  encryptionKeyMissing,
  TELEGRAM_BOT_TOKEN_SETTING_KEY,
} from '../notifications';
import { SettingsService } from '../settings/settings.service';
import { escapeMarkdownV2 } from './markdown-v2';
import { TelegramApiError, TelegramClient } from './telegram-client';
import { registerBotMenus } from './telegram-commands';
import {
  telegramNotConfigured,
  telegramNotLinked,
  telegramTokenInvalid,
  telegramUnavailable,
} from './telegram-error';
import { TELEGRAM_OPTIONS, type TelegramOptions } from './telegram-options';
import { TelegramPoller } from './telegram-poller';

/**
 * The bot the current `telegram_links` belong to. Kept apart from the token,
 * so clearing the bot and setting a different one still finds the links of
 * the old one (spec 22 notes).
 */
export const TELEGRAM_LINKS_BOT_SETTING_KEY = 'telegram.linksBot';

const TEST_MESSAGE =
  'Nautelle test message: Telegram notifications reach this chat.';

const isLinksBot = (value: unknown): value is { botUsername: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { botUsername?: unknown }).botUsername === 'string';

/** Telegram's answer to a token or a send, as the admin routes report it. */
const asHttpError = (error: unknown): never => {
  if (!(error instanceof TelegramApiError)) throw error;
  if (error.tokenRejected) throw telegramTokenInvalid();
  throw telegramUnavailable(error);
};

/**
 * `/admin/integrations/telegram` (spec 22 D8). The token is verified with
 * `getMe`, stored through `BotTokenStore` and never returned. When it belongs
 * to a different bot than the links do, the links and open codes go — a chat
 * id is a chat with one particular bot, and the new one cannot write to it.
 */
@Injectable()
export class TelegramIntegrationService {
  private readonly logger = new Logger(TelegramIntegrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: BotTokenStore,
    private readonly settings: SettingsService,
    private readonly client: TelegramClient,
    private readonly poller: TelegramPoller,
    private readonly audit: AuditService,
    @Inject(TELEGRAM_OPTIONS) private readonly options: TelegramOptions,
  ) {}

  async status(): Promise<TelegramIntegrationStatus> {
    const [bot, linkedUsers] = await Promise.all([
      this.tokens.status(),
      this.prisma.telegramLink.count(),
    ]);
    const health = this.poller.health();
    return {
      configured: bot.configured,
      botUsername: bot.botUsername,
      encryptionAvailable: bot.encryptionAvailable,
      polling: health.polling,
      lastError: health.lastError,
      lastPollAt: health.lastPollAt?.toISOString() ?? null,
      linkedUsers,
    };
  }

  async configure(
    token: string,
    admin: AuthUser,
    ctx: AuditContext,
  ): Promise<TelegramIntegrationStatus> {
    // Before any call to Telegram: without a key nothing could be stored.
    if (!(await this.tokens.status()).encryptionAvailable) {
      throw encryptionKeyMissing();
    }
    const bot = await this.client.getMe(token).catch(asHttpError);
    const linksBot = await this.linksBot();
    await this.tokens.set(token, bot.username, admin.id, ctx);
    // #500 / #580: the command menu and the menu button. The token is already stored, so a menu Telegram
    // refused is only logged; the poller sets it once more for a bot it has
    // not polled for yet, and after a restart.
    await registerBotMenus(
      this.client,
      token,
      this.options.appUrl,
      (what, error) => {
        this.logger.warn(
          `Telegram ${what} not set: ${
            error instanceof TelegramApiError ? error.message : 'internal error'
          }`,
        );
      },
    );

    let unlinkedUsers = 0;
    if (linksBot !== null && linksBot !== bot.username) {
      unlinkedUsers = await this.dropLinks(linksBot, bot.username, ctx);
    }
    if (linksBot !== bot.username) {
      await this.settings.set(
        TELEGRAM_LINKS_BOT_SETTING_KEY,
        { botUsername: bot.username },
        admin.id,
      );
    }
    return { ...(await this.status()), unlinkedUsers };
  }

  async clear(ctx: AuditContext): Promise<TelegramIntegrationStatus> {
    await this.tokens.clear(ctx);
    return this.status();
  }

  /** A test message to the caller's own linked chat — never anyone else's. */
  async sendTest(admin: AuthUser): Promise<void> {
    const link = await this.prisma.telegramLink.findUnique({
      where: { userId: admin.id },
      select: { chatId: true },
    });
    if (!link) throw telegramNotLinked();
    const bot = await this.tokens.read();
    if (!bot.ok) throw telegramNotConfigured();
    await this.client
      .sendMessage(bot.token, link.chatId, escapeMarkdownV2(TEST_MESSAGE))
      .catch(asHttpError);
  }

  private async linksBot(): Promise<string | null> {
    const stored = await this.settings.get(TELEGRAM_LINKS_BOT_SETTING_KEY);
    if (isLinksBot(stored)) return stored.botUsername;
    // Links made before this row existed belong to the bot configured then.
    return (await this.tokens.status()).botUsername;
  }

  /**
   * The links and open codes of `previous`, gone in one transaction with the
   * update offset. Runs after the new token is stored: a crash between the
   * two leaves stale links that fail with 403 until an admin saves again.
   */
  private async dropLinks(
    previous: string,
    botUsername: string,
    ctx: AuditContext,
  ): Promise<number> {
    this.poller.forgetOffset();
    const [links] = await this.prisma.$transaction([
      this.prisma.telegramLink.deleteMany({}),
      this.prisma.telegramLinkCode.deleteMany({ where: { usedAt: null } }),
      this.prisma.telegramPendingLink.deleteMany({}),
      this.prisma.notificationMatcherState.updateMany({
        data: { telegramUpdateOffset: 0n },
      }),
    ]);
    await this.audit.record({
      ...ctx,
      action: 'telegram.unlink',
      target: { type: 'setting', id: TELEGRAM_BOT_TOKEN_SETTING_KEY },
      after: {
        botUsername,
        previousBotUsername: previous,
        unlinkedUsers: links.count,
      },
      result: 'ok',
      meta: { reason: 'bot_changed' },
    });
    return links.count;
  }
}
