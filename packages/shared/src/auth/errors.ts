export const AUTH_ERROR = {
  invalidCredentials: 'invalid_credentials',
  pendingApproval: 'pending_approval',
  registrationClosed: 'registration_closed',
  emailTaken: 'email_taken',
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  csrfFailed: 'csrf_failed',
  unsupportedMediaType: 'unsupported_media_type',
  lastAdmin: 'last_admin',
  invalidTransition: 'invalid_transition',
  notFound: 'not_found',
  /** 429: this source failed too often; `Retry-After` says when to try again. */
  throttled: 'throttled',
  /** #580: Mini App `initData` that Telegram did not sign for this bot. */
  telegramInvalid: 'telegram_init_data_invalid',
  /** #580: Mini App `initData` older than the sign-in allows; reopen the app. */
  telegramExpired: 'telegram_init_data_expired',
  /** #580: no AgentDock account is linked to this Telegram user. */
  telegramNotLinked: 'telegram_not_linked',
  /** #580: no usable bot token, so no `initData` can be checked. */
  telegramNotConfigured: 'telegram_not_configured',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];

/** Body of every error the auth and admin routes return. */
export interface ApiErrorBody {
  statusCode: number;
  error: AuthErrorCode;
  message: string;
}
