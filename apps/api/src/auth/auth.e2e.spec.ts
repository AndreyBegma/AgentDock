import {
  AUTH_ERROR,
  CSRF_COOKIE,
  REGISTRATION_SETTING_KEY,
  SESSION_COOKIE,
} from '@agentdock/shared';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  nextIp,
  PASSWORD,
  resetDatabase,
  setCookies,
} from '../test/e2e-app';
import { hashToken } from './tokens';

describe('auth (e2e)', () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.prisma));

  const openRegistration = () =>
    ctx.prisma.setting.create({
      data: { key: REGISTRATION_SETTING_KEY, value: true },
    });
  const register = (email: string, ip = nextIp()) =>
    ctx
      .http()
      .post('/auth/register')
      .set('X-Forwarded-For', ip)
      .send({ email, password: PASSWORD, name: 'New Person' });
  const attempt = (email: string, password: string, ip = nextIp()) =>
    ctx
      .http()
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password });

  describe('registration', () => {
    it('is closed on a fresh database: 403 registration_closed', async () => {
      const state = await ctx.http().get('/auth/registration');
      expect(state.body).toEqual({ open: false });

      const response = await register('new@example.com');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe(AUTH_ERROR.registrationClosed);
      expect(await ctx.prisma.user.count()).toBe(0);
    });

    it('when open creates a pending user who cannot log in yet', async () => {
      await openRegistration();

      const response = await register('  New@Example.com ');
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ status: 'pending' });

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'new@example.com' },
      });
      expect(user.status).toBe('pending');

      const loginResponse = await attempt('new@example.com', PASSWORD);
      expect(loginResponse.status).toBe(403);
      expect(loginResponse.body.error).toBe(AUTH_ERROR.pendingApproval);
      expect(setCookies(loginResponse)).toEqual([]);
    });

    it('refuses a taken email with 409 email_taken', async () => {
      await openRegistration();
      await createUser(ctx.prisma, 'taken@example.com', 'viewer');

      const response = await register('taken@example.com');

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(AUTH_ERROR.emailTaken);
    });

    it('rejects a password shorter than 12 characters', async () => {
      await openRegistration();
      const response = await ctx
        .http()
        .post('/auth/register')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'a@example.com', password: 'short' });
      expect(response.status).toBe(400);
    });
  });

  describe('login', () => {
    it('sets an httpOnly SameSite=Lax session cookie and a readable CSRF cookie', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');

      const response = await attempt('op@example.com', PASSWORD);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: expect.any(String),
        email: 'op@example.com',
        name: null,
        role: 'operator',
        status: 'active',
      });
      const cookies = setCookies(response);
      const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Lax/i);
      expect(session).not.toMatch(/Secure/i);
      expect(csrf).not.toMatch(/HttpOnly/i);

      const token = session?.split(';')[0].split('=')[1] ?? '';
      const stored = await ctx.prisma.userSession.findFirstOrThrow();
      expect(stored.tokenHash).toBe(hashToken(token));
      expect(stored.tokenHash).not.toBe(token);
    });

    it('marks cookies Secure when APP_ENV=production', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      process.env.APP_ENV = 'production';
      try {
        const response = await attempt('op@example.com', PASSWORD);
        for (const cookie of setCookies(response)) {
          expect(cookie).toMatch(/; Secure/i);
        }
      } finally {
        process.env.APP_ENV = 'test';
      }
    });

    it('answers a wrong email and a wrong password identically', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');

      const wrongEmail = await attempt('nobody@example.com', PASSWORD);
      const wrongPassword = await attempt('op@example.com', 'wrong password!!');

      expect(wrongEmail.status).toBe(401);
      expect(wrongPassword.status).toBe(wrongEmail.status);
      expect(wrongPassword.body).toEqual(wrongEmail.body);
      expect(wrongEmail.body.error).toBe(AUTH_ERROR.invalidCredentials);
    });

    it.each([
      'rejected',
      'disabled',
    ] as const)('answers a correct password on a %s account like a wrong one', async (status) => {
      await createUser(ctx.prisma, 'x@example.com', 'viewer', status);
      const response = await attempt('x@example.com', PASSWORD);
      expect(response.status).toBe(401);
      expect(response.body.error).toBe(AUTH_ERROR.invalidCredentials);
    });

    it('locks the account for 15 minutes after 10 failures; the correct password then fails', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');

      for (let i = 0; i < 10; i += 1) {
        const failed = await attempt('op@example.com', 'wrong password!!');
        expect(failed.status).toBe(401);
      }
      const locked = await attempt('op@example.com', PASSWORD);
      expect(locked.status).toBe(401);
      expect(locked.body.error).toBe(AUTH_ERROR.invalidCredentials);

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'op@example.com' },
      });
      const minutes =
        ((user.lockedUntil?.getTime() ?? 0) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);

      // Once the lock has run out, the right password works again.
      await ctx.prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      expect((await attempt('op@example.com', PASSWORD)).status).toBe(200);
    });

    it('throttles more than 10 login requests a minute from one IP with 429', async () => {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push(
          (await attempt('a@example.com', 'whatever!!', ip)).status,
        );
      }
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
      expect(statuses[10]).toBe(429);
      // Another address is unaffected.
      expect((await attempt('a@example.com', 'whatever!!')).status).toBe(401);
    });

    it('throttles registration the same way', async () => {
      const ip = nextIp();
      let last = 0;
      for (let i = 0; i < 11; i += 1) {
        last = (await register(`r${i}@example.com`, ip)).status;
      }
      expect(last).toBe(429);
    });

    it('refuses a non-JSON body with 415', async () => {
      const response = await ctx
        .http()
        .post('/auth/login')
        .set('X-Forwarded-For', nextIp())
        .type('form')
        .send(`email=a@example.com&password=${PASSWORD}`);
      expect(response.status).toBe(415);
    });
  });

  describe('session routes', () => {
    it('/auth/me returns the caller', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');

      const me = await session.get('/auth/me');

      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        email: 'op@example.com',
        role: 'operator',
      });
    });

    it('enforces CSRF on non-GET requests', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');

      const missing = await session.sendWithoutCsrf('post', '/auth/logout');
      expect(missing.status).toBe(403);
      expect(missing.body.error).toBe(AUTH_ERROR.csrfFailed);

      const mismatched = await ctx
        .http()
        .post('/auth/logout')
        .set(
          'Cookie',
          `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=forged`,
        )
        .set('X-CSRF-Token', 'forged');
      expect(mismatched.status).toBe(403);

      expect((await session.get('/auth/me')).status).toBe(200);
      expect((await session.send('post', '/auth/logout')).status).toBe(204);
    });

    it('logout ends the session', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');

      await session.send('post', '/auth/logout');

      expect((await session.get('/auth/me')).status).toBe(401);
      expect(await ctx.prisma.userSession.count()).toBe(0);
    });

    it('lists and revokes only the caller’s own sessions', async () => {
      await createUser(ctx.prisma, 'a@example.com', 'operator');
      await createUser(ctx.prisma, 'b@example.com', 'viewer');
      const a1 = await login(ctx, 'a@example.com');
      const a2 = await login(ctx, 'a@example.com');
      const b = await login(ctx, 'b@example.com');

      const list = await a1.get('/auth/sessions');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
      expect(
        list.body.filter((s: { current: boolean }) => s.current),
      ).toHaveLength(1);

      const bSession = await ctx.prisma.userSession.findFirstOrThrow({
        where: { user: { email: 'b@example.com' } },
      });
      const foreign = await a1.send('delete', `/auth/sessions/${bSession.id}`);
      expect(foreign.status).toBe(404);
      expect((await b.get('/auth/me')).status).toBe(200);

      const a2Id = list.body.find((s: { current: boolean }) => !s.current).id;
      expect((await a1.send('delete', `/auth/sessions/${a2Id}`)).status).toBe(
        204,
      );
      expect((await a2.get('/auth/me')).status).toBe(401);
      expect((await a1.get('/auth/me')).status).toBe(200);
    });

    it('a password change keeps the current session and ends the others', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const current = await login(ctx, 'op@example.com');
      const other = await login(ctx, 'op@example.com');
      const newPassword = 'another long passphrase';

      const wrong = await current.send('patch', '/auth/me/password', {
        currentPassword: 'not my password',
        newPassword,
      });
      expect(wrong.status).toBe(403);

      const changed = await current.send('patch', '/auth/me/password', {
        currentPassword: PASSWORD,
        newPassword,
      });
      expect(changed.status).toBe(204);
      expect((await current.get('/auth/me')).status).toBe(200);
      expect((await other.get('/auth/me')).status).toBe(401);
      expect((await attempt('op@example.com', PASSWORD)).status).toBe(401);
      expect((await attempt('op@example.com', newPassword)).status).toBe(200);
    });

    it('drops a session that is past its idle or absolute expiry', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const idle = await login(ctx, 'op@example.com');
      const old = await login(ctx, 'op@example.com');
      const day = 24 * 60 * 60_000;
      await ctx.prisma.userSession.update({
        where: { tokenHash: hashToken(idle.token) },
        data: { lastSeenAt: new Date(Date.now() - 7 * day - 1000) },
      });
      await ctx.prisma.userSession.update({
        where: { tokenHash: hashToken(old.token) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      expect((await idle.get('/auth/me')).status).toBe(401);
      expect((await old.get('/auth/me')).status).toBe(401);
      expect(await ctx.prisma.userSession.count()).toBe(0);
    });
  });

  it('never puts a password, hash or token in a response body or log line', async () => {
    const output: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      output.push(chunk.toString());
      return true;
    };
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
    const bodies: string[] = [];
    try {
      await openRegistration();
      const admin = await createUser(ctx.prisma, 'admin@example.com', 'admin');
      bodies.push((await register('new@example.com')).text);
      bodies.push((await attempt('new@example.com', PASSWORD)).text);
      bodies.push(
        (await attempt('admin@example.com', 'wrong password!!')).text,
      );
      const session = await login(ctx, 'admin@example.com');
      bodies.push((await session.get('/auth/me')).text);
      bodies.push((await session.get('/auth/sessions')).text);
      bodies.push((await session.get('/admin/users')).text);

      const secrets = [
        PASSWORD,
        admin.passwordHash,
        session.token,
        hashToken(session.token),
        '$argon2',
      ];
      for (const text of [...bodies, ...output]) {
        for (const secret of secrets) expect(text).not.toContain(secret);
        expect(text).not.toMatch(/passwordHash|tokenHash/);
      }
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
