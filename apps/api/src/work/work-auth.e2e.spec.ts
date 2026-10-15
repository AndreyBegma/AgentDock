import type { WorkItem, WorkPage } from '@agentdock/shared';
import type { Session } from '../test/e2e-app';
import { at, WorkWorld } from './testing/work-e2e';

/** `GET /work` authorization (issue #270 D11, ADR-0021, ADR-0026). */
describe('work list authorization (e2e)', () => {
  const w = new WorkWorld();
  const list = async (session: Session, query = '') => {
    const response = await session.get(`/work${query}`);
    expect(response.status).toBe(200);
    return response.body as WorkPage;
  };
  /** `<project>:<C-n | key>`, so rows of A and B are told apart. */
  const rows = (page: WorkPage) =>
    page.items
      .map((i: WorkItem) => {
        const project = i.projectId === w.a ? 'A' : 'B';
        return `${project}:${i.source === 'plan' ? i.key : i.label}`;
      })
      .sort();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    for (const project of [w.a, w.b]) {
      await w.card({ project, number: 1, updatedAt: at(1) });
      await w.card({ project, number: 2, column: 'inbox', updatedAt: at(2) });
      await w.plan({ project, author: w.authorId }, [
        { key: 't1', updatedAt: at(3) },
      ]);
    }
    await w.plan({ project: w.a, author: w.authorId, visibility: 'private' }, [
      { key: 't2', updatedAt: at(4) },
    ]);
  });

  it('needs a signed-in caller', async () => {
    expect((await w.ctx.http().get('/work')).status).toBe(401);
  });

  it('a project the caller is not a member of contributes nothing', async () => {
    expect(rows(await list(w.operator))).toEqual(['A:C-1', 'A:C-2', 'A:t1']);
    expect((await list(w.outsider)).items).toEqual([]);
    expect((await list(w.operator, `?projectId=${w.b}`)).items).toEqual([]);
  });

  it("another user's private plan is absent; the author's own is there", async () => {
    expect(rows(await list(w.operator))).not.toContain('A:t2');
    expect(rows(await list(w.author))).toContain('A:t2');
    // A site admin is no exception to a private plan.
    expect(rows(await list(w.admin))).not.toContain('A:t2');
  });

  it('a viewer gets cards and project plan tasks, but no Inbox items', async () => {
    expect(rows(await list(w.viewer))).toEqual(['A:C-1', 'A:t1']);
    expect((await list(w.viewer, '?source=inbox')).items).toEqual([]);
    expect((await list(w.viewer, '?status=inbox')).items).toEqual([]);
  });

  it('Inbox items follow the role per project: operator of A, viewer of B', async () => {
    expect(rows(await list(w.mixed))).toEqual([
      'A:C-1',
      'A:C-2',
      'A:t1',
      'B:C-1',
      'B:t1',
    ]);
    expect(rows(await list(w.mixed, '?source=inbox'))).toEqual(['A:C-2']);
  });

  it('source=inbox from a caller who operates nowhere is an empty page, not 403', async () => {
    const page = await list(w.outsider, '?source=inbox');
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('a site admin sees every project, with its Inbox', async () => {
    expect(rows(await list(w.admin))).toEqual([
      'A:C-1',
      'A:C-2',
      'A:t1',
      'B:C-1',
      'B:C-2',
      'B:t1',
    ]);
  });

  it('never carries Inbox evidence', async () => {
    await w.ctx.prisma.boardCard.updateMany({
      where: { column: 'inbox' },
      data: {
        evidence: [{ contentId: 'x', kind: 'message', excerpt: 'secret' }],
      },
    });
    const response = await w.admin.get('/work?source=inbox');
    expect(response.text).not.toContain('secret');
    expect(response.text).not.toContain('evidence');
  });
});
