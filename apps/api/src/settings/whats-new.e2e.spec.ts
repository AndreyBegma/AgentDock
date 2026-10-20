import { APP_VERSION, type WhatsNewView } from '@agentdock/shared';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';

/** C-294: `GET /me/whats-new` and `POST /me/whats-new/seen` — per person, stored server-side. */
describe('/me/whats-new (e2e)', () => {
  let ctx: E2eContext;
  let ann: Session;
  let bob: Session;
  let annId: string;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    annId = (await createUser(ctx.prisma, 'ann@example.com', 'operator')).id;
    await createUser(ctx.prisma, 'bob@example.com', 'viewer');
    ann = await login(ctx, 'ann@example.com');
    bob = await login(ctx, 'bob@example.com');
  });

  const whatsNewOf = async (session: Session) => {
    const response = await session.get('/me/whats-new');
    expect(response.status).toBe(200);
    return response.body as WhatsNewView;
  };

  it('is unread for a person who never opened it', async () => {
    expect(await whatsNewOf(ann)).toEqual({
      version: APP_VERSION,
      seenVersion: null,
      unread: true,
    });
    expect(await ctx.prisma.userSettings.count()).toBe(0);
  });

  it('clears for the caller alone once seen, and keeps the planning model', async () => {
    await ann.send('put', '/me/settings', { planningModel: 'opus' });

    const seen = await ann.send('post', '/me/whats-new/seen');
    expect(seen.status).toBe(200);
    expect(seen.body).toEqual({
      version: APP_VERSION,
      seenVersion: APP_VERSION,
      unread: false,
    });
    expect((await whatsNewOf(ann)).unread).toBe(false);
    expect((await whatsNewOf(bob)).unread).toBe(true);
    expect(
      await ctx.prisma.userSettings.findUniqueOrThrow({
        where: { userId: annId },
        select: { planningModel: true, seenVersion: true },
      }),
    ).toEqual({ planningModel: 'opus', seenVersion: APP_VERSION });

    // Seen twice is still seen.
    expect((await ann.send('post', '/me/whats-new/seen')).status).toBe(200);
    expect((await whatsNewOf(ann)).unread).toBe(false);
  });

  it('shows the dot again when an older version was seen', async () => {
    await ctx.prisma.userSettings.create({
      data: { userId: annId, seenVersion: '0.0.1' },
    });
    expect(await whatsNewOf(ann)).toEqual({
      version: APP_VERSION,
      seenVersion: '0.0.1',
      unread: true,
    });
  });

  it('records the API’s own version, never one the client names', async () => {
    const response = await ann.send('post', '/me/whats-new/seen', {
      version: '99.0.0',
    });
    expect(response.status).toBe(200);
    expect((response.body as WhatsNewView).seenVersion).toBe(APP_VERSION);
    expect(
      (
        await ctx.prisma.userSettings.findUniqueOrThrow({
          where: { userId: annId },
        })
      ).seenVersion,
    ).toBe(APP_VERSION);
  });

  it('needs a session', async () => {
    expect((await ctx.http().get('/me/whats-new')).status).toBe(401);
    expect((await ctx.http().post('/me/whats-new/seen')).status).toBe(401);
  });
});
