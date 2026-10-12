import type { WebhookDeliveryPage, WebhookWithSecret } from '@agentdock/shared';
import { SecretCipher } from '../../common/crypto';
import { createUser, login, type Session } from '../../test/e2e-app';
import {
  allowN8n as allowTarget,
  WEBHOOKS_ROUTE as BASE,
  createHook as createWebhook,
  sendTest as enqueueTest,
  OUTBOUND_TEST_KEY,
  type OutboundE2e,
  type Receiver,
  WEBHOOK_SETTINGS_ROUTE as SETTINGS,
  useOutboundFixture,
} from './testing/outbound-e2e';

const SECOND = 1000;

describe('outbound webhooks: admin API and SSRF guard (e2e, spec 26)', () => {
  const fixture = useOutboundFixture();
  let ctx: OutboundE2e;
  let receiver: Receiver;
  let admin: Session;
  let adminId: string;
  beforeEach(() => {
    ({ ctx, receiver, admin, adminId } = fixture());
  });

  const allowN8n = () => allowTarget(admin);
  const createHook = (body: Parameters<typeof createWebhook>[1] = {}) =>
    createWebhook(fixture(), body);
  const sendTest = (id: string) => enqueueTest(admin, id);
  const delivery = (id: string) =>
    ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
  const webhook = (id: string) =>
    ctx.prisma.webhook.findUniqueOrThrow({ where: { id } });
  const soon = () => new Date(Date.now() + SECOND);

  describe('authorization (D16)', () => {
    const ROUTES: ['get' | 'post' | 'patch' | 'put' | 'delete', string][] = [
      ['get', BASE],
      ['post', BASE],
      ['get', `${BASE}/x`],
      ['patch', `${BASE}/x`],
      ['delete', `${BASE}/x`],
      ['get', `${BASE}/x/deliveries`],
      ['post', `${BASE}/x/deliveries/y/redeliver`],
      ['post', `${BASE}/x/test`],
      ['post', `${BASE}/x/close-circuit`],
      ['post', `${BASE}/x/rotate-secret`],
      ['get', SETTINGS],
      ['put', SETTINGS],
    ];

    it('answers 403 to operators and viewers and 401 to anonymous callers', async () => {
      await createUser(ctx.prisma, 'olga@example.com', 'operator');
      await createUser(ctx.prisma, 'vic@example.com', 'viewer');
      const operator = await login(ctx, 'olga@example.com');
      const viewer = await login(ctx, 'vic@example.com');
      for (const [method, path] of ROUTES) {
        for (const session of [operator, viewer]) {
          const response =
            method === 'get'
              ? await session.get(path)
              : await session.send(method, path, {});
          expect([method, path, response.status]).toEqual([method, path, 403]);
        }
        const anonymous = await ctx.http()[method](path).send({});
        expect([method, path, anonymous.status]).toEqual([method, path, 401]);
      }
    });
  });

  describe('admin API, secrets and audit (D17, D19)', () => {
    it('shows the secret once, stores ciphertext, and never echoes it', async () => {
      await allowN8n();
      const created = await createHook();
      expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const row = await webhook(created.id);
      expect(row.secret).not.toContain(created.secret);
      expect(
        SecretCipher.fromKeyText(OUTBOUND_TEST_KEY).decrypt(row.secret),
      ).toBe(created.secret);

      const list = await admin.get(BASE);
      const detail = await admin.get(`${BASE}/${created.id}`);
      expect(list.status).toBe(200);
      expect(detail.status).toBe(200);
      for (const response of [list, detail]) {
        expect(response.text).not.toContain(created.secret);
        expect(response.text).not.toContain(row.secret);
      }
      expect(detail.body).toMatchObject({
        name: 'n8n',
        circuitState: 'closed',
        consecutiveFailures: 0,
        lastDelivery: null,
        createdById: adminId,
      });
      expect(detail.body).not.toHaveProperty('secret');
    });

    it('audits every D19 action without the secret', async () => {
      await allowN8n();
      const created = await createHook();
      const { id } = created;
      expect(
        (await admin.send('patch', `${BASE}/${id}`, { name: 'renamed' })).body,
      ).toMatchObject({ name: 'renamed' });
      const rotated = await admin.send('post', `${BASE}/${id}/rotate-secret`);
      expect(rotated.status).toBe(200);
      const test = await sendTest(id);
      expect(
        (
          await admin.send(
            'post',
            `${BASE}/${id}/deliveries/${test.id}/redeliver`,
          )
        ).status,
      ).toBe(202);
      expect(
        (await admin.send('post', `${BASE}/${id}/close-circuit`)).status,
      ).toBe(200);
      expect((await admin.send('delete', `${BASE}/${id}`)).status).toBe(204);

      const records = await ctx.prisma.auditRecord.findMany({
        where: { targetType: 'webhook', targetId: id },
        orderBy: { seq: 'asc' },
      });
      expect(records.map((r) => r.action)).toEqual([
        'webhook.create',
        'webhook.update',
        'webhook.rotate_secret',
        'webhook.test',
        'webhook.redeliver',
        'webhook.circuit_close',
        'webhook.delete',
      ]);
      const secrets = [
        created.secret,
        (rotated.body as WebhookWithSecret).secret,
      ];
      for (const record of records) {
        expect(record.actorUserId).toBe(adminId);
        const text = JSON.stringify([record.before, record.after, record.meta]);
        for (const secret of secrets) expect(text).not.toContain(secret);
        expect(text).not.toContain('"secret"');
      }
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'settings.webhooks', actorUserId: adminId },
        }),
      ).toBe(1);
      expect(await ctx.prisma.webhook.count()).toBe(0);
      expect(await ctx.prisma.webhookDelivery.count()).toBe(0);
    });

    it('answers 404 for an unknown webhook, delivery or project', async () => {
      expect((await admin.get(`${BASE}/nope`)).status).toBe(404);
      await allowN8n();
      const { id } = await createHook();
      expect(
        (await admin.send('post', `${BASE}/${id}/deliveries/nope/redeliver`))
          .status,
      ).toBe(404);
      const response = await admin.send('post', BASE, {
        name: 'x',
        url: receiver.url(),
        events: ['pr.merged'],
        projectIds: ['no-such-project'],
      });
      expect(response.status).toBe(404);
    });

    it('validates the body', async () => {
      for (const body of [
        {
          name: 'x',
          url: receiver.url(),
          events: ['llm.request'],
          projectIds: [],
        },
        { name: 'x', url: receiver.url(), events: [], projectIds: [] },
        {
          name: '',
          url: receiver.url(),
          events: ['pr.merged'],
          projectIds: [],
        },
        { name: 'x', url: receiver.url(), events: ['pr.merged'] },
      ]) {
        expect((await admin.send('post', BASE, body)).status).toBe(400);
      }
    });

    it('pages the delivery log newest first and filters by status', async () => {
      await allowN8n();
      const { id } = await createHook();
      await ctx.prisma.webhookDelivery.createMany({
        data: Array.from({ length: 53 }, (_, i) => ({
          webhookId: id,
          eventType: 'webhook.test',
          payload: {},
          status: i % 2 === 0 ? ('succeeded' as const) : ('failed' as const),
          createdAt: new Date(Date.parse('2026-10-01T00:00:00Z') + i * SECOND),
        })),
      });
      const first = (await admin.get(`${BASE}/${id}/deliveries`))
        .body as WebhookDeliveryPage;
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).not.toBeNull();
      const second = (
        await admin.get(
          `${BASE}/${id}/deliveries?cursor=${first.nextCursor ?? ''}`,
        )
      ).body as WebhookDeliveryPage;
      expect(second.items).toHaveLength(3);
      expect(second.nextCursor).toBeNull();
      const all = [...first.items, ...second.items].map((d) => d.createdAt);
      expect(all).toEqual([...all].sort().reverse());

      const failed = (await admin.get(`${BASE}/${id}/deliveries?status=failed`))
        .body as WebhookDeliveryPage;
      expect(failed.items).toHaveLength(26);
      expect(failed.items.every((d) => d.status === 'failed')).toBe(true);
      expect(
        (await admin.get(`${BASE}/${id}/deliveries?cursor=bad!`)).status,
      ).toBe(400);
    });
  });

  describe('SSRF guard (D15)', () => {
    it.each([
      ['127.0.0.1', 'https://127.0.0.1/hook'],
      ['10.0.0.5', 'https://internal.example.com/hook'],
      ['169.254.169.254', 'https://metadata.example.com/hook'],
      ['100.100.1.1', 'https://tailnet.example.com/hook'],
      ['::1', 'https://[::1]/hook'],
    ])('refuses a URL resolving to %s at create', async (address, url) => {
      const host = new URL(url).hostname;
      if (!host.startsWith('[') && !/^\d/.test(host))
        ctx.dns.set(host, address);
      const response = await admin.send('post', BASE, {
        name: 'x',
        url,
        events: ['pr.merged'],
        projectIds: [],
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ error: 'blocked_address' });
      expect(await ctx.prisma.webhook.count()).toBe(0);
    });

    it('refuses plain http to a public host, and a URL that does not parse or resolve', async () => {
      const cases: [string, string][] = [
        ['http://hooks.example.com/x', 'https_required'],
        ['ftp://hooks.example.com/x', 'invalid_url'],
        ['https://user:pw@hooks.example.com/x', 'invalid_url'],
        ['https://nowhere.example.com/x', 'unresolvable'],
      ];
      for (const [url, error] of cases) {
        const response = await admin.send('post', BASE, {
          name: 'x',
          url,
          events: ['pr.merged'],
          projectIds: [],
        });
        expect([url, response.status, response.body.error]).toEqual([
          url,
          422,
          error,
        ]);
      }
    });

    it('re-checks a changed URL on update', async () => {
      const { id } = await createHook({ url: 'https://hooks.example.com/x' });
      ctx.dns.set('internal.example.com', '10.0.0.5');
      const response = await admin.send('patch', `${BASE}/${id}`, {
        url: 'https://internal.example.com/x',
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ error: 'blocked_address' });
      expect((await webhook(id)).url).toBe('https://hooks.example.com/x');
    });

    it('delivers to http://n8n.lan once an admin allowlists it', async () => {
      const refused = await admin.send('post', BASE, {
        name: 'n8n',
        url: receiver.url(),
        events: ['webhook.test'],
        projectIds: [],
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ error: 'blocked_address' });

      await allowN8n();
      expect((await admin.get(SETTINGS)).body).toEqual({
        allowedPrivateTargets: ['n8n.lan'],
      });
      const { id } = await createHook({ events: ['webhook.test'] });
      const test = await sendTest(id);
      expect(await ctx.worker.tick(soon())).toBe(1);
      expect(receiver.requests).toHaveLength(1);
      expect(await delivery(test.id)).toMatchObject({
        status: 'succeeded',
        attempts: 1,
        responseCode: 200,
        responseBody: 'ok',
        error: null,
      });
    });

    it('refuses at send time a name that now resolves to a private address', async () => {
      const { id } = await createHook({
        url: 'https://hooks.example.com/x',
      });
      ctx.dns.set('hooks.example.com', '10.0.0.5');
      const test = await sendTest(id);
      expect(await ctx.worker.tick(soon())).toBe(1);
      expect(await delivery(test.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        responseCode: null,
        error: 'blocked_address',
      });
    });

    it('records a 302 as a failure and does not follow it', async () => {
      await allowN8n();
      const { id } = await createHook();
      receiver.status = 302;
      receiver.location = `${receiver.url()}/followed`;
      const test = await sendTest(id);
      await ctx.worker.tick(soon());
      expect(receiver.requests.map((r) => r.path)).toEqual(['/hook']);
      expect(await delivery(test.id)).toMatchObject({
        status: 'pending',
        responseCode: 302,
        error: 'redirect',
      });
    });

    it('rejects a malformed allowlist entry', async () => {
      const response = await admin.send('put', SETTINGS, {
        allowedPrivateTargets: ['not a host!'],
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ error: 'invalid_target' });
    });
  });
});
