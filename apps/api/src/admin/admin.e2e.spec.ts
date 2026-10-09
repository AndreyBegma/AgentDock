import { AUTH_ERROR, REGISTRATION_SETTING_KEY } from '@agentdock/shared';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  nextIp,
  PASSWORD,
  resetDatabase,
} from '../test/e2e-app';
import { AdminUsersService } from './admin-users.service';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

const ADMIN_ROUTES: [Method, string, object?][] = [
  ['get', '/admin/users'],
  ['post', '/admin/users/some-id/approve', { role: 'viewer' }],
  ['post', '/admin/users/some-id/reject'],
  ['patch', '/admin/users/some-id', { role: 'viewer' }],
  ['delete', '/admin/users/some-id'],
  ['get', '/admin/settings/registration'],
  ['put', '/admin/settings/registration', { open: true }],
];

const SESSION_ROUTES: [Method, string][] = [
  ['post', '/auth/logout'],
  ['get', '/auth/me'],
  ['patch', '/auth/me/password'],
  ['get', '/auth/sessions'],
  ['delete', '/auth/sessions/some-id'],
];

describe('admin and authorization (e2e)', () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.prisma));

  const status = (email: string) =>
    ctx.prisma.user
      .findUniqueOrThrow({ where: { email } })
      .then((u) => u.status);

  describe('authorization', () => {
    it.each([
      'operator',
      'viewer',
    ] as const)('%s gets 403 on every /admin route', async (role) => {
      await createUser(ctx.prisma, 'u@example.com', role);
      const session = await login(ctx, 'u@example.com');

      for (const [method, path, body] of ADMIN_ROUTES) {
        const response =
          method === 'get'
            ? await session.get(path)
            : await session.send(method, path, body);
        expect([method, path, response.status]).toEqual([method, path, 403]);
        expect(response.body.error).toBe(AUTH_ERROR.forbidden);
      }
    });

    it('an anonymous caller gets 401 on every route but the public ones', async () => {
      for (const [method, path] of [...ADMIN_ROUTES, ...SESSION_ROUTES]) {
        const response = await ctx.http()[method](path).send({});
        expect([method, path, response.status]).toEqual([method, path, 401]);
        expect(response.body.error).toBe(AUTH_ERROR.unauthenticated);
      }

      expect((await ctx.http().get('/health')).status).toBe(200);
      expect((await ctx.http().get('/auth/registration')).status).toBe(200);
      const loginResponse = await ctx
        .http()
        .post('/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'x@example.com', password: 'whatever' });
      expect(loginResponse.status).toBe(401);
      expect(loginResponse.body.error).toBe(AUTH_ERROR.invalidCredentials);
      const registerResponse = await ctx
        .http()
        .post('/auth/register')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'x@example.com', password: PASSWORD });
      expect(registerResponse.body.error).toBe(AUTH_ERROR.registrationClosed);
    });
  });

  describe('approval flow', () => {
    it('register → pending → approve as operator → login, /auth/me says operator', async () => {
      const admin = await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const adminSession = await login(ctx, 'admin@example.com');

      const opened = await adminSession.send(
        'put',
        '/admin/settings/registration',
        { open: true },
      );
      expect(opened.body).toEqual({ open: true });
      expect((await ctx.http().get('/auth/registration')).body).toEqual({
        open: true,
      });

      await ctx
        .http()
        .post('/auth/register')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'new@example.com', password: PASSWORD })
        .expect(201);

      const pending = await adminSession.get('/admin/users?status=pending');
      expect(pending.body).toHaveLength(1);
      const id = pending.body[0].id;

      const approved = await adminSession.send(
        'post',
        `/admin/users/${id}/approve`,
        { role: 'operator' },
      );
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({
        status: 'active',
        role: 'operator',
        approvedById: admin.id,
      });

      const userSession = await login(ctx, 'new@example.com');
      const me = await userSession.get('/auth/me');
      expect(me.body).toMatchObject({ role: 'operator', status: 'active' });

      const again = await adminSession.send(
        'post',
        `/admin/users/${id}/approve`,
        { role: 'admin' },
      );
      expect(again.status).toBe(409);
      expect(again.body.error).toBe(AUTH_ERROR.invalidTransition);
    });

    it('a rejected account cannot log in or register again until deleted', async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const user = await createUser(
        ctx.prisma,
        'new@example.com',
        'viewer',
        'pending',
      );
      await ctx.prisma.setting.create({
        data: { key: REGISTRATION_SETTING_KEY, value: true },
      });
      const adminSession = await login(ctx, 'admin@example.com');

      const rejected = await adminSession.send(
        'post',
        `/admin/users/${user.id}/reject`,
      );
      expect(rejected.body.status).toBe('rejected');

      const loginResponse = await ctx
        .http()
        .post('/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'new@example.com', password: PASSWORD });
      expect(loginResponse.body.error).toBe(AUTH_ERROR.invalidCredentials);

      const register = () =>
        ctx
          .http()
          .post('/auth/register')
          .set('X-Forwarded-For', nextIp())
          .send({ email: 'new@example.com', password: PASSWORD });
      expect((await register()).status).toBe(409);

      await adminSession.send('delete', `/admin/users/${user.id}`).expect(204);
      expect((await register()).status).toBe(201);
    });

    it('PATCH refuses pending accounts and unknown ids', async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const pending = await createUser(
        ctx.prisma,
        'p@example.com',
        'viewer',
        'pending',
      );
      const adminSession = await login(ctx, 'admin@example.com');

      const onPending = await adminSession.send(
        'patch',
        `/admin/users/${pending.id}`,
        { status: 'active' },
      );
      expect(onPending.status).toBe(409);
      const unknown = await adminSession.send('patch', '/admin/users/nope', {
        role: 'viewer',
      });
      expect(unknown.status).toBe(404);
    });
  });

  describe('last admin', () => {
    it.each([
      ['demoting', 'patch', { role: 'operator' }],
      ['disabling', 'patch', { status: 'disabled' }],
      ['deleting', 'delete', undefined],
    ] as const)('refuses %s the last active admin with 409 last_admin', async (_case, method, body) => {
      const admin = await createUser(ctx.prisma, 'admin@example.com', 'admin');
      // A disabled admin does not count.
      await createUser(ctx.prisma, 'old@example.com', 'admin', 'disabled');
      const session = await login(ctx, 'admin@example.com');

      const response = await session.send(
        method,
        `/admin/users/${admin.id}`,
        body,
      );

      expect(response.status).toBe(409);
      expect(response.body.error).toBe(AUTH_ERROR.lastAdmin);
      expect(await status('admin@example.com')).toBe('active');
    });

    it('allows it while another active admin remains', async () => {
      await createUser(ctx.prisma, 'a@example.com', 'admin');
      const b = await createUser(ctx.prisma, 'b@example.com', 'admin');
      const session = await login(ctx, 'a@example.com');

      const demoted = await session.send('patch', `/admin/users/${b.id}`, {
        role: 'viewer',
      });
      expect(demoted.status).toBe(200);
      expect(demoted.body.role).toBe('viewer');
    });

    it('two admins demoting each other over HTTP at once leave one admin', async () => {
      const a = await createUser(ctx.prisma, 'a@example.com', 'admin');
      const b = await createUser(ctx.prisma, 'b@example.com', 'admin');
      const sa = await login(ctx, 'a@example.com');
      const sb = await login(ctx, 'b@example.com');

      const results = await Promise.all([
        sa.send('patch', `/admin/users/${b.id}`, { role: 'viewer' }),
        sb.send('patch', `/admin/users/${a.id}`, { role: 'viewer' }),
      ]);

      const admins = await ctx.prisma.user.count({
        where: { role: 'admin', status: 'active' },
      });
      expect(admins).toBe(1);
      // The loser is refused by whichever check sees the winner's commit first:
      // its session is gone (401), its role is gone (403), or the lock (409).
      const [won, lost] = results.map((r) => r.status).sort();
      expect(won).toBe(200);
      expect([401, 403, 409]).toContain(lost);
    });

    it('the last-admin check holds when both changes reach the service at once', async () => {
      const a = await createUser(ctx.prisma, 'a@example.com', 'admin');
      const b = await createUser(ctx.prisma, 'b@example.com', 'admin');
      const service = ctx.app.get(AdminUsersService);

      for (let round = 0; round < 5; round += 1) {
        await ctx.prisma.user.updateMany({ data: { role: 'admin' } });
        const results = await Promise.allSettled([
          service.update(a.id, { role: 'viewer' }),
          service.update(b.id, { status: 'disabled' }),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([
          'fulfilled',
          'rejected',
        ]);
        const failure = results.find((r) => r.status === 'rejected');
        expect(failure?.reason).toMatchObject({
          response: { error: AUTH_ERROR.lastAdmin },
        });
        await ctx.prisma.user.updateMany({ data: { status: 'active' } });
      }
    });
  });

  describe('revocation', () => {
    it('disabling a user ends their sessions immediately; re-enabling lets them log in', async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const op = await createUser(ctx.prisma, 'op@example.com', 'operator');
      const adminSession = await login(ctx, 'admin@example.com');
      const opSession = await login(ctx, 'op@example.com');

      await adminSession
        .send('patch', `/admin/users/${op.id}`, { status: 'disabled' })
        .expect(200);

      expect((await opSession.get('/auth/me')).status).toBe(401);
      expect(
        await ctx.prisma.userSession.count({ where: { userId: op.id } }),
      ).toBe(0);

      await adminSession
        .send('patch', `/admin/users/${op.id}`, { status: 'active' })
        .expect(200);
      await login(ctx, 'op@example.com');
    });

    it('changing a role ends that user’s sessions', async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const op = await createUser(ctx.prisma, 'op@example.com', 'operator');
      const adminSession = await login(ctx, 'admin@example.com');
      const opSession = await login(ctx, 'op@example.com');

      await adminSession
        .send('patch', `/admin/users/${op.id}`, { role: 'viewer' })
        .expect(200);

      expect((await opSession.get('/auth/me')).status).toBe(401);
      expect((await adminSession.get('/auth/me')).status).toBe(200);
    });
  });
});
