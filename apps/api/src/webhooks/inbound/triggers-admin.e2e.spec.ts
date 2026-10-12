import {
  type InboundTriggerDetail,
  type InboundTriggerView,
  type InboundTriggerWithSecret,
  TRIGGER_PUBLIC_ID_LENGTH,
} from '@agentdock/shared';
import { SecretCipher } from '../../common/crypto';
import {
  createUser,
  type E2eContext,
  login,
  type Session,
} from '../../test/e2e-app';
import {
  auditSince,
  createInboundApp,
  resetInbound,
  seedSkillProject,
  testCipher,
} from './testing/inbound-e2e';

/** An audit record as text, for "the secret is not in it" checks. */
const recordText = (record: object | undefined): string =>
  JSON.stringify(record, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

const skillAction = {
  kind: 'skill',
  skill: 'estimate',
  args: 'branch {{payload.ref}}',
  output: 'report',
};

describe('triggers admin API (e2e, spec 26)', () => {
  let ctx: E2eContext;
  let projectId: string;
  let admin: Session;
  let operator: Session;
  let viewer: Session;
  let auditOf: Awaited<ReturnType<typeof auditSince>>;

  const create = (body: object = {}, session = admin) =>
    session.send('post', '/admin/triggers', {
      name: 'CI failure',
      projectId,
      action: skillAction,
      allowedPaths: ['ref'],
      ...body,
    });

  const createOk = async (body: object = {}) => {
    const response = await create(body);
    expect(response.status).toBe(201);
    return response.body as InboundTriggerWithSecret;
  };

  beforeAll(async () => {
    ctx = await createInboundApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetInbound(ctx.prisma);
    ({ projectId } = await seedSkillProject(ctx.prisma));
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    await createUser(ctx.prisma, 'operator@example.com', 'operator');
    await createUser(ctx.prisma, 'viewer@example.com', 'viewer');
    admin = await login(ctx, 'admin@example.com');
    operator = await login(ctx, 'operator@example.com');
    viewer = await login(ctx, 'viewer@example.com');
    auditOf = await auditSince(ctx.prisma);
  });

  it('creates a trigger: secret shown once, stored sealed, never listed or audited', async () => {
    const created = await createOk();
    expect(created.publicId).toMatch(
      new RegExp(`^[A-Za-z0-9]{${TRIGGER_PUBLIC_ID_LENGTH}}$`),
    );
    expect(created.path).toBe(`/hooks/${created.publicId}`);
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await ctx.prisma.inboundTrigger.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(SecretCipher.isSealed(row.secret)).toBe(true);
    expect(row.secret).not.toContain(created.secret);
    expect(testCipher().decrypt(row.secret)).toBe(created.secret);
    expect(row.bucketTokens).toBe(30);

    const list = await admin.get('/admin/triggers');
    const detail = await admin.get(`/admin/triggers/${created.id}`);
    for (const response of [list, detail]) {
      expect(response.status).toBe(200);
      expect(response.text).not.toContain(created.secret);
      expect(response.text).not.toContain(row.secret);
      expect(response.text).not.toContain('"secret"');
    }
    expect((list.body as InboundTriggerView[]).map((t) => t.id)).toEqual([
      created.id,
    ]);
    expect((detail.body as InboundTriggerDetail).deliveries).toEqual([]);

    const [record] = await auditOf('trigger.create');
    expect(record).toMatchObject({ result: 'ok', targetId: created.id });
    expect(recordText(record)).not.toContain(created.secret);
    expect(recordText(record)).not.toContain(row.secret);
  });

  it('refuses a bad action, a template using a disallowed path and a bad pattern', async () => {
    expect(
      (await create({ action: { kind: 'shell', cmd: 'ls' } })).status,
    ).toBe(400);
    expect(
      (await create({ action: { kind: 'orchestrator', mode: 'stop' } })).status,
    ).toBe(400);
    expect(
      (
        await create({
          action: { ...skillAction, skill: 'code-sentinel:orchestrator' },
        })
      ).status,
    ).toBe(400);

    const disallowed = await create({ allowedPaths: ['branch'] });
    expect(disallowed.status).toBe(422);
    expect(disallowed.body).toMatchObject({
      error: 'invalid_template',
      reason: 'path_not_allowed',
      path: 'ref',
    });
    const stray = await create({
      action: { ...skillAction, args: '{{ payload.ref }}' },
    });
    expect(stray.body).toMatchObject({
      error: 'invalid_template',
      reason: 'bad_placeholder',
    });
    expect((await create({ valuePattern: '([' })).body).toMatchObject({
      error: 'invalid_template',
    });
    expect((await create({ allowedPaths: ['a..b'] })).body).toMatchObject({
      error: 'invalid_template',
      path: 'a..b',
    });
    expect((await create({ projectId: 'nope' })).status).toBe(404);
    expect(await ctx.prisma.inboundTrigger.count()).toBe(0);
  });

  it('answers 409 encryption_key_missing without a key', async () => {
    const keyless = await createInboundApp(SecretCipher.fromKeyText(undefined));
    try {
      await createUser(keyless.prisma, 'keyless@example.com', 'admin');
      const session = await login(keyless, 'keyless@example.com');
      const response = await session.send('post', '/admin/triggers', {
        name: 'x',
        projectId,
        action: { kind: 'orchestrator', mode: 'next' },
        allowedPaths: [],
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('encryption_key_missing');
    } finally {
      await keyless.app.close();
    }
  });

  it('updates, disables and re-enables; the template is re-checked against the new paths', async () => {
    const created = await createOk();
    const narrowed = await admin.send(
      'patch',
      `/admin/triggers/${created.id}`,
      {
        allowedPaths: ['branch'],
      },
    );
    expect(narrowed.status).toBe(422);
    expect(narrowed.body.reason).toBe('path_not_allowed');

    const disabled = await admin.send(
      'patch',
      `/admin/triggers/${created.id}`,
      {
        name: 'Deploy',
        enabled: false,
      },
    );
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({
      name: 'Deploy',
      enabled: false,
      disabledReason: 'manual',
    });
    const enabled = await admin.send('patch', `/admin/triggers/${created.id}`, {
      enabled: true,
    });
    expect(enabled.body).toMatchObject({ enabled: true, disabledReason: null });

    const records = await auditOf('trigger.update');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      before: expect.objectContaining({ name: 'CI failure', enabled: true }),
      after: expect.objectContaining({ name: 'Deploy', enabled: false }),
    });
  });

  it('rotates the secret: a new one shown once, the old one kept sealed for 24 hours', async () => {
    const created = await createOk();
    const rotated = await admin.send(
      'post',
      `/admin/triggers/${created.id}/rotate-secret`,
    );
    expect(rotated.status).toBe(200);
    const body = rotated.body as InboundTriggerWithSecret;
    expect(body.secret).not.toBe(created.secret);
    const until = Date.parse(body.previousSecretUntil as string);
    expect(until - Date.now()).toBeGreaterThan(23.9 * 3_600_000);

    const row = await ctx.prisma.inboundTrigger.findUniqueOrThrow({
      where: { id: created.id },
    });
    const cipher = testCipher();
    expect(cipher.decrypt(row.secret)).toBe(body.secret);
    expect(cipher.decrypt(row.previousSecret as string)).toBe(created.secret);

    const [record] = await auditOf('trigger.rotate_secret');
    expect(record).toBeDefined();
    expect(recordText(record)).not.toContain(body.secret);
    expect(recordText(record)).not.toContain(created.secret);
  });

  it('deletes, audited', async () => {
    const created = await createOk();
    const response = await admin.send(
      'delete',
      `/admin/triggers/${created.id}`,
    );
    expect(response.status).toBe(204);
    expect(await ctx.prisma.inboundTrigger.count()).toBe(0);
    expect(await auditOf('trigger.delete')).toHaveLength(1);
    expect(
      (await admin.send('delete', `/admin/triggers/${created.id}`)).status,
    ).toBe(404);
  });

  describe('dry run (D4) — the hook’s verdict, nothing fires', () => {
    const dryRun = async (id: string, payload: unknown) => {
      const response = await admin.send(
        'post',
        `/admin/triggers/${id}/dry-run`,
        {
          payload,
        },
      );
      expect(response.status).toBe(200);
      return response.body;
    };

    it.each([
      [
        'renders an allowed scalar',
        { ref: 'feat/26-x' },
        { ok: true, args: 'branch feat/26-x' },
      ],
      [
        'a missing path',
        { other: 1 },
        { ok: false, reason: 'path_missing', path: 'ref' },
      ],
      [
        'an object',
        { ref: { a: 1 } },
        { ok: false, reason: 'not_scalar', path: 'ref' },
      ],
      [
        'over 500 characters',
        { ref: 'a'.repeat(501) },
        { ok: false, reason: 'too_long' },
      ],
      [
        'a backtick',
        { ref: 'a`id`' },
        { ok: false, reason: 'pattern_mismatch' },
      ],
      ['a $(', { ref: '$(id)' }, { ok: false, reason: 'pattern_mismatch' }],
    ])('%s', async (_name, payload, expected) => {
      const created = await createOk();
      expect(await dryRun(created.id, payload)).toMatchObject(
        expected.ok ? expected : { ...expected, error: 'invalid_payload' },
      );
      expect(await ctx.prisma.inboundDelivery.count()).toBe(0);
    });

    it('has nothing to render for an orchestrator action', async () => {
      const created = await createOk({
        action: { kind: 'orchestrator', mode: 'next' },
        allowedPaths: [],
      });
      expect(await dryRun(created.id, {})).toEqual({ ok: true, args: null });
    });
  });

  describe('authorization (D16)', () => {
    const routes = (id: string) =>
      [
        ['get', '/admin/triggers'],
        ['post', '/admin/triggers'],
        ['get', `/admin/triggers/${id}`],
        ['patch', `/admin/triggers/${id}`],
        ['delete', `/admin/triggers/${id}`],
        ['post', `/admin/triggers/${id}/rotate-secret`],
        ['post', `/admin/triggers/${id}/dry-run`],
      ] as const;

    it('is 403 for operators and viewers, 401 for anonymous, on every route', async () => {
      const created = await createOk();
      for (const [method, path] of routes(created.id)) {
        for (const session of [operator, viewer]) {
          const response =
            method === 'get'
              ? await session.get(path)
              : await session.send(method, path, { payload: {} });
          expect([method, path, response.status]).toEqual([method, path, 403]);
        }
        const anonymous = await ctx.http()[method](path);
        expect([method, path, anonymous.status]).toEqual([method, path, 401]);
      }
      expect(await ctx.prisma.inboundTrigger.count()).toBe(1);
    });
  });
});
