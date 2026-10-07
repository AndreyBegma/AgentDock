import { PAIRING_CODE_PATTERN } from '@agentdock/shared/protocol';
import {
  createUser,
  login,
  nextIp,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { hashPairingCode } from './credentials';
import {
  adminSession,
  createRunner,
  createRunnerE2eApp,
  pairBody,
  pairedRunner,
  type RunnerE2eContext,
} from './testing/runner-e2e';

type Method = 'get' | 'post' | 'patch';

const RUNNER_ROUTES: [Method, string, object?][] = [
  ['post', '/admin/runners', { name: 'x' }],
  ['get', '/admin/runners'],
  ['get', '/admin/runners/some-id'],
  ['patch', '/admin/runners/some-id', { name: 'y' }],
  ['post', '/admin/runners/some-id/pairing-code'],
  ['post', '/admin/runners/some-id/ping'],
  ['post', '/admin/runners/some-id/revoke'],
];

describe('runners admin and pairing (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
  });

  const pair = (body: object) =>
    ctx
      .http()
      .post('/runners/pair')
      .set('X-Forwarded-For', nextIp())
      .send(body);

  describe('authorization', () => {
    it.each([
      'operator',
      'viewer',
    ] as const)('%s gets 403 on every /admin/runners route', async (role) => {
      await createUser(ctx.prisma, `${role}@example.com`, role);
      const session = await login(ctx, `${role}@example.com`);
      for (const [method, path, body] of RUNNER_ROUTES) {
        const response =
          method === 'get'
            ? await session.get(path)
            : await session.send(method, path, body);
        expect([method, path, response.status]).toEqual([method, path, 403]);
      }
    });

    it('anonymous gets 401 on every /admin/runners route', async () => {
      for (const [method, path, body] of RUNNER_ROUTES) {
        const response = await ctx.http()[method](path).send(body);
        expect([method, path, response.status]).toEqual([method, path, 401]);
      }
    });

    it('/runners/pair is public, JSON only', async () => {
      const response = await pair(pairBody('AAAA-AAAA'));
      expect(response.status).toBe(400);
      const form = await ctx
        .http()
        .post('/runners/pair')
        .set('X-Forwarded-For', nextIp())
        .type('form')
        .send('code=AAAA-AAAA');
      expect(form.status).toBe(415);
    });
  });

  describe('pairing', () => {
    it('returns a code once; the code pairs once; reuse is 400 invalid_code', async () => {
      const created = await createRunner(admin, 'desk');
      expect(created.pairingCode).toMatch(PAIRING_CODE_PATTERN);
      expect(created.command).toBe(
        `agentdock-runner pair --server ${ctx.origin} --code ${created.pairingCode}`,
      );
      expect(created.runner).toMatchObject({
        name: 'desk',
        status: 'offline',
        pairedAt: null,
      });
      expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(
        9 * 60_000,
      );

      const first = await pair(pairBody(created.pairingCode.toLowerCase()));
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        runnerId: created.runner.id,
        token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });

      const again = await pair(pairBody(created.pairingCode));
      expect(again.status).toBe(400);
      expect(again.body).toMatchObject({
        statusCode: 400,
        error: 'invalid_code',
      });
    });

    it('a code older than 10 minutes is 400', async () => {
      const created = await createRunner(admin);
      await ctx.prisma.runnerPairingCode.updateMany({
        where: { runnerId: created.runner.id },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      const response = await pair(pairBody(created.pairingCode));
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_code');
    });

    it('an unknown, malformed or revoked runner code is 400 invalid_code', async () => {
      expect((await pair(pairBody('ZZZZ-ZZZZ'))).body.error).toBe(
        'invalid_code',
      );
      expect((await pair(pairBody('not a code'))).body.error).toBe(
        'invalid_code',
      );
      const created = await createRunner(admin);
      await admin.send('post', `/admin/runners/${created.runner.id}/revoke`);
      expect((await pair(pairBody(created.pairingCode))).body.error).toBe(
        'invalid_code',
      );
    });

    it('a new pairing code invalidates the earlier unused one', async () => {
      const created = await createRunner(admin);
      const renewed = await admin.send(
        'post',
        `/admin/runners/${created.runner.id}/pairing-code`,
      );
      expect(renewed.status).toBe(200);
      expect(renewed.body.pairingCode).not.toBe(created.pairingCode);
      expect((await pair(pairBody(created.pairingCode))).status).toBe(400);
      expect((await pair(pairBody(renewed.body.pairingCode))).status).toBe(200);
    });

    it('rejects a body that fails validation', async () => {
      const response = await pair({ code: 'AAAA-AAAA', hostname: 'h' });
      expect(response.status).toBe(400);
    });
  });

  describe('secrets', () => {
    it('the database holds only hashes; no other response carries the code or token', async () => {
      const created = await createRunner(admin);
      const { token } = (await pair(pairBody(created.pairingCode))).body as {
        token: string;
      };
      const id = created.runner.id;

      const runner = await ctx.prisma.runner.findUniqueOrThrow({
        where: { id },
      });
      expect(runner.tokenHash).toMatch(/^\$argon2id\$/);
      expect(runner.tokenHash).not.toContain(token);
      expect(runner.tokenPrefix).toBe(token.slice(0, 8));
      const codes = await ctx.prisma.runnerPairingCode.findMany({
        where: { runnerId: id },
      });
      expect(codes.map((c) => c.codeHash)).toEqual([
        hashPairingCode(created.pairingCode),
      ]);
      const dump = JSON.stringify(
        await ctx.prisma.$queryRawUnsafe(
          'SELECT r.*, c.* FROM runners r LEFT JOIN runner_pairing_codes c ON c."runnerId" = r.id',
        ),
        (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
      );
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(created.pairingCode);

      const reads = [
        await admin.get('/admin/runners'),
        await admin.get(`/admin/runners/${id}`),
        await admin.send('patch', `/admin/runners/${id}`, { name: 'renamed' }),
        await admin.send('post', `/admin/runners/${id}/revoke`),
      ];
      for (const response of reads) {
        expect(response.status).toBe(200);
        expect(response.text).not.toContain(token);
        expect(response.text).not.toContain(token.slice(0, 8));
        expect(response.text).not.toContain(created.pairingCode);
        expect(response.text).not.toContain('tokenHash');
      }
    });
  });

  describe('admin routes', () => {
    it('lists, shows, renames and revokes; the row stays', async () => {
      const { runnerId } = await pairedRunner(ctx, admin, 'desk');

      const list = await admin.get('/admin/runners');
      expect(list.body).toEqual([
        expect.objectContaining({
          id: runnerId,
          name: 'desk',
          status: 'offline',
          hostname: 'test-host',
          version: '0.1.0',
          protocolVersion: 1,
          profilesCount: 0,
          pairedAt: expect.any(String),
        }),
      ]);

      const renamed = await admin.send('patch', `/admin/runners/${runnerId}`, {
        name: '  laptop ',
      });
      expect(renamed.body.name).toBe('laptop');
      expect(
        (await admin.send('patch', `/admin/runners/${runnerId}`, { name: '' }))
          .status,
      ).toBe(400);

      const revoked = await admin.send(
        'post',
        `/admin/runners/${runnerId}/revoke`,
      );
      expect(revoked.body).toMatchObject({
        status: 'revoked',
        revokedAt: expect.any(String),
      });
      const detail = await admin.get(`/admin/runners/${runnerId}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        status: 'revoked',
        capabilities: null,
        profiles: [],
        events: [],
        heartbeat: null,
        ackedSeq: 0,
      });

      const renew = await admin.send(
        'post',
        `/admin/runners/${runnerId}/pairing-code`,
      );
      expect(renew.status).toBe(409);
    });

    it('404 on an unknown runner', async () => {
      expect((await admin.get('/admin/runners/nope')).status).toBe(404);
      expect(
        (await admin.send('patch', '/admin/runners/nope', { name: 'x' }))
          .status,
      ).toBe(404);
      expect(
        (await admin.send('post', '/admin/runners/nope/revoke')).status,
      ).toBe(404);
      expect(
        (await admin.send('post', '/admin/runners/nope/ping')).status,
      ).toBe(404);
    });

    it('pinging an offline runner answers unknown at once', async () => {
      const { runnerId } = await pairedRunner(ctx, admin);
      const started = Date.now();
      const response = await admin.send(
        'post',
        `/admin/runners/${runnerId}/ping`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'unknown' });
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});
