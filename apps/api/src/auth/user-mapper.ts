import type { AdminUser, PublicUser } from '@agentdock/shared';
import type { User } from '@prisma/client';

// Explicit field lists: a new column (or passwordHash) never leaks by default.
export const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  status: user.status,
});

export const toAdminUser = (user: User): AdminUser => ({
  ...toPublicUser(user),
  approvedById: user.approvedById,
  approvedAt: user.approvedAt?.toISOString() ?? null,
  createdAt: user.createdAt.toISOString(),
});
