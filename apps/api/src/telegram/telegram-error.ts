import type { HttpException } from '@nestjs/common';
import { notificationError } from '../notifications';
import type { TelegramApiError } from './telegram-client';

/** Linking or a test message needs a configured, readable bot. */
export const telegramNotConfigured = (): HttpException =>
  notificationError(
    409,
    'telegram_not_configured',
    'The Telegram bot is not configured',
  );

/** The test message goes only to the caller's own linked chat. */
export const telegramNotLinked = (): HttpException =>
  notificationError(
    409,
    'telegram_not_linked',
    'Link your Telegram account first',
  );

/** `getMe` refused the token. */
export const telegramTokenInvalid = (): HttpException =>
  notificationError(
    400,
    'telegram_token_invalid',
    'Telegram rejected this bot token',
  );

/** Telegram could not be reached or failed; the message is already redacted. */
export const telegramUnavailable = (error: TelegramApiError): HttpException =>
  notificationError(
    502,
    'telegram_unavailable',
    `Telegram API call failed: ${error.message}`,
  );
