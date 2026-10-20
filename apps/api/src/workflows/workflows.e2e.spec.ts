import type {
  WorkflowsOrchestrationResponse,
  WorkflowsSummaryResponse,
  WorkflowsToolsResponse,
} from '@nautelle/shared';
import type { RunnerEvent } from '@nautelle/shared/protocol';
import { Logger } from '@nestjs/common';
import { RunnerEventSinks } from '../runners/runner-event-sinks';
import { adminSession } from '../runners/testing/runner-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { Events, projectRow, runnerRow } from '../usage/testing/usage-e2e';
import { WorkflowsProjector } from './workflows-projector.service';
import { WorkflowsQueryService } from './workflows-query.service';

const MIN = 60_000;
/** Two hours ago: every session started then has ended unless it says otherwise. */
const BASE = Date.now() - 120 * MIN;
const at = (s: number) => new Date(BASE + s * 1000).toISOString();
const range = `from=${new Date(BASE - 60 * MIN).toISOString()}&to=${new Date(Date.now() + 60 * MIN).toISOString()}`;

const tokens = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  reasoning: 0,
};

/** Session events of one runner, with the shapes the Claude adapter sends. */
class Transcript {
  readonly e = new Events();

  observed(id: string, s: number, extra: object = {}): RunnerEvent {
    return this.e.next(
      'session.observed',
      id,
      { cwd: '/srv/dev/x', startedAt: at(s), parsed: true, ...extra },
      at(s),
    );
  }

  turn(
    id: string,
    promptId: string,
    s: number,
    finished?: number,
  ): RunnerEvent[] {
    const started = this.e.next('turn.started', id, { promptId }, at(s));
    return finished === undefined
      ? [started]
      : [started, this.e.next('turn.finished', id, { promptId }, at(finished))];
  }

  request(id: string, requestId: string, s: number, extra: object = {}) {
    return this.e.next(
      'llm.request',
      id,
      {
        requestId,
        model: 'claude-opus-5-5',
        tokens,
        querySource: 'main',
        ...extra,
      },
      at(s),
    );
  }

  /** A tool call and its result, `s` seconds in; `ok` false for a failure. */
  tool(
    id: string,
    promptId: string,
    toolUseId: string,
    tool: string,
    s: number,
    ok = true,
  ) {
    return this.e.next(
      'tool.call',
      id,
      {
        toolUseId,
        promptId,
        tool,
        startedAt: at(s),
        endedAt: at(s + 1),
        ok,
      },
      at(s + 1),
    );
  }

  compacted(id: string, compactionId: string, s: number) {
    return this.e.next(
      'session.compacted',
      id,
      { compactionId, trigger: 'auto', preTokens: 160_000 },
      at(s),
    );
  }

  error(id: string, errorId: string, s: number) {
    return this.e.next(
      'session.error',
      id,
      { errorId, kind: 'rate_limit', status: 429 },
      at(s),
    );
  }
}

describe('workflows (e2e)', () => {
  let ctx: E2eContext;
  let admin: Session;
  let runnerId: string;
  let projectA: string;
  let projectB: string;

  const ingest = (events: RunnerEvent[]) =>
    ctx.app.get(RunnerEventSinks).dispatch(runnerId, events);
  const project = async () => ctx.app.get(WorkflowsProjector).tick();

  const get = async <T>(caller: Session, path: string) => {
    const response = await caller.get(path);
    return { status: response.status, body: response.body as T };
  };
  const summary = (caller: Session, q = '') =>
    get<WorkflowsSummaryResponse>(caller, `/workflows/summary?${range}${q}`);
  const graph = (caller: Session, q = '') =>
    get<WorkflowsOrchestrationResponse>(
      caller,
      `/workflows/orchestration?${range}${q}`,
    );
  const tools = (caller: Session, q = '') =>
    get<WorkflowsToolsResponse>(caller, `/workflows/tools?${range}${q}`);

  const member = async (projectId: string, email: string) => {
    const user = await createUser(ctx.prisma, email, 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId, userId: user.id },
    });
    return login(ctx, email);
  };

  /**
   * Project A: `root` — Bash → Edit → Bash(failed) in one turn, an Explore
   * subagent with Read → Grep, two compactions, and an error after its last
   * request (outcome error); `done` — one finished turn (completed); `open`
   * — a turn that never finished (abandoned). Project B: `other`, completed.
   * And `stray`, in no project.
   */
  const seed = async () => {
    const t = new Transcript();
    await ingest([
      t.observed('root', 0, { projectId: projectA }),
      ...t.turn('root', 'p1', 1, 60),
      t.request('root', 'r1', 2),
      t.tool('root', 'p1', 'tu1', 'Bash', 3),
      t.tool('root', 'p1', 'tu2', 'Edit', 5),
      t.tool('root', 'p1', 'tu3', 'Bash', 7, false),
      t.observed('sub', 10, {
        parent: { sessionId: 'root', toolUseId: 'tu4' },
      }),
      t.request('sub', 'r2', 11, {
        querySource: 'subagent',
        agentName: 'Explore',
      }),
      t.tool('sub', 'ps', 'tu5', 'Read', 12),
      t.tool('sub', 'ps', 'tu6', 'Grep', 14),
      t.compacted('root', 'c1', 20),
      t.compacted('root', 'c2', 30),
      t.request('root', 'r3', 40),
      t.error('root', 'e1', 50),
      t.observed('done', 0, { projectId: projectA }),
      ...t.turn('done', 'p2', 1, 30),
      t.request('done', 'r4', 2),
      t.tool('done', 'p2', 'tu7', 'Bash', 3),
      t.tool('done', 'p2', 'tu8', 'Edit', 5),
      t.observed('open', 0, { projectId: projectA }),
      ...t.turn('open', 'p3', 1),
      t.request('open', 'r5', 2),
      t.observed('other', 0, { projectId: projectB }),
      ...t.turn('other', 'p4', 1, 10),
      t.observed('stray', 0),
      ...t.turn('stray', 'p5', 1, 10),
    ]);
    await project();
    return t;
  };

  beforeAll(async () => {
    ctx = await createE2eApp();
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE projects, runners CASCADE',
    );
    ctx.app.get(WorkflowsQueryService).clearCache();
    admin = await adminSession(ctx);
    runnerId = (await runnerRow(ctx.prisma)).id;
    projectA = (await projectRow(ctx.prisma, runnerId, 'alpha')).id;
    projectB = (await projectRow(ctx.prisma, runnerId, 'beta')).id;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('ingest', () => {
    it('stores compactions, errors and the subagent type, idempotently', async () => {
      const t = await seed();
      // The same events again, as a runner resends after a reconnect.
      await ingest([t.compacted('root', 'c1', 20), t.error('root', 'e1', 50)]);
      const root = await ctx.prisma.agentSession.findFirstOrThrow({
        where: { externalId: 'root' },
        include: { compactions: true, errors: true },
      });
      expect(root.compactions.map((c) => c.compactionId).sort()).toEqual([
        'c1',
        'c2',
      ]);
      expect(root.errors).toEqual([
        expect.objectContaining({
          errorId: 'e1',
          kind: 'rate_limit',
          status: 429,
        }),
      ]);
      const sub = await ctx.prisma.agentSession.findFirstOrThrow({
        where: { externalId: 'sub' },
      });
      expect(sub.agentType).toBe('Explore');
    });

    it('keeps one row per root, and drops a session that turns out to be a subagent', async () => {
      const t = new Transcript();
      // The subagent's events arrive before anything links it to its parent.
      await ingest([t.observed('late', 0, { projectId: projectA })]);
      await ingest([t.observed('kid', 5)]);
      await project();
      expect(await ctx.prisma.sessionWorkflow.count()).toBe(2);

      await ingest([t.observed('kid', 5, { parent: { sessionId: 'late' } })]);
      await project();
      const rows = await ctx.prisma.sessionWorkflow.findMany({
        include: { session: { select: { externalId: true } } },
      });
      expect(rows).toEqual([
        expect.objectContaining({
          session: { externalId: 'late' },
          subagents: 1,
          depth: 1,
        }),
      ]);
      expect(await ctx.prisma.sessionWorkflowMark.count()).toBe(0);
    });

    it('backfills the roots that have no row yet', async () => {
      await seed();
      await ctx.prisma.sessionWorkflow.deleteMany();
      const projector = ctx.app.get(WorkflowsProjector);
      expect(await projector.backfill()).toBe(5);
      await projector.tick();
      expect(await ctx.prisma.sessionWorkflow.count()).toBe(5);
      // root: Bash → Edit, Edit → Bash, Read → Grep; done: Bash → Edit.
      expect(await ctx.prisma.sessionToolTransition.count()).toBe(4);
    });
  });

  describe('GET /workflows/summary', () => {
    it('returns the six metrics over the root sessions in scope', async () => {
      await seed();
      const { status, body } = await summary(admin, `&projectId=${projectA}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        sessions: 3,
        active: 0,
        ended: 3,
        outcomes: { completed: 1, error: 1, abandoned: 1, active: 0 },
        avgDepth: 1 / 3,
        avgSubagents: 1 / 3,
        successRate: 1 / 3,
        topToolFlow: { from: 'Bash', to: 'Edit', count: 2 },
        avgCompactions: 2 / 3,
        avgDurationMs: expect.any(Number),
        computedAt: expect.any(String),
      });
      // root's last event is its turn's end at 60 s, done's at 30 s, open's
      // request at 2 s.
      expect(body.avgDurationMs).toBeCloseTo(((60 + 30 + 2) * 1000) / 3, 0);
    });

    it('counts a session with a recent event as active, and filters on status', async () => {
      await seed();
      const t = new Transcript();
      const now = new Date().toISOString();
      await ingest([
        t.e.next(
          'session.observed',
          'live',
          {
            cwd: '/srv/dev/x',
            startedAt: now,
            parsed: true,
            projectId: projectA,
          },
          now,
        ),
      ]);
      await project();
      const all = await summary(admin, `&projectId=${projectA}`);
      expect(all.body).toMatchObject({ sessions: 4, active: 1, ended: 3 });
      const active = await summary(
        admin,
        `&projectId=${projectA}&status=active`,
      );
      expect(active.body).toMatchObject({ sessions: 1, successRate: null });
      const ended = await summary(admin, `&projectId=${projectA}&status=ended`);
      expect(ended.body.sessions).toBe(3);
    });

    it('applies a node filter to the whole page', async () => {
      await seed();
      const errored = await summary(admin, '&outcome=error');
      expect(errored.body).toMatchObject({
        sessions: 1,
        avgCompactions: 2,
        topToolFlow: { from: 'Bash', to: 'Edit', count: 1 },
      });
      const explore = await summary(admin, '&agentType=Explore');
      expect(explore.body.sessions).toBe(1);
      const many = await summary(admin, '&compactions=many');
      expect(many.body.sessions).toBe(1);
      const none = await summary(admin, '&agentType=~none');
      expect(none.body.sessions).toBe(4);
    });

    it('is null, never zero, with no session in scope', async () => {
      const { body } = await summary(admin);
      expect(body).toMatchObject({
        sessions: 0,
        avgDepth: null,
        successRate: null,
        topToolFlow: null,
      });
    });
  });

  describe('GET /workflows/orchestration', () => {
    it('returns a conserving Sankey whose nodes carry their filters', async () => {
      await seed();
      const { status, body } = await graph(admin, `&projectId=${projectA}`);
      expect(status).toBe(200);
      expect(body.sessions).toBe(3);
      const value = (id: string) => body.nodes.find((n) => n.id === id)?.value;
      expect(value('origin')).toBe(3);
      expect(value('agent:claude')).toBe(3);
      expect(value('type:Explore')).toBe(1);
      expect(value('type:~none')).toBe(2);
      expect(value('compactions:many')).toBe(1);
      expect(value('compactions:none')).toBe(2);
      expect(value('outcome:error')).toBe(1);
      expect(value('outcome:abandoned')).toBe(1);
      expect(value('outcome:completed')).toBe(1);
      expect(body.links).toContainEqual({
        source: 'compactions:many',
        target: 'outcome:error',
        value: 1,
      });
      expect(body.nodes.find((n) => n.id === 'type:Explore')?.filter).toEqual({
        key: 'agentType',
        value: 'Explore',
      });
    });
  });

  describe('GET /workflows/tools', () => {
    it('returns transitions within a turn, with counts and error shares', async () => {
      await seed();
      const { status, body } = await tools(admin, `&projectId=${projectA}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        transitions: [
          { from: 'Bash', to: 'Edit', count: 2, errors: 0, errorShare: 0 },
          { from: 'Edit', to: 'Bash', count: 1, errors: 1, errorShare: 1 },
          { from: 'Read', to: 'Grep', count: 1, errors: 0, errorShare: 0 },
        ],
        totalTransitions: 4,
        distinctTransitions: 3,
        computedAt: expect.any(String),
      });
      const top = await tools(admin, `&projectId=${projectA}&limit=1`);
      expect(top.body.transitions).toHaveLength(1);
      expect(top.body.totalTransitions).toBe(4);
    });
  });

  describe('access', () => {
    it('shows a member only their projects, never the project-less sessions', async () => {
      await seed();
      const viewer = await member(projectB, 'viewer@example.com');
      expect((await summary(viewer)).body.sessions).toBe(1);
      expect((await graph(viewer)).body.sessions).toBe(1);
      expect((await tools(viewer)).body.totalTransitions).toBe(0);
      expect((await summary(admin)).body.sessions).toBe(5);
    });

    it('answers 404 for a project the caller cannot see, and 401 signed out', async () => {
      await seed();
      const viewer = await member(projectB, 'viewer@example.com');
      for (const path of ['summary', 'orchestration', 'tools']) {
        const hidden = await viewer.get(
          `/workflows/${path}?${range}&projectId=${projectA}`,
        );
        expect(hidden.status).toBe(404);
        expect(hidden.body).toMatchObject({ error: 'not_found' });
        const missing = await admin.get(
          `/workflows/${path}?${range}&projectId=nope`,
        );
        expect(missing.status).toBe(404);
        const anonymous = await ctx.http().get(`/workflows/${path}?${range}`);
        expect(anonymous.status).toBe(401);
      }
    });
  });

  describe('validation', () => {
    it('refuses a missing or inverted range, and unknown values or fields', async () => {
      expect((await admin.get('/workflows/summary')).status).toBe(400);
      const inverted = await admin.get(
        `/workflows/summary?from=${at(10)}&to=${at(0)}`,
      );
      expect(inverted.status).toBe(400);
      expect(inverted.body).toMatchObject({ error: 'invalid_range' });
      const long = await admin.get(
        '/workflows/summary?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      );
      expect(long.body).toMatchObject({ error: 'invalid_range' });
      for (const bad of [
        '&status=done',
        '&outcome=failed',
        '&compactions=3',
        '&runtime=gpt',
        '&sort=asc',
      ]) {
        expect(
          (await admin.get(`/workflows/summary?${range}${bad}`)).status,
        ).toBe(400);
      }
      expect(
        (await admin.get(`/workflows/tools?${range}&limit=0`)).status,
      ).toBe(400);
    });
  });

  describe('cache', () => {
    it('serves the same answer within its TTL, per caller visibility', async () => {
      await seed();
      const first = await summary(admin);
      const t = new Transcript();
      await ingest([t.observed('new', 0, { projectId: projectA })]);
      await project();
      const again = await summary(admin);
      expect(again.body).toEqual(first.body);

      const viewer = await member(projectA, 'viewer@example.com');
      expect((await summary(viewer)).body.sessions).toBe(4);

      ctx.app.get(WorkflowsQueryService).clearCache();
      expect((await summary(admin)).body.sessions).toBe(6);
    });
  });
});
