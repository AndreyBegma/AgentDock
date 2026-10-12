import {
  WEBHOOK_CIRCUIT_OPEN_MS,
  WEBHOOK_CIRCUIT_THRESHOLD,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_SUMMARY_MAX_CHARS,
  type WebhookEnvelope,
  type WebhookView,
  type WebhookWithSecret,
} from '@agentdock/shared';
import { REPO, ROOT, seedProject } from '../../fleet/testing/fleet-e2e';
import type { Session } from '../../test/e2e-app';
import { verifyOutboundSignature } from '../common';
import {
  allowN8n as allowTarget,
  WEBHOOKS_ROUTE as BASE,
  createHook as createWebhook,
  sendTest as enqueueTest,
  type OutboundE2e,
  type Receiver,
  useOutboundFixture,
} from './testing/outbound-e2e';

const MID = () => 0.5;
const SECOND = 1000;

describe('outbound webhooks: dispatch and delivery (e2e, spec 26)', () => {
  const fixture = useOutboundFixture();
  let ctx: OutboundE2e;
  let receiver: Receiver;
  let admin: Session;
  beforeEach(() => {
    ({ ctx, receiver, admin } = fixture());
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

  describe('signature (D13, D17)', () => {
    it('signs so the documented recipe verifies; after rotation only the new secret does', async () => {
      await allowN8n();
      const created = await createHook();
      const first = await sendTest(created.id);
      await ctx.worker.tick(soon());
      const [request] = receiver.requests;
      expect(request.headers['x-agentdock-event']).toBe('webhook.test');
      expect(request.headers['x-agentdock-delivery']).toBe(first.id);
      expect(request.headers['content-type']).toBe('application/json');
      const signature = request.headers['x-agentdock-signature'] as string;
      expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(
        verifyOutboundSignature(signature, request.body, created.secret),
      ).toBe(true);
      const envelope = JSON.parse(request.body) as WebhookEnvelope;
      expect(envelope).toMatchObject({
        id: `test_${first.id}`,
        type: 'webhook.test',
        project: null,
        data: { message: expect.any(String) },
      });

      const rotated = (
        await admin.send('post', `${BASE}/${created.id}/rotate-secret`)
      ).body as WebhookWithSecret;
      expect(rotated.secret).not.toBe(created.secret);
      receiver.reset();
      await sendTest(created.id);
      await ctx.worker.tick(soon());
      const [after] = receiver.requests;
      const header = after.headers['x-agentdock-signature'] as string;
      expect(verifyOutboundSignature(header, after.body, rotated.secret)).toBe(
        true,
      );
      expect(verifyOutboundSignature(header, after.body, created.secret)).toBe(
        false,
      );
    });

    it('fails an attempt whose secret cannot be opened without touching the circuit', async () => {
      await allowN8n();
      const { id } = await createHook();
      await ctx.prisma.webhook.update({
        where: { id },
        data: { secret: 'v1:not-a-real-ciphertext', consecutiveFailures: 9 },
      });
      const test = await sendTest(id);
      await ctx.worker.tick(soon());
      expect(receiver.requests).toHaveLength(0);
      expect(await delivery(test.id)).toMatchObject({
        status: 'pending',
        error: 'secret_unavailable',
      });
      expect(await webhook(id)).toMatchObject({
        circuitState: 'closed',
        consecutiveFailures: 9,
      });
    });
  });

  describe('retries and circuit breaker (D12, D14)', () => {
    it('retries at ~30 s, ~60 s, ~120 s … and fails after 8 attempts', async () => {
      await allowN8n();
      const { id } = await createHook();
      receiver.status = 500;
      const test = await sendTest(id);
      let now = soon();
      const delays: number[] = [];
      for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
        expect(await ctx.worker.tick(now, MID)).toBe(1);
        const row = await delivery(test.id);
        expect(row.attempts).toBe(attempt);
        expect(row.responseCode).toBe(500);
        expect(row.error).toBe('http_status');
        if (attempt < WEBHOOK_MAX_ATTEMPTS) {
          expect(row.status).toBe('pending');
          delays.push(row.nextAttemptAt.getTime() - now.getTime());
          // Not due before its time.
          expect(
            await ctx.worker.tick(new Date(row.nextAttemptAt.getTime() - 1)),
          ).toBe(0);
          now = row.nextAttemptAt;
        } else {
          expect(row.status).toBe('failed');
        }
      }
      expect(delays).toEqual(
        [30, 60, 120, 240, 480, 960, 1920].map((s) => s * SECOND),
      );
      expect(receiver.requests).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
      expect(await ctx.worker.tick(new Date(now.getTime() + 86_400_000))).toBe(
        0,
      );
    });

    it('opens the circuit after 10 failures, holds deliveries, and closes on a success after 15 minutes', async () => {
      await allowN8n();
      const { id } = await createHook();
      receiver.status = 500;
      await ctx.prisma.webhookDelivery.createMany({
        data: Array.from({ length: WEBHOOK_CIRCUIT_THRESHOLD }, () => ({
          webhookId: id,
          eventType: 'webhook.test',
          payload: {},
        })),
      });
      const t0 = soon();
      expect(await ctx.worker.tick(t0, MID)).toBe(WEBHOOK_CIRCUIT_THRESHOLD);
      expect(await webhook(id)).toMatchObject({
        circuitState: 'open',
        consecutiveFailures: WEBHOOK_CIRCUIT_THRESHOLD,
        circuitOpenedAt: t0,
      });
      const shown = (await admin.get(`${BASE}/${id}`)).body as WebhookView;
      expect(shown.circuitState).toBe('open');

      // Due, but held: nothing is attempted while the circuit is open.
      receiver.reset();
      expect(await ctx.worker.tick(new Date(t0.getTime() + 60 * SECOND))).toBe(
        0,
      );
      expect(receiver.requests).toHaveLength(0);
      expect(
        await ctx.prisma.webhookDelivery.count({
          where: { webhookId: id, status: 'pending' },
        }),
      ).toBe(WEBHOOK_CIRCUIT_THRESHOLD);

      // After 15 minutes exactly one half-open probe; its success closes it.
      const later = new Date(t0.getTime() + WEBHOOK_CIRCUIT_OPEN_MS);
      expect(await ctx.worker.tick(later)).toBe(1);
      expect(await webhook(id)).toMatchObject({
        circuitState: 'closed',
        consecutiveFailures: 0,
        circuitOpenedAt: null,
      });
      expect(await ctx.worker.tick(later)).toBe(WEBHOOK_CIRCUIT_THRESHOLD - 1);
      expect(
        await ctx.prisma.webhookDelivery.count({
          where: { webhookId: id, status: 'succeeded' },
        }),
      ).toBe(WEBHOOK_CIRCUIT_THRESHOLD);
    });

    it('reopens on a failed probe, and an admin can close the circuit by hand', async () => {
      await allowN8n();
      const { id } = await createHook();
      const opened = new Date(Date.now() - WEBHOOK_CIRCUIT_OPEN_MS - SECOND);
      await ctx.prisma.webhook.update({
        where: { id },
        data: {
          circuitState: 'open',
          circuitOpenedAt: opened,
          consecutiveFailures: 10,
        },
      });
      receiver.status = 500;
      await sendTest(id);
      await sendTest(id);
      const now = soon();
      expect(await ctx.worker.tick(now)).toBe(1);
      expect(await webhook(id)).toMatchObject({
        circuitState: 'open',
        circuitOpenedAt: now,
        consecutiveFailures: 11,
      });

      const closed = await admin.send('post', `${BASE}/${id}/close-circuit`);
      expect(closed.body).toMatchObject({
        circuitState: 'closed',
        consecutiveFailures: 0,
      });
      receiver.status = 200;
      expect(
        await ctx.worker.tick(new Date(now.getTime() + 10 * 60 * SECOND)),
      ).toBe(2);
    });

    it('holds the deliveries of a disabled webhook', async () => {
      await allowN8n();
      const { id } = await createHook();
      await sendTest(id);
      await admin.send('patch', `${BASE}/${id}`, { enabled: false });
      expect(await ctx.worker.tick(soon())).toBe(0);
      await admin.send('patch', `${BASE}/${id}`, { enabled: true });
      expect(await ctx.worker.tick(soon())).toBe(1);
    });

    it('redelivers a failed delivery once, with the same payload and a new signature', async () => {
      await allowN8n();
      const created = await createHook();
      const test = await sendTest(created.id);
      await ctx.prisma.webhookDelivery.update({
        where: { id: test.id },
        data: {
          status: 'failed',
          attempts: WEBHOOK_MAX_ATTEMPTS,
          error: 'http_status',
        },
      });
      const response = await admin.send(
        'post',
        `${BASE}/${created.id}/deliveries/${test.id}/redeliver`,
      );
      expect(response.body).toMatchObject({ status: 'pending', error: null });
      await ctx.worker.tick(soon());
      expect(await delivery(test.id)).toMatchObject({
        status: 'succeeded',
        attempts: WEBHOOK_MAX_ATTEMPTS + 1,
      });
      const [request] = receiver.requests;
      expect(JSON.parse(request.body)).toEqual(test.payload);
      expect(
        verifyOutboundSignature(
          request.headers['x-agentdock-signature'] as string,
          request.body,
          created.secret,
        ),
      ).toBe(true);
    });
  });

  describe('dispatcher (D9–D11)', () => {
    let runnerId: string;
    let projectId: string;
    let seq = 0;

    const store = (
      type: string,
      data: object,
      extra: { slot?: string; issue?: number; source?: string } = {},
    ) => {
      seq += 1;
      return ctx.prisma.event.create({
        data: {
          runnerId,
          seq: BigInt(seq),
          ts: new Date('2026-10-10T10:00:00Z'),
          type,
          source: extra.source ?? 'code-sentinel',
          projectRoot: ROOT,
          projectRepo: REPO,
          slot: extra.slot,
          issue: extra.issue,
          data,
        },
      });
    };

    beforeEach(async () => {
      ({ runnerId, projectId } = await seedProject(ctx.prisma));
      seq = 0;
      await allowN8n();
      // First pass: the cursor starts after everything already stored.
      expect(await ctx.dispatcher.tick()).toBe(0);
    });

    it('creates one delivery per matching webhook, and none twice on replay', async () => {
      const a = await createHook({ name: 'a', events: ['pr.merged'] });
      const b = await createHook({
        name: 'b',
        events: ['pr.merged'],
        projectIds: [projectId],
      });
      await createHook({ name: 'c', events: ['pr.opened'] });
      const other = await seedProject(ctx.prisma, '/srv/dev/other', runnerId);
      await createHook({
        name: 'd',
        events: ['pr.merged'],
        projectIds: [other.projectId],
      });
      const event = await store(
        'pr.merged',
        { number: 7, branch: 'feat/x', method: 'squash' },
        { issue: 26 },
      );

      expect(await ctx.dispatcher.tick()).toBe(2);
      const rows = await ctx.prisma.webhookDelivery.findMany({
        orderBy: { webhookId: 'asc' },
      });
      expect(rows.map((r) => r.webhookId).sort()).toEqual([a.id, b.id].sort());
      expect(rows[0].payload).toEqual({
        id: `evt_${event.id}`,
        type: 'pr.merged',
        ts: '2026-10-10T10:00:00.000Z',
        project: { id: projectId, repo: REPO },
        issue: 26,
        data: { number: 7, branch: 'feat/x', method: 'squash' },
      });

      await ctx.prisma.webhookDispatcherState.update({
        where: { id: 'webhooks' },
        data: { eventsCursor: event.id - 1n },
      });
      expect(await ctx.dispatcher.tick()).toBe(0);
      expect(await ctx.prisma.webhookDelivery.count()).toBe(2);
    });

    it('never sends llm.request, tool.call or pane text, and copies only allowlisted checkpoint keys', async () => {
      await createHook({ events: ['slot.checkpoint', 'pane.prompt'] });
      await store('llm.request', { prompt: 'secret prompt' });
      await store('tool.call', { tool: 'Bash', input: 'rm -rf /' });
      await store('pane.output', { text: 'pane text' });
      await store('webhook.test', { message: 'forged' });
      await store(
        'slot.checkpoint',
        {
          checkpoint: 'pull request open',
          summary: 'x'.repeat(WEBHOOK_SUMMARY_MAX_CHARS + 50),
          prNumber: 101,
          prUrl: 'https://github.com/acme/widget/pull/101',
          worktree: '/home/someone/.wt-secret',
          briefPath: '/home/someone/brief.md',
          text: 'pane text',
          nested: { a: 1 },
        },
        { slot: 'i26-outbound', issue: 26 },
      );

      expect(await ctx.dispatcher.tick()).toBe(1);
      const [row] = await ctx.prisma.webhookDelivery.findMany();
      const envelope = row.payload as unknown as WebhookEnvelope;
      expect(envelope.type).toBe('slot.checkpoint');
      expect(envelope.slot).toBe('i26-outbound');
      expect(Object.keys(envelope.data).sort()).toEqual([
        'checkpoint',
        'pr',
        'summary',
      ]);
      expect(String(envelope.data.summary)).toHaveLength(
        WEBHOOK_SUMMARY_MAX_CHARS,
      );
      expect(envelope.data.pr).toEqual({
        number: 101,
        url: 'https://github.com/acme/widget/pull/101',
      });
      expect(JSON.stringify(envelope)).not.toContain('/home/someone');
    });

    it('skips a scraped checkpoint the live plugin channel already sent', async () => {
      await createHook({ events: ['slot.checkpoint'] });
      await store('slot.checkpoint', { checkpoint: 'plan ready' });
      await store(
        'slot.checkpoint',
        { checkpoint: 'plan ready' },
        { source: 'scraped' },
      );
      expect(await ctx.dispatcher.tick()).toBe(1);
    });

    it('creates nothing for a disabled webhook', async () => {
      const { id } = await createHook({ events: ['pr.merged'] });
      await admin.send('patch', `${BASE}/${id}`, { enabled: false });
      await store('pr.merged', { number: 1 });
      expect(await ctx.dispatcher.tick()).toBe(0);
      expect(
        (
          await ctx.prisma.webhookDispatcherState.findUniqueOrThrow({
            where: { id: 'webhooks' },
          })
        ).eventsCursor,
      ).toBeGreaterThan(0n);
    });

    it('delivers what it dispatched end to end', async () => {
      const hook = await createHook({ events: ['pr.merged'] });
      await store('pr.merged', { number: 9 });
      await ctx.dispatcher.tick();
      expect(await ctx.worker.tick(soon())).toBe(1);
      const [request] = receiver.requests;
      expect(request.headers['x-agentdock-event']).toBe('pr.merged');
      expect(
        verifyOutboundSignature(
          request.headers['x-agentdock-signature'] as string,
          request.body,
          hook.secret,
        ),
      ).toBe(true);
    });
  });

  describe('retention (D18)', () => {
    it('deletes deliveries of both directions older than 30 days', async () => {
      await allowN8n();
      const { id } = await createHook();
      const now = new Date('2026-10-10T00:00:00Z');
      const old = new Date(now.getTime() - 31 * 86_400_000);
      const recent = new Date(now.getTime() - 29 * 86_400_000);
      await ctx.prisma.webhookDelivery.createMany({
        data: [old, recent].map((createdAt) => ({
          webhookId: id,
          eventType: 'webhook.test',
          payload: {},
          createdAt,
        })),
      });
      const { projectId } = await seedProject(ctx.prisma);
      const trigger = await ctx.prisma.inboundTrigger.create({
        data: {
          publicId: 'p'.repeat(24),
          name: 'ci',
          projectId,
          action: { kind: 'orchestrator', mode: 'next' },
          allowedPaths: [],
          secret: 'v1:sealed',
          bucketTokens: 30,
          bucketRefilledAt: now,
        },
      });
      await ctx.prisma.inboundDelivery.createMany({
        data: [old, recent].map((receivedAt, i) => ({
          triggerId: trigger.id,
          deliveryId: `d-${i}`,
          status: 'accepted' as const,
          receivedAt,
        })),
      });

      expect(await ctx.retention.sweep(now)).toEqual({
        outbound: 1,
        inbound: 1,
      });
      expect(await ctx.prisma.webhookDelivery.count()).toBe(1);
      expect(await ctx.prisma.inboundDelivery.count()).toBe(1);
    });
  });
});
