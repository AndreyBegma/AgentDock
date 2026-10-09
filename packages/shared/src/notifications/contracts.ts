import type {
  ChannelSwitches,
  NotificationChannel,
  NotificationKind,
} from './kinds';

/**
 * HTTP and live contracts of in-app notifications
 * (docs/specs/22-notifications-and-telegram.md "API", D11).
 */

/** One stored notification, as its owner sees it. Ids are decimal strings. */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  projectId: string | null;
  /** The project's display name; null for a runner kind. */
  projectName: string | null;
  runnerId: string | null;
  slot: string | null;
  issue: number | null;
  title: string;
  body: string;
  /** Path in the web app, e.g. `/projects/<id>/fleet`. */
  link: string | null;
  /** Events folded into this one (D6). */
  count: number;
  firstAt: string;
  lastAt: string;
  readAt: string | null;
  /** The project was muted when it arrived: shown, never counted as unread (D3). */
  muted: boolean;
}

/** `GET /notifications` — newest `lastAt` first. */
export interface NotificationPage {
  items: NotificationView[];
  /** Unread and not muted, across all of the caller's notifications. */
  unreadCount: number;
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

export const NOTIFICATION_PAGE_DEFAULT = 20;
export const NOTIFICATION_PAGE_MAX = 100;

/** `POST /notifications/:id/read` and `/read-all`. */
export interface NotificationReadResult {
  unreadCount: number;
}

/** One row of `GET /notifications/rules`: every kind, defaults filled in. */
export interface NotificationRuleView extends ChannelSwitches {
  kind: NotificationKind;
  /** Channels the kind can be turned on for. */
  channels: NotificationChannel[];
  /** No stored row: these are the D1 defaults. */
  isDefault: boolean;
}

export interface NotificationRulesView {
  rules: NotificationRuleView[];
}

/** `PUT /notifications/rules` — the rules to store; kinds left out keep theirs. */
export interface NotificationRulesUpdate {
  rules: (ChannelSwitches & { kind: NotificationKind })[];
}

/** A project mute (D3). `until` null: until removed. */
export interface NotificationMuteView {
  projectId: string;
  projectName: string;
  until: string | null;
  createdAt: string;
}

/** `GET /notifications/mutes/:projectId` — `mute` null: not muted. */
export interface NotificationMuteState {
  projectId: string;
  mute: NotificationMuteView | null;
}

/** `PUT /notifications/mutes/:projectId`. */
export interface NotificationMuteUpdate {
  until?: string | null;
}

/** Live events on `user:<id>` (D11). */
export const NOTIFICATION_NEW_EVENT = 'notification.new';
/** Another tab marked something read — keeps every bell in step. */
export const NOTIFICATION_READ_EVENT = 'notification.read';

/** `notification.new` — a new notification, or one an event was folded into. */
export interface NotificationNewLive {
  notification: NotificationView;
  unreadCount: number;
}

/** `notification.read` — `ids` null: all of them. */
export interface NotificationReadLive {
  ids: string[] | null;
  unreadCount: number;
}

/** Telegram delivery states (spec 22 "Data / Schema"). */
export const NOTIFICATION_DELIVERY_STATUSES = [
  'pending',
  'sent',
  'digested',
  'failed',
  'skipped',
] as const;
export type NotificationDeliveryStatus =
  (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/**
 * Why a Telegram delivery was `skipped` — stored in `lastError`. A user with
 * no linked chat gets no delivery row at all.
 */
export const DELIVERY_SKIP_REASONS = ['muted', 'rule_off', 'unlinked'] as const;
export type DeliverySkipReason = (typeof DELIVERY_SKIP_REASONS)[number];

export const NOTIFICATION_ERROR_CODES = [
  'notification_not_found',
  'project_not_found',
  'invalid_rule',
  'invalid_cursor',
  'encryption_key_missing',
  'telegram_not_configured',
  'telegram_not_linked',
  'telegram_token_invalid',
  'telegram_unavailable',
] as const;
export type NotificationErrorCode = (typeof NOTIFICATION_ERROR_CODES)[number];

export interface NotificationErrorBody {
  statusCode: number;
  error: NotificationErrorCode;
  message: string;
}

/** `GET /notifications/telegram/link` — the caller's own link (D9). */
export interface TelegramLinkStatus {
  linked: boolean;
  /** The Telegram username of the linked chat, when it has one. */
  username: string | null;
  linkedAt: string | null;
  /** An admin has configured the bot: linking is possible. */
  botConfigured: boolean;
}

/** `POST /notifications/telegram/link` — open `url` in Telegram within 10 minutes. */
export interface TelegramLinkCode {
  /** `https://t.me/<bot>?start=<one-time code>`. */
  url: string;
  expiresAt: string;
}

/** `GET|PUT|DELETE /admin/integrations/telegram` (D8). The token is never returned. */
export interface TelegramIntegrationStatus {
  configured: boolean;
  botUsername: string | null;
  /** `APP_ENCRYPTION_KEY` is set and usable; without it the bot cannot be configured. */
  encryptionAvailable: boolean;
  /** This API instance holds the poller lock and its loop is running. */
  polling: boolean;
  /** The poller's last error, redacted; null after a good poll. */
  lastError: string | null;
  lastPollAt: string | null;
  linkedUsers: number;
  /**
   * `PUT` only: links removed because the token belongs to a different bot
   * than before — those users must link again. 0 on a token rotation.
   */
  unlinkedUsers?: number;
}

/** `PUT /admin/integrations/telegram` — verified with `getMe` before it is stored. */
export interface TelegramBotTokenUpdate {
  token: string;
}
