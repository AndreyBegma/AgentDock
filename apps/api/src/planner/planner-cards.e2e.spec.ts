import type { CreatePlanCardsResponse, PlanDetail } from '@agentdock/shared';
import { decomposed, PlannerHarness, task } from './testing/planner-e2e';

/** #337 D7, D11, D12: Create cards, and plans from before the Board planner. */
describe('Create cards (e2e, #337)', () => {
  const h = new PlannerHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const approve = async (plan: PlanDetail, ...keys: string[]) => {
    for (const key of keys) {
      const response = await h.author.send(
        'post',
        `${h.base(plan.id)}/tasks/${key}/review`,
        { decision: 'approve' },
      );
      expect(response.status).toBe(200);
    }
  };

  const createCards = (planId: string, session = h.author) =>
    session.send('post', `${h.base(planId)}/cards`, {});

  /** t1 ← t2 ← t3, and t4 alone; t1 carries a written document. */
  const graph = () =>
    decomposed(h, [
      task('t1'),
      task('t2', { dependsOn: ['t1'] }),
      task('t3', { kind: 'bug', dependsOn: ['t2'] }),
      task('t4'),
    ]);

  it('makes one Todo card per approved task, in task order, with Depends-on links mirroring the graph; a second call is 409', async () => {
    const plan = await graph();
    await h.ctx.prisma.planTask.updateMany({
      where: { planId: plan.id, key: 't1' },
      data: { document: '## What to do\n\nThe written spec of t1.' },
    });
    await approve(plan, 't1', 't2', 't3', 't4');

    const response = await createCards(plan.id);
    expect(response.status).toBe(201);
    const { cards } = response.body as CreatePlanCardsResponse;
    expect(cards.map((c) => c.taskKey)).toEqual(['t1', 't2', 't3', 't4']);
    expect(cards.map((c) => c.label)).toEqual(['C-1', 'C-2', 'C-3', 'C-4']);

    const rows = await h.ctx.prisma.boardCard.findMany({
      where: { projectId: h.projectId },
      orderBy: { position: 'asc' },
      include: { dependsOn: { include: { dependsOn: true } } },
    });
    expect(rows.map((r) => r.title)).toEqual([
      'Task t1',
      'Task t2',
      'Task t3',
      'Task t4',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        column: 'todo',
        planId: plan.id,
        source: 'manual',
        kindSource: 'auto',
        createdById: h.authorId,
      });
    }
    expect(rows[2].kind).toBe('bug');
    const deps = Object.fromEntries(
      rows.map((r) => [r.title, r.dependsOn.map((d) => d.dependsOn.title)]),
    );
    expect(deps).toEqual({
      'Task t1': [],
      'Task t2': ['Task t1'],
      'Task t3': ['Task t2'],
      'Task t4': [],
    });
    // The written document is the body; a task without one gets the D6 sections.
    expect(rows[0].body).toBe('## What to do\n\nThe written spec of t1.');
    expect(rows[1].body).toContain('## Acceptance criteria');
    expect(rows[1].body).toContain('Summary of t2');

    const detail = await h.detail(plan.id);
    expect(detail.status).toBe('done');
    expect(detail.tasks.every((t) => t.cardId !== null)).toBe(true);
    expect(await h.auditOf('card.created')).toHaveLength(4);

    const again = await createCards(plan.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('cards_exist');
    // A plan that made its cards is not sent as well.
    expect(
      (await h.author.send('post', `${h.base(plan.id)}/send`, {})).status,
    ).toBe(409);
    expect(await h.ctx.prisma.boardCard.count()).toBe(4);
  });

  it('leaves rejected tasks out, and refuses while a task needs talk or a dependency is not approved', async () => {
    const plan = await graph();
    await approve(plan, 't2', 't3', 't4');
    const missing = await createCards(plan.id);
    expect(missing.status).toBe(409);
    expect(missing.body.error).toBe('not_sendable');

    await h.author.send('post', `${h.base(plan.id)}/tasks/t1/review`, {
      decision: 'reject',
    });
    await h.author.send('post', `${h.base(plan.id)}/tasks/t2/review`, {
      decision: 'reject',
    });
    await h.author.send('post', `${h.base(plan.id)}/tasks/t3/review`, {
      decision: 'reject',
    });
    const response = await createCards(plan.id);
    expect(response.status).toBe(201);
    expect(
      (response.body as CreatePlanCardsResponse).cards.map((c) => c.taskKey),
    ).toEqual(['t4']);
  });

  it('refuses a plan not decomposed yet, and a card intake (wrong_mode)', async () => {
    const dialogue = await h.createPlan('dialogue');
    expect((await createCards(dialogue.id)).body.error).toBe('not_sendable');
    const intake = await h.author.send('post', h.base(), {
      brief: 'Add a CSV export',
      mode: 'card',
    });
    const refused = await createCards((intake.body as PlanDetail).id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('wrong_mode');
  });

  it('Send to fleet behaves as today on a plan that made no cards', async () => {
    const plan = await decomposed(h, [task('t1', { kind: 'bug' })]);
    await approve(plan, 't1');
    const response = await h.author.send('post', `${h.base(plan.id)}/send`, {});
    expect(response.status).toBe(200);
    expect((response.body as PlanDetail).status).toBe('sent');
    expect(h.sentOf('issue.create')).toHaveLength(1);
    expect((await createCards(plan.id)).status).toBe(409);
  });

  it('a viewer gets 403, an operator who cannot read the plan 404', async () => {
    const plan = await graph();
    await approve(plan, 't1', 't2', 't3', 't4');
    expect((await createCards(plan.id, h.viewer)).status).toBe(403);
    expect((await createCards(plan.id, h.other)).status).toBe(404);
    expect(await h.ctx.prisma.boardCard.count()).toBe(0);
  });

  describe('a plan from before the Board planner (D11)', () => {
    const legacy = async () => {
      const plan = await graph();
      await h.ctx.prisma.plan.update({
        where: { id: plan.id },
        data: { contractVersion: 2 },
      });
      return plan;
    };

    it('reads, but takes no turns, reviews, revisions, send or cards', async () => {
      const plan = await legacy();
      expect((await h.author.get(h.base(plan.id))).status).toBe(200);
      const sentBefore = h.sent.length;
      for (const [path, body] of [
        ['turns', { message: 'hi' }],
        ['tasks/t1/turns', { message: 'hi' }],
        ['tasks/t1/review', { decision: 'approve' }],
        ['revise', {}],
        ['send', {}],
        ['cards', {}],
      ] as const) {
        const response = await h.author.send(
          'post',
          `${h.base(plan.id)}/${path}`,
          body,
        );
        expect([path, response.status, response.body.error]).toEqual([
          path,
          409,
          'plan_closed',
        ]);
      }
      expect(h.sent.length).toBe(sentBefore);
    });

    it('can still be shared and archived', async () => {
      const plan = await legacy();
      expect(
        (
          await h.author.send('post', `${h.base(plan.id)}/visibility`, {
            visibility: 'project',
          })
        ).status,
      ).toBe(200);
      expect(
        (await h.author.send('post', `${h.base(plan.id)}/archive`, {})).status,
      ).toBe(200);
    });
  });
});
