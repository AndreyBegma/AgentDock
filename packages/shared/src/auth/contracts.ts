import type { Role, UserStatus } from './roles';

export const SESSION_COOKIE = 'ad_session';
export const CSRF_COOKIE = 'ad_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const REGISTRATION_SETTING_KEY = 'registration.open';

/** C-189: whether every admin must sign in with a second factor. Missing: no. */
export const TWO_FACTOR_ADMIN_SETTING_KEY =
  'auth.two_factor.required_for_admins';

/** C-189: digits of a TOTP code (RFC 6238 defaults: SHA-1, 30-second steps). */
export const TOTP_DIGITS = 6;

/** C-189: how many recovery codes an enrolment or a regeneration issues. */
export const RECOVERY_CODE_COUNT = 10;

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  /** C-189: signing in asks for a code from an authenticator app. */
  twoFactorEnabled: boolean;
}

/** `GET /auth/me`: the caller, plus what the instance still asks of them. */
export interface CurrentUserResponse extends PublicUser {
  /**
   * C-189: the instance requires two-factor sign-in for admins and this admin
   * has not set it up; every route outside `/auth` answers 403
   * `two_factor_setup_required` until they do.
   */
  twoFactorSetupRequired: boolean;
}

export interface AdminUser extends PublicUser {
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

export interface RegisterResponse {
  status: 'pending';
}

export interface LoginRequest {
  email: string;
  password: string;
  /**
   * C-189: a code from the authenticator app, or an unused recovery code.
   * Without it an enrolled account answers 401 `two_factor_required`.
   */
  code?: string;
}

/** C-189: `GET /auth/me/two-factor`. */
export interface TwoFactorStatus {
  enabled: boolean;
  /** The instance requires a second factor of this account (an admin's). */
  required: boolean;
  /** Unused recovery codes; 0 while two-factor sign-in is off. */
  recoveryCodesLeft: number;
}

/** C-189: `POST /auth/me/two-factor/setup` — the password proves it is the owner. */
export interface TwoFactorSetupRequest {
  password: string;
}

/**
 * C-189: a fresh secret, not in force until `enable` confirms a code from it.
 * `otpauthUrl` is what the QR code carries; `secret` (base32) is typed by hand.
 */
export interface TwoFactorSetupResponse {
  secret: string;
  otpauthUrl: string;
}

/** C-189: `POST /auth/me/two-factor/enable` — a code from the new secret. */
export interface TwoFactorEnableRequest {
  code: string;
}

/** C-189: shown once; only their hashes are stored. */
export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

/**
 * C-189: `POST /auth/me/two-factor/disable` and `…/recovery-codes`: the
 * password and a current code (or an unused recovery code).
 */
export interface TwoFactorConfirmRequest {
  password: string;
  code: string;
}

/** C-189: `GET`/`PUT /admin/settings/two-factor`. */
export interface TwoFactorPolicy {
  requiredForAdmins: boolean;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface RegistrationState {
  open: boolean;
}

/** C-367: `GET /setup/status` — true while the instance has no user at all. */
export interface SetupStatus {
  needsSetup: boolean;
}

/**
 * C-367: `POST /setup/admin` — the first admin. `token` is the one-time setup
 * token the API logs on boot (`Open <WEB_URL>/setup?token=…`).
 */
export interface SetupAdminRequest {
  token: string;
  email: string;
  password: string;
  name?: string;
}

export interface ApproveUserRequest {
  role: Role;
}

export interface UpdateUserRequest {
  role?: Role;
  status?: Extract<UserStatus, 'active' | 'disabled'>;
}
