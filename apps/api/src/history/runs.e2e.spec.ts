import type { RunDetail, RunPage, RunSummary } from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import { resetActivity } from '../activity/testing/activity-e2e';
import { seedProject } from '../fleet/testing/fleet-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { RunsProjector } from './runs-projector.service';

const T0 = Date.parse('2026-10-08T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe('execution history (e2e)', () => {
  let ctx: E2eContext;
  let projector: RunsProjector;
  let runnerId: string;
  let projectId: string;
  let admin: Session;

  const slot = (
    name: string,
    fields: Partial<Prisma.SlotUncheckedCreateInput> = {},
  ) =>
    ctx.prisma.slot.create({
      data: {
        projectId,
        name,
        worktree: `/srv/dev/.wt-widget-${name}`,
        owns: [],
        never: [],
        status: 'running',
        lastSeq: 1n,
        startedAt: at(0),
        updatedAt: at(1),
        ...fields,
      },
    });

  const runOf = (slotId: string) =>
    ctx.prisma.run.findUniqueOrThrow({ where: { slotId } });

  beforeAll(async () => {
    ctx = await createE2eApp();
    projector = ctx.app.get(RunsProjector);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await resetActivity(ctx.prisma);
    ({ runnerId, projectId } = await seedProject(ctx.prisma));
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    admin = await login(ctx, 'admin@example.com');
  });

  describe('projection (D7)', () => {
    it('gives every existing slot exactly one run, with its status from the PR', async () => {
      const merged = await slot('merged', {
        status: 'ended',
        prNumber: 7,
        prUrl: 'https://github.com/acme/widget/pull/7',
        prState: 'merged',
        endedAt: at(30),
        updatedAt: at(30),
      });
      const closed = await slot('closed', {
        status: 'stale',
        sessionAlive: false,
        prNumber: 8,
        prState: 'closed',
        updatedAt: at(40),
      });
      const noPr = await slot('nopr', {
        status: 'ended',
        worktreeExists: false,
        endedAt: at(20),
        updatedAt: at(20),
      });
      const live = await slot('live', {
        status: 'running',
        sessionAlive: true,
      });

      expect(await projector.tick()).toBe(4);
      expect(await ctx.prisma.run.count()).toBe(4);
      expect(await runOf(merged.id)).toMatchObject({
        kind: 'orchestrator_slot',
        status: 'succeeded',
        output: 'pr',
        prNumber: 7,
        endedAt: at(30),
        durationMs: 30 * 60_000,
        triggeredByType: 'orchestrator',
      });
      expect((await runOf(closed.id)).status).toBe('failed');
      expect((await runOf(noPr.id)).status).toBe('abandoned');
      expect(await runOf(live.id)).toMatchObject({
        status: 'running',
        endedAt: null,
        durationMs: null,
      });

      // Nothing changed: nothing is rewritten.
      expect(await projector.tick()).toBe(0);
    });

    it('rebuilds a run when its slot changes, keeping one run per slot', async () => {
      const row = await slot('i21', { sessionAlive: true });
      await ctx.prisma.slotCheckpoint.create({
        data: {
          slotId: row.id,
          kind: 'blocked',
          heading: 'blocked',
          summary: 'needs a grant',
          position: 0,
          at: at(2),
        },
      });
      await ctx.prisma.slot.update({
        where: { id: row.id },
        data: { lastCheckpoint: 'blocked', lastSeq: 2n, updatedAt: at(2) },
      });
      await projector.tick();
      const first = await runOf(row.id);
      expect(first).toMatchObject({
        status: 'blocked',
        outcome: 'needs a grant',
      });

      // A replayed spool writes an older `updatedAt` but a higher `lastSeq`.
      await ctx.prisma.slot.update({
        where: { id: row.id },
        data: {
          lastCheckpoint: 'pr_open',
          prNumber: 9,
          prState: 'open',
          lastSeq: 3n,
          updatedAt: at(1),
        },
      });
      expect(await projector.tick()).toBe(1);
      const second = await runOf(row.id);
      expect(second.id).toBe(first.id);
      expect(second).toMatchObject({
        status: 'running',
        prNumber: 9,
        slotSeq: 3n,
      });
    });

    it('rebuilds identical runs from scratch', async () => {
      await slot('a', {
        status: 'ended',
        prNumber: 1,
        prState: 'merged',
        endedAt: at(5),
      });
      await slot('b', { status: 'quota', sessionAlive: true, pane: 'quota' });
      await projector.tick();
      const strip = (rows: { id: string; slotId: string | null }[]) =>
        rows.map(({ id: _id, ...rest }) => rest);
      const before = strip(
        await ctx.prisma.run.findMany({ orderBy: { slotId: 'asc' } }),
      );
      await ctx.prisma.run.deleteMany();
      await projector.tick();
      expect(
        strip(await ctx.prisma.run.findMany({ orderBy: { slotId: 'asc' } })),
      ).toEqual(before);
    });
  });

  describe('tokens and cost (D8)', () => {
    const session = (slotName: string, externalId: string) =>
      ctx.prisma.agentSession.create({
        data: {
          runnerId,
          runtime: 'claude',
          externalId,
          projectId,
          slotName,
          cwd: `/srv/dev/.wt-widget-${slotName}`,
          startedAt: at(0),
          lastEventAt: at(10),
        },
      });

    const request = (
      sessionId: string,
      requestId: string,
      minute: number,
      tokens: { input: number; output: number },
      costUsd: string | null,
    ) =>
      ctx.prisma.llmRequest.create({
        data: {
          sessionId,
          requestId,
          ts: at(minute),
          model: 'claude-opus-5-5',
          querySource: 'main',
          ...tokens,
          costUsd,
        },
      });

    it('sums the slot’s requests in the run window, priced and unpriced', async () => {
      const row = await slot('i21', {
        status: 'ended',
        prNumber: 3,
        prState: 'merged',
        endedAt: at(30),
        updatedAt: at(30),
      });
      const main = await session('i21', 's-main');
      const other = await session('i22', 's-other');
      await request(main.id, 'q1', 1, { input: 100, output: 10 }, '0.500000');
      await request(main.id, 'q2', 2, { input: 200, output: 20 }, '0.250000');
      await request(main.id, 'q3', 3, { input: 50, output: 5 }, null);
      // Outside the window, and another slot's: neither counts.
      await request(main.id, 'q4', 45, { input: 999, output: 999 }, '9.000000');
      await request(other.id, 'q5', 2, { input: 999, output: 999 }, '9.000000');
      await projector.tick();

      const page = (await admin.get(`/projects/${projectId}/runs`).expect(200))
        .body as RunPage;
      expect(page.items).toHaveLength(1);
      expect(page.items[0].usage).toMatchObject({
        requests: 3,
        input: 350,
        output: 35,
        costUsd: '0.750000',
        unpricedRequests: 1,
      });

      const detail = (
        await admin
          .get(`/projects/${projectId}/runs/${(await runOf(row.id)).id}`)
          .expect(200)
      ).body as RunDetail;
      expect(detail.slot).toBe('i21');
      expect(detail.sessions).toHaveLength(1);
      expect(detail.sessions[0].usage.requests).toBe(3);
    });

    it('reports a null cost with unpriced requests while nothing is priced', async () => {
      await slot('i21', { sessionAlive: true });
      const main = await session('i21', 's-main');
      await request(main.id, 'q1', 1, { input: 10, output: 1 }, null);
      await request(main.id, 'q2', 2, { input: 10, output: 1 }, null);
      await projector.tick();

      const [run] = (
        (await admin.get(`/projects/${projectId}/runs`).expect(200))
          .body as RunPage
      ).items;
      expect(run.usage).toMatchObject({
        requests: 2,
        costUsd: null,
        unpricedRequests: 2,
      });
    });
  });

  describe('routes', () => {
    it('lists newest first with filters and a stable cursor', async () => {
      for (let i = 0; i < 5; i += 1) {
        await slot(`s${i}`, {
          startedAt: at(i),
          updatedAt: at(i),
          status: i % 2 === 0 ? 'running' : 'ended',
          issue: 20 + i,
        });
      }
      await projector.tick();
      const url = `/projects/${projectId}/runs`;
      const first = (await admin.get(`${url}?limit=2`).expect(200))
        .body as RunPage;
      expect(first.items.map((r: RunSummary) => r.slot)).toEqual(['s4', 's3']);
      await slot('s9', { startedAt: at(99), updatedAt: at(99) });
      await projector.tick();
      const second = (
        await admin.get(`${url}?limit=2&cursor=${first.nextCursor}`).expect(200)
      ).body as RunPage;
      expect(second.items.map((r) => r.slot)).toEqual(['s2', 's1']);

      const abandoned = (await admin.get(`${url}?status=abandoned`).expect(200))
        .body as RunPage;
      expect(abandoned.items.map((r) => r.slot)).toEqual(['s3', 's1']);
      // The status chips count under every filter but the status itself.
      expect(abandoned.counts).toMatchObject({
        running: 4,
        abandoned: 2,
        failed: 0,
        succeeded: 0,
      });
      const issue = (await admin.get(`${url}?issue=22`).expect(200))
        .body as RunPage;
      expect(issue.items.map((r) => r.slot)).toEqual(['s2']);
      expect(issue.counts).toEqual({
        running: 1,
        blocked: 0,
        waiting_person: 0,
        succeeded: 0,
        failed: 0,
        abandoned: 0,
      });
      await admin.get(`${url}?status=bogus`).expect(400);
    });

    it('names the plan of a planner run, and no plan for a slot run', async () => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'admin@example.com' },
      });
      const instructions = await ctx.prisma.plannerInstructions.create({
        data: { projectId, version: 1, body: 'plan well' },
      });
      const plan = await ctx.prisma.plan.create({
        data: {
          projectId,
          authorId: user.id,
          title: 'Exporter',
          brief: 'Build an exporter',
          mode: 'batch',
          visibility: 'project',
          status: 'drafting',
          sessionId: '6f1c1d0e-5b7a-4c1e-9a52-1f3a7c9d2e10',
          instructionsId: instructions.id,
          contractVersion: 1,
          profileKey: 'claude-main',
          model: 'opus',
        },
      });
      const run = await ctx.prisma.run.create({
        data: {
          kind: 'plan',
          projectId,
          title: 'Plan decompose',
          status: 'failed',
          outcome: 'plan.turn failed on the runner: unknown_command',
          triggeredByType: 'user',
          startedAt: at(5),
          endedAt: at(6),
          updatedAt: at(6),
        },
      });
      await ctx.prisma.planTurn.create({
        data: {
          planId: plan.id,
          runId: run.id,
          action: 'decompose',
          input: {},
          phase: 'failed',
        },
      });
      await slot('i21');
      await projector.tick();

      const page = (await admin.get(`/projects/${projectId}/runs`).expect(200))
        .body as RunPage;
      expect(page.items.map((r) => [r.kind, r.planId])).toEqual([
        ['plan', plan.id],
        ['orchestrator_slot', null],
      ]);
      const detail = (
        await admin.get(`/projects/${projectId}/runs/${run.id}`).expect(200)
      ).body as RunDetail;
      expect(detail.planId).toBe(plan.id);
    });

    it('hides a private plan’s turns from every other member, admins too (L-24)', async () => {
      const member = async (email: string) => {
        const user = await createUser(ctx.prisma, email, 'viewer');
        await ctx.prisma.projectMember.create({
          data: { projectId, userId: user.id },
        });
        return { user, session: await login(ctx, email) };
      };
      const author = await member('author@example.com');
      const other = await member('other@example.com');
      const instructions = await ctx.prisma.plannerInstructions.create({
        data: { projectId, version: 1, body: 'plan well' },
      });
      const planTurn = async (
        title: string,
        visibility: 'private' | 'project',
        minute: number,
      ) => {
        const plan = await ctx.prisma.plan.create({
          data: {
            projectId,
            authorId: author.user.id,
            title,
            brief: title,
            mode: 'batch',
            visibility,
            status: 'drafting',
            sessionId: '6f1c1d0e-5b7a-4c1e-9a52-1f3a7c9d2e10',
            instructionsId: instructions.id,
            contractVersion: 1,
            profileKey: 'claude-main',
            model: 'opus',
          },
        });
        const run = await ctx.prisma.run.create({
          data: {
            kind: 'plan',
            projectId,
            title,
            status: 'succeeded',
            triggeredByType: 'user',
            triggeredById: author.user.id,
            startedAt: at(minute),
            endedAt: at(minute + 1),
            updatedAt: at(minute + 1),
          },
        });
        await ctx.prisma.planTurn.create({
          data: {
            planId: plan.id,
            runId: run.id,
            authorId: author.user.id,
            action: 'decompose',
            input: {},
            phase: 'succeeded',
          },
        });
        return run;
      };
      const secret = await planTurn('Secret plan', 'private', 5);
      const shared = await planTurn('Shared plan', 'project', 3);
      await slot('i21');
      await projector.tick();

      const titles = async (session: Session, query = '') =>
        (
          (await session.get(`/projects/${projectId}/runs${query}`).expect(200))
            .body as RunPage
        ).items.map((r) => r.title ?? r.slot);
      const url = (run: { id: string }) =>
        `/projects/${projectId}/runs/${run.id}`;

      expect(await titles(other.session, '?kind=plan')).toEqual([
        'Shared plan',
      ]);
      expect(await titles(other.session)).toEqual(['Shared plan', 'i21']);
      const counts = (
        (await other.session.get(`/projects/${projectId}/runs`).expect(200))
          .body as RunPage
      ).counts;
      expect(counts.succeeded).toBe(1);
      await other.session.get(url(secret)).expect(404);
      await other.session.get(url(shared)).expect(200);
      // A private plan is its author's alone, site admins included (D12).
      await admin.get(url(secret)).expect(404);

      expect(await titles(author.session, '?kind=plan')).toEqual([
        'Secret plan',
        'Shared plan',
      ]);
      await author.session.get(url(secret)).expect(200);
    });

    it('answers 404 for a run of another project', async () => {
      const other = await seedProject(ctx.prisma, '/srv/dev/other', runnerId);
      const row = await ctx.prisma.slot.create({
        data: {
          projectId: other.projectId,
          name: 'x',
          worktree: '/srv/dev/.wt-other-x',
          owns: [],
          never: [],
          status: 'running',
          lastSeq: 1n,
          startedAt: at(0),
          updatedAt: at(0),
        },
      });
      await projector.tick();
      const run = await runOf(row.id);
      await admin.get(`/projects/${projectId}/runs/${run.id}`).expect(404);
      await admin
        .get(`/projects/${other.projectId}/runs/${run.id}`)
        .expect(200);
    });
  });
});
