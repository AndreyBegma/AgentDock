import type { PrismaClient, User } from '@prisma/client';
import { CreateAdminError, createAdmin } from './create-admin';

type UserDelegate = Pick<PrismaClient, 'user'>;

const fakePrisma = (existing: User | null) => {
  const create = jest.fn(async ({ data }: { data: Partial<User> }) => ({
    id: 'u1',
    name: null,
    ...data,
  }));
  const prisma = {
    user: { findUnique: jest.fn(async () => existing), create },
  } as unknown as UserDelegate;
  return { prisma, create };
};

describe('createAdmin', () => {
  it('creates an active admin with a hashed password and a normalised email', async () => {
    const { prisma, create } = fakePrisma(null);

    const admin = await createAdmin(prisma, {
      email: '  Root@Example.COM ',
      password: 'correct horse battery',
    });

    expect(admin).toMatchObject({
      email: 'root@example.com',
      role: 'admin',
      status: 'active',
    });
    const data = create.mock.calls[0][0].data;
    expect(data.passwordHash).toMatch(/^\$argon2id\$/);
    expect(data.passwordHash).not.toContain('correct horse');
    expect(admin).not.toHaveProperty('passwordHash');
  });

  it('refuses an email that already exists and creates nothing', async () => {
    const { prisma, create } = fakePrisma({ id: 'x' } as User);

    await expect(
      createAdmin(prisma, {
        email: 'root@example.com',
        password: 'correct horse battery',
      }),
    ).rejects.toBeInstanceOf(CreateAdminError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['short password', 'root@example.com', 'short'],
    ['invalid email', 'not-an-email', 'correct horse battery'],
  ])('rejects a %s', async (_case, email, password) => {
    const { prisma, create } = fakePrisma(null);

    await expect(createAdmin(prisma, { email, password })).rejects.toThrow(
      CreateAdminError,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
