export const ROLES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = [
  'pending',
  'active',
  'rejected',
  'disabled',
] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
