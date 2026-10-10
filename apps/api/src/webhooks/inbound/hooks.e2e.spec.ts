import {
  INBOUND_RATE_PER_HOUR,
  type InboundTriggerWithSecret,
  WEBHOOK_HEADERS,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';
import { SkillRunService } from '../../skills';
import {
  createUser,
  type E2eContext,
  login,
  type Session,
} from '../../test/e2e-app';
import { signInbound } from '../common';
import {
  auditSince,
  createInboundApp,
  fakeRunner,
  refuse,
  resetInbound,
  seedSkillProject,
} from './testing/inbound-e2e';
import { TriggerFirer } from './trigger-firer';

const skillAction = {
  kind: 'skill',
  skill: 'estimate',
  args: 'CI failed on {{payload.ref}} ({{payload.run.id}})',
  output: 'report',
};

let deliveryCounter = 0;
const nextDeliveryId = () => {
  deliveryCounter += 1;
  return `d-${Date.now()}-${deliveryCounter}`;
};

describe('POST /hooks/:publicId (e2e, spec 26 D1–D7)', () => {
  let ctx: E2eContext;
  let projectId: string;
  let adminId: string;
  let admin: Session;
  let runner: ReturnType<typeof fakeRunner>;
  let auditOf: Awaited<ReturnType<typeof auditSince>>;

  const createTrigger = async (body: object = {}) => {
    const response = await admin.send('post', '/admin/triggers', {
      name: 'CI failure',
      projectId,
      action: skillAction,
      allowedPaths: ['ref', 'run.id'],
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body as InboundTriggerWithSecret;
  };

  interface Delivery {
    body?: string;
    deliveryId?: string;
    timestamp?: string;
    secret?: string;
    /** Signs this body but sends `body`. */
    signedBody?: string;
    omit?: (keyof typeof WEBHOOK_HEADERS)[];
  }

  const deliver = (trigger: InboundTriggerWithSecret, d: Delivery = {}) => {
    const body =
      d.body ?? JSON.stringify({ ref: 'feat/26-inbound', run: { id: 42 } });
    const deliveryId = d.deliveryId ?? nextDeliveryId();
    const timestamp = d.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = signInbound(
      d.secret ?? trigger.secret,
      timestamp,
      deliveryId,
      d.signedBody ?? body,
    );
    const headers: Record<string, string> = {
      [WEBHOOK_HEADERS.timestamp]: timestamp,
      [WEBHOOK_HEADERS.delivery]: deliveryId,
      [WEBHOOK_HEADERS.signature]: signature,
    };
    for (const key of d.omit ?? []) delete headers[WEBHOOK_HEADERS[key]];
    return ctx
      .http()
      .post(trigger.path)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(body);
  };

  const settle = () => ctx.app.get(TriggerFirer).drain();
  const deliveries = (triggerId: string) =>
    ctx.prisma.inboundDelivery.findMany({
      where: { triggerId },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    ctx = await createInboundApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetInbound(ctx.prisma);
    ({ projectId } = await seedSkillProject(ctx.prisma));
    adminId = (await createUser(ctx.prisma, 'admin@example.com', 'admin')).id;
    admin = await login(ctx, 'admin@example.com');
    runner = fakeRunner(ctx);
    auditOf = await auditSince(ctx.prisma);
  });
  afterEach(async () => {
    await settle();
    jest.restoreAllMocks();
  });

  it('accepts a signed delivery: 202, exactly one skill.run with the rendered args, a webhook run in history', async () => {
    const trigger = await createTrigger();
    const response = await deliver(trigger, { deliveryId: 'gh-1' });
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ deliveryId: 'gh-1', status: 'accepted' });
    await settle();

    const sent = runner.sent('skill.run');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      projectId,
      skill: 'estimate',
      args: 'CI failed on feat/26-inbound (42)',
      profileKey: 'claude-main',
    });

    const [row] = await deliveries(trigger.id);
    expect(row).toMatchObject({
      status: 'started',
      reason: null,
      renderedArgs: 'CI failed on feat/26-inbound (42)',
      sourceIp: expect.any(String),
    });
    const runs = await admin.get(`/projects/${projectId}/runs`);
    expect(runs.status).toBe(200);
    const run = (
      runs.body.items as {
        id: string;
        triggeredByType: string;
        triggeredById: string;
      }[]
    ).find((item) => item.id === row.runId);
    expect(run).toMatchObject({
      triggeredByType: 'webhook',
      triggeredById: trigger.id,
    });
  });

  it('hands the rendered args to the runner as one JSON string value, never as shell text (ADR-0010)', async () => {
    // A pattern an admin widened on purpose: shell metacharacters pass D4…
    const trigger = await createTrigger({
      action: { ...skillAction, args: 'msg {{payload.text}}' },
      allowedPaths: ['text'],
      valuePattern: '^[^\\n]*$',
    });
    const text = `a; rm -rf / && echo "$(id)" | sh \`x\``;
    const response = await deliver(trigger, { body: JSON.stringify({ text }) });
    expect(response.status).toBe(202);
    await settle();
    // …and still reach `skill.run` byte for byte, as the `args` field of the
    // command's JSON — data the runner's `skill.run` handler never interpolates.
    const [args] = runner.sent('skill.run') as { args: unknown }[];
    expect(args.args).toBe(`msg ${text}`);
    expect(JSON.parse(JSON.stringify(args)).args).toBe(`msg ${text}`);
  });

  describe('signature (D2)', () => {
    it.each<[string, (t: InboundTriggerWithSecret) => Delivery]>([
      ['a wrong signature', () => ({ secret: 'not-the-secret' })],
      [
        'a body changed by one byte',
        () => ({
          signedBody: '{"ref":"feat/26-inbound","run":{"id":42}}',
          body: '{"ref":"feat/26-inbound","run":{"id":43}}',
        }),
      ],
      ['no signature header', () => ({ omit: ['signature'] })],
      ['no timestamp header', () => ({ omit: ['timestamp'] })],
      ['no delivery header', () => ({ omit: ['delivery'] })],
      [
        'a timestamp 6 minutes old',
        () => ({ timestamp: String(Math.floor(Date.now() / 1000) - 360) }),
      ],
    ])('%s → 401, nothing recorded, nothing fired', async (_name, make) => {
      const trigger = await createTrigger();
      const response = await deliver(trigger, make(trigger));
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
      });
      await settle();
      expect(await deliveries(trigger.id)).toEqual([]);
      expect(runner.sent('skill.run')).toEqual([]);
    });

    it('the same delivery id twice → 409 replayed the second time', async () => {
      const trigger = await createTrigger();
      expect((await deliver(trigger, { deliveryId: 'same' })).status).toBe(202);
      const again = await deliver(trigger, { deliveryId: 'same' });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe('replayed');
      await settle();
      expect(runner.sent('skill.run')).toHaveLength(1);
    });

    it('verifies with the previous secret during its grace period, and not after (D17)', async () => {
      const trigger = await createTrigger();
      const rotated = await admin.send(
        'post',
        `/admin/triggers/${trigger.id}/rotate-secret`,
      );
      const fresh = rotated.body as InboundTriggerWithSecret;
      // Two settled deliveries only: the second would be skipped while the first runs.
      expect((await deliver(trigger, { secret: trigger.secret })).status).toBe(
        202,
      );
      await settle();
      await ctx.prisma.run.updateMany({ data: { status: 'succeeded' } });
      expect((await deliver(trigger, { secret: fresh.secret })).status).toBe(
        202,
      );

      await ctx.prisma.inboundTrigger.update({
        where: { id: trigger.id },
        data: { previousSecretUntil: new Date(Date.now() - 1000) },
      });
      expect((await deliver(trigger, { secret: trigger.secret })).status).toBe(
        401,
      );
    });
  });

  describe('not found (D1)', () => {
    it('an unknown publicId and a disabled trigger are both 404 with an empty body', async () => {
      const trigger = await createTrigger();
      const unknown = await deliver({
        ...trigger,
        path: '/hooks/AAAAAAAAAAAAAAAAAAAAAAAA',
      });
      await admin.send('patch', `/admin/triggers/${trigger.id}`, {
        enabled: false,
      });
      const disabled = await deliver(trigger);
      for (const response of [unknown, disabled]) {
        expect(response.status).toBe(404);
        expect(response.text).toBe('');
      }
      expect(await deliveries(trigger.id)).toEqual([]);
    });

    it('is public: no session, no CSRF token; a non-JSON body is 415', async () => {
      const trigger = await createTrigger();
      const form = await ctx
        .http()
        .post(trigger.path)
        .set('Content-Type', 'text/plain')
        .send('ref=x');
      expect(form.status).toBe(415);
      expect(await deliveries(trigger.id)).toEqual([]);
    });
  });

  describe('payload templating (D4)', () => {
    it.each<[string, unknown, string]>([
      ['an object', { ref: { name: 'x' }, run: { id: 1 } }, 'not_scalar'],
      [
        'a value over 500 characters',
        { ref: 'a'.repeat(501), run: { id: 1 } },
        'too_long',
      ],
      ['a backtick', { ref: 'x`id`', run: { id: 1 } }, 'pattern_mismatch'],
      ['a $(', { ref: '$(id)', run: { id: 1 } }, 'pattern_mismatch'],
      ['a missing path', { run: { id: 1 } }, 'path_missing'],
    ])('%s → 422, recorded rejected, nothing fired; the dry run agrees', async (_name, payload, reason) => {
      const trigger = await createTrigger();
      const response = await deliver(trigger, {
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ error: 'invalid_payload', reason });

      const dryRun = await admin.send(
        'post',
        `/admin/triggers/${trigger.id}/dry-run`,
        { payload },
      );
      expect(dryRun.body).toMatchObject({ ok: false, reason });

      await settle();
      expect(runner.sent('skill.run')).toEqual([]);
      const [row] = await deliveries(trigger.id);
      expect(row).toMatchObject({ status: 'rejected', reason });
    });

    it('a path no longer in allowedPaths → 422 path_not_allowed', async () => {
      const trigger = await createTrigger();
      // Stored rows are re-checked at fire time; a write outside the API cannot widen them.
      await ctx.prisma.inboundTrigger.update({
        where: { id: trigger.id },
        data: { allowedPaths: ['ref'] },
      });
      const response = await deliver(trigger);
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        reason: 'path_not_allowed',
        path: 'run.id',
      });
    });

    it('a body that is not JSON → 422, recorded', async () => {
      const trigger = await createTrigger();
      const response = await deliver(trigger, { body: '{"ref":' });
      expect(response.status).toBe(422);
      expect(response.body.error).toBe('invalid_payload');
      const [row] = await deliveries(trigger.id);
      expect(row).toMatchObject({ status: 'rejected', reason: 'invalid_json' });
    });
  });

  describe('limits (D6)', () => {
    it('the 31st delivery in one hour is 429; deliveries while the run is running are skipped', async () => {
      const trigger = await createTrigger();
      const statuses: string[] = [];
      for (let i = 0; i < INBOUND_RATE_PER_HOUR; i += 1) {
        const response = await deliver(trigger);
        expect(response.status).toBe(202);
        statuses.push(response.body.status);
        await settle();
      }
      expect(statuses[0]).toBe('accepted');
      expect(new Set(statuses.slice(1))).toEqual(new Set(['skipped']));

      const limited = await deliver(trigger);
      expect(limited.status).toBe(429);
      expect(limited.body.error).toBe('rate_limited');

      const rows = await deliveries(trigger.id);
      expect(rows).toHaveLength(INBOUND_RATE_PER_HOUR);
      expect(rows[1]).toMatchObject({
        status: 'skipped',
        reason: 'previous_still_running',
      });
      expect(runner.sent('skill.run')).toHaveLength(1);
    });

    it('a 422 spends a token too', async () => {
      const trigger = await createTrigger();
      await deliver(trigger, { body: '{}' });
      const row = await ctx.prisma.inboundTrigger.findUniqueOrThrow({
        where: { id: trigger.id },
      });
      expect(row.bucketTokens).toBe(INBOUND_RATE_PER_HOUR - 1);
    });

    it('fires again once the previous run has ended', async () => {
      const trigger = await createTrigger();
      expect((await deliver(trigger)).body.status).toBe('accepted');
      await settle();
      await ctx.prisma.run.updateMany({ data: { status: 'succeeded' } });
      expect((await deliver(trigger)).body.status).toBe('accepted');
      await settle();
      expect(runner.sent('skill.run')).toHaveLength(2);
    });
  });

  describe('authority (D5)', () => {
    it.each([
      ['demoted to operator', { role: 'operator' as const }],
      ['disabled', { status: 'disabled' as const }],
    ])('creator %s → 202 failed creator_not_authorized, trigger disabled by system', async (_name, change) => {
      const trigger = await createTrigger();
      await ctx.prisma.user.update({ where: { id: adminId }, data: change });

      const response = await deliver(trigger);
      expect(response.status).toBe(202);
      expect(response.body.status).toBe('failed');
      await settle();
      expect(runner.sent('skill.run')).toEqual([]);

      const [row] = await deliveries(trigger.id);
      expect(row).toMatchObject({
        status: 'failed',
        reason: 'creator_not_authorized',
      });
      const stored = await ctx.prisma.inboundTrigger.findUniqueOrThrow({
        where: { id: trigger.id },
      });
      expect(stored).toMatchObject({
        enabled: false,
        disabledReason: 'creator_not_authorized',
      });
      const records = (await auditOf('trigger.update')).filter(
        (r) => r.actorType === 'system',
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        targetId: trigger.id,
        after: { enabled: false, disabledReason: 'creator_not_authorized' },
      });
      // Disabled now: the endpoint no longer admits it exists.
      expect((await deliver(trigger)).status).toBe(404);
    });

    it('a deleted creator → failed creator_not_authorized', async () => {
      const trigger = await createTrigger();
      await ctx.prisma.user.delete({ where: { id: adminId } });
      const response = await deliver(trigger);
      expect(response.body.status).toBe('failed');
    });
  });

  describe('firing outcomes', () => {
    it('orchestrator next → one orchestrator.start, recorded with its command run', async () => {
      const trigger = await createTrigger({
        action: { kind: 'orchestrator', mode: 'next' },
        allowedPaths: [],
      });
      expect((await deliver(trigger, { body: '{}' })).status).toBe(202);
      await settle();
      const sent = runner.sent('orchestrator.start');
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ projectId, mode: 'next' });
      const [row] = await deliveries(trigger.id);
      expect(row.status).toBe('started');
      expect(row.commandRunId).toEqual(expect.any(String));
    });

    it('an orchestrator already running → skipped previous_still_running', async () => {
      runner.state.answers['orchestrator.start'] = () =>
        refuse('already_running');
      const trigger = await createTrigger({
        action: { kind: 'orchestrator', mode: 'next' },
        allowedPaths: [],
      });
      await deliver(trigger, { body: '{}' });
      await settle();
      const [row] = await deliveries(trigger.id);
      expect(row).toMatchObject({
        status: 'skipped',
        reason: 'previous_still_running',
      });
    });

    it('a runner offline → failed runner_offline', async () => {
      runner.state.online = false;
      const trigger = await createTrigger();
      await deliver(trigger);
      await settle();
      const [row] = await deliveries(trigger.id);
      expect(row).toMatchObject({ status: 'failed', reason: 'runner_offline' });
    });

    it('a stop budget (#28: 409 budget_exceeded) → skipped before_fire_denied', async () => {
      jest
        .spyOn(ctx.app.get(SkillRunService), 'start')
        .mockRejectedValue(
          new HttpException(
            { statusCode: 409, code: 'budget_exceeded', budgetId: 'b1' },
            409,
          ),
        );
      const trigger = await createTrigger();
      await deliver(trigger);
      await settle();
      const [row] = await deliveries(trigger.id);
      expect(row).toMatchObject({
        status: 'skipped',
        reason: 'before_fire_denied',
      });
      expect(runner.sent('skill.run')).toEqual([]);
    });

    it('a skill no longer installed → failed command_failed', async () => {
      await ctx.prisma.installedSkill.deleteMany();
      const trigger = await createTrigger();
      await deliver(trigger);
      await settle();
      const [row] = await deliveries(trigger.id);
      expect(row).toMatchObject({ status: 'failed', reason: 'command_failed' });
    });
  });
});
