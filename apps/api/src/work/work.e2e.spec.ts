import {
  type TaskPage,
  WORK_ERROR,
  WORK_PAGE_SIZE,
  type WorkItem,
  type WorkPage,
  workItemStatus,
} from '@nautelle/shared';
import { TASK_PAGE_SIZE } from '../planner/tasks-query.service';
import type { Session } from '../test/e2e-app';
import { at, WorkWorld } from './testing/work-e2e';

/** `GET /work` (issue #270 D10): the List across sources. */
describe('work list (e2e)', () => {
  const w = new WorkWorld();
  const list = async (
    query: Record<string, string> = {},
    session?: Session,
  ) => {
    const response = await (session ?? w.operator).get(
      `/work?${new URLSearchParams(query)}`,
    );
    expect(response.status).toBe(200);
    return response.body as WorkPage;
  };
  /** A row's identity: `C-n` for a card, the key for a plan task. */
  const ids = (items: WorkItem[]) =>
    items.map((i) => (i.source === 'plan' ? i.key : i.label));

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());

  describe('one project, both sources', () => {
    let planId: string;
    beforeEach(async () => {
      planId = await w.plan(
        { project: w.a, author: w.authorId, title: 'Exporter' },
        [
          { key: 't1', title: 'Draft the login', updatedAt: at(1) },
          {
            key: 't2',
            kind: 'bug',
            issue: { number: 41, fact: 'pr_open' },
            updatedAt: at(3),
          },
          { key: 't3', status: 'rejected', updatedAt: at(5) },
          {
            key: 't4',
            issue: { number: 43, fact: 'merged' },
            updatedAt: at(7),
          },
        ],
      );
      await w.card({
        project: w.a,
        number: 1,
        title: 'Login page',
        updatedAt: at(2),
      });
      await w.card({
        project: w.a,
        number: 2,
        kind: 'bug',
        column: 'in_progress',
        issueNumber: 42,
        updatedAt: at(4),
      });
      await w.card({
        project: w.a,
        number: 3,
        column: 'inbox',
        title: 'Suggested login fix',
        updatedAt: at(6),
      });
      await w.card({
        project: w.a,
        number: 4,
        column: 'completed',
        updatedAt: at(8),
      });
    });

    it('interleaves cards and plan tasks by updatedAt, newest first', async () => {
      const page = await list();
      expect(ids(page.items)).toEqual([
        'C-4',
        't4',
        'C-3',
        't3',
        'C-2',
        't2',
        'C-1',
        't1',
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('shapes each source as the contract says', async () => {
      const byId = new Map((await list()).items.map((i) => [i.updatedAt, i]));
      expect(byId.get(at(4).toISOString())).toEqual({
        source: 'card',
        projectId: w.a,
        projectName: 'widget',
        cardId: expect.any(String),
        number: 2,
        label: 'C-2',
        title: 'Card 2',
        kind: 'bug',
        column: 'in_progress',
        roundPhase: null,
        issueNumber: 42,
        issueUrl: 'https://github.com/acme/widget/issues/42',
        prNumber: null,
        prUrl: null,
        updatedAt: at(4).toISOString(),
        href: `/projects/${w.a}/board?card=2`,
      });
      expect(byId.get(at(6).toISOString())?.source).toBe('inbox');
      expect(byId.get(at(3).toISOString())).toEqual({
        source: 'plan',
        projectId: w.a,
        projectName: 'widget',
        planId,
        planTitle: 'Exporter',
        taskId: expect.any(String),
        key: 't2',
        title: 'Task t2',
        kind: 'bug',
        status: 'finished',
        nativeStatus: 'pr_open',
        issue: expect.objectContaining({ number: 41, liveStatus: 'pr_open' }),
        updatedAt: at(3).toISOString(),
        href: `/projects/${w.a}/board?plan=${planId}&task=t2`,
      });
      expect(byId.get(at(5).toISOString())).toMatchObject({
        status: 'rejected',
        nativeStatus: 'rejected',
      });
    });

    it('filters by source', async () => {
      expect(ids((await list({ source: 'card' })).items)).toEqual([
        'C-4',
        'C-2',
        'C-1',
      ]);
      expect(ids((await list({ source: 'inbox' })).items)).toEqual(['C-3']);
      expect(ids((await list({ source: 'plan' })).items)).toEqual([
        't4',
        't3',
        't2',
        't1',
      ]);
    });

    it('filters by kind', async () => {
      expect(ids((await list({ kind: 'bug' })).items)).toEqual(['C-2', 't2']);
    });

    it('filters by status in the column vocabulary, for both sources', async () => {
      const cases: [string, string[]][] = [
        ['inbox', ['C-3']],
        ['todo', ['C-1', 't1']],
        ['in_progress', ['C-2']],
        ['finished', ['t2']],
        ['completed', ['C-4', 't4']],
        ['rejected', ['t3']],
      ];
      for (const [status, expected] of cases) {
        const { items } = await list({ status });
        expect(ids(items)).toEqual(expected);
        for (const item of items) expect(workItemStatus(item)).toBe(status);
      }
    });

    it('searches the title of both sources, case-insensitively', async () => {
      expect(ids((await list({ q: 'LOGIN' })).items)).toEqual([
        'C-3',
        'C-1',
        't1',
      ]);
    });

    it('searches a card label, a task key and an issue number', async () => {
      expect(ids((await list({ q: 'c-2' })).items)).toEqual(['C-2']);
      expect(ids((await list({ q: 'T3' })).items)).toEqual(['t3']);
      expect(ids((await list({ q: '#42' })).items)).toEqual(['C-2']);
      expect(ids((await list({ q: '#41' })).items)).toEqual(['t2']);
    });

    it('narrows to one plan, which has no cards', async () => {
      await w.plan({ project: w.a, author: w.authorId }, [
        { key: 't1', updatedAt: at(9) },
      ]);
      expect(ids((await list({ planId })).items)).toEqual([
        't4',
        't3',
        't2',
        't1',
      ]);
    });

    it('narrows to one project', async () => {
      await w.card({ project: w.b, number: 1, updatedAt: at(9) });
      expect((await list({ projectId: w.b }, w.admin)).items).toHaveLength(1);
      expect((await list({ projectId: w.a }, w.admin)).items).toHaveLength(8);
    });
  });

  describe('fleet source (#388)', () => {
    beforeEach(async () => {
      await w.card({ project: w.a, number: 1, updatedAt: at(1) });
      await w.card({
        project: w.a,
        number: 2,
        column: 'in_progress',
        issueNumber: 359,
        updatedAt: at(2),
        fleet: { issue: 359, slot: 'i359-api', stage: 'plan_ready' },
      });
      await w.card({
        project: w.a,
        number: 3,
        column: 'finished',
        issueNumber: 359,
        updatedAt: at(3),
        fleet: { issue: 359, slot: 'i359-web' },
      });
    });

    it('reports a fleet card as fleet, with its slot, and a manual card as card', async () => {
      const { items } = await list();
      expect(
        items.map((i) => [i.source, i.source !== 'plan' && i.label]),
      ).toEqual([
        ['fleet', 'C-3'],
        ['fleet', 'C-2'],
        ['card', 'C-1'],
      ]);
      expect(
        items.find((i) => i.source === 'fleet' && i.number === 2),
      ).toMatchObject({
        fleet: {
          issue: 359,
          slot: 'i359-api',
          stage: 'plan_ready',
          slotGone: false,
        },
      });
      expect(items.find((i) => i.source === 'card')).not.toHaveProperty(
        'fleet',
      );
    });

    it('filters: fleet returns only fleet cards, card none of them', async () => {
      expect(ids((await list({ source: 'fleet' })).items)).toEqual([
        'C-3',
        'C-2',
      ]);
      expect(ids((await list({ source: 'card' })).items)).toEqual(['C-1']);
      expect(ids((await list({ source: 'inbox' })).items)).toEqual([]);
    });

    it('narrows fleet by status and finds a slot by label or issue', async () => {
      expect(
        ids((await list({ source: 'fleet', status: 'in_progress' })).items),
      ).toEqual(['C-2']);
      expect(ids((await list({ q: 'c-3' })).items)).toEqual(['C-3']);
      expect(ids((await list({ q: '#359' })).items)).toEqual(['C-3', 'C-2']);
    });
  });

  it('pages both sources by cursor without repeats or gaps, ties included', async () => {
    // Three rows per minute — a card and two plan tasks — so pages cut
    // through rows of one `updatedAt`.
    const minutes = 40;
    await w.plan(
      { project: w.a, author: w.authorId },
      Array.from({ length: minutes * 2 }, (_, i) => ({
        key: `t${i + 1}`,
        updatedAt: at(Math.floor(i / 2)),
      })),
    );
    for (let m = 0; m < minutes; m += 1) {
      await w.card({ project: w.a, number: m + 1, updatedAt: at(m) });
    }
    const total = minutes * 3;
    const seen: WorkItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: WorkPage = await list(cursor ? { cursor } : {});
      expect(page.items.length).toBeLessThanOrEqual(WORK_PAGE_SIZE);
      seen.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(Math.ceil(total / WORK_PAGE_SIZE));
    expect(seen).toHaveLength(total);
    expect(new Set(ids(seen)).size).toBe(total);
    const times = seen.map((i) => Date.parse(i.updatedAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('pages a filtered list', async () => {
    await w.plan(
      { project: w.a, author: w.authorId },
      Array.from({ length: WORK_PAGE_SIZE + 5 }, (_, i) => ({
        key: `t${i + 1}`,
        status: 'rejected' as const,
        updatedAt: at(i),
      })),
    );
    await w.card({ project: w.a, number: 1, updatedAt: at(1) });
    const first = await list({ status: 'rejected' });
    expect(first.items).toHaveLength(WORK_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    const second = await list({
      status: 'rejected',
      cursor: first.nextCursor ?? '',
    });
    expect(ids(second.items)).toEqual(['t5', 't4', 't3', 't2', 't1']);
    expect(second.nextCursor).toBeNull();
  });

  it('reads a page plus one per source, however large the project (L-25)', async () => {
    const count = 5000;
    await w.bulk(w.a, count);
    const reads = [
      jest.spyOn(w.ctx.prisma.boardCard, 'findMany'),
      jest.spyOn(w.ctx.prisma.planTask, 'findMany'),
    ];
    try {
      const first = await list();
      const second = await list({ cursor: first.nextCursor ?? '' });
      const tasks = (await w.operator.get('/tasks')).body as TaskPage;
      // The newest minute holds a card and a task; pages run on from there.
      expect(ids(first.items).slice(0, 2).sort()).toEqual([
        `C-${count}`,
        `t${count}`,
      ]);
      expect(first.items).toHaveLength(WORK_PAGE_SIZE);
      expect(second.items).toHaveLength(WORK_PAGE_SIZE);
      expect(Date.parse(second.items[0].updatedAt)).toBe(
        at(count - 1 - WORK_PAGE_SIZE / 2).getTime(),
      );
      expect(tasks.items).toHaveLength(TASK_PAGE_SIZE);
      expect(tasks.nextCursor).not.toBeNull();
      for (const read of reads) {
        expect(read).toHaveBeenCalled();
        for (const result of read.mock.results) {
          const rows = (await result.value) as unknown[];
          expect(rows.length).toBeLessThanOrEqual(WORK_PAGE_SIZE + 1);
        }
      }
    } finally {
      for (const read of reads) read.mockRestore();
    }
  });

  it('answers 400 invalid_args to an unknown cursor', async () => {
    const response = await w.operator.get('/work?cursor=bm90LWEtY3Vyc29y');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: WORK_ERROR.invalidArgs });
  });

  it('refuses an unknown filter value and an unknown field', async () => {
    for (const query of [
      'source=board',
      'status=done',
      'kind=chore',
      `q=${'x'.repeat(201)}`,
      'page=2',
    ]) {
      expect((await w.operator.get(`/work?${query}`)).status).toBe(400);
    }
  });
});
