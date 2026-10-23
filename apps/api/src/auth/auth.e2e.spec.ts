import {
  AUTH_ERROR,
  CSRF_COOKIE,
  REGISTRATION_SETTING_KEY,
  SESSION_COOKIE,
} from '@nautelle/shared';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AuditService } from '../audit/audit.service';
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

    it('answers a taken email like a new one and creates no user', async () => {
      await openRegistration();
      await createUser(ctx.prisma, 'taken@example.com', 'viewer');
      const before = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'taken@example.com' },
      });

      const response = await register('taken@example.com');

      expect(response.status).toBe(201);
      expect(response.body).toEqual({ status: 'pending' });
      expect(await ctx.prisma.user.count()).toBe(1);
      const after = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'taken@example.com' },
      });
      expect(after).toEqual(before);
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
        twoFactorEnabled: false,
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

    describe('throttling failed passwords per (account, IP) (C-109)', () => {
      const WRONG = 'wrong password!!';

      // These tests send far more than 10 requests a minute from one
      // address; the per-IP request limit is lifted so the per-(account, IP)
      // wait is what answers. Its own tests are below.
      let requestLimit: jest.SpyInstance | undefined;
      beforeEach(() => {
        requestLimit = jest
          .spyOn(ctx.app.get<ThrottlerStorage>(ThrottlerStorage), 'increment')
          .mockResolvedValue({
            totalHits: 1,
            timeToExpire: 60,
            isBlocked: false,
            timeToBlockExpire: 0,
          });
      });
      afterEach(() => requestLimit?.mockRestore());

      /** Ends the wait of every source now, as if its delay had passed. */
      const endWaits = () =>
        ctx.prisma.loginThrottle.updateMany({
          data: { blockedUntil: new Date(Date.now() - 1000) },
        });

      /**
       * Makes `count` wrong-password failures count from `ip`, waiting out
       * each delay. Returns the `Retry-After` of every 429 on the way.
       */
      const failFrom = async (ip: string, count: number) => {
        const waits: number[] = [];
        let failures = 0;
        while (failures < count) {
          const response = await attempt('op@example.com', WRONG, ip);
          if (response.status === 429) {
            expect(response.body.error).toBe(AUTH_ERROR.throttled);
            waits.push(Number(response.headers['retry-after']));
            await endWaits();
            continue;
          }
          expect(response.status).toBe(401);
          failures += 1;
        }
        return waits;
      };

      it('never delays the owner from another address: 20 failures from A, then B signs in at once', async () => {
        await createUser(ctx.prisma, 'op@example.com', 'operator');
        const a = nextIp();

        await failFrom(a, 20);

        const started = Date.now();
        const fromB = await attempt('op@example.com', PASSWORD);
        expect(fromB.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(1000);
        const user = await ctx.prisma.user.findUniqueOrThrow({
          where: { email: 'op@example.com' },
        });
        expect(user.status).toBe('active');
      });

      it('makes A wait after 5 failures, doubling from 1 s to a 60 s ceiling', async () => {
        await createUser(ctx.prisma, 'op@example.com', 'operator');
        const a = nextIp();

        const waits = await failFrom(a, 20);

        // Failures 5…19 each set a wait; the 20th's is still running.
        expect(waits).toEqual([
          1, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60, 60, 60, 60, 60,
        ]);
        const waiting = await attempt('op@example.com', PASSWORD, a);
        expect(waiting.status).toBe(429);
        expect(Number(waiting.headers['retry-after'])).toBe(60);

        // Once the wait is over, the right password works and clears A.
        await endWaits();
        expect((await attempt('op@example.com', PASSWORD, a)).status).toBe(200);
        expect(await ctx.prisma.loginThrottle.count()).toBe(0);
      });

      it('throttles an unknown email exactly like a real one', async () => {
        const ip = nextIp();
        const statuses: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          statuses.push(
            (await attempt('nobody@example.com', WRONG, ip)).status,
          );
        }
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      });

      it('notifies every active admin once when an account becomes throttled', async () => {
        const admin = await createUser(
          ctx.prisma,
          'admin@example.com',
          'admin',
        );
        await createUser(ctx.prisma, 'op@example.com', 'operator');

        await failFrom(nextIp(), 4);
        expect(
          await ctx.prisma.notification.count({
            where: { kind: 'account.throttled' },
          }),
        ).toBe(0);

        await failFrom(nextIp(), 5);
        const [notification] = await ctx.prisma.notification.findMany({
          where: { kind: 'account.throttled' },
        });
        expect(notification).toMatchObject({
          userId: admin.id,
          title: 'Sign-in attempts throttled for op@example.com',
          link: '/admin/users',
        });

        // A second source crossing within the window is the same episode.
        await failFrom(nextIp(), 6);
        expect(
          await ctx.prisma.notification.count({
            where: { kind: 'account.throttled' },
          }),
        ).toBe(1);
      });

      it('folds 100 refused logins from one (email, IP) into at most 2 audit records', async () => {
        await createUser(ctx.prisma, 'op@example.com', 'operator');
        const audit = ctx.app.get(AuditService);
        // Away from a minute boundary, so the burst stays in one minute.
        const intoMinute = Date.now() % 60_000;
        if (intoMinute > 40_000) {
          await new Promise((r) => setTimeout(r, 60_500 - intoMinute));
        }
        const ip = nextIp();
        // The audit log is append-only: earlier tests' records stay.
        const head = await ctx.prisma.auditRecord.aggregate({
          _max: { seq: true },
        });
        const mine = {
          action: 'auth.login',
          targetId: 'op@example.com',
          seq: { gt: head._max.seq ?? 0n },
        };
        const records = () => ctx.prisma.auditRecord.count({ where: mine });

        const statuses = new Set<number>();
        for (let i = 0; i < 100; i += 1) {
          statuses.add((await attempt('op@example.com', WRONG, ip)).status);
        }
        expect([...statuses].sort()).toEqual([401, 429]);
        expect(await records()).toBe(1);

        // The minute is over: the 99 repeats become one record.
        expect(await audit.flushFolds(new Date(Date.now() + 60_000))).toBe(1);
        const rows = await ctx.prisma.auditRecord.findMany({
          where: mine,
          orderBy: { seq: 'asc' },
        });
        expect(rows).toHaveLength(2);
        expect(rows[0].meta).toMatchObject({
          reason: 'invalid_credentials',
          count: 1,
        });
        const folded = rows[1].meta as {
          folded: boolean;
          count: number;
          reasons: Record<string, number>;
        };
        expect(folded).toMatchObject({ folded: true, count: 99 });
        // Wrong passwords until the source waits, then mostly 429s.
        expect(folded.reasons.invalid_credentials).toBeGreaterThanOrEqual(4);
        expect(folded.reasons.throttled).toBeGreaterThan(0);
        expect(
          folded.reasons.invalid_credentials + folded.reasons.throttled,
        ).toBe(99);
        expect(await ctx.prisma.auditFold.count()).toBe(0);
      });
    });

    it('throttles more than 10 login requests a minute from one IP with 429', async () => {
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        // A new email each time: the per-(account, IP) wait stays out of it.
        statuses.push(
          (await attempt(`a${i}@example.com`, 'whatever!!', ip)).status,
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

    it('throttles wrong current passwords: the 11th call in a minute gets 429', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');
      const ip = nextIp();
      const change = () =>
        session
          .send('patch', '/auth/me/password', {
            currentPassword: 'not my password',
            newPassword: 'another long passphrase',
          })
          .set('X-Forwarded-For', ip);

      // The per-IP request limit alone, with the failure counter held off.
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push((await change()).status);
        await ctx.prisma.loginThrottle.deleteMany();
      }
      expect(statuses).toEqual([...Array(10).fill(403), 429]);
    });

    it('counts wrong current passwords like failed logins: the 6th waits', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');
      const ip = nextIp();
      const statuses: number[] = [];
      let retryAfter = '';
      for (let i = 0; i < 6; i += 1) {
        const response = await session
          .send('patch', '/auth/me/password', {
            currentPassword: 'not my password',
            newPassword: 'another long passphrase',
          })
          .set('X-Forwarded-For', ip);
        statuses.push(response.status);
        retryAfter = response.headers['retry-after'] ?? '';
      }
      expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
      expect(retryAfter).toBe('1');
      // The same counter: a login from that address waits too.
      expect((await attempt('op@example.com', PASSWORD, ip)).status).toBe(429);
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
