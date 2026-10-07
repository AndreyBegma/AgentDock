import type { Role, UserStatus } from './roles';

export const SESSION_COOKIE = 'ad_session';
export const CSRF_COOKIE = 'ad_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const REGISTRATION_SETTING_KEY = 'registration.open';

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
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

export interface ApproveUserRequest {
  role: Role;
}

export interface UpdateUserRequest {
  role?: Role;
  status?: Extract<UserStatus, 'active' | 'disabled'>;
}
