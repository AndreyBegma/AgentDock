import type { CommandName } from '@agentdock/shared/protocol';
import { Queue } from 'bullmq';
import { redisConnection } from '../bullmq/bullmq-options';
import { obliterateQueues } from '../bullmq/bullmq-testing';
import { seedProject } from '../fleet/testing/fleet-e2e';
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
  type Session,
} from '../test/e2e-app';
import { testRedisUrl } from '../test/test-redis';
import { ScheduleFireProcessor } from './schedule-fire.processor';
import { ScheduleReconciler } from './schedule-reconciler';
import {
  type FireJobData,
  fireJobId,
  SCHEDULES_QUEUE,
  type SchedulesQueue,
  ScheduleTimers,
} from './schedule-timers';
import { SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler-options';

type Answer = CommandSendResult<CommandName>;

const at = (s: string) => new Date(s);

/** Nothing listens here: Redis is "down" for this app (spec 123 B18). */
const DEAD_REDIS = 'redis://:x@127.0.0.1:1/0';

/**
 * Spec 123 B8, B18: the API boots and serves with Redis unreachable; when it
 * is back, `reconcile` arms the timers and each late occurrence follows the
 * missed-run policy (spec 25 D6).
 */
describe('schedules with Redis down (e2e)', () => {
  let ctx: E2eContext;
  let admin: Session;
  let projectId: string;
  let runnerId: string;
  let creatorId: string;
  /** The Redis that comes back, and the parts that use it. */
  let back: SchedulesQueue;
  let reconciler: ScheduleReconciler;
  const realRedis = process.env.REDIS_URL as string;

  const sent = (name: CommandName) =>
    jest
      .mocked(ctx.app.get(RunnerCommandService).send)
      .mock.calls.filter(([, n]) => n === name);

  beforeAll(async () => {
    process.env.REDIS_URL = DEAD_REDIS;
    ctx = await createE2eApp();
    process.env.REDIS_URL = realRedis;
    back = new Queue(SCHEDULES_QUEUE, {
      connection: redisConnection(testRedisUrl()),
      prefix: process.env.QUEUE_PREFIX,
    });
    const options = ctx.app.get<SchedulerOptions>(SCHEDULER_OPTIONS);
    reconciler = new ScheduleReconciler(
      ctx.prisma,
      new ScheduleTimers(ctx.prisma, options, back),
      back,
    );
  });
  afterAll(async () => {
    await back.close();
    await ctx.app.close();
    await obliterateQueues(testRedisUrl(), process.env.QUEUE_PREFIX as string, [
      SCHEDULES_QUEUE,
    ]);
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await back.obliterate({ force: true });
    ({ runnerId, projectId } = await seedProject(ctx.prisma, '/srv/a'));
    creatorId = (await createUser(ctx.prisma, 'admin@example.com', 'admin')).id;
    admin = await login(ctx, 'admin@example.com');
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
    jest.spyOn(ctx.app.get(RunnerCommandService), 'send').mockImplementation(
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
    jest.restoreAllMocks();
  });

  it('serves HTTP and creates a schedule (201) while Redis is unreachable; reconcile arms it later', async () => {
    expect((await ctx.http().get('/health')).status).toBe(200);
    const started = Date.now();
    const response = await admin.send(
      'post',
      `/projects/${projectId}/schedules`,
      {
        name: 'Nightly',
        target: { kind: 'orchestrator', mode: 'next' },
        cron: '0 3 * * *',
        timezone: 'UTC',
      },
    );
    expect(response.status).toBe(201);
    // Bounded by the sync timeout, not by Redis coming back.
    expect(Date.now() - started).toBeLessThan(10_000);
    const id = response.body.id as string;
    expect(await ctx.prisma.scheduleFiring.count()).toBe(0);

    expect(await reconciler.reconcile()).toEqual({ added: 1, removed: 0 });
    const row = await ctx.prisma.schedule.findUniqueOrThrow({ where: { id } });
    const job = await back.getJob(fireJobId(id, row.nextRunAt as Date));
    expect(await job?.getState()).toBe('delayed');
  });

  it.each([
    ['skip', [['skipped', 'cron', 'missed']], 0],
    ['catch_up', [['succeeded', 'catch_up', null]], 1],
  ] as const)('missed by more than 2 minutes while Redis was down, %s follows its policy', async (missedPolicy, expected, commands) => {
    const due = at('2026-10-09T10:00:00Z');
    const schedule = await ctx.prisma.schedule.create({
      data: {
        projectId,
        name: 'Hourly',
        target: { kind: 'orchestrator', mode: 'next' },
        cron: '0 * * * *',
        timezone: 'UTC',
        missedPolicy,
        nextRunAt: due,
        createdById: creatorId,
      },
    });
    // Redis is back: reconcile adds the timer, the worker delivers it late.
    expect(await reconciler.reconcile()).toEqual({ added: 1, removed: 0 });
    const job = await back.getJob(fireJobId(schedule.id, due));
    const result = await ctx.app
      .get(ScheduleFireProcessor)
      .handle(job?.data as FireJobData, at('2026-10-09T10:10:00Z'));
    expect(result.kind).toBe('fired');

    const firings = await ctx.prisma.scheduleFiring.findMany({
      where: { scheduleId: schedule.id },
    });
    expect(firings.map((f) => [f.status, f.kind, f.reason])).toEqual(expected);
    expect(sent('orchestrator.start')).toHaveLength(commands);
  });
});
