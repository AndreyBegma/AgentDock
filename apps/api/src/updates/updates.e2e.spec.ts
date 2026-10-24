import { APP_VERSION, type ProductUpdateView } from '@nautelle/shared';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { LATEST_RELEASE_SETTING_KEY } from './product-release.service';

/** C-374: `GET /admin/updates` — the stored daily check, for admins only. */
describe('/admin/updates (e2e)', () => {
  let ctx: E2eContext;
  let admin: Session;
  let operator: Session;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await createUser(ctx.prisma, 'ann@example.com', 'admin');
    await createUser(ctx.prisma, 'bob@example.com', 'operator');
    admin = await login(ctx, 'ann@example.com');
    operator = await login(ctx, 'bob@example.com');
  });

  it('shows the running version before the first check, without asking GitHub', async () => {
    const response = await admin.get('/admin/updates');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      current: APP_VERSION,
      latest: null,
      available: false,
      checkEnabled: true,
      checkedAt: null,
    });
    expect(
      await ctx.prisma.setting.count({
        where: { key: LATEST_RELEASE_SETTING_KEY },
      }),
    ).toBe(0);
  });

  it('offers the stored newer release', async () => {
    const latest = {
      version: '999.0.0',
      url: 'https://github.com/AndreyBegma/Nautelle/releases/tag/v999.0.0',
    };
    await ctx.prisma.setting.create({
      data: {
        key: LATEST_RELEASE_SETTING_KEY,
        value: { checkedAt: '2026-10-24T10:00:00.000Z', latest },
      },
    });
    const response = await admin.get('/admin/updates');
    expect(response.body as ProductUpdateView).toEqual({
      current: APP_VERSION,
      latest,
      available: true,
      checkEnabled: true,
      checkedAt: '2026-10-24T10:00:00.000Z',
    });
  });

  it('is for admins only', async () => {
    expect((await operator.get('/admin/updates')).status).toBe(403);
    expect((await ctx.http().get('/admin/updates')).status).toBe(401);
  });
});
