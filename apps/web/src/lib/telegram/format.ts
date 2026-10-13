import type { TelegramIntegrationStatus } from '@agentdock/shared';
import { ApiError, type Described, describeError } from '../api';
import { ENCRYPTION_KEY_REMEDY } from '../prerequisites/copy';

/** Where a person links their own Telegram chat. */
export const TELEGRAM_LINK_PAGE = '/account/notifications';

/** A sentence for the Telegram routes' own error codes, with the fix when it is a page. */
export function describeTelegramError(error: unknown): Described {
  if (error instanceof ApiError) {
    switch (String(error.code)) {
      case 'encryption_key_missing':
        return `The server has no APP_ENCRYPTION_KEY, so it cannot store a bot token. ${ENCRYPTION_KEY_REMEDY}`;
      case 'telegram_token_invalid':
        return 'Telegram did not accept this token. Copy it again from @BotFather.';
      case 'telegram_unavailable':
        return 'Telegram could not be reached. Try again in a minute.';
      case 'telegram_not_configured':
        return 'The bot is not configured. Set its token below.';
      case 'telegram_not_linked':
        return {
          text: 'The test goes to your own chat, and you have not linked Telegram yet.',
          href: TELEGRAM_LINK_PAGE,
          cta: 'Link your Telegram',
        };
    }
  }
  return describeError(error);
}

/**
 * What "Polling" means for this status: one API instance at a time reads
 * Telegram, so a configured bot that is not polled here may be polled by
 * another instance — or by none.
 */
export function pollingNote(
  status: Pick<TelegramIntegrationStatus, 'configured' | 'polling'>,
): string {
  if (!status.configured) return 'Starts once a bot token is set.';
  if (status.polling) return 'This server is reading messages sent to the bot.';
  return 'This server is not reading messages sent to the bot. Only one API instance reads at a time, so another one may be doing it; if there is no other, restart the API. Until someone reads, /start link codes go unanswered. Notifications are still sent.';
}

/** The consequence of removing the bot, in the confirm dialog. */
export function removeBotConsequence(
  status: Pick<TelegramIntegrationStatus, 'linkedUsers'>,
): string {
  const who =
    status.linkedUsers === 1
      ? 'the 1 linked user'
      : `the ${status.linkedUsers} linked users`;
  return status.linkedUsers === 0
    ? 'The stored token is deleted and Telegram notifications stop. Nobody has linked a chat yet.'
    : `The stored token is deleted and Telegram notifications stop for ${who}. Their links are kept: setting the same bot again brings them back; a different bot makes them link again.`;
}
