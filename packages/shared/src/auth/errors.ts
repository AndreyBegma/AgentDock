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
} as const;
export type AuthErrorCode = (typeof AUTH_ERROR)[keyof typeof AUTH_ERROR];

/** Body of every error the auth and admin routes return. */
export interface ApiErrorBody {
  statusCode: number;
  error: AuthErrorCode;
  message: string;
}
