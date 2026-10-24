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
  /** C-189: the password was right; the account also needs a code. */
  twoFactorRequired: 'two_factor_required',
  /** C-189: the code is wrong, expired, already used or not a recovery code. */
  twoFactorInvalid: 'two_factor_invalid',
  /** C-189: setup or enable on an account that already has two-factor sign-in. */
  twoFactorAlreadyEnabled: 'two_factor_already_enabled',
  /** C-189: a code-confirmed action on an account without two-factor sign-in. */
  twoFactorNotEnabled: 'two_factor_not_enabled',
  /** C-189: enable without a setup in progress. */
  twoFactorNoSetup: 'two_factor_no_setup',
  /** C-189: the instance requires a second factor of this admin; it cannot be turned off. */
  twoFactorRequiredByPolicy: 'two_factor_required_by_policy',
  /** C-189: an admin who must set up two-factor sign-in before anything else. */
  twoFactorSetupRequired: 'two_factor_setup_required',
  /** C-189: `APP_ENCRYPTION_KEY` is missing, so no secret can be stored or read. */
  twoFactorUnavailable: 'two_factor_unavailable',
  /** #580: Mini App `initData` that Telegram did not sign for this bot. */
  telegramInvalid: 'telegram_init_data_invalid',
  /** #580: Mini App `initData` older than the sign-in allows; reopen the app. */
  telegramExpired: 'telegram_init_data_expired',
  /** #580: no Nautelle account is linked to this Telegram user. */
  telegramNotLinked: 'telegram_not_linked',
  /** #580: no usable bot token, so no `initData` can be checked. */
  telegramNotConfigured: 'telegram_not_configured',
  /** C-367: the first-run setup token is missing, wrong or already used. */
  setupTokenInvalid: 'setup_token_invalid',
  /** C-367: a user exists, so the first-run setup is over. */
  setupDone: 'setup_done',
  /** C-367: the first admin's email or password breaks the account rules. */
  setupInvalid: 'setup_invalid',
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];

/** Body of every error the auth and admin routes return. */
export interface ApiErrorBody {
  statusCode: number;
  error: AuthErrorCode;
  message: string;
}
