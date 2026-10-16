import type { UserSettingsView } from '@agentdock/shared';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';

/** #337 D9: `GET/PUT /me/settings` — the caller's own row, nobody else's. */
describe('/me/settings (e2e)', () => {
  let ctx: E2eContext;
  let ann: Session;
  let bob: Session;
  let annId: string;
  let bobId: string;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    annId = (await createUser(ctx.prisma, 'ann@example.com', 'operator')).id;
    bobId = (await createUser(ctx.prisma, 'bob@example.com', 'viewer')).id;
    ann = await login(ctx, 'ann@example.com');
    bob = await login(ctx, 'bob@example.com');
  });

  const settingsOf = async (session: Session) => {
    const response = await session.get('/me/settings');
    expect(response.status).toBe(200);
    return response.body as UserSettingsView;
  };

  it('answers the default, sonnet, for a person without a row', async () => {
    expect(await settingsOf(ann)).toEqual({ planningModel: 'sonnet' });
    expect(await ctx.prisma.userSettings.count()).toBe(0);
  });

  it('writes only the caller’s row, and null clears it back to the default', async () => {
    const put = await ann.send('put', '/me/settings', {
      planningModel: 'opus',
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ planningModel: 'opus' });
    expect(await settingsOf(ann)).toEqual({ planningModel: 'opus' });
    // Bob, any role, keeps his own default.
    expect(await settingsOf(bob)).toEqual({ planningModel: 'sonnet' });
    expect(
      await ctx.prisma.userSettings.findMany({ select: { userId: true } }),
    ).toEqual([{ userId: annId }]);

    await bob.send('put', '/me/settings', { planningModel: 'fable' });
    expect(await settingsOf(ann)).toEqual({ planningModel: 'opus' });
    expect(await settingsOf(bob)).toEqual({ planningModel: 'fable' });
    expect(
      (
        await ctx.prisma.userSettings.findUniqueOrThrow({
          where: { userId: bobId },
        })
      ).planningModel,
    ).toBe('fable');

    const cleared = await ann.send('put', '/me/settings', {
      planningModel: null,
    });
    expect(cleared.body).toEqual({ planningModel: 'sonnet' });
  });

  it('refuses a model outside the catalog, a missing field, and extra fields', async () => {
    for (const body of [
      { planningModel: 'gpt-5' },
      { planningModel: '--dangerously-skip-permissions' },
      {},
      { planningModel: 'opus', userId: bobId },
    ]) {
      const response = await ann.send('put', '/me/settings', body);
      expect(response.status).toBe(400);
    }
    expect(await ctx.prisma.userSettings.count()).toBe(0);
  });

  it('needs a session', async () => {
    expect((await ctx.http().get('/me/settings')).status).toBe(401);
  });
});
