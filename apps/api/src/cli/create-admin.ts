import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PublicUser,
} from '@agentdock/shared';
import type { PrismaClient } from '@prisma/client';
import { isEmail } from 'class-validator';
import { hashPassword } from '../auth/password';
import { toPublicUser } from '../auth/user-mapper';

export class CreateAdminError extends Error {}

export interface CreateAdminInput {
  email: string;
  password: string;
  name?: string;
}

/**
 * Creates an active admin (spec D2). Refuses an email that already exists, so
 * running it twice changes nothing.
 */
export const createAdmin = async (
  prisma: Pick<PrismaClient, 'user'>,
  input: CreateAdminInput,
): Promise<PublicUser> => {
  const email = input.email.trim().toLowerCase();
  if (!isEmail(email)) throw new CreateAdminError('Not a valid email address');
  const { length } = input.password;
  if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH) {
    throw new CreateAdminError(
      `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    throw new CreateAdminError(`A user with email ${email} already exists`);
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name?.trim() || null,
      passwordHash: await hashPassword(input.password),
      role: 'admin',
      status: 'active',
      approvedAt: new Date(),
    },
  });
  return toPublicUser(user);
};
