import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  createE2eApp,
  type E2eContext,
  login,
  resetDatabase,
} from '../test/e2e-app';

const PASSWORD = 'first admin passphrase';

const runCli = (email: string) =>
  spawnSync(
    process.execPath,
    [
      require.resolve('ts-node/dist/bin.js'),
      resolve(__dirname, 'admin-create.ts'),
    ],
    {
      cwd: resolve(__dirname, '../..'),
      env: { ...process.env, ADMIN_EMAIL: email, ADMIN_PASSWORD: PASSWORD },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

describe('admin:create (e2e)', () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.prisma));

  it('creates an active admin who can log in; a second run exits non-zero and changes nothing', async () => {
    const first = runCli('Root@Example.com');
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);

    const session = await login(ctx, 'root@example.com', PASSWORD);
    const me = await session.get('/auth/me');
    expect(me.body).toMatchObject({ role: 'admin', status: 'active' });
    const before = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'root@example.com' },
    });
    const created = await ctx.prisma.auditRecord.findMany({
      where: { action: 'user.create', targetId: before.id },
    });
    expect(created).toEqual([
      expect.objectContaining({
        actorType: 'system',
        targetType: 'user',
        result: 'ok',
        after: { email: 'root@example.com', role: 'admin', status: 'active' },
        meta: { via: 'cli' },
      }),
    ]);

    const second = runCli('root@example.com');
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('already exists');

    const after = await ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'root@example.com' },
    });
    expect(after).toEqual(before);
    expect(await ctx.prisma.user.count()).toBe(1);
  }, 150_000); // two cold ts-node runs of the real script
});
