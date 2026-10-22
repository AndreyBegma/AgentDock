import {
  AUTH_ERROR,
  RECOVERY_CODE_COUNT,
  TWO_FACTOR_ADMIN_SETTING_KEY,
} from '@nautelle/shared';
import { ThrottlerStorage } from '@nestjs/throttler';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  nextIp,
  PASSWORD,
  resetDatabase,
  type Session,
  setCookies,
} from '../test/e2e-app';
import { hashRecoveryCode, totpCode, totpStep } from './totp';

const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

describe('two-factor sign-in (e2e, C-189)', () => {
  let ctx: E2eContext;
  let previousKey: string | undefined;
  let requestLimit: jest.SpyInstance | undefined;

  beforeAll(async () => {
    previousKey = process.env.APP_ENCRYPTION_KEY;
    process.env.APP_ENCRYPTION_KEY = ENCRYPTION_KEY;
    ctx = await createE2eApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    // The 2FA routes are limited to 10 requests a minute per address and
    // every test here comes from one; the per-(account, IP) wait still holds.
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

  const attempt = (email: string, code?: string, password = PASSWORD) =>
    ctx
      .http()
      .post('/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send(
        code === undefined ? { email, password } : { email, password, code },
      );

  /** The code of the current step, with the replay mark cleared so it counts. */
  const freshCode = async (email: string, secret: string) => {
    await ctx.prisma.user.update({
      where: { email },
      data: { totpLastStep: null },
    });
    return totpCode(secret, totpStep(new Date()));
  };

  /** Enrols `session`'s user; returns the secret and the recovery codes. */
  const enrol = async (session: Session, email: string) => {
    const setup = await session.send('post', '/auth/me/two-factor/setup', {
      password: PASSWORD,
    });
    expect(setup.status).toBe(200);
    const secret: string = setup.body.secret;
    const enabled = await session.send('post', '/auth/me/two-factor/enable', {
      code: await freshCode(email, secret),
    });
    expect(enabled.status).toBe(200);
    return { secret, recoveryCodes: enabled.body.recoveryCodes as string[] };
  };

  describe('enrolment', () => {
    it('sets up, confirms with a code and seals the secret', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');

      const before = await session.get('/auth/me/two-factor');
      expect(before.body).toEqual({
        enabled: false,
        required: false,
        recoveryCodesLeft: 0,
      });

      const setup = await session.send('post', '/auth/me/two-factor/setup', {
        password: PASSWORD,
      });
      expect(setup.status).toBe(200);
      expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.body.otpauthUrl).toContain(`secret=${setup.body.secret}`);

      const pending = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'op@example.com' },
      });
      expect(pending.totpEnabledAt).toBeNull();
      expect(pending.totpPendingSecret).not.toContain(setup.body.secret);

      const wrong = await session.send('post', '/auth/me/two-factor/enable', {
        code: '000000',
      });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error).toBe(AUTH_ERROR.twoFactorInvalid);

      const enabled = await session.send('post', '/auth/me/two-factor/enable', {
        code: totpCode(setup.body.secret, totpStep(new Date())),
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);

      const after = await session.get('/auth/me/two-factor');
      expect(after.body).toEqual({
        enabled: true,
        required: false,
        recoveryCodesLeft: RECOVERY_CODE_COUNT,
      });
      const me = await session.get('/auth/me');
      expect(me.body.twoFactorEnabled).toBe(true);
    });

    it('refuses setup with a wrong password', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');

      const response = await session.send('post', '/auth/me/two-factor/setup', {
        password: 'not the password',
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe(AUTH_ERROR.invalidCredentials);
    });

    it('signs the other sessions out when it is turned on', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');
      const other = await login(ctx, 'op@example.com');

      await enrol(session, 'op@example.com');

      expect((await session.get('/auth/me')).status).toBe(200);
      expect((await other.get('/auth/me')).status).toBe(401);
    });

    it('stores recovery codes only as hashes', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');
      const { recoveryCodes } = await enrol(session, 'op@example.com');

      const rows = await ctx.prisma.userRecoveryCode.findMany();
      expect(rows).toHaveLength(RECOVERY_CODE_COUNT);
      const stored = rows.map((row) => row.codeHash).sort();
      expect(stored).toEqual(recoveryCodes.map(hashRecoveryCode).sort());
      for (const code of recoveryCodes) {
        expect(JSON.stringify(rows)).not.toContain(code.replace(/-/g, ''));
      }
    });
  });

  describe('login', () => {
    it('asks an enrolled account for a code, then accepts a right one', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const { secret } = await enrol(
        await login(ctx, 'op@example.com'),
        'op@example.com',
      );

      const noCode = await attempt('op@example.com');
      expect(noCode.status).toBe(401);
      expect(noCode.body.error).toBe(AUTH_ERROR.twoFactorRequired);
      expect(setCookies(noCode)).toEqual([]);

      const wrong = await attempt('op@example.com', '000000');
      expect(wrong.status).toBe(401);
      expect(wrong.body.error).toBe(AUTH_ERROR.twoFactorInvalid);
      expect(setCookies(wrong)).toEqual([]);

      const right = await attempt(
        'op@example.com',
        await freshCode('op@example.com', secret),
      );
      expect(right.status).toBe(200);
      expect(right.body.twoFactorEnabled).toBe(true);
    });

    it('never asks an account without two-factor sign-in for a code', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      expect((await attempt('op@example.com')).status).toBe(200);
    });

    it('does not ask for the code before the password is right', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      await enrol(await login(ctx, 'op@example.com'), 'op@example.com');

      const response = await attempt('op@example.com', undefined, 'wrong!!!');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe(AUTH_ERROR.invalidCredentials);
    });

    it('refuses a TOTP code that was already used', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const { secret } = await enrol(
        await login(ctx, 'op@example.com'),
        'op@example.com',
      );
      const code = await freshCode('op@example.com', secret);

      expect((await attempt('op@example.com', code)).status).toBe(200);
      const replay = await attempt('op@example.com', code);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toBe(AUTH_ERROR.twoFactorInvalid);
    });

    it('accepts each recovery code once, however it is typed', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');
      const { recoveryCodes } = await enrol(session, 'op@example.com');
      const [first] = recoveryCodes;

      const used = await attempt('op@example.com', first.toLowerCase());
      expect(used.status).toBe(200);

      const again = await attempt('op@example.com', first);
      expect(again.status).toBe(401);
      expect(again.body.error).toBe(AUTH_ERROR.twoFactorInvalid);

      const status = await session.get('/auth/me/two-factor');
      expect(status.body.recoveryCodesLeft).toBe(RECOVERY_CODE_COUNT - 1);
    });

    it('counts a wrong code as a failed sign-in', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      await enrol(await login(ctx, 'op@example.com'), 'op@example.com');

      await attempt('op@example.com', '000000');

      const throttle = await ctx.prisma.loginThrottle.findFirst({
        where: { email: 'op@example.com' },
      });
      expect(throttle?.failures).toBe(1);
      const denied = await ctx.prisma.auditRecord.findFirst({
        where: { action: 'auth.login', result: 'denied' },
        orderBy: { ts: 'desc' },
      });
      expect(denied?.meta).toMatchObject({ reason: 'two_factor_invalid' });
    });
  });

  describe('turning it off and new recovery codes', () => {
    it('needs the password and a code', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');
      const { secret } = await enrol(session, 'op@example.com');

      const wrongPassword = await session.send(
        'post',
        '/auth/me/two-factor/disable',
        { password: 'not the password', code: totpCode(secret, 0) },
      );
      expect(wrongPassword.status).toBe(403);
      expect(wrongPassword.body.error).toBe(AUTH_ERROR.invalidCredentials);

      const wrongCode = await session.send(
        'post',
        '/auth/me/two-factor/disable',
        { password: PASSWORD, code: '000000' },
      );
      expect(wrongCode.status).toBe(403);
      expect(wrongCode.body.error).toBe(AUTH_ERROR.twoFactorInvalid);

      const off = await session.send('post', '/auth/me/two-factor/disable', {
        password: PASSWORD,
        code: await freshCode('op@example.com', secret),
      });
      expect(off.status).toBe(204);

      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'op@example.com' },
      });
      expect(user.totpEnabledAt).toBeNull();
      expect(user.totpSecret).toBeNull();
      expect(await ctx.prisma.userRecoveryCode.count()).toBe(0);
      expect((await attempt('op@example.com')).status).toBe(200);
    });

    it('replaces the recovery codes', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      const session = await login(ctx, 'op@example.com');
      const { secret, recoveryCodes } = await enrol(session, 'op@example.com');

      const fresh = await session.send(
        'post',
        '/auth/me/two-factor/recovery-codes',
        { password: PASSWORD, code: await freshCode('op@example.com', secret) },
      );
      expect(fresh.status).toBe(200);
      expect(fresh.body.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);

      expect((await attempt('op@example.com', recoveryCodes[0])).status).toBe(
        401,
      );
      expect(
        (await attempt('op@example.com', fresh.body.recoveryCodes[0])).status,
      ).toBe(200);
    });
  });

  describe('required for admins', () => {
    const requireForAdmins = () =>
      ctx.prisma.setting.create({
        data: { key: TWO_FACTOR_ADMIN_SETTING_KEY, value: true },
      });

    it('is set by an admin and audited', async () => {
      const since = new Date();
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const admin = await login(ctx, 'admin@example.com');

      const off = await admin.get('/admin/settings/two-factor');
      expect(off.body).toEqual({ requiredForAdmins: false });

      const on = await admin.send('put', '/admin/settings/two-factor', {
        requiredForAdmins: true,
      });
      expect(on.status).toBe(200);
      expect(on.body).toEqual({ requiredForAdmins: true });
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'settings.two_factor', ts: { gte: since } },
        }),
      ).toBe(1);
    });

    it('keeps an admin without it to the account routes until they enrol', async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      await requireForAdmins();
      const admin = await login(ctx, 'admin@example.com');

      const me = await admin.get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.twoFactorSetupRequired).toBe(true);

      const blocked = await admin.get('/admin/users');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe(AUTH_ERROR.twoFactorSetupRequired);

      await enrol(admin, 'admin@example.com');

      expect((await admin.get('/auth/me')).body.twoFactorSetupRequired).toBe(
        false,
      );
      expect((await admin.get('/admin/users')).status).toBe(200);
    });

    it('does not apply to other roles', async () => {
      await createUser(ctx.prisma, 'op@example.com', 'operator');
      await requireForAdmins();
      const session = await login(ctx, 'op@example.com');

      const me = await session.get('/auth/me');
      expect(me.body.twoFactorSetupRequired).toBe(false);
      expect((await session.get('/projects')).status).toBe(200);
    });

    it('stops an admin turning it off', async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const admin = await login(ctx, 'admin@example.com');
      const { secret } = await enrol(admin, 'admin@example.com');
      await requireForAdmins();

      const response = await admin.send('post', '/auth/me/two-factor/disable', {
        password: PASSWORD,
        code: await freshCode('admin@example.com', secret),
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe(AUTH_ERROR.twoFactorRequiredByPolicy);
    });
  });

  describe('admin reset', () => {
    it("turns off another user's two-factor sign-in", async () => {
      await createUser(ctx.prisma, 'admin@example.com', 'admin');
      const target = await createUser(ctx.prisma, 'op@example.com', 'operator');
      await enrol(await login(ctx, 'op@example.com'), 'op@example.com');
      const admin = await login(ctx, 'admin@example.com');

      const response = await admin.send(
        'delete',
        `/admin/users/${target.id}/two-factor`,
      );

      expect(response.status).toBe(200);
      expect(response.body.twoFactorEnabled).toBe(false);
      expect(await ctx.prisma.userRecoveryCode.count()).toBe(0);
      expect((await attempt('op@example.com')).status).toBe(200);
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'user.two_factor_reset', targetId: target.id },
        }),
      ).toBe(1);
    });

    it('is refused for oneself and for viewers', async () => {
      const self = await createUser(ctx.prisma, 'admin@example.com', 'admin');
      await createUser(ctx.prisma, 'viewer@example.com', 'viewer');
      const admin = await login(ctx, 'admin@example.com');
      await enrol(admin, 'admin@example.com');
      const viewer = await login(ctx, 'viewer@example.com');

      expect(
        (await admin.send('delete', `/admin/users/${self.id}/two-factor`))
          .status,
      ).toBe(403);
      expect(
        (await viewer.send('delete', `/admin/users/${self.id}/two-factor`))
          .status,
      ).toBe(403);
    });
  });
});
