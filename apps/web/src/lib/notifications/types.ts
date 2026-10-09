/**
 * Telegram-side responses of the notifications API. They mirror the contracts
 * i22-telegram adds to `packages/shared` (`TelegramLinkStatus`,
 * `TelegramLinkCode`, `TelegramIntegrationStatus`); until that slot merges they
 * are declared here, and this file can then re-export them.
 */

/** `GET /notifications/telegram/link` — the caller's own link, always 200. */
export interface TelegramLinkState {
  linked: boolean;
  username: string | null;
  linkedAt: string | null;
  /** An admin has configured the bot, so linking can work. */
  botConfigured: boolean;
}

/** `POST /notifications/telegram/link`. */
export interface TelegramLinkStart {
  url: string;
  expiresAt: string;
}

/** `GET|PUT|DELETE /admin/integrations/telegram`. The token is never returned. */
export interface TelegramAdminStatus {
  configured: boolean;
  botUsername: string | null;
  /** `APP_ENCRYPTION_KEY` is set and usable. */
  encryptionAvailable: boolean;
  polling: boolean;
  lastError: string | null;
  lastPollAt: string | null;
  linkedUsers: number;
  /** `PUT` only: links dropped because the token belongs to another bot. */
  unlinkedUsers?: number;
}

/** `PUT /admin/integrations/telegram`. */
export interface TelegramBotTokenUpdate {
  token: string;
}
