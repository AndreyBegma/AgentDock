import { Logger } from '@nestjs/common';
import type { RunKind } from '@prisma/client';
import { seedProject } from '../fleet/testing/fleet-e2e';
import { seedPrices } from '../prices/seed-prices';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  resetDatabase,
} from '../test/e2e-app';
import { ingest, resetUsage } from '../usage/testing/usage-e2e';
import { spendOf } from './budget-spend';
import { Feed } from './testing/budgets-e2e';

const ROOT = '/srv/dev/widget';
const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
/** `NOW` plus `s` seconds. */
const at = (s: number) => iso(NOW + s * 1000);
const DAY_START = new Date('2026-10-09T00:00:00.000Z');
const DAY_END = new Date('2026-10-10T00:00:00.000Z');
const MATCH_MS = 90_000;

/** Claude session ids are UUIDs: the API assigns them to cards and plans. */
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/**
 * C-121 (D-10): the spend of every run kind counts toward the user who
 * started it — board rounds, plan and design turns, UI profile builds and
 * skill runs, by hand or through a schedule firing that ran as them.
 */
describe('budget spend by run kind (D-10)', () => {
  let ctx: E2eContext;
  let runnerId: string;
  let projectId: string;
  let starter: string;
  let other: string;
  let instructionsId: string;
  let feed: Feed;
  let cardNumber = 0;

  const spent = async (userId: string) =>
    (
      await spendOf(
        ctx.prisma,
        { scope: 'user', userId },
        DAY_START,
        DAY_END,
        MATCH_MS,
      )
    ).spentUsd.toFixed(6);

  /** A run of `kind` that `userId` started in `[fromS, toS]` seconds after NOW. */
  const run = (
    kind: RunKind,
    userId: string,
    fromS: number,
    toS: number | null,
  ) =>
    ctx.prisma.run.create({
      data: {
        kind,
        projectId,
        status: toS === null ? 'running' : 'succeeded',
        triggeredByType: 'user',
        triggeredById: userId,
        startedAt: new Date(NOW + fromS * 1000),
        endedAt: toS === null ? null : new Date(NOW + toS * 1000),
        updatedAt: new Date(NOW),
      },
    });

  const card = (extra: { sessionId?: string; designSessionId?: string }) => {
    cardNumber += 1;
    return ctx.prisma.boardCard.create({
      data: {
        projectId,
        number: cardNumber,
        shortId: `card${cardNumber.toString().padStart(4, '0')}`,
        title: `Card ${cardNumber}`,
        position: cardNumber,
        issueOnRun: false,
        specOnRun: false,
        movedAt: new Date(NOW),
        ...extra,
      },
    });
  };

  const round = async (
    cardId: string,
    n: number,
    userId: string,
    fromS: number,
    toS: number | null,
  ) => {
    const r = await run('card', userId, fromS, toS);
    await ctx.prisma.boardCardRound.create({
      data: {
        cardId,
        round: n,
        runId: r.id,
        trigger: 'run',
        cardTitle: 'Card',
        cardBody: '',
        cardKind: 'feature',
        authorId: userId,
      },
    });
  };

  const plan = (sessionId: string) =>
    ctx.prisma.plan.create({
      data: {
        projectId,
        title: 'Exporter',
        brief: 'Build an exporter',
        mode: 'batch',
        status: 'drafting',
        sessionId,
        instructionsId,
        contractVersion: 1,
        profileKey: 'claude-main',
        model: 'opus',
      },
    });

  const turn = async (
    owner: { planId?: string; cardId?: string; stackId?: string },
    userId: string,
    fromS: number,
    toS: number,
    taskId?: string,
  ) => {
    const r = await run('plan', userId, fromS, toS);
    await ctx.prisma.planTurn.create({
      data: {
        ...owner,
        ...(taskId ? { taskId } : {}),
        runId: r.id,
        action: owner.planId ? 'decompose' : 'design',
        authorId: userId,
        input: {},
      },
    });
  };

  const skillRun = (
    worktree: string,
    trigger: { type: 'user' | 'schedule'; id: string },
  ) =>
    ctx.prisma.run.create({
      data: {
        kind: 'skill',
        projectId,
        status: 'running',
        triggeredByType: trigger.type,
        triggeredById: trigger.id,
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
            worktree,
          },
        },
      },
    });

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetUsage(ctx.prisma);
    await seedPrices(ctx.prisma);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    ({ runnerId, projectId } = await seedProject(ctx.prisma, ROOT));
    starter = (await createUser(ctx.prisma, 'op@example.com', 'operator')).id;
    other = (await createUser(ctx.prisma, 'other@example.com', 'operator')).id;
    instructionsId = (
      await ctx.prisma.plannerInstructions.create({
        data: { projectId: null, version: 1, body: 'GLOBAL' },
      })
    ).id;
    feed = new Feed();
    cardNumber = 0;
  });

  afterEach(() => jest.restoreAllMocks());

  it('counts a board round toward its starter, only inside the round’s window', async () => {
    const session = uuid(1);
    const c = await card({ sessionId: session });
    // Round 1 by the starter, round 2 by someone else, in the same session.
    await round(c.id, 1, starter, 0, 100);
    await round(c.id, 2, other, 200, null);
    await ingest(ctx, runnerId, [
      feed.session(session, '/srv/dev/.wt-widget-card-card0001', at(1), {
        projectId,
      }),
      feed.spend(session, 'r1', at(10)),
      // A subagent of round 1 counts with it.
      feed.session(uuid(2), '/srv/dev/.wt-widget-card-card0001', at(20), {
        projectId,
        parent: session,
      }),
      feed.spend(uuid(2), 'r1-sub', at(30)),
      // Round 2's requests are the other person's.
      feed.spend(session, 'r2', at(210)),
    ]);
    expect(await spent(starter)).toBe('3.000000');
    expect(await spent(other)).toBe('1.500000');
  });

  it('counts a plan turn, a task turn, a card design turn and a stack design turn toward their starter', async () => {
    const planSession = uuid(10);
    const taskSession = uuid(11);
    const cardDesign = uuid(12);
    const stackDesign = uuid(13);
    const p = await plan(planSession);
    const task = await ctx.prisma.planTask.create({
      data: {
        planId: p.id,
        key: 't1',
        planVersion: 1,
        kind: 'feature',
        title: 'Task',
        summary: 'Task',
        sessionId: taskSession,
      },
    });
    const c = await card({ designSessionId: cardDesign });
    const stack = await ctx.prisma.boardStack.create({
      data: {
        projectId,
        number: 1,
        title: 'Stack',
        designSessionId: stackDesign,
      },
    });
    await turn({ planId: p.id }, starter, 0, 50);
    await turn({ planId: p.id }, starter, 60, 100, task.id);
    await turn({ cardId: c.id }, starter, 0, 100);
    await turn({ stackId: stack.id }, starter, 0, 100);
    // The plan's session again, in a turn the other person started.
    await turn({ planId: p.id }, other, 300, 400);
    await ingest(ctx, runnerId, [
      feed.session(planSession, '/srv/dev/.wt-widget-plan-p1', at(1)),
      feed.spend(planSession, 'p1', at(10)),
      feed.session(taskSession, '/srv/dev/.wt-widget-plan-p1', at(61)),
      feed.spend(taskSession, 't1', at(70)),
      feed.session(cardDesign, '/srv/dev/.wt-widget-plan-c1', at(1)),
      feed.spend(cardDesign, 'c1', at(10)),
      feed.session(stackDesign, '/srv/dev/.wt-widget-plan-s1', at(1)),
      feed.spend(stackDesign, 's1', at(10)),
      feed.spend(planSession, 'p2', at(310)),
    ]);
    expect(await spent(starter)).toBe('6.000000');
    expect(await spent(other)).toBe('1.500000');
  });

  it('counts a UI profile build toward its starter, not another project session of the same time', async () => {
    await run('ui_profile', starter, 0, 100);
    await ingest(ctx, runnerId, [
      feed.session('build', '/srv/dev/.wt-widget-uiprofile-ab12cd', at(1), {
        projectId,
      }),
      feed.spend('build', 'u1', at(10)),
      // A UI profile session long after the build ended is not its.
      feed.session('later', '/srv/dev/.wt-widget-uiprofile-ef34gh', at(500), {
        projectId,
      }),
      feed.spend('later', 'u2', at(510)),
      // A fleet worker of the project in the same window.
      feed.session('worker', '/srv/dev/.wt-widget-i5', at(1), {
        projectId,
        slot: 'i5',
      }),
      feed.spend('worker', 'w1', at(10)),
    ]);
    expect(await spent(starter)).toBe('1.500000');
  });

  it('counts a skill run toward the person who started it, by hand or through a schedule firing that ran as them', async () => {
    await skillRun('/srv/dev/.wt-widget-run-aaaaaa', {
      type: 'user',
      id: starter,
    });
    const scheduled = await skillRun('/srv/dev/.wt-widget-run-bbbbbb', {
      type: 'schedule',
      id: 'sched-1',
    });
    const schedule = await ctx.prisma.schedule.create({
      data: {
        projectId,
        name: 'Nightly',
        target: {
          kind: 'skill',
          skill: 'estimate',
          args: '',
          output: 'report',
        },
        cron: '@daily',
        timezone: 'UTC',
        createdById: other,
      },
    });
    // Run now by the starter on the other person's schedule: theirs.
    await ctx.prisma.scheduleFiring.create({
      data: {
        scheduleId: schedule.id,
        scheduledFor: new Date(NOW),
        kind: 'manual',
        status: 'started',
        runId: scheduled.id,
        principalId: starter,
      },
    });
    await ingest(ctx, runnerId, [
      feed.session('mine', '/srv/dev/.wt-widget-run-aaaaaa', at(1), {
        projectId,
      }),
      feed.spend('mine', 'k1', at(10)),
      feed.session('fired', '/srv/dev/.wt-widget-run-bbbbbb', at(1), {
        projectId,
      }),
      feed.spend('fired', 'k2', at(10)),
    ]);
    expect(await spent(starter)).toBe('3.000000');
    expect(await spent(other)).toBe('0.000000');
  });
});
