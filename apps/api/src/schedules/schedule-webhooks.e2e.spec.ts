import type { WebhookEnvelope } from '@agentdock/shared';
import type { CommandName } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { BudgetClock } from '../budgets/budget-options';
import { BudgetSweep } from '../budgets/budget-sweep';
import { Feed } from '../budgets/testing/budgets-e2e';
import { REPO, ROOT, seedProject } from '../fleet/testing/fleet-e2e';
import { seedPrices } from '../prices/seed-prices';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { ingest, resetUsage } from '../usage/testing/usage-e2e';
import { verifyOutboundSignature } from '../webhooks/common';
import {
  allowN8n,
  createHook,
  type OutboundFixture,
  useOutboundFixture,
} from '../webhooks/outbound/testing/outbound-e2e';
import { ScheduleFireProcessor } from './schedule-fire.processor';
import { ScheduleMaintenance } from './schedule-maintenance';
import { dueTick } from './testing/schedule-e2e';

type Answer = CommandSendResult<CommandName>;

const at = (s: string) => new Date(s);
/** Past the dispatcher's hole grace and the delivery's `nextAttemptAt`. */
const later = () => Date.now() + 60_000;

/**
 * Issue #107: `schedule.failed` and `schedule.disabled` reach outbound
 * webhooks. They are `events` rows (ADR-0014, keyed by firing), so the D11
 * dispatcher sends them like any other event: once per firing, signed.
 */
describe('schedule events to outbound webhooks (e2e)', () => {
  const fixture = useOutboundFixture();
  let f: OutboundFixture;
  let tick: (now: Date) => Promise<bigint[]>;
  let projectId: string;
  let runnerId: string;
  let online: boolean;

  const scheduleDue = (due: Date) =>
    f.ctx.prisma.schedule.create({
      data: {
        projectId,
        name: 'Nightly',
        target: { kind: 'orchestrator', mode: 'next' },
        cron: '0 * * * *',
        timezone: 'UTC',
        nextRunAt: due,
        createdById: f.adminId,
      },
    });

  /** Fires `scheduleId` at each hour in `hours`, as its timer would. */
  const fireAt = async (scheduleId: string, hours: number[]) => {
    for (const hour of hours) {
      const due = at(`2026-10-09T${hour}:00:00Z`);
      await f.ctx.prisma.schedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: due },
      });
      await tick(new Date(due.getTime() + 5000));
    }
  };

  /** Dispatches, then delivers; returns what the receiver got. */
  const deliver = async () => {
    await f.ctx.dispatcher.tick(later());
    await f.ctx.worker.tick(new Date(later()));
    return f.receiver.requests.map((request) => ({
      request,
      envelope: JSON.parse(request.body) as WebhookEnvelope,
    }));
  };

  beforeEach(async () => {
    f = fixture();
    tick = dueTick(
      f.ctx.prisma,
      f.ctx.app.get(ScheduleFireProcessor),
      f.ctx.app.get(ScheduleMaintenance),
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await resetUsage(f.ctx.prisma);
    await seedPrices(f.ctx.prisma);
    ({ runnerId, projectId } = await seedProject(f.ctx.prisma));
    const profile = await f.ctx.prisma.runtimeProfile.create({
      data: {
        runnerId,
        key: 'claude-main',
        runtime: 'claude',
        label: 'Claude',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await f.ctx.prisma.projectOrchestratorSettings.create({
      data: { projectId, profileId: profile.id },
    });
    online = true;
    jest
      .spyOn(f.ctx.app.get(RunnerPresence), 'isConnected')
      .mockImplementation(() => online);
    jest.spyOn(f.ctx.app.get(RunnerCommandService), 'send').mockImplementation(
      async () =>
        ({
          status: 'ok',
          output: {
            session: 'agentdock-orch-a',
            startedAt: new Date().toISOString(),
          },
          rttMs: 1,
        }) as Answer as never,
    );
    await allowN8n(f.admin);
    // First pass: the cursor starts after everything already stored.
    expect(await f.ctx.dispatcher.tick()).toBe(0);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a failed firing is one signed schedule.failed delivery, and a replay of the firing adds none', async () => {
    const hook = await createHook(f, { events: ['schedule.failed'] });
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));
    online = false;

    await fireAt(schedule.id, [10]);
    const firing = await f.ctx.prisma.scheduleFiring.findFirstOrThrow({
      where: { scheduleId: schedule.id },
    });
    expect(firing.status).toBe('failed');

    const received = await deliver();
    expect(received).toHaveLength(1);
    const [{ request, envelope }] = received;
    expect(request.headers['x-agentdock-event']).toBe('schedule.failed');
    expect(
      verifyOutboundSignature(
        request.headers['x-agentdock-signature'] as string,
        request.body,
        hook.secret,
      ),
    ).toBe(true);
    expect(envelope).toMatchObject({
      id: expect.stringMatching(/^evt_\d+$/),
      type: 'schedule.failed',
      project: { id: projectId, repo: REPO },
      data: {
        scheduleId: schedule.id,
        name: 'Nightly',
        reason: firing.reason,
      },
    });

    // A BullMQ redelivery of the same job: the firing is claimed already.
    await f.ctx.app.get(ScheduleFireProcessor).handle(
      {
        scheduleId: schedule.id,
        scheduledFor: firing.scheduledFor.toISOString(),
      },
      new Date(firing.scheduledFor.getTime() + 6000),
    );
    expect(await deliver()).toHaveLength(1);
    expect(
      await f.ctx.prisma.webhookDelivery.count({
        where: { webhookId: hook.id },
      }),
    ).toBe(1);
  });

  it('auto-disable after repeated failures is one schedule.disabled delivery', async () => {
    const hook = await createHook(f, {
      events: ['schedule.failed', 'schedule.disabled'],
    });
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));
    online = false;

    await fireAt(schedule.id, [10, 11, 12, 13, 14]);
    const after = await f.ctx.prisma.schedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(after.enabled).toBe(false);

    const received = await deliver();
    expect(received.map(({ envelope }) => envelope.type)).toEqual([
      ...Array(5).fill('schedule.failed'),
      'schedule.disabled',
    ]);
    const disabled = received[5];
    expect(
      verifyOutboundSignature(
        disabled.request.headers['x-agentdock-signature'] as string,
        disabled.request.body,
        hook.secret,
      ),
    ).toBe(true);
    expect(disabled.envelope).toMatchObject({
      project: { id: projectId, repo: REPO },
      data: { scheduleId: schedule.id, name: 'Nightly', reason: 'failing' },
    });
    expect(await deliver()).toHaveLength(6);
  });

  it('a budget-skipped firing sends nothing', async () => {
    const clock = f.ctx.app.get(BudgetClock);
    const now = Date.parse('2026-10-09T10:00:00.000Z');
    clock.set(new Date(now));
    try {
      await createHook(f, { events: ['schedule.failed', 'schedule.disabled'] });
      await f.ctx.prisma.budget.create({
        data: {
          scope: 'project',
          projectId,
          period: 'day',
          timezone: 'UTC',
          limitUsd: '1',
          thresholds: [100],
          action: 'stop',
        },
      });
      const feed = new Feed();
      await ingest(f.ctx, runnerId, [
        feed.session('w', `${ROOT}-wt/i1`, new Date(now - 2000).toISOString(), {
          projectId,
          slot: 'i1',
        }),
        feed.spend('w', 'r1', new Date(now - 1000).toISOString()),
      ]);
      await f.ctx.app.get(BudgetSweep).flush();
      const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));

      await tick(at('2026-10-09T10:00:05Z'));

      const firing = await f.ctx.prisma.scheduleFiring.findFirstOrThrow({
        where: { scheduleId: schedule.id },
      });
      expect(firing.status).toBe('skipped');
      expect(await deliver()).toHaveLength(0);
      expect(await f.ctx.prisma.webhookDelivery.count()).toBe(0);
    } finally {
      clock.set(null);
    }
  });
});
