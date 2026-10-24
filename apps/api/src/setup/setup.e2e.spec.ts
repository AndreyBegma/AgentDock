import { AUTH_ERROR, CSRF_COOKIE, SESSION_COOKIE } from '@nautelle/shared';
import { Logger } from '@nestjs/common';
import { hashToken } from '../auth/tokens';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  nextIp,
  PASSWORD,
  resetDatabase,
  setCookies,
} from '../test/e2e-app';
import { SetupService } from './setup.service';

describe('setup (e2e)', () => {
  let ctx: E2eContext;
  let setup: SetupService;

  beforeAll(async () => {
    ctx = await createE2eApp();
    setup = ctx.app.get(SetupService);
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.prisma));

  const status = () => ctx.http().get('/setup/status');
  const post = (body: object) =>
    ctx.http().post('/setup/admin').set('X-Forwarded-For', nextIp()).send(body);
  const admin = (token?: string) => ({
    token,
    email: ' Owner@Example.com ',
    password: PASSWORD,
    name: 'Owner',
  });

  it('needs setup on an empty database', async () => {
    const response = await status();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ needsSetup: true });
  });

  it('refuses a missing or wrong token with 403 and creates nobody', async () => {
    setup.issueToken();

    const missing = await post(admin());
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe(AUTH_ERROR.setupTokenInvalid);

    const wrong = await post(admin('not-the-token'));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe(AUTH_ERROR.setupTokenInvalid);

    expect(await ctx.prisma.user.count()).toBe(0);
  });

  it('refuses a token that a newer one replaced', async () => {
    const old = setup.issueToken();
    setup.issueToken();

    const response = await post(admin(old));
    expect(response.status).toBe(403);
  });

  it('creates the admin and a session once, then 409 and no setup', async () => {
    const token = setup.issueToken();

    const first = await post(admin(token));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      email: 'owner@example.com',
      name: 'Owner',
      role: 'admin',
      status: 'active',
    });

    const cookies = setCookies(first);
    const sessionCookie = cookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    expect(sessionCookie).toBeDefined();
    expect(cookies.some((c) => c.startsWith(`${CSRF_COOKIE}=`))).toBe(true);
    const sessionToken = sessionCookie?.split(';')[0].split('=')[1] ?? '';
    const stored = await ctx.prisma.userSession.findUniqueOrThrow({
      where: { tokenHash: hashToken(sessionToken) },
    });
    expect(stored.userId).toBe(first.body.id);

    const me = await ctx
      .http()
      .get('/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${sessionToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('owner@example.com');

    const second = await post({ ...admin(token), email: 'other@example.com' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe(AUTH_ERROR.setupDone);
    expect(await ctx.prisma.user.count()).toBe(1);

    expect((await status()).body).toEqual({ needsSetup: false });
  });

  it('lets only one of two concurrent posts win', async () => {
    const token = setup.issueToken();

    const results = await Promise.all([
      post({ ...admin(token), email: 'a@example.com' }),
      post({ ...admin(token), email: 'b@example.com' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await ctx.prisma.user.count()).toBe(1);
  });

  it('answers 409 once any user exists, token or not', async () => {
    const token = setup.issueToken();
    await createUser(ctx.prisma, 'someone@example.com', 'viewer');

    expect((await status()).body).toEqual({ needsSetup: false });
    expect((await post(admin(token))).status).toBe(409);
    expect((await post(admin())).status).toBe(409);
  });

  it('applies the account rules of createAdmin', async () => {
    const token = setup.issueToken();

    const short = await post({ ...admin(token), password: 'short' });
    expect(short.status).toBe(400);
    const email = await post({ ...admin(token), email: 'not-an-email' });
    expect(email.status).toBe(400);

    expect(await ctx.prisma.user.count()).toBe(0);
  });

  describe('on boot', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      jest.spyOn(Logger.prototype, 'log').mockImplementation();
      jest.spyOn(Logger.prototype, 'error').mockImplementation();
    });
    afterEach(() => jest.restoreAllMocks());

    it('logs a setup link whose token works', async () => {
      await setup.prepare({ WEB_URL: 'https://nautelle.example/' });

      const line = String(warn.mock.calls[0]?.[0]);
      const match =
        /Open https:\/\/nautelle\.example\/setup\?token=(\S+) /.exec(line);
      expect(match).not.toBeNull();
      expect((await post(admin(match?.[1]))).status).toBe(201);
    });

    it('creates the admin from ADMIN_EMAIL / ADMIN_PASSWORD', async () => {
      await setup.prepare({
        ADMIN_EMAIL: 'env@example.com',
        ADMIN_PASSWORD: PASSWORD,
      });

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'env@example.com' },
      });
      expect(user.role).toBe('admin');
      expect(warn).not.toHaveBeenCalled();
    });

    it('falls back to the link when the env admin is invalid', async () => {
      await setup.prepare({
        ADMIN_EMAIL: 'x@example.com',
        ADMIN_PASSWORD: 'x',
      });

      expect(await ctx.prisma.user.count()).toBe(0);
      expect(String(warn.mock.calls[0]?.[0])).toContain('/setup?token=');
    });

    it('does nothing once a user exists', async () => {
      await createUser(ctx.prisma, 'someone@example.com', 'viewer');
      await setup.prepare({});
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
