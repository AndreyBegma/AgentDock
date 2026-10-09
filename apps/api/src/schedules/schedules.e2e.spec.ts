import type {
  RunPage,
  ScheduleDetail,
  ScheduleFiringView,
  ScheduleView,
  SystemJobView,
} from '@agentdock/shared';
import type { CommandName } from '@agentdock/shared/protocol';
import type { ScheduleFiring } from '@prisma/client';
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
import { ScheduleFirer } from './schedule-firer';
import { ScheduleLive } from './schedule-live';
import { SchedulerService } from './scheduler.service';
import { SCHEDULER_OPTIONS, type SchedulerOptions } from './scheduler-options';

type Answer = CommandSendResult<CommandName>;
const ok = (output: unknown): Answer =>
  ({ status: 'ok', output, rttMs: 1 }) as Answer;
const refuse = (code: string): Answer =>
  ({ status: 'error', error: { code } }) as Answer;

const at = (s: string) => new Date(s);

describe('schedules (e2e)', () => {
  let ctx: E2eContext;
  let scheduler: SchedulerService;
  let runnerId: string;
  let a: string;
  let b: string;
  let profileA: string;
  let profileB: string;
  let admin: Session;
  let viewerOfA: Session;
  let operatorOfA: Session;
  let operatorOfB: Session;
  let outsider: Session;
  let operatorOfAId: string;
  let online: boolean;
  let answers: Partial<Record<CommandName, () => Answer>>;

  const sent = (name: CommandName) =>
    jest
      .mocked(ctx.app.get(RunnerCommandService).send)
      .mock.calls.filter(([, n]) => n === name);

  let auditFrom = 0n;
  const auditOf = (action: string) =>
    ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: auditFrom }, action },
      orderBy: { seq: 'asc' },
    });

  const skillTarget = {
    kind: 'skill',
    skill: 'estimate',
    args: 'the queue',
    output: 'report',
  };

  const create = async (body: object = {}, session = operatorOfA) => {
    const response = await session.send('post', `/projects/${a}/schedules`, {
      name: 'Nightly estimate',
      target: skillTarget,
      cron: '0 3 * * *',
      timezone: 'Europe/Kyiv',
      ...body,
    });
    return response;
  };

  const createOk = async (body: object = {}) => {
    const response = await create(body);
    expect(response.status).toBe(201);
    return response.body as ScheduleView;
  };

  /** Puts a schedule's next occurrence at `due`, as if time had passed. */
  const dueAt = (id: string, due: Date, missedPolicy?: 'skip' | 'catch_up') =>
    ctx.prisma.schedule.update({
      where: { id },
      data: { nextRunAt: due, ...(missedPolicy ? { missedPolicy } : {}) },
    });

  const firings = (scheduleId: string): Promise<ScheduleFiring[]> =>
    ctx.prisma.scheduleFiring.findMany({
      where: { scheduleId },
      orderBy: { id: 'asc' },
    });

  const schedule = (id: string) =>
    ctx.prisma.schedule.findUniqueOrThrow({ where: { id } });

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
    ({ runnerId, projectId: a } = await seedProject(ctx.prisma, '/srv/a'));
    const other = await seedProject(ctx.prisma, '/srv/b');
    b = other.projectId;
    const [mainA, mainB] = await Promise.all(
      [runnerId, other.runnerId].map((runner) =>
        ctx.prisma.runtimeProfile.create({
          data: {
            runnerId: runner,
            key: 'claude-main',
            runtime: 'claude',
            label: 'Claude',
            env: {},
            args: [],
            authenticated: true,
          },
        }),
      ),
    );
    profileA = mainA.id;
    profileB = mainB.id;
    await ctx.prisma.project.update({
      where: { id: a },
      data: { defaultProfileId: profileA },
    });
    await ctx.prisma.installedSkill.create({
      data: {
        runnerId,
        projectId: a,
        scope: 'project',
        runtime: 'claude',
        name: 'estimate',
        invocation: 'estimate',
        path: '.claude/skills/estimate',
        seenAt: new Date(),
      },
    });
    const memberOf = async (
      email: string,
      projectId: string | null,
      role: 'viewer' | 'operator',
    ) => {
      const user = await createUser(ctx.prisma, email, role);
      if (projectId) {
        await ctx.prisma.projectMember.create({
          data: { projectId, userId: user.id },
        });
      }
      return { user, session: await login(ctx, email) };
    };
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    admin = await login(ctx, 'admin@example.com');
    viewerOfA = (await memberOf('viewer-a@example.com', a, 'viewer')).session;
    const opA = await memberOf('operator-a@example.com', a, 'operator');
    operatorOfA = opA.session;
    operatorOfAId = opA.user.id;
    operatorOfB = (await memberOf('operator-b@example.com', b, 'operator'))
      .session;
    outsider = (await memberOf('outsider@example.com', null, 'operator'))
      .session;

    const last = await ctx.prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    auditFrom = last?.seq ?? 0n;

    online = true;
    answers = {
      'skill.run': () => ok({ phase: 'queued' }),
      'orchestrator.start': () =>
        ok({
          session: 'agentdock-orch-a',
          startedAt: new Date().toISOString(),
        }),
    };
    jest
      .spyOn(ctx.app.get(RunnerPresence), 'isConnected')
      .mockImplementation(() => online);
    jest
      .spyOn(ctx.app.get(RunnerCommandService), 'send')
      .mockImplementation(async (_runner, name) => {
        const answer = answers[name];
        if (!answer) throw new Error(`no answer for ${name}`);
        return answer() as never;
      });
    expect(await scheduler.lead()).toBe(true);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('create and preview', () => {
    it('stores the next 03:00 Kyiv time in UTC; the preview agrees', async () => {
      const view = await createOk();
      const next = new Date(view.nextRunAt as string);
      const kyiv = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Kyiv',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(next);
      expect(kyiv).toBe('03:00');
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);

      const preview = await operatorOfA.send('post', '/schedules/preview', {
        cron: '0 3 * * *',
        timezone: 'Europe/Kyiv',
      });
      expect(preview.status).toBe(200);
      expect(preview.body.description).toBe('At 03:00 AM');
      expect(preview.body.next).toHaveLength(5);
      expect(preview.body.next[0]).toBe(view.nextRunAt);
      expect((await auditOf('schedule.create')).length).toBe(1);
    });

    it('refuses short intervals, six fields and unknown zones with 422', async () => {
      const cases: [object, string][] = [
        [{ cron: '* * * * *' }, 'interval_too_short'],
        [{ cron: '*/2 * * * *' }, 'interval_too_short'],
        [{ cron: '0 0 3 * * *' }, 'invalid_cron'],
        [{ timezone: 'Mars/Olympus' }, 'invalid_timezone'],
        [{ target: { kind: 'shell', command: 'rm -rf /' } }, 'invalid_target'],
        [
          { target: { ...skillTarget, skill: 'code-sentinel:orchestrator' } },
          'invalid_target',
        ],
      ];
      for (const [body, code] of cases) {
        const response = await create(body);
        expect([body, response.status, response.body.error]).toEqual([
          body,
          422,
          code,
        ]);
      }
      const preview = await operatorOfA.send('post', '/schedules/preview', {
        cron: '* * * * *',
        timezone: 'UTC',
      });
      expect([preview.status, preview.body.error]).toEqual([
        422,
        'interval_too_short',
      ]);
      expect(await ctx.prisma.schedule.count()).toBe(0);
    });

    it("refuses a profile on another project's runner (422 invalid_target)", async () => {
      const response = await create({
        target: { ...skillTarget, profileId: profileB },
      });
      expect([response.status, response.body.error]).toEqual([
        422,
        'invalid_target',
      ]);
      expect(
        (await create({ target: { ...skillTarget, profileId: profileA } }))
          .status,
      ).toBe(201);
    });
  });

  describe('firing', () => {
    it('a due schedule fires once: one firing, one skill.run, nextRunAt moves', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      const due = at('2026-10-09T10:00:00Z');
      await dueAt(view.id, due);

      const fired = await scheduler.tick(at('2026-10-09T10:00:10Z'));
      expect(fired).toHaveLength(1);
      expect(await scheduler.tick(at('2026-10-09T10:00:20Z'))).toEqual([]);

      const rows = await firings(view.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'started',
        kind: 'cron',
        scheduledFor: due,
      });
      expect(sent('skill.run')).toHaveLength(1);
      expect((await schedule(view.id)).nextRunAt).toEqual(
        at('2026-10-09T11:00:00Z'),
      );

      // #21: the run is an ordinary run, triggered by the schedule.
      const runs = await operatorOfA.get(`/projects/${a}/runs`);
      expect(runs.status).toBe(200);
      const run = (runs.body as RunPage).items.find(
        (r) => r.id === rows[0].runId,
      );
      expect(run).toMatchObject({
        triggeredByType: 'schedule',
        triggeredById: view.id,
      });

      // The run ends; the firing follows it.
      await ctx.prisma.run.update({
        where: { id: rows[0].runId as string },
        data: { status: 'succeeded', endedAt: new Date() },
      });
      await scheduler.tick(at('2026-10-09T10:01:00Z'));
      expect((await firings(view.id))[0].status).toBe('succeeded');
    });

    it('fires orchestrator.start for an orchestrator target; already_running is noop', async () => {
      await ctx.prisma.projectOrchestratorSettings.create({
        data: { projectId: a, profileId: profileA },
      });
      const view = await createOk({
        cron: '0 * * * *',
        timezone: 'UTC',
        target: { kind: 'orchestrator', mode: 'next' },
      });
      await dueAt(view.id, at('2026-10-09T10:00:00Z'));
      await scheduler.tick(at('2026-10-09T10:00:05Z'));
      const [first] = await firings(view.id);
      expect(first).toMatchObject({ status: 'succeeded' });
      expect(first.commandRunId).toBeTruthy();
      expect(sent('orchestrator.start')).toHaveLength(1);

      answers['orchestrator.start'] = () => refuse('already_running');
      await dueAt(view.id, at('2026-10-09T11:00:00Z'));
      await ctx.prisma.schedule.update({
        where: { id: view.id },
        data: { consecutiveFailures: 3 },
      });
      await scheduler.tick(at('2026-10-09T11:00:05Z'));
      const second = (await firings(view.id))[1];
      expect(second).toMatchObject({
        status: 'noop',
        reason: 'already_running',
      });
      expect((await schedule(view.id)).consecutiveFailures).toBe(3);
    });

    it('missed by three with skip: one skipped firing, no command', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      await dueAt(view.id, at('2026-10-09T10:00:00Z'), 'skip');
      await scheduler.tick(at('2026-10-09T12:30:00Z'));
      const rows = await firings(view.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'skipped', missedCount: 3 });
      expect(sent('skill.run')).toHaveLength(0);
      expect((await schedule(view.id)).nextRunAt).toEqual(
        at('2026-10-09T13:00:00Z'),
      );
    });

    it('missed by three with catch_up: one command for the newest, one skipped with missedCount 2', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      await dueAt(view.id, at('2026-10-09T10:00:00Z'), 'catch_up');
      await scheduler.tick(at('2026-10-09T12:30:00Z'));
      const rows = await firings(view.id);
      expect(rows.map((r) => [r.status, r.kind, r.missedCount])).toEqual([
        ['skipped', 'cron', 2],
        ['started', 'catch_up', 0],
      ]);
      expect(rows[1].scheduledFor).toEqual(at('2026-10-09T12:00:00Z'));
      expect(sent('skill.run')).toHaveLength(1);
    });

    it('missed by more than 24 hours with catch_up: skipped only', async () => {
      const view = await createOk({ cron: '0 3 * * 1', timezone: 'UTC' });
      await dueAt(view.id, at('2026-10-05T03:00:00Z'), 'catch_up');
      await scheduler.tick(at('2026-10-07T03:00:00Z'));
      const rows = await firings(view.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'skipped',
        reason: 'missed_over_24h',
      });
      expect(sent('skill.run')).toHaveLength(0);
    });

    it('skips a firing while the previous run is still running (D7)', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      await dueAt(view.id, at('2026-10-09T10:00:00Z'));
      await scheduler.tick(at('2026-10-09T10:00:05Z'));
      await dueAt(view.id, at('2026-10-09T11:00:00Z'));
      await scheduler.tick(at('2026-10-09T11:00:05Z'));
      const rows = await firings(view.id);
      expect(rows[1]).toMatchObject({
        status: 'skipped',
        reason: 'previous_still_running',
      });
      expect(sent('skill.run')).toHaveLength(1);
    });

    it('runner offline: failed runner_offline; five in a row disable it (D9, D11)', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      online = false;
      for (let hour = 10; hour < 15; hour++) {
        const due = at(`2026-10-09T${hour}:00:00Z`);
        await dueAt(view.id, due);
        await scheduler.tick(new Date(due.getTime() + 5000));
      }
      const rows = await firings(view.id);
      expect(rows.map((r) => [r.status, r.reason])).toEqual(
        Array(5).fill(['failed', 'runner_offline']),
      );
      const row = await schedule(view.id);
      expect(row).toMatchObject({
        enabled: false,
        disabledReason: 'failing',
        consecutiveFailures: 5,
        nextRunAt: null,
      });
      const disabled = await auditOf('schedule.disable');
      expect(disabled).toHaveLength(1);
      expect(disabled[0].actorType).toBe('system');
      expect(sent('skill.run')).toHaveLength(0);
    });

    it('catch_up retries an offline occurrence once the runner is back (D9)', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      await dueAt(view.id, at('2026-10-09T10:00:00Z'), 'catch_up');
      online = false;
      await scheduler.tick(at('2026-10-09T10:00:05Z'));
      // Still offline: nothing new, nothing counted twice.
      await scheduler.tick(at('2026-10-09T10:10:00Z'));
      expect(await firings(view.id)).toHaveLength(1);
      online = true;
      await scheduler.tick(at('2026-10-09T10:20:00Z'));
      const rows = await firings(view.id);
      expect(rows.map((r) => [r.status, r.kind, r.reason])).toEqual([
        ['failed', 'cron', 'runner_offline'],
        ['started', 'catch_up', null],
      ]);
      expect((await schedule(view.id)).nextRunAt).toEqual(
        at('2026-10-09T11:00:00Z'),
      );
    });

    it('a creator who lost operator membership: creator_not_authorized, disabled (D10)', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      await ctx.prisma.projectMember.update({
        where: { projectId_userId: { projectId: a, userId: operatorOfAId } },
        data: { roleOverride: 'viewer' },
      });
      await dueAt(view.id, at('2026-10-09T10:00:00Z'));
      await scheduler.tick(at('2026-10-09T10:00:05Z'));
      expect((await firings(view.id))[0]).toMatchObject({
        status: 'failed',
        reason: 'creator_not_authorized',
      });
      expect(await schedule(view.id)).toMatchObject({
        enabled: false,
        disabledReason: 'creator_not_authorized',
      });
      expect(sent('skill.run')).toHaveLength(0);
    });

    it('a disabled creator: creator_not_authorized (D10)', async () => {
      const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
      await ctx.prisma.user.update({
        where: { id: operatorOfAId },
        data: { status: 'disabled' },
      });
      await dueAt(view.id, at('2026-10-09T10:00:00Z'));
      await scheduler.tick(at('2026-10-09T10:00:05Z'));
      expect((await firings(view.id))[0].reason).toBe('creator_not_authorized');
    });

    it('run now fires a manual firing and leaves nextRunAt alone (D15)', async () => {
      const view = await createOk();
      const response = await operatorOfA.send(
        'post',
        `/projects/${a}/schedules/${view.id}/run-now`,
      );
      expect(response.status).toBe(201);
      expect(response.body as ScheduleFiringView).toMatchObject({
        kind: 'manual',
        status: 'started',
      });
      expect((await schedule(view.id)).nextRunAt?.toISOString()).toBe(
        view.nextRunAt,
      );
      expect(await auditOf('schedule.run_now')).toHaveLength(1);
    });
  });

  describe('leader election (D5)', () => {
    it('only the lock holder ticks; when it goes, another takes over', async () => {
      const options = ctx.app.get<SchedulerOptions>(SCHEDULER_OPTIONS);
      expect(options.leaderRetryMs).toBeLessThanOrEqual(30_000);
      const second = new SchedulerService(
        ctx.prisma,
        ctx.app.get(RunnerPresence),
        ctx.app.get(ScheduleFirer),
        ctx.app.get(ScheduleLive),
        options,
      );
      try {
        expect(await second.lead()).toBe(false);
        expect(await second.tick()).toBeNull();

        const view = await createOk({ cron: '0 * * * *', timezone: 'UTC' });
        await dueAt(view.id, at('2026-10-09T10:00:00Z'));
        await scheduler.release();
        expect(await second.lead()).toBe(true);
        expect(await second.tick(at('2026-10-09T10:00:05Z'))).toHaveLength(1);
        expect(await firings(view.id)).toHaveLength(1);

        // The same occurrence written again is refused by the unique key.
        await expect(
          ctx.prisma.scheduleFiring.create({
            data: {
              scheduleId: view.id,
              scheduledFor: at('2026-10-09T10:00:00Z'),
              kind: 'cron',
              status: 'due',
            },
          }),
        ).rejects.toThrow();
      } finally {
        await second.release();
      }
    });
  });

  describe('routes', () => {
    it('updates, disables, enables and deletes, each audited', async () => {
      const view = await createOk();
      const path = `/projects/${a}/schedules/${view.id}`;
      expect(
        (await operatorOfA.send('patch', path, { name: 'Renamed' })).status,
      ).toBe(200);
      const off = await operatorOfA.send('patch', path, { enabled: false });
      expect(off.body).toMatchObject({
        enabled: false,
        disabledReason: 'manual',
        nextRunAt: null,
      });
      await ctx.prisma.schedule.update({
        where: { id: view.id },
        data: { consecutiveFailures: 4 },
      });
      const on = await operatorOfA.send('patch', path, { enabled: true });
      expect(on.body).toMatchObject({
        enabled: true,
        disabledReason: null,
        consecutiveFailures: 0,
      });
      expect(on.body.nextRunAt).toBeTruthy();

      const detail = await viewerOfA.get(path);
      expect(detail.status).toBe(200);
      expect((detail.body as ScheduleDetail).firings).toEqual([]);

      expect((await operatorOfA.send('delete', path)).status).toBe(204);
      expect(await ctx.prisma.schedule.count()).toBe(0);
      for (const action of [
        'schedule.update',
        'schedule.disable',
        'schedule.enable',
        'schedule.delete',
      ]) {
        expect([action, (await auditOf(action)).length]).toEqual([action, 1]);
      }
    });

    it('authorization: viewer 403, non-member 404, admin routes 403 to operators', async () => {
      const view = await createOk();
      const routes = [
        ['post', `/projects/${a}/schedules`],
        ['patch', `/projects/${a}/schedules/${view.id}`],
        ['delete', `/projects/${a}/schedules/${view.id}`],
        ['post', `/projects/${a}/schedules/${view.id}/run-now`],
      ] as const;
      for (const [method, path] of routes) {
        const response = await viewerOfA.send(method, path, {});
        expect([path, response.status]).toEqual([path, 403]);
      }
      expect((await viewerOfA.get(`/projects/${a}/schedules`)).status).toBe(
        200,
      );

      for (const session of [outsider, operatorOfB]) {
        for (const [method, path] of [
          ...routes,
          ['get', `/projects/${a}/schedules`],
          ['get', `/projects/${a}/schedules/${view.id}`],
        ] as const) {
          const response =
            method === 'get'
              ? await session.get(path)
              : await session.send(method, path, {});
          expect([path, response.status]).toEqual([path, 404]);
        }
      }
      for (const path of ['/admin/schedules', '/admin/system-jobs']) {
        expect((await operatorOfA.get(path)).status).toBe(403);
      }
      expect(sent('skill.run')).toHaveLength(0);
    });

    it('admin lists schedules across projects and the system jobs', async () => {
      await createOk();
      const list = await admin.get(`/admin/schedules?enabled=true`);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].projectName).toBe('a');
      expect(
        (await admin.get(`/admin/schedules?projectId=${b}`)).body,
      ).toHaveLength(0);

      const jobs = await admin.get('/admin/system-jobs');
      expect(jobs.status).toBe(200);
      const audit = (jobs.body as SystemJobView[]).find(
        (j) => j.name === 'audit-verification',
      );
      expect(audit).toMatchObject({ kind: 'cron', cron: '0 3 * * *' });
      expect(audit?.nextRunAt).toBeTruthy();
    });
  });
});
