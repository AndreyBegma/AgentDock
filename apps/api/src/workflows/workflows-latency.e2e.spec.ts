import type { WorkflowsSummaryResponse } from '@nautelle/shared';
import { adminSession } from '../runners/testing/runner-e2e';
import {
  createE2eApp,
  createUser,
  type E2eContext,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { projectRow, runnerRow } from '../usage/testing/usage-e2e';
import { WorkflowsProjector } from './workflows-projector.service';
import { WorkflowsQueryService } from './workflows-query.service';

const ROOTS = 10_000;
/** #161: every route answers under this for 10k sessions. */
const BUDGET_MS = 300;
const ROUTES = ['summary', 'orchestration', 'tools'] as const;

/**
 * The latency budget of #161 on a seeded database: 10 000 root sessions in
 * two projects, a subagent under every third one, a turn and eight tool calls
 * each, and a compaction on every fourth. The cache is cleared before each
 * timed request, so what is measured is the computation.
 */
describe('workflows latency (e2e)', () => {
  let ctx: E2eContext;
  let admin: Session;
  let viewer: Session;
  const range = `from=${new Date(Date.now() - 2 * 86_400_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`;

  beforeAll(async () => {
    ctx = await createE2eApp();
    await resetDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE projects, runners CASCADE',
    );
    admin = await adminSession(ctx);
    const runner = (await runnerRow(ctx.prisma)).id;
    const a = (await projectRow(ctx.prisma, runner, 'alpha')).id;
    const b = (await projectRow(ctx.prisma, runner, 'beta')).id;
    const user = await createUser(ctx.prisma, 'viewer@example.com', 'viewer');
    await ctx.prisma.projectMember.create({
      data: { projectId: a, userId: user.id },
    });
    viewer = await login(ctx, 'viewer@example.com');

    await ctx.prisma.$executeRaw`
      INSERT INTO sessions (id, "runnerId", runtime, "externalId", "projectId", cwd,
        "profileKey", "startedAt", "lastEventAt")
      SELECT 'r' || i, ${runner}, 'claude', 'r' || i,
        CASE WHEN i % 2 = 0 THEN ${a} ELSE ${b} END, '/srv/dev/x', 'p' || (i % 3),
        now() - interval '3 hours' - i * interval '1 second',
        now() - interval '1 hour' - i * interval '1 second'
      FROM generate_series(1, ${ROOTS}) i`;
    await ctx.prisma.$executeRaw`
      INSERT INTO sessions (id, "runnerId", runtime, "externalId", "projectId", cwd,
        "startedAt", "lastEventAt", "parentSessionId", "agentType")
      SELECT 'c' || i, ${runner}, 'claude', 'c' || i,
        CASE WHEN i % 2 = 0 THEN ${a} ELSE ${b} END, '/srv/dev/x',
        now() - interval '3 hours', now() - interval '2 hours', 'r' || i,
        (ARRAY['Explore','Plan','general-purpose','a','b','c','d','e','f','g','h'])[1 + i % 11]
      FROM generate_series(1, ${ROOTS}, 3) i`;
    await ctx.prisma.$executeRaw`
      INSERT INTO turns (id, "sessionId", "promptId", "startedAt", "endedAt")
      SELECT 't' || i, 'r' || i, 'p', now() - interval '3 hours',
        CASE WHEN i % 5 = 0 THEN NULL ELSE now() - interval '2 hours' END
      FROM generate_series(1, ${ROOTS}) i`;
    await ctx.prisma.$executeRaw`
      INSERT INTO tool_calls (id, "sessionId", "turnId", "toolUseId", name, "startedAt", ok)
      SELECT 'tc' || i || '_' || k, 'r' || i, 't' || i, 'u' || k,
        (ARRAY['Bash','Edit','Read','Grep','Write'])[1 + (i * k) % 5],
        now() - interval '3 hours' + k * interval '1 second', (i + k) % 7 <> 0
      FROM generate_series(1, ${ROOTS}) i, generate_series(1, 8) k`;
    await ctx.prisma.$executeRaw`
      INSERT INTO session_compactions (id, "sessionId", "compactionId", ts, trigger)
      SELECT 'cp' || i, 'r' || i, 'c', now() - interval '150 minutes', 'auto'
      FROM generate_series(1, ${ROOTS}, 4) i`;

    const projector = ctx.app.get(WorkflowsProjector);
    await projector.backfill();
    await projector.tick();
  }, 300_000);
  afterAll(() => ctx.app.close());

  const timed = async (caller: Session, path: string) => {
    ctx.app.get(WorkflowsQueryService).clearCache();
    const started = performance.now();
    const response = await caller.get(path);
    return { ms: performance.now() - started, response };
  };

  it('projected every root session', async () => {
    expect(await ctx.prisma.sessionWorkflow.count()).toBe(ROOTS);
    expect(await ctx.prisma.sessionWorkflowMark.count()).toBe(0);
    const { response } = await timed(admin, `/workflows/summary?${range}`);
    const body = response.body as WorkflowsSummaryResponse;
    expect(body.sessions).toBe(ROOTS);
    expect(body.avgCompactions).toBeCloseTo(0.25, 2);
  });

  it.each(ROUTES)('answers /workflows/%s under the budget', async (route) => {
    const path = `/workflows/${route}?${range}`;
    // One request first, so connection and JIT warm-up are not measured.
    await timed(admin, `${path}&status=ended`);
    const slow: { caller: string; ms: number }[] = [];
    for (const [name, caller] of [
      ['admin', admin],
      ['viewer', viewer],
    ] as const) {
      const { ms, response } = await timed(caller, path);
      expect(response.status).toBe(200);
      if (ms >= BUDGET_MS) slow.push({ caller: name, ms: Math.round(ms) });
    }
    // On failure, the list names who was slow and by how much.
    expect(slow).toEqual([]);
  });
});
