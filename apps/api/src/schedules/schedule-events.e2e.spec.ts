import type { ActivityItem } from '@agentdock/shared';
import { API_EVENT_SOURCE, type CommandName } from '@agentdock/shared/protocol';
import {
  ACTIVITY_OPTIONS,
  type ActivityOptions,
  ActivityProjector,
} from '../activity';
import { resetActivity, storeEvents } from '../activity/testing/activity-e2e';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { LiveService } from '../live/live.service';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { nextServerEventSeq } from '../server-events';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { recordFiringEvent } from './schedule-events';
import { SchedulerService } from './scheduler.service';

type Answer = CommandSendResult<CommandName>;

const at = (s: string) => new Date(s);

/** Issue #99, ADR-0014: `schedule.*` recorded in `events` with `source` `api`. */
describe('schedule events (e2e)', () => {
  let ctx: E2eContext;
  let scheduler: SchedulerService;
  let runnerId: string;
  let projectId: string;
  let creatorId: string;
  let admin: Session;
  let online: boolean;

  const serverEvents = () =>
    ctx.prisma.event.findMany({
      where: { source: API_EVENT_SOURCE },
      orderBy: { id: 'asc' },
    });

  /** A schedule due at `due`, as if it had been saved and time had passed. */
  const scheduleDue = async (
    due: Date,
    extra: { missedPolicy?: 'skip' | 'catch_up'; target?: object } = {},
  ) =>
    ctx.prisma.schedule.create({
      data: {
        projectId,
        name: 'Nightly',
        target: extra.target ?? {
          kind: 'skill',
          skill: 'estimate',
          output: 'report',
        },
        cron: '0 * * * *',
        timezone: 'UTC',
        missedPolicy: extra.missedPolicy ?? 'skip',
        nextRunAt: due,
        createdById: creatorId,
      },
    });

  beforeAll(async () => {
    ctx = await createE2eApp();
    scheduler = ctx.app.get(SchedulerService);
  });
  afterAll(async () => {
    await scheduler.release();
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetActivity(ctx.prisma);
    ({ runnerId, projectId } = await seedProject(ctx.prisma, '/srv/a'));
    creatorId = (await createUser(ctx.prisma, 'admin@example.com', 'admin')).id;
    admin = await login(ctx, 'admin@example.com');
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
    expect(await scheduler.lead()).toBe(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a fired firing writes one schedule.fired row on the project’s runner, with a negative seq', async () => {
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
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'), {
      target: { kind: 'orchestrator', mode: 'next' },
    });
    await scheduler.tick(at('2026-10-09T10:00:05Z'));

    const [firing] = await ctx.prisma.scheduleFiring.findMany({
      where: { scheduleId: schedule.id },
    });
    expect(firing.status).toBe('succeeded');
    const rows = await serverEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runnerId,
      type: 'schedule.fired',
      source: 'api',
      projectRoot: '/srv/a',
      dedupeKey: `schedule.fired:${firing.id}`,
      data: {
        scheduleId: schedule.id,
        scheduleName: 'Nightly',
        firingId: firing.id.toString(),
        status: 'succeeded',
        kind: 'cron',
        scheduledFor: '2026-10-09T10:00:00.000Z',
      },
    });
    expect(rows[0].seq < 0n).toBe(true);

    // The settle already happened: settling again changes nothing.
    await scheduler.tick(at('2026-10-09T10:00:30Z'));
    expect(await serverEvents()).toHaveLength(1);
  });

  it('a firing that is started, then succeeds, is one schedule.fired; a replay burns no events.id', async () => {
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));
    const firing = await ctx.prisma.scheduleFiring.create({
      data: {
        scheduleId: schedule.id,
        scheduledFor: at('2026-10-09T10:00:00Z'),
        kind: 'cron',
        status: 'started',
      },
    });
    const now = new Date();
    await ctx.prisma.$transaction((tx) => recordFiringEvent(tx, firing, now));
    await ctx.prisma.$transaction((tx) =>
      recordFiringEvent(tx, { ...firing, status: 'succeeded' }, now),
    );
    const rows = await serverEvents();
    expect(rows.map((r) => r.type)).toEqual(['schedule.fired']);

    // The duplicate was looked up, not inserted: the next row follows with
    // no hole in `events.id` for the activity projector to wait out.
    await ctx.prisma.$transaction((tx) =>
      recordFiringEvent(tx, { ...firing, status: 'failed' }, now),
    );
    const [fired, failed] = await serverEvents();
    expect(failed.id).toBe(fired.id + 1n);
  });

  it('a skipped claim writes schedule.skipped with its missed count', async () => {
    await scheduleDue(at('2026-10-09T10:00:00Z'));
    await scheduler.tick(at('2026-10-09T12:30:00Z'));
    const rows = await serverEvents();
    expect(rows.map((r) => [r.type, r.data])).toEqual([
      [
        'schedule.skipped',
        expect.objectContaining({ status: 'skipped', missedCount: 3 }),
      ],
    ]);
  });

  it('five offline failures write five schedule.failed and one schedule.disabled, shown in the activity feed', async () => {
    const schedule = await scheduleDue(at('2026-10-09T10:00:00Z'));
    online = false;
    for (let hour = 10; hour < 15; hour++) {
      const due = at(`2026-10-09T${hour}:00:00Z`);
      await ctx.prisma.schedule.update({
        where: { id: schedule.id },
        data: { nextRunAt: due },
      });
      await scheduler.tick(new Date(due.getTime() + 5000));
    }
    const rows = await serverEvents();
    expect(rows.map((r) => r.type)).toEqual([
      ...Array(5).fill('schedule.failed'),
      'schedule.disabled',
    ]);
    const lastFiring = await ctx.prisma.scheduleFiring.findFirstOrThrow({
      where: { scheduleId: schedule.id },
      orderBy: { id: 'desc' },
    });
    expect(rows[5]).toMatchObject({
      dedupeKey: `schedule.disabled:${lastFiring.id}`,
      data: expect.objectContaining({ disabledReason: 'failing' }),
    });
    // One sequence, strictly decreasing, never a runner's.
    const seqs = rows.map((r) => r.seq);
    expect(
      seqs.every((seq, i) => seq < 0n && (i === 0 || seq < seqs[i - 1])),
    ).toBe(true);

    const projector = new ActivityProjector(
      ctx.prisma,
      ctx.app.get(LiveService),
      { ...ctx.app.get<ActivityOptions>(ACTIVITY_OPTIONS), gapGraceMs: 0 },
    );
    // `tick()` also counts audit items, and `audit_records` outlives every
    // suite's reset (#8's trigger): count the event items instead.
    await projector.tick();
    expect(
      await ctx.prisma.activityItem.count({ where: { sourceKind: 'event' } }),
    ).toBe(6);
    const feed = await admin.get(`/projects/${projectId}/activity`);
    expect(feed.status).toBe(200);
    const items = (feed.body as { items: ActivityItem[] }).items;
    expect(items[0]).toMatchObject({
      type: 'schedule.disabled',
      category: 'fleet',
      severity: 'danger',
      actorType: 'system',
      actorId: null,
      title: 'Schedule “Nightly” disabled: failing',
      link: `/projects/${projectId}/schedules`,
    });
    expect(items.filter((i) => i.type === 'schedule.failed')).toHaveLength(5);
  });

  it('runner rows and server rows share a runner without meeting', async () => {
    await storeEvents(ctx.prisma, runnerId, [
      {
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'orchestrator.started',
        source: 'runner',
        data: {},
      },
    ]);
    await scheduleDue(at('2026-10-09T10:00:00Z'));
    await scheduler.tick(at('2026-10-09T12:30:00Z'));
    const seqs = (
      await ctx.prisma.event.findMany({
        where: { runnerId },
        orderBy: { id: 'asc' },
      })
    ).map((r) => r.seq);
    expect(seqs[0]).toBe(1n);
    expect(seqs[1] < 0n).toBe(true);
    // The sequence GitHub rows draw from is the same one.
    const next = await ctx.prisma.$transaction((tx) => nextServerEventSeq(tx));
    expect(next).toBe(seqs[1] - 1n);
  });
});
