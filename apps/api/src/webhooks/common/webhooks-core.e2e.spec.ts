import { userActor } from '../../audit/audit.types';
import { seedProject } from '../../fleet/testing/fleet-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  nextIp,
} from '../../test/e2e-app';
import { newTriggerPublicId } from './secrets';
import { WebhookSettingsService } from './webhook-settings.service';
import { WebhooksFailure } from './webhooks-error';

const reset = (ctx: E2eContext) =>
  ctx.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE user_sessions, settings, users, runners, projects, webhooks CASCADE',
  );

const UNIQUE_VIOLATION = { code: 'P2002' };

describe('webhooks core (e2e)', () => {
  let ctx: E2eContext;

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => reset(ctx));

  describe('tables (spec 26 "Data / Schema")', () => {
    const seedTrigger = async () => {
      const { projectId } = await seedProject(ctx.prisma);
      const admin = await createUser(ctx.prisma, 'ada@example.com', 'admin');
      const trigger = await ctx.prisma.inboundTrigger.create({
        data: {
          publicId: newTriggerPublicId(),
          name: 'CI failure',
          projectId,
          action: { kind: 'orchestrator', mode: 'next' },
          allowedPaths: ['branch'],
          secret: 'v1:sealed',
          bucketTokens: 30,
          bucketRefilledAt: new Date(),
          createdById: admin.id,
        },
      });
      return { projectId, admin, trigger };
    };

    it('makes (triggerId, deliveryId) the replay nonce', async () => {
      const { trigger } = await seedTrigger();
      const delivery = {
        triggerId: trigger.id,
        deliveryId: 'd-1',
        status: 'accepted' as const,
      };
      await ctx.prisma.inboundDelivery.create({ data: delivery });
      await expect(
        ctx.prisma.inboundDelivery.create({ data: delivery }),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
    });

    it('keeps a trigger whose creator is deleted, without a creator (D5)', async () => {
      const { trigger, admin } = await seedTrigger();
      await ctx.prisma.user.delete({ where: { id: admin.id } });
      const kept = await ctx.prisma.inboundTrigger.findUniqueOrThrow({
        where: { id: trigger.id },
      });
      expect(kept.createdById).toBeNull();
    });

    it('deletes triggers and their deliveries with the project', async () => {
      const { trigger, projectId } = await seedTrigger();
      await ctx.prisma.inboundDelivery.create({
        data: { triggerId: trigger.id, deliveryId: 'd-1', status: 'skipped' },
      });
      await ctx.prisma.project.delete({ where: { id: projectId } });
      expect(await ctx.prisma.inboundTrigger.count()).toBe(0);
      expect(await ctx.prisma.inboundDelivery.count()).toBe(0);
    });

    it('makes (webhookId, eventId) the dispatcher idempotency key (D11)', async () => {
      const { runnerId } = await seedProject(ctx.prisma);
      const event = await ctx.prisma.event.create({
        data: {
          runnerId,
          seq: 1n,
          ts: new Date(),
          type: 'pr.merged',
          source: 'github',
          data: { number: 7 },
        },
      });
      const webhook = (name: string) =>
        ctx.prisma.webhook.create({
          data: {
            name,
            url: 'https://hooks.example/a',
            events: ['pr.merged'],
            secret: 'v1:x',
          },
        });
      const [a, b] = [await webhook('a'), await webhook('b')];
      const delivery = (webhookId: string, eventId: bigint | null) =>
        ctx.prisma.webhookDelivery.create({
          data: { webhookId, eventId, eventType: 'pr.merged', payload: {} },
        });

      await delivery(a.id, event.id);
      await delivery(b.id, event.id);
      await expect(delivery(a.id, event.id)).rejects.toMatchObject(
        UNIQUE_VIOLATION,
      );
      // `webhook.test` deliveries have no event; any number of them may exist.
      await delivery(a.id, null);
      await delivery(a.id, null);

      const fresh = await ctx.prisma.webhookDelivery.findFirstOrThrow({
        where: { webhookId: b.id },
      });
      expect(fresh).toMatchObject({ status: 'pending', attempts: 0 });
      expect(a.circuitState).toBe('closed');

      await ctx.prisma.webhook.delete({ where: { id: a.id } });
      expect(await ctx.prisma.webhookDelivery.count()).toBe(1);
    });
  });

  describe('WebhookSettingsService (D15)', () => {
    it('stores normalised entries, reads them back, and audits the change', async () => {
      const admin = await createUser(ctx.prisma, 'ada@example.com', 'admin');
      const service = ctx.app.get(WebhookSettingsService);
      expect(await service.allowedPrivateTargets()).toEqual([]);

      const stored = await service.setAllowedPrivateTargets(
        [' N8N.lan', '192.168.1.0/24', 'n8n.lan'],
        admin.id,
        { actor: userActor(admin.id) },
      );
      expect(stored).toEqual(['n8n.lan', '192.168.1.0/24']);
      expect(await service.allowedPrivateTargets()).toEqual(stored);

      const allowlist = await service.allowlist();
      expect(allowlist.hasHost('n8n.lan')).toBe(true);
      expect(allowlist.hasAddress('192.168.1.77')).toBe(true);
      expect(allowlist.hasAddress('192.168.2.1')).toBe(false);

      const record = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'settings.webhooks' },
        orderBy: { seq: 'desc' },
      });
      expect(record).toMatchObject({
        actorUserId: admin.id,
        targetId: 'webhooks.allowedPrivateTargets',
        before: { allowedPrivateTargets: [] },
        after: { allowedPrivateTargets: stored },
        result: 'ok',
      });
    });

    it('refuses an entry that is not a host, address or CIDR with 422 invalid_target', async () => {
      const admin = await createUser(ctx.prisma, 'ada@example.com', 'admin');
      const service = ctx.app.get(WebhookSettingsService);
      for (const entry of ['http://n8n.lan', '10.0.0.0/40', 'n8n.lan:5678']) {
        const attempt = service.setAllowedPrivateTargets([entry], admin.id, {
          actor: userActor(admin.id),
        });
        await expect(attempt).rejects.toBeInstanceOf(WebhooksFailure);
        await expect(attempt).rejects.toMatchObject({
          statusCode: 422,
          code: 'invalid_target',
        });
      }
      expect(await service.allowedPrivateTargets()).toEqual([]);
    });

    it('ignores a hand-edited row that is not a list of valid entries', async () => {
      await ctx.prisma.setting.create({
        data: {
          key: 'webhooks.allowedPrivateTargets',
          value: ['n8n.lan', 42, '10.0.0.0/99'],
        },
      });
      expect(
        await ctx.app.get(WebhookSettingsService).allowedPrivateTargets(),
      ).toEqual(['n8n.lan']);
    });
  });

  describe('raw body capture in the app (D8)', () => {
    it('answers 413 above 256 KB on a hook route', async () => {
      const response = await ctx
        .http()
        .post('/hooks/abcdefghijklmnopqrstuvwx')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ blob: 'x'.repeat(256 * 1024) }));
      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({ error: 'payload_too_large' });
    });

    it('still parses JSON on every other route', async () => {
      // Parsed: the DTO sees the fields and the credentials are simply wrong.
      const response = await ctx
        .http()
        .post('/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: 'nobody@example.com', password: 'wrong password here' });
      expect(response.status).toBe(401);
    });
  });
});
