import {
  BOARD_COMPLETED_PAGE_SIZE,
  type BoardPlanTasksView,
} from '@agentdock/shared';
import { at, type TaskSeed, WorkWorld } from './testing/work-e2e';

/** `GET /projects/:projectId/work/plan-tasks` (issue #270 D2–D4, D8, D11). */
describe('board plan tasks (e2e)', () => {
  const w = new WorkWorld();
  const path = (projectId = w.a) => `/projects/${projectId}/work/plan-tasks`;
  const view = async (session = w.author, projectId = w.a) => {
    const response = await session.get(path(projectId));
    expect(response.status).toBe(200);
    return response.body as BoardPlanTasksView;
  };
  const columns = (body: BoardPlanTasksView) =>
    Object.fromEntries(body.items.map((t) => [t.key, t.column]));

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());

  it('puts each task in the column its status and issue derive (D2), newest first', async () => {
    await w.plan({ project: w.a, author: w.authorId }, [
      { key: 't1', status: 'draft', updatedAt: at(1) },
      { key: 't2', status: 'approved', updatedAt: at(2) },
      { key: 't3', issue: { number: 3, fact: 'unqueued' }, updatedAt: at(3) },
      { key: 't4', issue: { number: 4, fact: 'queued' }, updatedAt: at(4) },
      { key: 't5', issue: { number: 5, fact: 'pr_open' }, updatedAt: at(5) },
      { key: 't6', issue: { number: 6, fact: 'merged' }, updatedAt: at(6) },
      { key: 't7', issue: { number: 7, fact: 'closed' }, updatedAt: at(7) },
      { key: 't8', status: 'rejected', updatedAt: at(8) },
    ]);
    const body = await view();
    expect(body.projectId).toBe(w.a);
    expect(columns(body)).toEqual({
      t1: 'todo',
      t2: 'todo',
      t3: 'in_progress',
      t4: 'in_progress',
      t5: 'finished',
      t6: 'completed',
      t7: 'completed',
    });
    expect(body.items.map((t) => t.key)).toEqual([
      't7',
      't6',
      't5',
      't4',
      't3',
      't2',
      't1',
    ]);
    const byKey = new Map(body.items.map((t) => [t.key, t]));
    expect(byKey.get('t1')?.status).toBe('draft');
    expect(byKey.get('t3')?.status).toBe('issued');
    expect(byKey.get('t5')).toMatchObject({
      status: 'pr_open',
      issue: { number: 5, liveStatus: 'pr_open', prNumber: 905 },
    });
    expect(byKey.get('t6')?.status).toBe('merged');
  });

  it('carries the face and sheet fields (D6, D7)', async () => {
    const planId = await w.plan(
      { project: w.a, author: w.authorId, title: 'Exporter' },
      [{ key: 't1', kind: 'bug', design: true, updatedAt: at(1) }],
    );
    const [item] = (await view()).items;
    expect(item).toEqual({
      planId,
      planTitle: 'Exporter',
      taskId: expect.any(String),
      key: 't1',
      title: 'Task t1',
      kind: 'bug',
      column: 'todo',
      status: 'draft',
      issue: null,
      design: expect.objectContaining({ needed: true, variantCount: 2 }),
      summary: 'Summary of t1',
      updatedAt: at(1).toISOString(),
    });
  });

  it('shows the current version only', async () => {
    const planId = await w.plan(
      { project: w.a, author: w.authorId, version: 2 },
      [{ key: 't1', updatedAt: at(1) }],
    );
    await w.ctx.prisma.planTask.create({
      data: {
        planId,
        key: 't9',
        planVersion: 1,
        kind: 'feature',
        title: 'Old',
        summary: '',
      },
    });
    expect((await view()).items.map((t) => t.key)).toEqual(['t1']);
  });

  it('keeps only the issued tasks of an archived plan (D3)', async () => {
    await w.plan({ project: w.a, author: w.authorId, status: 'archived' }, [
      { key: 't1', status: 'approved', updatedAt: at(1) },
      { key: 't2', issue: { number: 2, fact: 'queued' }, updatedAt: at(2) },
      { key: 't3', issue: { number: 3, fact: 'merged' }, updatedAt: at(3) },
    ]);
    expect(columns(await view())).toEqual({
      t2: 'in_progress',
      t3: 'completed',
    });
  });

  it(`caps Completed at ${BOARD_COMPLETED_PAGE_SIZE}, keeping the newest`, async () => {
    const done: TaskSeed[] = Array.from(
      { length: BOARD_COMPLETED_PAGE_SIZE + 2 },
      (_, i) => ({
        key: `t${i + 1}`,
        issue: { number: i + 1, fact: 'closed' as const },
        updatedAt: at(i + 1),
      }),
    );
    await w.plan({ project: w.a, author: w.authorId }, [
      ...done,
      { key: 't100', status: 'draft', updatedAt: at(0) },
    ]);
    const body = await view();
    const completed = body.items.filter((t) => t.column === 'completed');
    expect(completed).toHaveLength(BOARD_COMPLETED_PAGE_SIZE);
    expect(completed.map((t) => t.key)).not.toContain('t1');
    expect(completed.map((t) => t.key)).not.toContain('t2');
    expect(completed[0].key).toBe(`t${BOARD_COMPLETED_PAGE_SIZE + 2}`);
    // The cap is Completed's alone.
    expect(body.items.find((t) => t.key === 't100')?.column).toBe('todo');
  });

  it("omits another user's private plan, keeps the caller's own", async () => {
    await w.plan({ project: w.a, author: w.authorId, visibility: 'private' }, [
      { key: 't1', updatedAt: at(1) },
    ]);
    await w.plan(
      { project: w.a, author: w.operatorId, visibility: 'private' },
      [{ key: 't2', updatedAt: at(2) }],
    );
    expect((await view(w.author)).items.map((t) => t.key)).toEqual(['t1']);
    expect((await view(w.operator)).items.map((t) => t.key)).toEqual(['t2']);
    // A site admin is no exception to a private plan.
    expect((await view(w.admin)).items).toEqual([]);
  });

  it('only shows the plans of the project in the path', async () => {
    await w.plan({ project: w.b, author: w.authorId }, [
      { key: 't1', updatedAt: at(1) },
    ]);
    expect((await view()).items).toEqual([]);
    expect((await view(w.mixed, w.b)).items.map((t) => t.key)).toEqual(['t1']);
  });

  it('answers 404 to a non-member and 200 to a viewer (D11)', async () => {
    await w.plan({ project: w.a, author: w.authorId }, [
      { key: 't1', updatedAt: at(1) },
    ]);
    expect((await w.outsider.get(path())).status).toBe(404);
    expect((await w.viewer.get(path(w.b))).status).toBe(404);
    expect((await w.viewer.get(path('nope'))).status).toBe(404);
    expect((await view(w.viewer)).items.map((t) => t.key)).toEqual(['t1']);
  });
});
