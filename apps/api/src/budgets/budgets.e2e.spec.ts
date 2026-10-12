import type {
  BudgetExceededBody,
  BudgetRecomputeResult,
  BudgetView,
} from '@agentdock/shared';
import type { CommandName } from '@agentdock/shared/protocol';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { ControlService } from '../control/control.service';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { seedPrices } from '../prices/seed-prices';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import { SkillCommands } from '../skills/skill-commands';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { ingest, resetUsage } from '../usage/testing/usage-e2e';
import { BudgetClock } from './budget-options';
import { BudgetSweep } from './budget-sweep';
import { Feed } from './testing/budgets-e2e';

const ROOT_A = '/srv/dev/widget';
const ROOT_B = '/srv/dev/gadget';
/** A Friday morning, UTC. */
const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
/** `NOW` plus `s` seconds. */
const at = (s: number) => iso(NOW + s * 1000);

/** A small deterministic PRNG, so a failing randomized run can be replayed. */
const prng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

interface Sent {
  name: CommandName;
  args: Record<string, unknown>;
}

/** What the fake runner answers, per command. */
const OUTPUTS: Partial<Record<CommandName, unknown>> = {
  'orchestrator.start': {
    session: 'agentdock-orch-acme-widget',
    startedAt: '2026-10-09T10:00:00.000Z',
  },
  'orchestrator.stop': { stopped: true },
  'slot.stop': { stopped: true },
  'slot.message': { written: true, delivered: true },
};

describe('budgets (e2e)', () => {
  let ctx: E2eContext;
  let clock: BudgetClock;
  let sweep: BudgetSweep;
  let runnerId: string;
  let a: string;
  let b: string;
  let admin: Session;
  let adminId: string;
  let operatorOfA: Session;
  let operatorId: string;
  let viewerOfA: Session;
  let outsider: Session;
  let otherId: string;
  /** The runner command log: every command the API sent. */
  let sent: Sent[];
  let feed: Feed;
  let auditFrom = 0n;

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
    return { session: await login(ctx, email), id: user.id };
  };

  const auditOf = (action: string) =>
    ctx.prisma.auditRecord.findMany({
      where: { seq: { gt: auditFrom }, action },
      orderBy: { seq: 'asc' },
    });

  const createProjectBudget = async (body: object, projectId = a) => {
    const response = await admin.send(
      'post',
      `/projects/${projectId}/budgets`,
      {
        period: 'day',
        limitUsd: '10',
        action: 'alert',
        timezone: 'UTC',
        ...body,
      },
    );
    expect(response.status).toBe(201);
    return response.body as BudgetView;
  };

  const createUserBudget = async (userId: string, body: object = {}) => {
    const response = await admin.send('post', '/admin/budgets', {
      scope: 'user',
      userId,
      period: 'day',
      limitUsd: '10',
      action: 'alert',
      timezone: 'UTC',
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body as BudgetView;
  };

  /** Ingests, then runs the fast path as the debounce would. */
  const arrive = async (...events: Parameters<typeof ingest>[2]) => {
    await ingest(ctx, runnerId, events);
    await sweep.flush();
  };

  const period = (budgetId: string) =>
    ctx.prisma.budgetPeriodRow.findMany({
      where: { budgetId },
      orderBy: { start: 'asc' },
    });

  const notifications = (userId: string) =>
    ctx.prisma.notification.findMany({
      where: { userId, kind: { startsWith: 'budget.' } },
      orderBy: { id: 'asc' },
      select: { kind: true, title: true, projectId: true },
    });

  const start = (session: Session, mode: 'start' | 'next' = 'start') =>
    session.send('post', `/projects/${a}/orchestrator/start`, { mode });

  const startSkillRun = (session: Session) =>
    session.send('post', `/projects/${a}/skill-runs`, {
      skill: 'estimate',
      args: 'issue 28',
      model: 'opus',
      output: 'report',
    });

  /** A project-A worker spending `n` × $1.50 from `fromS` seconds after NOW. */
  let requestSeq = 0;
  const spendOnA = async (n: number, fromS = 0) => {
    const events = [
      feed.session('w-a', `${ROOT_A}-wt/i1`, at(fromS - 1), {
        projectId: a,
        slot: 'i1',
      }),
    ];
    for (let i = 0; i < n; i += 1) {
      requestSeq += 1;
      events.push(feed.spend('w-a', `ra-${requestSeq}`, at(fromS + i)));
    }
    await arrive(...events);
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
    clock = ctx.app.get(BudgetClock);
    sweep = ctx.app.get(BudgetSweep);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetUsage(ctx.prisma);
    await seedPrices(ctx.prisma);
    clock.set(new Date(NOW));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    ({ runnerId, projectId: a } = await seedProject(ctx.prisma, ROOT_A));
    ({ projectId: b } = await seedProject(ctx.prisma, ROOT_B, runnerId));
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
    await ctx.prisma.project.updateMany({
      where: { id: { in: [a, b] } },
      data: { defaultProfileId: profile.id },
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

    adminId = (await createUser(ctx.prisma, 'admin@example.com', 'admin')).id;
    admin = await login(ctx, 'admin@example.com');
    ({ session: operatorOfA, id: operatorId } = await memberOf(
      'operator-a@example.com',
      a,
      'operator',
    ));
    ({ session: viewerOfA } = await memberOf(
      'viewer-a@example.com',
      a,
      'viewer',
    ));
    ({ session: outsider, id: otherId } = await memberOf(
      'outsider@example.com',
      null,
      'operator',
    ));

    // A connected runner that answers every command, and the log of them.
    sent = [];
    jest
      .spyOn(ctx.app.get(RunnerPresence), 'isConnected')
      .mockReturnValue(true);
    jest
      .spyOn(ctx.app.get(SkillCommands), 'assertReady')
      .mockImplementation(() => undefined);
    jest
      .spyOn(ctx.app.get(RunnerCommandService), 'send')
      .mockImplementation(async (_runner, name, args) => {
        sent.push({ name, args: args as Record<string, unknown> });
        const output = OUTPUTS[name];
        return output === undefined
          ? { status: 'error', error: { code: 'unknown_command' } }
          : ({ status: 'ok', output, rttMs: 1 } as never);
      });

    feed = new Feed();
    requestSeq = 0;
    const last = await ctx.prisma.auditRecord.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    auditFrom = last?.seq ?? 0n;
  });

  afterEach(() => {
    clock.set(null);
    jest.restoreAllMocks();
  });

  describe('thresholds (D6)', () => {
    it('fires exactly one notification per threshold as priced requests arrive, none again in the period', async () => {
      const budget = await createProjectBudget({ thresholds: [50, 80, 100] });
      const seen: string[][] = [];
      // $1.50 a request: 50 % at $6.00 (4th), 80 % at $9.00 (6th), 100 % at $10.50 (7th).
      for (let i = 0; i < 9; i += 1) {
        await spendOnA(1, i * 10);
        seen.push((await notifications(adminId)).map((n) => n.kind));
      }
      expect(seen.map((s) => s.length)).toEqual([0, 0, 0, 1, 1, 2, 3, 3, 3]);
      expect(seen[8]).toEqual([
        'budget.threshold',
        'budget.threshold',
        'budget.exceeded',
      ]);
      const titles = (await notifications(adminId)).map((n) => n.title);
      expect(titles).toEqual([
        'Budget 50 % reached — widget',
        'Budget 80 % reached — widget',
        'Budget exceeded — widget',
      ]);

      // The sweep re-evaluates; nothing fires twice.
      await sweep.sweep();
      await sweep.sweep();
      expect(await notifications(adminId)).toHaveLength(3);

      // D6 recipients: the operator too, never the viewer.
      expect(await notifications(operatorId)).toHaveLength(3);
      const viewer = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'viewer-a@example.com' },
      });
      expect(await notifications(viewer.id)).toHaveLength(0);

      const [row] = await period(budget.id);
      expect(row.spentUsd.toFixed(6)).toBe('13.500000');
      expect(row.firedThresholds).toEqual([50, 80, 100]);
      expect(row.exceededAt).not.toBeNull();
    });

    it('counts an unpriced request as zero and as unpriced (D2)', async () => {
      const budget = await createProjectBudget({});
      await spendOnA(1);
      await arrive(feed.spend('w-a', 'unpriced-1', at(30), false));
      const [row] = await period(budget.id);
      expect(row.spentUsd.toFixed(6)).toBe('1.500000');
      expect(row.unpricedRequests).toBe(1);
      const view = (await admin.get(`/projects/${a}/budgets`))
        .body as BudgetView[];
      expect(view[0].current).toMatchObject({
        spentUsd: '1.500000',
        unpricedRequests: 1,
        percent: 15,
        state: 'ok',
      });
    });
  });

  describe('stop (D7, D11)', () => {
    it('refuses orchestrator start/next and skill runs with 409 budget_exceeded, keeps stop and message, and sends nothing to running work', async () => {
      const budget = await createProjectBudget({ action: 'stop' });
      await spendOnA(7);
      await sweep.sweep();
      // Exceeding the budget sent no command at all — nothing killed or messaged.
      expect(sent).toEqual([]);

      for (const mode of ['start', 'next'] as const) {
        const refused = await start(operatorOfA, mode);
        expect(refused.status).toBe(409);
        expect(refused.body as BudgetExceededBody).toEqual({
          statusCode: 409,
          error: 'budget_exceeded',
          message: expect.stringContaining('no new spend') as string,
          budgetId: budget.id,
          scope: 'project',
          resetsAt: '2026-10-10T00:00:00.000Z',
        });
      }
      const skill = await startSkillRun(operatorOfA);
      expect(skill.status).toBe(409);
      expect((skill.body as BudgetExceededBody).error).toBe('budget_exceeded');
      // Refused before anything was recorded or sent.
      expect(sent).toEqual([]);
      expect(await ctx.prisma.commandRun.count()).toBe(0);
      expect(await ctx.prisma.run.count()).toBe(0);

      // A person who wants a harder stop still has one.
      expect(
        (await operatorOfA.send('post', `/projects/${a}/orchestrator/stop`))
          .status,
      ).toBe(201);
      expect(
        (await operatorOfA.send('post', `/projects/${a}/slots/i1/stop`)).status,
      ).toBe(201);
      expect(
        (
          await operatorOfA.send('post', `/projects/${a}/slots/i1/message`, {
            text: 'wrap up',
          })
        ).status,
      ).toBe(201);
      expect(sent.map((s) => s.name)).toEqual([
        'orchestrator.stop',
        'slot.stop',
        'slot.message',
      ]);

      // Another project is not affected.
      const other = await admin.send(
        'post',
        `/projects/${b}/orchestrator/start`,
        { mode: 'start' },
      );
      expect(other.status).toBe(201);
    });

    it('lets an alert budget past 100 % through', async () => {
      await createProjectBudget({ action: 'alert' });
      await spendOnA(7);
      expect((await start(operatorOfA)).status).toBe(201);
    });

    it('has no lag at the gate: it evaluates without waiting for the debounce', async () => {
      await createProjectBudget({ action: 'stop' });
      const events = [
        feed.session('w-a', `${ROOT_A}-wt/i1`, at(-1), {
          projectId: a,
          slot: 'i1',
        }),
      ];
      for (let i = 0; i < 7; i += 1)
        events.push(feed.spend('w-a', `fast-${i}`, at(i)));
      await ingest(ctx, runnerId, events); // no flush
      expect((await start(operatorOfA)).status).toBe(409);
    });
  });

  describe('override (D8)', () => {
    it('lets starts through until it expires, is audited with reason, and revoking restores the refusal at once', async () => {
      const budget = await createProjectBudget({ action: 'stop' });
      await spendOnA(7);
      expect((await start(operatorOfA)).status).toBe(409);

      const until = at(3600);
      const overridden = await admin.send(
        'post',
        `/admin/budgets/${budget.id}/override`,
        { until, reason: 'release day' },
      );
      expect(overridden.status).toBe(201);
      expect((overridden.body as BudgetView).current?.state).toBe('overridden');
      expect((overridden.body as BudgetView).override).toMatchObject({
        until,
        reason: 'release day',
        by: { id: adminId, email: 'admin@example.com' },
      });
      expect((await start(operatorOfA)).status).toBe(201);

      const [record] = await auditOf('budget.override');
      expect(record.actorUserId).toBe(adminId);
      expect(record.meta).toMatchObject({ reason: 'release day' });
      expect(record.before).toEqual({ override: null });
      expect(record.after).toMatchObject({
        override: { until, reason: 'release day' },
      });

      // Expires on its own.
      clock.set(new Date(NOW + 3601_000));
      expect((await start(operatorOfA)).status).toBe(409);

      // A new one, revoked: refused again immediately.
      await admin
        .send('post', `/admin/budgets/${budget.id}/override`, {
          until: iso(NOW + 7200_000),
          reason: 'one more hour',
        })
        .expect(201);
      expect((await start(operatorOfA)).status).toBe(201);
      const revoked = await admin.send(
        'delete',
        `/admin/budgets/${budget.id}/override`,
      );
      expect(revoked.status).toBe(200);
      expect((revoked.body as BudgetView).override).toBeNull();
      expect((await start(operatorOfA)).status).toBe(409);
      const [revokeRecord] = await auditOf('budget.override_revoke');
      expect(revokeRecord.meta).toMatchObject({ reason: 'one more hour' });
      expect(revokeRecord.after).toMatchObject({
        override: { reason: 'one more hour' },
      });

      // Thresholds still notified while overridden: no duplicates either.
      expect(
        (await notifications(adminId)).filter(
          (n) => n.kind === 'budget.exceeded',
        ),
      ).toHaveLength(1);
    });

    it('refuses an override past the period end, on an alert budget, and a revoke with none active', async () => {
      const stop = await createProjectBudget({ action: 'stop' });
      const past = await admin.send(
        'post',
        `/admin/budgets/${stop.id}/override`,
        {
          until: '2026-10-10T00:00:01.000Z',
          reason: 'too long',
        },
      );
      expect(past.status).toBe(400);
      const none = await admin.send(
        'delete',
        `/admin/budgets/${stop.id}/override`,
      );
      expect(none.status).toBe(409);
      const alert = await createProjectBudget({ action: 'alert' }, b);
      const notStop = await admin.send(
        'post',
        `/admin/budgets/${alert.id}/override`,
        { until: at(60), reason: 'x' },
      );
      expect(notStop.status).toBe(409);
    });
  });

  describe('user budgets (D3)', () => {
    it('counts the user’s skill run and orchestrator session, not fleet workers or other users', async () => {
      const budget = await createUserBudget(operatorId);
      // An orchestrator.start by the operator, and one by the admin later on.
      await ctx.prisma.commandRun.create({
        data: {
          projectId: a,
          runnerId,
          userId: operatorId,
          command: 'orchestrator.start',
          args: {},
          status: 'ok',
          requestedAt: new Date(NOW),
        },
      });
      await ctx.prisma.commandRun.create({
        data: {
          projectId: b,
          runnerId,
          userId: adminId,
          command: 'orchestrator.start',
          args: {},
          status: 'ok',
          requestedAt: new Date(NOW),
        },
      });
      // A skill run the operator started, and one a schedule started.
      const run = await ctx.prisma.run.create({
        data: {
          kind: 'skill',
          projectId: a,
          status: 'running',
          triggeredByType: 'user',
          triggeredById: operatorId,
          startedAt: new Date(NOW),
          updatedAt: new Date(NOW),
          skillRun: {
            create: {
              skill: 'estimate',
              args: '',
              profileKey: 'claude-main',
              model: 'opus',
              permissionMode: 'auto',
              output: 'report',
              timeoutSec: 600,
              worktree: '/srv/dev/.wt-widget-run-a1b2c3',
            },
          },
        },
      });
      await ctx.prisma.run.create({
        data: {
          kind: 'skill',
          projectId: a,
          status: 'running',
          triggeredByType: 'schedule',
          triggeredById: 'sched-1',
          startedAt: new Date(NOW),
          updatedAt: new Date(NOW),
          skillRun: {
            create: {
              skill: 'estimate',
              args: '',
              profileKey: 'claude-main',
              model: 'opus',
              permissionMode: 'auto',
              output: 'report',
              timeoutSec: 600,
              worktree: '/srv/dev/.wt-widget-run-d4e5f6',
            },
          },
        },
      });
      expect(run.id).toBeTruthy();

      await arrive(
        // The operator's orchestrator: project root, 30 s after the start.
        feed.session('orch', ROOT_A, at(30), { projectId: a }),
        feed.spend('orch', 'o1', at(40)),
        // Its subagent counts with it.
        feed.session('orch-sub', ROOT_A, at(500), {
          projectId: a,
          parent: 'orch',
        }),
        feed.spend('orch-sub', 'o2', at(510)),
        // The operator's skill run, and a subdirectory of its worktree.
        feed.session('skill', '/srv/dev/.wt-widget-run-a1b2c3', at(60), {
          projectId: a,
        }),
        feed.spend('skill', 's1', at(70)),
        feed.session(
          'skill-sub',
          '/srv/dev/.wt-widget-run-a1b2c3/pkg',
          at(80),
          { projectId: a },
        ),
        feed.spend('skill-sub', 's2', at(90)),
        // Not the operator's: a fleet worker of the same project ...
        feed.session('worker', '/srv/dev/.wt-widget-i5', at(30), {
          projectId: a,
          slot: 'i5',
        }),
        feed.spend('worker', 'w1', at(40)),
        // ... the scheduled run ...
        feed.session('sched', '/srv/dev/.wt-widget-run-d4e5f6', at(60), {
          projectId: a,
        }),
        feed.spend('sched', 'x1', at(70)),
        // ... a root session that began too late after the start ...
        feed.session('late', ROOT_A, at(121), { projectId: a }),
        feed.spend('late', 'l1', at(130)),
        // ... the admin's orchestrator on B ...
        feed.session('orch-b', ROOT_B, at(10), { projectId: b }),
        feed.spend('orch-b', 'b1', at(20)),
        // ... and a worktree whose name only starts like the run's.
        feed.session('lookalike', '/srv/dev/.wt-widget-run-a1b2c3x', at(60), {
          projectId: a,
        }),
        feed.spend('lookalike', 'k1', at(70)),
      );

      const [row] = await period(budget.id);
      expect(row.spentUsd.toFixed(6)).toBe('6.000000'); // o1, o2, s1, s2

      const admins = (await createUserBudget(adminId)).id;
      const [adminRow] = await period(admins);
      expect(adminRow.spentUsd.toFixed(6)).toBe('1.500000'); // b1
    });

    it('refuses the user’s own starts on any project once their stop budget is exceeded', async () => {
      await createUserBudget(operatorId, { action: 'stop', limitUsd: '1' });
      await ctx.prisma.commandRun.create({
        data: {
          projectId: a,
          runnerId,
          userId: operatorId,
          command: 'orchestrator.start',
          args: {},
          status: 'ok',
          requestedAt: new Date(NOW),
        },
      });
      await arrive(
        feed.session('orch', ROOT_A, at(5), { projectId: a }),
        feed.spend('orch', 'o1', at(6)),
      );
      const refused = await start(operatorOfA);
      expect(refused.status).toBe(409);
      expect((refused.body as BudgetExceededBody).scope).toBe('user');
      // The admin starting on the same project is not this user.
      expect((await start(admin)).status).toBe(201);
    });

    it('keeps a scheduled orchestrator start project-only: neither counted nor gated by its creator’s budget (#25)', async () => {
      const budget = await createUserBudget(operatorId, {
        action: 'stop',
        limitUsd: '1',
      });
      const schedule = await ctx.prisma.schedule.create({
        data: {
          projectId: a,
          name: 'nightly next',
          target: { kind: 'orchestrator', mode: 'next' },
          cron: '@daily',
          timezone: 'UTC',
          createdById: operatorId,
        },
      });
      // A firing sends the start as the system, with the creator as `user`.
      const control = ctx.app.get(ControlService, { strict: false });
      const fired = await control.start(
        {
          projectId: a,
          role: 'operator',
          user: { id: operatorId, email: 'operator-a@example.com' },
          ctx: { actor: SYSTEM_ACTOR },
        },
        { mode: 'next' },
      );
      await ctx.prisma.scheduleFiring.create({
        data: {
          scheduleId: schedule.id,
          scheduledFor: new Date(NOW),
          kind: 'cron',
          status: 'succeeded',
          commandRunId: fired.id,
        },
      });
      const requestedAt = (
        await ctx.prisma.commandRun.findUniqueOrThrow({
          where: { id: fired.id },
        })
      ).requestedAt.getTime();
      await arrive(
        feed.session('orch', ROOT_A, iso(requestedAt + 5_000), {
          projectId: a,
        }),
        feed.spend('orch', 'o1', iso(requestedAt + 6_000)),
      );
      const [row] = await period(budget.id);
      expect(row.spentUsd.toFixed(6)).toBe('0.000000');

      // Over budget by their own start: the person is refused, the schedule is not.
      await ctx.prisma.commandRun.create({
        data: {
          projectId: a,
          runnerId,
          userId: operatorId,
          command: 'orchestrator.start',
          args: {},
          status: 'ok',
          requestedAt: new Date(NOW + 600_000),
        },
      });
      await arrive(
        feed.session('mine', ROOT_A, at(605), { projectId: a }),
        feed.spend('mine', 'm1', at(606)),
      );
      expect((await start(operatorOfA)).status).toBe(409);
      await expect(
        control.start(
          {
            projectId: a,
            role: 'operator',
            user: { id: operatorId, email: 'operator-a@example.com' },
            ctx: { actor: SYSTEM_ACTOR },
          },
          { mode: 'next' },
        ),
      ).resolves.toMatchObject({ status: 'ok' });
    });
  });

  describe('periods (D9)', () => {
    it('resets a Europe/Berlin daily budget at local midnight across the DST change, with nothing fired', async () => {
      // 2026-10-25: Berlin goes from UTC+2 to UTC+1 at 03:00 local.
      const before = Date.parse('2026-10-24T21:30:00.000Z'); // 23:30 local
      clock.set(new Date(before));
      const budget = await createProjectBudget({
        timezone: 'Europe/Berlin',
        action: 'stop',
      });
      const events = [
        feed.session('w-a', `${ROOT_A}-wt/i1`, iso(before - 1000), {
          projectId: a,
          slot: 'i1',
        }),
      ];
      for (let i = 0; i < 7; i += 1)
        events.push(feed.spend('w-a', `d-${i}`, iso(before + i * 1000)));
      await arrive(...events);
      const refused = await start(operatorOfA);
      expect(refused.status).toBe(409);
      expect((refused.body as BudgetExceededBody).resetsAt).toBe(
        '2026-10-24T22:00:00.000Z',
      );

      // Local midnight: a new period, 25 hours long, starting empty.
      clock.set(new Date('2026-10-24T22:00:00.000Z'));
      await sweep.sweep();
      const rows = await period(budget.id);
      expect(
        rows.map((r) => [r.start.toISOString(), r.end.toISOString()]),
      ).toEqual([
        ['2026-10-23T22:00:00.000Z', '2026-10-24T22:00:00.000Z'],
        ['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
      ]);
      expect(rows[0].firedThresholds).toEqual([50, 80, 100]);
      expect(rows[1].firedThresholds).toEqual([]);
      expect(rows[1].spentUsd.toFixed(6)).toBe('0.000000');
      // The closed period got its final reconciliation.
      expect(rows[0].reconciledAt.getTime()).toBeGreaterThanOrEqual(
        rows[0].end.getTime(),
      );
      expect((await start(operatorOfA)).status).toBe(201);

      // And the following midnight is 23:00 UTC, after the change.
      clock.set(new Date('2026-10-25T23:00:00.000Z'));
      await sweep.sweep();
      expect((await period(budget.id)).at(-1)?.start.toISOString()).toBe(
        '2026-10-25T23:00:00.000Z',
      );
    });
  });

  describe('reconciliation (D4, D5)', () => {
    it('makes every affected period equal a from-scratch sum after #13 re-prices a range', async () => {
      const day = await createProjectBudget({});
      const user = await createUserBudget(operatorId);
      await ctx.prisma.commandRun.create({
        data: {
          projectId: a,
          runnerId,
          userId: operatorId,
          command: 'orchestrator.start',
          args: {},
          status: 'ok',
          requestedAt: new Date(NOW - 86_400_000),
        },
      });
      // Yesterday and today, on the operator's orchestrator session.
      clock.set(new Date(NOW - 86_400_000));
      await arrive(
        feed.session('orch', ROOT_A, iso(NOW - 86_400_000 + 10_000), {
          projectId: a,
        }),
        feed.spend('orch', 'y1', iso(NOW - 86_400_000 + 20_000)),
        feed.spend('orch', 'y2', iso(NOW - 86_400_000 + 30_000)),
      );
      clock.set(new Date(NOW));
      await arrive(feed.spend('orch', 't1', at(10)));
      expect(await period(day.id)).toHaveLength(2);

      // #13's recompute rewrote yesterday's prices.
      await ctx.prisma.llmRequest.updateMany({
        where: { ts: { lt: new Date(NOW - 3_600_000) } },
        data: { costUsd: new Prisma.Decimal('0.250000') },
      });
      const result = await admin.send('post', '/admin/budgets/recompute', {});
      expect(result.status).toBe(200);
      expect(result.body as BudgetRecomputeResult).toEqual({
        budgets: 2,
        periods: 4,
      });

      for (const budgetId of [day.id, user.id]) {
        for (const p of await period(budgetId)) {
          const [{ sum }] = await ctx.prisma.$queryRaw<{ sum: string }[]>`
            SELECT coalesce(sum("costUsd"), 0)::text AS sum FROM llm_requests
            WHERE ts >= ${p.start} AND ts < ${p.end}`;
          expect(p.spentUsd.toFixed(6)).toBe(
            new Prisma.Decimal(sum).toFixed(6),
          );
        }
      }
      expect((await period(day.id))[0].spentUsd.toFixed(6)).toBe('0.500000');
      const [record] = await auditOf('budget.recompute');
      expect(record.after).toEqual({ budgets: 2, periods: 4 });
    });

    it('keeps spentUsd equal to a from-scratch sum through a randomized ingestion of 1 000 requests', async () => {
      const project = await createProjectBudget({
        period: 'week',
        limitUsd: '100000',
      });
      const user = await createUserBudget(operatorId, {
        period: 'week',
        limitUsd: '100000',
      });
      await ctx.prisma.commandRun.create({
        data: {
          projectId: a,
          runnerId,
          userId: operatorId,
          command: 'orchestrator.start',
          args: {},
          status: 'ok',
          requestedAt: new Date(NOW - 3_600_000),
        },
      });
      const random = prng(28);
      const userSessions = new Set(['orch']);
      await arrive(
        feed.session('orch', ROOT_A, at(-3590), { projectId: a }),
        feed.session('w1', '/srv/dev/.wt-widget-i1', at(-3590), {
          projectId: a,
          slot: 'i1',
        }),
        feed.session('w2', '/srv/dev/.wt-widget-i2', at(-3590), {
          projectId: a,
          slot: 'i2',
        }),
        feed.session('gb', ROOT_B, at(-3590), { projectId: b }),
      );
      const sessions = ['orch', 'w1', 'w2', 'gb'];
      /** Request id → its session, for re-sends. */
      const issued: [string, string][] = [];
      let resends = 0;
      for (let batch = 0; batch < 20; batch += 1) {
        const events = [];
        for (let i = 0; i < 50; i += 1) {
          // One in ten re-sends an earlier request with new usage (spec 12 D4).
          let requestId: string;
          let sessionId: string;
          if (issued.length > 0 && random() < 0.1) {
            [requestId, sessionId] =
              issued[Math.floor(random() * issued.length)];
            resends += 1;
          } else {
            requestId = `r${issued.length}`;
            sessionId = sessions[Math.floor(random() * sessions.length)];
            issued.push([requestId, sessionId]);
          }
          events.push(
            feed.request(
              sessionId,
              requestId,
              random() < 0.05 ? 'acme-unknown' : 'claude-sonnet-4-5-20250929',
              {
                input: 1 + Math.floor(random() * 200_000),
                output: Math.floor(random() * 20_000),
              },
              at(-3000 + batch * 60 + i),
            ),
          );
        }
        await arrive(...events);
      }

      const sumOf = async (sessionFilter: Prisma.Sql) => {
        const [row] = await ctx.prisma.$queryRaw<
          { sum: string; unpriced: number }[]
        >`
          SELECT coalesce(sum(r."costUsd"), 0)::text AS sum,
                 (count(*) FILTER (WHERE r."costUsd" IS NULL))::int AS unpriced
          FROM llm_requests r JOIN sessions s ON s.id = r."sessionId"
          WHERE ${sessionFilter}`;
        return row;
      };
      const [projectRow] = await period(project.id);
      const projectTruth = await sumOf(Prisma.sql`s."projectId" = ${a}`);
      expect(projectRow.spentUsd.toFixed(6)).toBe(
        new Prisma.Decimal(projectTruth.sum).toFixed(6),
      );
      expect(projectRow.unpricedRequests).toBe(projectTruth.unpriced);

      const [userRow] = await period(user.id);
      const userTruth = await sumOf(
        Prisma.sql`s."externalId" IN (${Prisma.join([...userSessions])})`,
      );
      expect(userRow.spentUsd.toFixed(6)).toBe(
        new Prisma.Decimal(userTruth.sum).toFixed(6),
      );
      expect(userRow.unpricedRequests).toBe(userTruth.unpriced);
      // The run exercised what it claims to.
      expect(Number(userTruth.sum)).toBeGreaterThan(0);
      expect(resends).toBeGreaterThan(50);
      expect(issued.length + resends).toBe(1000);
      expect(projectTruth.unpriced).toBeGreaterThan(0);
    }, 120_000);
  });

  describe('authorization (D10)', () => {
    it('is 404 for a non-member on every project budget route', async () => {
      const budget = await createProjectBudget({});
      const routes = [
        ['get', `/projects/${a}/budgets`],
        ['post', `/projects/${a}/budgets`],
        ['patch', `/projects/${a}/budgets/${budget.id}`],
        ['delete', `/projects/${a}/budgets/${budget.id}`],
      ] as const;
      for (const [method, path] of routes) {
        const response =
          method === 'get'
            ? await outsider.get(path)
            : await outsider.send(method, path, {
                period: 'day',
                limitUsd: '1',
                action: 'alert',
              });
        expect([method, path, response.status]).toEqual([method, path, 404]);
      }
    });

    it('lets an operator and a viewer read, and refuses them create/update/delete/override with 403', async () => {
      const budget = await createProjectBudget({ action: 'stop' });
      for (const session of [operatorOfA, viewerOfA]) {
        const list = await session.get(`/projects/${a}/budgets`);
        expect(list.status).toBe(200);
        expect((list.body as BudgetView[]).map((v) => v.id)).toEqual([
          budget.id,
        ]);
        const calls = [
          session.send('post', `/projects/${a}/budgets`, {
            period: 'week',
            limitUsd: '1',
            action: 'alert',
          }),
          session.send('patch', `/projects/${a}/budgets/${budget.id}`, {
            limitUsd: '2',
          }),
          session.send('delete', `/projects/${a}/budgets/${budget.id}`),
          session.send('post', `/admin/budgets/${budget.id}/override`, {
            until: at(60),
            reason: 'x',
          }),
          session.send('delete', `/admin/budgets/${budget.id}/override`),
        ];
        for (const response of await Promise.all(calls)) {
          expect(response.status).toBe(403);
        }
      }
    });

    it('never returns another user’s budget on /me/budgets', async () => {
      const mine = await createUserBudget(operatorId);
      await createUserBudget(otherId);
      await createProjectBudget({});
      const response = await operatorOfA.get('/me/budgets');
      expect(response.status).toBe(200);
      expect((response.body as BudgetView[]).map((v) => v.id)).toEqual([
        mine.id,
      ]);
      expect((await outsider.get('/me/budgets')).body).toHaveLength(1);
    });

    it('is 403 on every /admin/budgets route for a non-admin', async () => {
      const budget = await createProjectBudget({});
      const routes = [
        ['get', '/admin/budgets'],
        ['post', '/admin/budgets'],
        ['patch', `/admin/budgets/${budget.id}`],
        ['delete', `/admin/budgets/${budget.id}`],
        ['post', `/admin/budgets/${budget.id}/override`],
        ['delete', `/admin/budgets/${budget.id}/override`],
        ['post', '/admin/budgets/recompute'],
      ] as const;
      for (const session of [operatorOfA, viewerOfA, outsider]) {
        for (const [method, path] of routes) {
          const response =
            method === 'get'
              ? await session.get(path)
              : await session.send(method, path, {});
          expect([method, path, response.status]).toEqual([method, path, 403]);
        }
      }
    });
  });

  describe('changes (D1, D8)', () => {
    it('audits create, update and delete with before and after', async () => {
      const budget = await createProjectBudget({ thresholds: [80, 25] });
      expect(budget.thresholds).toEqual([25, 80, 100]);
      await admin
        .send('patch', `/projects/${a}/budgets/${budget.id}`, {
          limitUsd: '25.5',
          enabled: false,
        })
        .expect(200);
      await admin
        .send('delete', `/projects/${a}/budgets/${budget.id}`)
        .expect(204);

      const [created] = await auditOf('budget.create');
      expect(created.actorUserId).toBe(adminId);
      expect(created.projectId).toBe(a);
      expect(created.targetId).toBe(budget.id);
      expect(created.after).toMatchObject({
        limitUsd: '10.0000',
        thresholds: [25, 80, 100],
      });
      const [updated] = await auditOf('budget.update');
      expect(updated.before).toMatchObject({
        limitUsd: '10.0000',
        enabled: true,
      });
      expect(updated.after).toMatchObject({
        limitUsd: '25.5000',
        enabled: false,
      });
      const [deleted] = await auditOf('budget.delete');
      expect(deleted.before).toMatchObject({ limitUsd: '25.5000' });
      expect(deleted.after).toBeNull();
    });

    it('validates D1: zone, limit, thresholds, one enabled budget per scope and period', async () => {
      const bad = [
        { timezone: 'Mars/Olympus' },
        { limitUsd: '0' },
        { limitUsd: '-1' },
        { limitUsd: '1.23456' },
        { thresholds: [0] },
        { thresholds: [50.5] },
        { period: 'year' },
        { action: 'kill' },
      ];
      for (const body of bad) {
        const response = await admin.send('post', `/projects/${a}/budgets`, {
          period: 'day',
          limitUsd: '10',
          action: 'alert',
          ...body,
        });
        expect([body, response.status]).toEqual([body, 400]);
      }
      await createProjectBudget({});
      const twice = await admin.send('post', `/projects/${a}/budgets`, {
        period: 'day',
        limitUsd: '20',
        action: 'stop',
      });
      expect(twice.status).toBe(409);
      // A disabled one does not count, and another period is fine.
      await createProjectBudget({ enabled: false });
      await createProjectBudget({ period: 'month' });
    });

    it('defaults the zone to APP_TIMEZONE, else UTC', async () => {
      const response = await admin.send('post', `/projects/${a}/budgets`, {
        period: 'day',
        limitUsd: '10',
        action: 'alert',
      });
      expect((response.body as BudgetView).timezone).toBe(
        process.env.APP_TIMEZONE ?? 'UTC',
      );
    });

    it('filters /admin/budgets by scope and state', async () => {
      await createProjectBudget({});
      await createUserBudget(operatorId);
      await spendOnA(7);
      const all = (await admin.get('/admin/budgets')).body as BudgetView[];
      expect(all).toHaveLength(2);
      const users = (await admin.get('/admin/budgets?scope=user'))
        .body as BudgetView[];
      expect(users.map((v) => v.scope)).toEqual(['user']);
      expect(users[0].scopeName).toBe('operator-a@example.com');
      const exceeded = (await admin.get('/admin/budgets?state=exceeded'))
        .body as BudgetView[];
      expect(exceeded.map((v) => v.scopeName)).toEqual(['widget']);
    });
  });
});
