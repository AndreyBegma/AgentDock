import type { SystemJobView } from '@agentdock/shared';
import { API_EVENT_SOURCE, type CommandName } from '@agentdock/shared/protocol';
import { getQueueToken } from '@nestjs/bullmq';
import { Worker } from 'bullmq';
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
import {
  type FireResult,
  ScheduleFireProcessor,
} from './schedule-fire.processor';
import { ScheduleReconciler } from './schedule-reconciler';
import {
  FIRE_JOB,
  FIRE_JOB_OPTIONS,
  type FireJobData,
  fireJobId,
  SCHEDULES_QUEUE,
  type SchedulesQueue,
  ScheduleTimers,
} from './schedule-timers';
import {
  RECONCILE_SCHEDULER,
  ScheduleWorker,
  SETTLE_SCHEDULER,
} from './schedule-worker';

type Answer = CommandSendResult<CommandName>;

const at = (s: string) => new Date(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it holds, or fails after `ms`. */
const until = async (
  what: string,
  check: () => Promise<boolean>,
  ms = 10_000,
): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A daily cron whose occurrence is the current UTC minute: a job processed
 * now is on time (within the 2-minute grace), whatever the clock says.
 */
const thisMinute = () => {
  const now = new Date();
  const occurrence = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
    ),
  );
  return {
    cron: `${occurrence.getUTCMinutes()} ${occurrence.getUTCHours()} * * *`,
    occurrence,
  };
};

/** Spec 123 against a real Redis: timers, workers, reconcile, system jobs. */
describe('schedules queue (e2e)', () => {
  let ctx: E2eContext;
  let queue: SchedulesQueue;
  let timers: ScheduleTimers;
  let processor: ScheduleFireProcessor;
  let reconciler: ScheduleReconciler;
  let runnerId: string;
  let projectId: string;
  let creatorId: string;
  let admin: Session;
  let online: boolean;
  let workers: Worker[] = [];

  const sent = (name: CommandName) =>
    jest
      .mocked(ctx.app.get(RunnerCommandService).send)
      .mock.calls.filter(([, n]) => n === name);

  /** The pending `fire` jobs of `scheduleId`, by id. */
  const fireJobs = async (scheduleId: string): Promise<string[]> => {
    const jobs = await queue.getJobs(['delayed', 'waiting', 'active']);
    return jobs
      .filter(
        (job) =>
          job.name === FIRE_JOB &&
          (job.data as FireJobData).scheduleId === scheduleId,
      )
      .map((job) => job.id ?? '')
      .sort();
  };

  const firings = (scheduleId: string) =>
    ctx.prisma.scheduleFiring.findMany({
      where: { scheduleId },
      orderBy: { id: 'asc' },
    });

  const schedule = (id: string) =>
    ctx.prisma.schedule.findUniqueOrThrow({ where: { id } });

  /** A saved orchestrator schedule; its timer is not added. */
  const scheduleRow = (data: {
    cron?: string;
    nextRunAt: Date | null;
    missedPolicy?: 'skip' | 'catch_up';
    enabled?: boolean;
  }) =>
    ctx.prisma.schedule.create({
      data: {
        projectId,
        name: 'Nightly',
        target: { kind: 'orchestrator', mode: 'next' },
        cron: data.cron ?? '0 3 * * *',
        timezone: 'UTC',
        missedPolicy: data.missedPolicy ?? 'skip',
        enabled: data.enabled ?? true,
        disabledReason: data.enabled === false ? 'manual' : null,
        nextRunAt: data.nextRunAt,
        createdById: creatorId,
      },
    });

  const startWorker = (): Worker => {
    const worker = ctx.app.get(ScheduleWorker).startWorker();
    workers.push(worker);
    return worker;
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    queue = ctx.app.get<SchedulesQueue>(getQueueToken(SCHEDULES_QUEUE));
    timers = ctx.app.get(ScheduleTimers);
    processor = ctx.app.get(ScheduleFireProcessor);
    reconciler = ctx.app.get(ScheduleReconciler);
  });
  afterAll(async () => {
    await ctx.app.close();
    await obliterateQueues(testRedisUrl(), process.env.QUEUE_PREFIX as string, [
      SCHEDULES_QUEUE,
    ]);
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await queue.obliterate({ force: true });
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
    online = true;
    jest
      .spyOn(ctx.app.get(RunnerPresence), 'isConnected')
      .mockImplementation(() => online);
    jest
      .spyOn(ctx.app.get(RunnerCommandService), 'send')
      .mockImplementation(async (_runner, name) => {
        if (name !== 'orchestrator.start') throw new Error(`no ${name}`);
        return {
          status: 'ok',
          output: {
            session: 'agentdock-orch-a',
            startedAt: new Date().toISOString(),
          },
          rttMs: 1,
        } as Answer as never;
      });
  });
  afterEach(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    workers = [];
    jest.restoreAllMocks();
  });

  it('create, edit, disable, enable and delete keep exactly one fire-<id>-<ms> job', async () => {
    const created = await admin.send(
      'post',
      `/projects/${projectId}/schedules`,
      {
        name: 'Nightly',
        target: { kind: 'orchestrator', mode: 'next' },
        cron: '0 3 * * *',
        timezone: 'UTC',
      },
    );
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const path = `/projects/${projectId}/schedules/${id}`;
    const jobFor = async () => {
      const row = await schedule(id);
      return row.nextRunAt ? [fireJobId(id, row.nextRunAt)] : [];
    };

    expect(await fireJobs(id)).toEqual(await jobFor());
    expect(await fireJobs(id)).toHaveLength(1);
    const job = await queue.getJob((await jobFor())[0]);
    expect(await job?.getState()).toBe('delayed');
    expect(job?.data).toEqual({
      scheduleId: id,
      scheduledFor: (await schedule(id)).nextRunAt?.toISOString(),
    });

    // A new cron replaces the job with one for the new nextRunAt.
    const before = await jobFor();
    expect(
      (await admin.send('patch', path, { cron: '0 4 * * *' })).status,
    ).toBe(200);
    expect(await fireJobs(id)).toEqual(await jobFor());
    expect(await fireJobs(id)).not.toEqual(before);

    expect((await admin.send('patch', path, { enabled: false })).status).toBe(
      200,
    );
    expect(await fireJobs(id)).toEqual([]);

    expect((await admin.send('patch', path, { enabled: true })).status).toBe(
      200,
    );
    expect(await fireJobs(id)).toEqual(await jobFor());
    expect(await fireJobs(id)).toHaveLength(1);

    expect((await admin.send('delete', path)).status).toBe(204);
    expect(await fireJobs(id)).toEqual([]);
  });

  it('a worker fires a schedule due in 1 s exactly once, and arms the next occurrence', async () => {
    const { cron } = thisMinute();
    const row = await scheduleRow({
      cron,
      nextRunAt: new Date(Date.now() + 1000),
    });
    await timers.sync(row.id);
    expect(await fireJobs(row.id)).toHaveLength(1);

    startWorker();
    await until('one firing', async () => (await firings(row.id)).length > 0);
    await sleep(500);
    const rows = await firings(row.id);
    expect(rows.map((f) => [f.status, f.kind])).toEqual([
      ['succeeded', 'cron'],
    ]);
    expect(sent('orchestrator.start')).toHaveLength(1);

    const after = await schedule(row.id);
    expect(after.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    await until(
      'the next timer',
      async () =>
        (await fireJobs(row.id)).join() ===
        fireJobId(row.id, after.nextRunAt as Date),
    );
  });

  it('two workers, one job added twice, then replayed: one firing, one command, one event', async () => {
    const { cron, occurrence } = thisMinute();
    const row = await scheduleRow({ cron, nextRunAt: occurrence });
    const id = fireJobId(row.id, occurrence);
    const data: FireJobData = {
      scheduleId: row.id,
      scheduledFor: occurrence.toISOString(),
    };
    await queue.add(FIRE_JOB, data, { ...FIRE_JOB_OPTIONS, jobId: id });
    await queue.add(FIRE_JOB, data, { ...FIRE_JOB_OPTIONS, jobId: id });

    startWorker();
    startWorker();
    const completed = async () =>
      (await (await queue.getJob(id))?.getState()) === 'completed';
    await until('the job to complete', completed);
    const job = await queue.getJob(id);
    const firstFinish = job?.finishedOn ?? 0;

    // Replayed, as stalled-job recovery would.
    await job?.retry('completed');
    await until(
      'the replay to complete',
      async () =>
        (await completed()) &&
        ((await queue.getJob(id))?.finishedOn ?? 0) > firstFinish,
    );

    expect(await firings(row.id)).toHaveLength(1);
    expect(sent('orchestrator.start')).toHaveLength(1);
    const events = await ctx.prisma.event.findMany({
      where: { source: API_EVENT_SOURCE },
    });
    expect(events.map((e) => e.type)).toEqual(['schedule.fired']);
  });

  it('D9 (B7): with the runner offline, the same job is moved back to delayed', async () => {
    const { cron, occurrence } = thisMinute();
    const row = await scheduleRow({
      cron,
      nextRunAt: occurrence,
      missedPolicy: 'catch_up',
    });
    await timers.sync(row.id);
    const id = fireJobId(row.id, occurrence);
    online = false;

    startWorker();
    await until(
      'the re-delay',
      async () => (await (await queue.getJob(id))?.getState()) === 'delayed',
    );
    const job = await queue.getJob(id);
    expect(job?.data).toMatchObject({ retry: 1 });
    expect((await firings(row.id)).map((f) => [f.status, f.reason])).toEqual([
      ['failed', 'runner_offline'],
    ]);
    // nextRunAt is rewound; the step-5 timer for the next day is gone.
    expect((await schedule(row.id)).nextRunAt).toEqual(occurrence);
    await until(
      'only the retried job',
      async () => (await fireJobs(row.id)).join() === id,
    );

    // The runner is back: the retried job fires it once, as catch_up.
    online = true;
    const result = await processor.handle(job?.data as FireJobData);
    expect(result.kind).toBe('fired');
    expect((await firings(row.id)).map((f) => [f.status, f.kind])).toEqual([
      ['failed', 'cron'],
      ['succeeded', 'catch_up'],
    ]);
    expect(sent('orchestrator.start')).toHaveLength(1);
  });

  it('D9 (B7): the retry backs off and stops after 24 hours', async () => {
    const due = at('2026-10-05T03:00:00Z');
    const row = await scheduleRow({
      cron: '0 3 * * 1',
      nextRunAt: due,
      missedPolicy: 'catch_up',
    });
    online = false;
    const job: FireJobData = {
      scheduleId: row.id,
      scheduledFor: due.toISOString(),
    };
    const minutes = (m: number) => new Date(due.getTime() + m * 60_000);
    expect(await processor.handle(job, minutes(0.1))).toEqual({
      kind: 'redelay',
      delayMs: 30_000,
    });
    expect(await processor.handle({ ...job, retry: 1 }, minutes(1))).toEqual({
      kind: 'redelay',
      delayMs: 60_000,
    });
    expect(
      await processor.handle({ ...job, retry: 9 }, minutes(23 * 60)),
    ).toEqual({ kind: 'redelay', delayMs: 300_000 });
    expect(await firings(row.id)).toHaveLength(1);

    // Past 24 hours: no wait, no command; the schedule moves on.
    const late = await processor.handle(
      { ...job, retry: 10 },
      minutes(24 * 60 + 1),
    );
    expect(late).toEqual({ kind: 'fired', fired: [] });
    expect((await firings(row.id)).map((f) => f.status)).toEqual(['failed']);
    expect((await schedule(row.id)).nextRunAt).toEqual(
      at('2026-10-12T03:00:00Z'),
    );
    expect(sent('orchestrator.start')).toHaveLength(0);
  });

  it('a stale job — scheduledFor is not nextRunAt — writes nothing', async () => {
    const row = await scheduleRow({ nextRunAt: at('2026-10-09T03:00:00Z') });
    const result = await processor.handle(
      { scheduleId: row.id, scheduledFor: '2026-10-08T03:00:00.000Z' },
      at('2026-10-09T03:00:05Z'),
    );
    expect(result).toEqual({ kind: 'stale' });
    expect(await firings(row.id)).toEqual([]);
    expect((await schedule(row.id)).nextRunAt).toEqual(
      at('2026-10-09T03:00:00Z'),
    );
  });

  it('B21: a job waits on a row lock held elsewhere, then finds the row moved', async () => {
    const due = at('2026-10-09T03:00:00Z');
    const row = await scheduleRow({ nextRunAt: due });
    let handled: Promise<FireResult> | undefined;
    let done = false;
    await ctx.prisma.$transaction(async (tx) => {
      // As the old tick holds it: FOR UPDATE … SKIP LOCKED, then advance.
      await tx.$queryRaw`SELECT id FROM schedules WHERE id = ${row.id} FOR UPDATE`;
      handled = processor.handle(
        { scheduleId: row.id, scheduledFor: due.toISOString() },
        at('2026-10-09T03:00:05Z'),
      );
      void handled.then(() => {
        done = true;
      });
      await sleep(500);
      expect(done).toBe(false);
      await tx.schedule.update({
        where: { id: row.id },
        data: { nextRunAt: at('2026-10-10T03:00:00Z') },
      });
    });
    expect(await handled).toEqual({ kind: 'stale' });
    expect(await firings(row.id)).toEqual([]);
  });

  it('after the queue is wiped, reconcile restores every enabled timer and removes orphans', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const kept = await scheduleRow({ nextRunAt: tomorrow });
    const other = await scheduleRow({
      nextRunAt: new Date(Date.now() + 3_600_000),
    });
    const off = await scheduleRow({ nextRunAt: null, enabled: false });
    for (const r of [kept, other, off]) await timers.sync(r.id);

    await queue.obliterate({ force: true });
    // An orphan: the timer of a schedule that no longer exists.
    await queue.add(
      FIRE_JOB,
      { scheduleId: 'gone', scheduledFor: tomorrow.toISOString() },
      { jobId: fireJobId('gone', tomorrow), delay: 86_400_000 },
    );

    expect(await reconciler.reconcile()).toEqual({ added: 2, removed: 1 });
    expect(await fireJobs(kept.id)).toEqual([fireJobId(kept.id, tomorrow)]);
    expect(await fireJobs(other.id)).toHaveLength(1);
    expect(await fireJobs(off.id)).toEqual([]);
    expect(await fireJobs('gone')).toEqual([]);
    // Idempotent.
    expect(await reconciler.reconcile()).toEqual({ added: 0, removed: 0 });
  });

  it('reconcile re-adds a job that completed while the row still points at it', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const row = await scheduleRow({ nextRunAt: tomorrow });
    const id = fireJobId(row.id, tomorrow);
    // A completed job under the same id: a plain add would be a no-op.
    await queue.add(
      FIRE_JOB,
      { scheduleId: row.id, scheduledFor: tomorrow.toISOString() },
      { jobId: id },
    );
    // A worker that completes it without looking, as one that died after.
    const worker = new Worker(SCHEDULES_QUEUE, async () => undefined, {
      connection: queue.opts.connection,
      prefix: queue.opts.prefix,
    });
    workers.push(worker);
    await until(
      'the job to complete',
      async () => (await (await queue.getJob(id))?.getState()) === 'completed',
    );
    await worker.close();

    expect(await reconciler.reconcile()).toEqual({ added: 1, removed: 0 });
    expect(await (await queue.getJob(id))?.getState()).toBe('delayed');
  });

  it('GET /admin/system-jobs lists schedules.settle and schedules.reconcile', async () => {
    await ctx.app.get(ScheduleWorker).registerJobSchedulers();
    const response = await admin.get('/admin/system-jobs');
    expect(response.status).toBe(200);
    const jobs = (response.body as SystemJobView[]).filter((j) =>
      [SETTLE_SCHEDULER, RECONCILE_SCHEDULER].includes(j.name),
    );
    expect(jobs.map((j) => [j.name, j.kind, j.lastRunAt])).toEqual([
      [RECONCILE_SCHEDULER, 'interval', null],
      [SETTLE_SCHEDULER, 'interval', null],
    ]);
    for (const job of jobs) expect(job.nextRunAt).toBeTruthy();
  });
});
