import type { BudgetExceededBody } from '@agentdock/shared';
import type { CommandName } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { BudgetClock } from '../budgets/budget-options';
import { BudgetSweep } from '../budgets/budget-sweep';
import { Feed } from '../budgets/testing/budgets-e2e';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { seedPrices } from '../prices/seed-prices';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
} from '../test/e2e-app';
import { ingest, resetUsage } from '../usage/testing/usage-e2e';
import { ScheduleFireProcessor } from './schedule-fire.processor';
import { ScheduleMaintenance } from './schedule-maintenance';
import { dueTick } from './testing/schedule-e2e';

type Answer = CommandSendResult<CommandName>;

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const at = (s: string) => new Date(s);

/**
 * Issue #106, spec 25 D12: an exceeded `stop` budget skips a firing — the
 * project's, or the firing principal's own (C-121, D-10).
 */
describe('schedules and budgets (e2e)', () => {
  let ctx: E2eContext;
  let clock: BudgetClock;
  let sweep: BudgetSweep;
  let tick: (now: Date) => Promise<bigint[]>;
  let runnerId: string;
  let projectId: string;
  let creatorId: string;
  let send: jest.SpyInstance;

  const exceedStopBudget = async () => {
    await ctx.prisma.budget.create({
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
    // One $1.50 request against a $1.00 limit.
    await ingest(ctx, runnerId, [
      feed.session('w', '/srv/a-wt/i1', new Date(NOW - 2000).toISOString(), {
        projectId,
        slot: 'i1',
      }),
      feed.spend('w', 'r1', new Date(NOW - 1000).toISOString()),
    ]);
    await sweep.flush();
  };

  const scheduleDue = (due: Date) =>
    ctx.prisma.schedule.create({
      data: {
        projectId,
        name: 'Nightly',
        target: { kind: 'orchestrator', mode: 'next' },
        cron: '0 * * * *',
        timezone: 'UTC',
        nextRunAt: due,
        createdById: creatorId,
      },
    });

  beforeAll(async () => {
    ctx = await createE2eApp();
    clock = ctx.app.get(BudgetClock);
    sweep = ctx.app.get(BudgetSweep);
    tick = dueTick(
      ctx.prisma,
      ctx.app.get(ScheduleFireProcessor),
      ctx.app.get(ScheduleMaintenance),
    );
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetUsage(ctx.prisma);
    await seedPrices(ctx.prisma);
    clock.set(new Date(NOW));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ({ runnerId, projectId } = await seedProject(ctx.prisma, '/srv/a'));
    creatorId = (await createUser(ctx.prisma, 'admin@example.com', 'admin')).id;
    const profile = await ctx.prisma.runtimeProfile.create({
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
    await ctx.prisma.projectOrchestratorSettings.create({
      data: { projectId, profileId: profile.id },
    });
    jest
      .spyOn(ctx.app.get(RunnerPresence), 'isConnected')
      .mockReturnValue(true);
    send = jest
      .spyOn(ctx.app.get(RunnerCommandService), 'send')
      .mockImplementation(
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
  });
  afterEach(() => {
    clock.set(null);
    jest.restoreAllMocks();
  });

  it('an exceeded stop budget skips the firing; the schedule stays enabled with no failure counted', async () => {
    await exceedStopBudget();
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));

    await tick(at('2026-10-09T10:00:05Z'));

    const [firing] = await ctx.prisma.scheduleFiring.findMany({
      where: { scheduleId: schedule.id },
    });
    expect(firing).toMatchObject({
      status: 'skipped',
      error: { code: 'denied', message: 'budget' },
    });
    expect(send).not.toHaveBeenCalled();
    const after = await ctx.prisma.schedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(after.enabled).toBe(true);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.nextRunAt).not.toBeNull();
  });

  it('skips every occurrence while exceeded, however many, and never auto-disables', async () => {
    await exceedStopBudget();
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));
    for (let hour = 0; hour < 6; hour += 1) {
      await ctx.prisma.schedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: new Date(NOW + hour * 3_600_000) },
      });
      await tick(new Date(NOW + hour * 3_600_000 + 5000));
    }
    const firings = await ctx.prisma.scheduleFiring.findMany({
      where: { scheduleId: schedule.id },
    });
    expect(firings.length).toBeGreaterThanOrEqual(6);
    expect(firings.every((f) => f.status === 'skipped')).toBe(true);
    const after = await ctx.prisma.schedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(after.enabled).toBe(true);
    expect(after.consecutiveFailures).toBe(0);
  });

  describe('the principal’s user budget (D-10)', () => {
    let operatorId: string;

    /** An operator of the project whose own orchestrator spent $1.50 of $1. */
    const exhaustedOperator = async () => {
      operatorId = (
        await createUser(ctx.prisma, 'operator@example.com', 'operator')
      ).id;
      await ctx.prisma.projectMember.create({
        data: { projectId, userId: operatorId },
      });
      await ctx.prisma.budget.create({
        data: {
          scope: 'user',
          userId: operatorId,
          period: 'day',
          timezone: 'UTC',
          limitUsd: '1',
          thresholds: [100],
          action: 'stop',
        },
      });
      await ctx.prisma.commandRun.create({
        data: {
          projectId,
          runnerId,
          userId: operatorId,
          command: 'orchestrator.start',
          args: {},
          status: 'ok',
          requestedAt: new Date(NOW - 60_000),
        },
      });
      const feed = new Feed();
      await ingest(ctx, runnerId, [
        feed.session('own', '/srv/a', new Date(NOW - 50_000).toISOString(), {
          projectId,
        }),
        feed.spend('own', 'o1', new Date(NOW - 40_000).toISOString()),
      ]);
      await sweep.flush();
    };

    const ownSchedule = (due: Date | null) =>
      ctx.prisma.schedule.create({
        data: {
          projectId,
          name: 'Mine',
          target: { kind: 'orchestrator', mode: 'next' },
          cron: '0 * * * *',
          timezone: 'UTC',
          nextRunAt: due,
          createdById: operatorId,
        },
      });

    it('refuses run now on their own schedule with 409 budget_exceeded, recording the firing skipped', async () => {
      await exhaustedOperator();
      const schedule = await ownSchedule(null);
      const operator = await login(ctx, 'operator@example.com');

      const response = await operator.send(
        'post',
        `/projects/${projectId}/schedules/${schedule.id}/run-now`,
      );

      expect(response.status).toBe(409);
      expect(response.body as BudgetExceededBody).toMatchObject({
        error: 'budget_exceeded',
        scope: 'user',
      });
      const [firing] = await ctx.prisma.scheduleFiring.findMany({
        where: { scheduleId: schedule.id },
      });
      expect(firing).toMatchObject({
        kind: 'manual',
        status: 'skipped',
        error: { code: 'denied', message: 'budget' },
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('skips a cron firing of a schedule they own, and fires someone else’s', async () => {
      await exhaustedOperator();
      const mine = await ownSchedule(at('2026-10-09T10:00:00Z'));
      const admins = await scheduleDue(at('2026-10-09T10:00:00Z'));

      await tick(at('2026-10-09T10:00:05Z'));

      const [skipped] = await ctx.prisma.scheduleFiring.findMany({
        where: { scheduleId: mine.id },
      });
      expect(skipped).toMatchObject({
        kind: 'cron',
        status: 'skipped',
        error: { code: 'denied', message: 'budget' },
      });
      const [fired] = await ctx.prisma.scheduleFiring.findMany({
        where: { scheduleId: admins.id },
      });
      expect(fired).toMatchObject({
        status: 'succeeded',
        principalId: creatorId,
      });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it('fires normally without an exceeded budget', async () => {
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));
    await tick(at('2026-10-09T10:00:05Z'));
    const [firing] = await ctx.prisma.scheduleFiring.findMany({
      where: { scheduleId: schedule.id },
    });
    expect(firing.status).toBe('succeeded');
    expect(send).toHaveBeenCalled();
  });
});
