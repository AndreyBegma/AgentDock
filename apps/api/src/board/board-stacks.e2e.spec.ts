import {
  BOARD_ERROR,
  type BoardStackDetail,
  type BoardView,
  type ConfirmSplitResponse,
  type PlanDetail,
  STACK_GATE_REASON,
  stackDesignPath,
  type TaskDesignView,
} from '@agentdock/shared';
import type { CardRunFile } from '@agentdock/shared/protocol';
import { CardDesignHarness } from '../design/testing/card-design-e2e';
import { designResult, MOCKUP } from '../design/testing/design-e2e';
import { block } from '../planner/testing/planner-e2e';

/**
 * #480 (docs/specs/480-add-card-stacks-staged-cards-sharing-one.md,
 * ADR-0044): a stack — staged cards under one shared design. The intake may
 * propose one; Confirm makes it with its stage dependencies in one
 * transaction; while its design is not approved no card of it runs.
 */

const REDESIGN =
  'Переделай страницу настроек: новые секции формы, строки с переключателями, опасная зона, потом сама страница.';

const body = (what: string) =>
  [
    '## What to do',
    '',
    `${what} for the people who use the board every day.`,
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The change works on the board and is covered by a test.',
    '',
    '## Out of scope',
    '',
    'None.',
    '',
    '## Open questions',
    '',
    'None.',
  ].join('\n');

const card = (title: string) => ({
  title,
  kind: 'feature',
  summary: `${title}, as one part of the page.`,
  body: body(title),
});

const STACK = {
  action: 'intake',
  stack: {
    reason: 'Одна страница: сначала компоненты, потом сама страница.',
    title: 'Redesign the Settings page',
    body: 'Move the Settings page to the new section layout. The components come first, then the page that is composed from them, so every part shares one look.',
    design: true,
    stages: [
      {
        title: 'Components',
        cards: [
          card('Add the form section component'),
          card('Toggle row with description'),
        ],
      },
      { title: 'Page', cards: [card('Compose the Settings page')] },
    ],
  },
};

const SPLIT = {
  action: 'intake',
  split: {
    reason: 'Это две независимые задачи.',
    cards: [card('Export the board as CSV'), card('Add a dark theme')],
  },
};

const STACK_KEY = 'stack-1';

describe('card stacks (e2e, #480)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const proposed = async (output: object): Promise<PlanDetail> => {
    const created = await h.author.send('post', h.base(), {
      brief: REDESIGN,
      mode: 'card',
    });
    expect(created.status).toBe(201);
    const plan = created.body as PlanDetail;
    await h.finish(plan.id, block(output));
    return h.detail(plan.id);
  };

  const confirm = (planId: string, request: object) =>
    h.author.send('post', `${h.base(planId)}/split`, request);

  const stackPath = (number = 1) =>
    `/projects/${h.projectId}/board/stacks/${number}`;

  const stackRequest = (design = true) => ({
    title: 'Redesign the Settings page',
    body: 'Components first, then the page.',
    design,
    stages: [
      { title: 'Components', cards: [0, 1] },
      { title: 'Page', cards: [2] },
    ],
  });

  const keptCards = (titles: string[]) =>
    titles.map((title, index) => ({ index, title, kind: 'feature' }));

  /** The stack from the proposal, confirmed as proposed. */
  const confirmedStack = async (design = true) => {
    const plan = await proposed(STACK);
    const response = await confirm(plan.id, {
      turnId: plan.intake?.split?.turnId,
      cards: keptCards([
        'Add the form section component',
        'Toggle row with description',
        'Compose the Settings page',
      ]),
      stack: stackRequest(design),
    });
    if (response.status !== 201) throw new Error(response.text);
    return { plan, response: response.body as ConfirmSplitResponse };
  };

  const run = (number: number) =>
    h.author.send('post', `${h.cardPath(number)}/run`, {});

  /** The stack's active design turn finishes with `resultText`. */
  const finishStackTurn = async (stackId: string, resultText: string) => {
    const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
      where: { stackId, phase: { in: ['queued', 'running'] } },
    });
    await h.sinks.dispatch(h.runnerId, [
      h.event('plan_turn.finished', {
        planId: stackId,
        turnId: turn.id,
        runId: turn.runId,
        projectId: h.projectId,
        phase: 'succeeded',
        at: new Date().toISOString(),
        exitCode: 0,
        resultText,
        resultTruncated: false,
      }),
    ]);
  };

  /** Generate the stack design, let the turn draw it, and approve it. */
  const approveStackDesign = async () => {
    await h.seedProfile();
    const stack = await h.ctx.prisma.boardStack.findFirstOrThrow();
    expect(
      (await h.author.send('post', `${stackPath()}/design/generate`)).status,
    ).toBe(201);
    await finishStackTurn(
      stack.id,
      designResult(
        { taskKey: STACK_KEY, variant: 1, rationale: 'One column.' },
        MOCKUP.replace('Export', 'Whole page'),
      ),
    );
    const view = (await h.author.get(`${stackPath()}/design`))
      .body as TaskDesignView;
    expect(view.status).toBe('reviewing');
    const approved = await h.author.send(
      'post',
      `${stackPath()}/design/approve`,
      { revisionId: view.revisions[0].id },
    );
    expect(approved.status).toBe(200);
    return { stack, view: approved.body as TaskDesignView };
  };

  describe('intake', () => {
    it('a multi-part redesign reads back as a stack proposal: its cards in stage order, the stages by index', async () => {
      const plan = await proposed(STACK);
      expect(plan.status).toBe('clarifying');
      expect(plan.intake?.split).toMatchObject({
        reason: STACK.stack.reason,
        cards: [
          { index: 0, title: 'Add the form section component' },
          { index: 1, title: 'Toggle row with description' },
          { index: 2, title: 'Compose the Settings page' },
        ],
        stack: {
          title: 'Redesign the Settings page',
          design: true,
          stages: [
            { title: 'Components', cards: [0, 1] },
            { title: 'Page', cards: [2] },
          ],
        },
      });
      expect(
        await h.ctx.prisma.boardCard.count({ where: { planId: plan.id } }),
      ).toBe(0);
    });

    it('independent tasks still read back as a plain split, with no stack', async () => {
      const plan = await proposed(SPLIT);
      expect(plan.intake?.split?.cards).toHaveLength(2);
      expect(plan.intake?.split?.stack).toBeNull();
    });

    it('a stack with one stage fails the turn: a stack orders work in two or more', async () => {
      const plan = await proposed({
        ...STACK,
        stack: {
          ...STACK.stack,
          stages: [
            {
              title: 'All',
              cards: [card('One part'), card('Another part')],
            },
          ],
        },
      });
      expect(plan.intake?.split ?? null).toBeNull();
      expect(plan.turns.at(-1)?.phase).toBe('failed');
    });
  });

  describe('confirm', () => {
    it('creates the stack, its stages, its cards in To Do and every stage dependency in one step', async () => {
      const { plan, response } = await confirmedStack();
      expect(response.stack).toEqual({ number: 1, label: 'S-1' });
      expect(response.cards.map((c) => c.label)).toEqual(['C-1', 'C-2', 'C-3']);

      const stack = await h.ctx.prisma.boardStack.findFirstOrThrow({
        include: {
          stages: {
            orderBy: { position: 'asc' },
            include: { cards: { orderBy: { number: 'asc' } } },
          },
          design: true,
        },
      });
      expect(stack).toMatchObject({
        number: 1,
        title: 'Redesign the Settings page',
        planId: plan.id,
      });
      expect(
        stack.stages.map((s) => [s.title, s.cards.map((c) => c.number)]),
      ).toEqual([
        ['Components', [1, 2]],
        ['Page', [3]],
      ]);
      expect(stack.stages.flatMap((s) => s.cards.map((c) => c.column))).toEqual(
        ['todo', 'todo', 'todo'],
      );
      expect(stack.design).toMatchObject({ needed: true, status: 'idle' });

      // Every card of stage 2 waits on every card of stage 1 — and nothing else.
      const deps = await h.ctx.prisma.boardCardDependency.findMany({
        select: {
          card: { select: { number: true } },
          dependsOn: { select: { number: true } },
        },
      });
      expect(
        deps
          .map((d) => [d.card.number, d.dependsOn.number])
          .sort((a, b) => a[1] - b[1]),
      ).toEqual([
        [3, 1],
        [3, 2],
      ]);
      expect((await h.detail(plan.id)).status).toBe('done');
      const audit = await h.auditOf('stack.created');
      expect(audit).toHaveLength(1);
      expect(audit[0].after).toMatchObject({
        number: 1,
        cards: [1, 2, 3],
        stages: 2,
        design: true,
      });
    });

    it('a split proposal can be confirmed as a stack, with the stages the person chose', async () => {
      const plan = await proposed(SPLIT);
      const response = await confirm(plan.id, {
        turnId: plan.intake?.split?.turnId,
        cards: keptCards(['Export the board as CSV', 'Add a dark theme']),
        stack: {
          title: 'Board export and theme',
          body: '',
          design: false,
          stages: [
            { title: '', cards: [1] },
            { title: '', cards: [0] },
          ],
        },
      });
      expect(response.status).toBe(201);
      // Made in stage order: the dark theme first.
      const cards = await h.ctx.prisma.boardCard.findMany({
        orderBy: { number: 'asc' },
        include: { dependsOn: true },
      });
      expect(cards.map((c) => c.title)).toEqual([
        'Add a dark theme',
        'Export the board as CSV',
      ]);
      expect(cards[1].dependsOn.map((d) => d.dependsOnId)).toEqual([
        cards[0].id,
      ]);
      expect(await h.ctx.prisma.taskDesign.count()).toBe(0);
    });

    it('a stack proposal confirmed as Split makes independent cards and no stack', async () => {
      const plan = await proposed(STACK);
      const response = await confirm(plan.id, {
        turnId: plan.intake?.split?.turnId,
        cards: keptCards([
          'Add the form section component',
          'Toggle row with description',
          'Compose the Settings page',
        ]),
      });
      expect(response.status).toBe(201);
      expect((response.body as ConfirmSplitResponse).stack).toBeNull();
      expect(await h.ctx.prisma.boardStack.count()).toBe(0);
      expect(await h.ctx.prisma.boardCardDependency.count()).toBe(0);
    });

    it('refuses a stack that leaves a kept card out of every stage, and makes nothing', async () => {
      const plan = await proposed(STACK);
      const response = await confirm(plan.id, {
        turnId: plan.intake?.split?.turnId,
        cards: keptCards([
          'Add the form section component',
          'Toggle row with description',
          'Compose the Settings page',
        ]),
        stack: { ...stackRequest(), stages: [{ title: '', cards: [0, 1] }] },
      });
      expect(response.status).toBe(400);
      expect(await h.ctx.prisma.boardCard.count()).toBe(0);
      expect(await h.ctx.prisma.boardStack.count()).toBe(0);
    });
  });

  describe('board and stack page', () => {
    it('the board lists the stack with its column, progress and current stage; each card names its stack and gate', async () => {
      await confirmedStack();
      const board = (await h.author.get(`/projects/${h.projectId}/board`))
        .body as BoardView;
      expect(board.stacks).toEqual([
        expect.objectContaining({
          number: 1,
          label: 'S-1',
          column: 'todo',
          accepted: 0,
          total: 3,
          currentStage: 0,
          stages: [
            { position: 0, title: 'Components', cards: [1, 2] },
            { position: 1, title: 'Page', cards: [3] },
          ],
          design: expect.objectContaining({ needed: true, status: 'idle' }),
        }),
      ]);
      const todo = board.columns.find((c) => c.column === 'todo');
      expect(todo?.cards.find((c) => c.number === 3)?.stack).toEqual({
        number: 1,
        label: 'S-1',
        title: 'Redesign the Settings page',
        stage: 1,
        stageTitle: 'Page',
        gate: STACK_GATE_REASON,
      });

      // Accepting the first stage moves the current stage on.
      await h.ctx.prisma.boardCard.updateMany({
        where: { number: { in: [1, 2] } },
        data: { column: 'completed', completedAt: new Date() },
      });
      const later = (await h.author.get(`/projects/${h.projectId}/board`))
        .body as BoardView;
      expect(later.stacks?.[0]).toMatchObject({
        column: 'todo',
        accepted: 2,
        currentStage: 1,
      });
    });

    it('the stack page has the description, the stages with their cards and links, and the design', async () => {
      await confirmedStack();
      const detail = (await h.author.get(stackPath())).body as BoardStackDetail;
      expect(detail).toMatchObject({
        label: 'S-1',
        body: 'Components first, then the page.',
        started: false,
        design: { needed: true },
      });
      expect(
        detail.stages.map((s) => s.cards.map((c) => [c.label, c.after])),
      ).toEqual([
        [
          ['C-1', []],
          ['C-2', []],
        ],
        [['C-3', [1, 2]]],
      ]);
      expect((await h.author.get(stackPath(9))).status).toBe(404);
    });

    it('a card joins and leaves a stage with its stage dependencies', async () => {
      await confirmedStack(false);
      const extra = await h.createCard({ title: 'Danger zone panel' });
      const added = await h.author.send('post', `${stackPath()}/cards`, {
        card: extra.number,
        stage: 0,
      });
      expect(added.status).toBe(201);
      expect((added.body as BoardStackDetail).stages[1].cards[0].after).toEqual(
        [1, 2, extra.number],
      );

      const removed = await h.author.send(
        'delete',
        `${stackPath()}/cards/${extra.number}`,
      );
      expect(removed.status).toBe(200);
      expect(
        (removed.body as BoardStackDetail).stages[1].cards[0].after,
      ).toEqual([1, 2]);
      expect(
        await h.ctx.prisma.boardCard.findUniqueOrThrow({
          where: { id: extra.id },
          select: { stageId: true },
        }),
      ).toEqual({ stageId: null });
    });
  });

  describe('design-first gate', () => {
    it('refuses Run on every card of the stack while its design is not approved, then lets it run with the design as reference', async () => {
      await confirmedStack();
      const refused = await run(1);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(BOARD_ERROR.stackDesignNotApproved);
      expect(h.cardSentOf('card.run')).toHaveLength(0);
      expect(
        await h.ctx.prisma.boardCardRound.count({
          where: { card: { number: 1 } },
        }),
      ).toBe(0);

      const { stack } = await approveStackDesign();
      const started = await run(1);
      expect(started.status).toBe(200);
      const [args] = h.cardSentOf('card.run');
      const path = stackDesignPath(
        null,
        { number: stack.number, title: stack.title },
        1,
        'mockup',
      );
      const files = args.files as CardRunFile[];
      expect(files).toContainEqual({
        path,
        content: MOCKUP.replace('Export', 'Whole page'),
      });
      const prompt = String(args.prompt);
      expect(prompt).toContain('## Stack');
      expect(prompt).toContain(
        'S-1 "Redesign the Settings page", stage 1 of 2',
      );
      expect(prompt).toContain(path);
    });

    it('a stack without a design never holds its cards', async () => {
      await confirmedStack(false);
      expect((await run(1)).status).toBe(200);
    });

    const setNeeded = (needed: boolean) =>
      h.author.send('patch', `${stackPath()}/design`, { needed });

    it('#502: the design switched off lifts the gate, and switched back on holds it again with its revisions and approval kept', async () => {
      await confirmedStack();
      expect((await run(1)).status).toBe(409);

      const off = await setNeeded(false);
      expect(off.status).toBe(200);
      expect((off.body as TaskDesignView).needed).toBe(false);
      expect((await h.author.get(stackPath())).body.design).toBeNull();
      expect((await run(1)).status).toBe(200);

      const on = await setNeeded(true);
      expect(on.status).toBe(200);
      expect((await h.author.get(stackPath())).body.design).toMatchObject({
        needed: true,
        status: 'idle',
      });
      const refused = await run(2);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(BOARD_ERROR.stackDesignNotApproved);

      const { view } = await approveStackDesign();
      expect((await setNeeded(false)).status).toBe(200);
      const back = await setNeeded(true);
      expect(back.status).toBe(200);
      const kept = back.body as TaskDesignView;
      expect(kept.status).toBe('approved');
      expect(kept.approvedRevisionId).toBe(view.approvedRevisionId);
      expect(kept.revisions).toHaveLength(view.revisions.length);
      expect((await run(2)).status).toBe(200);

      const audit = await h.auditOf('design.toggled');
      expect(audit.map((a) => [a.before, a.after])).toEqual([
        [
          expect.objectContaining({ needed: true }),
          expect.objectContaining({ needed: false }),
        ],
        [
          expect.objectContaining({ needed: false }),
          expect.objectContaining({ needed: true }),
        ],
        [
          expect.objectContaining({ needed: true }),
          expect.objectContaining({ needed: false }),
        ],
        [
          expect.objectContaining({ needed: false }),
          expect.objectContaining({ needed: true }),
        ],
      ]);
    });

    it('#502: a stack confirmed without a design can be switched on, which holds its cards', async () => {
      await confirmedStack(false);
      expect((await setNeeded(true)).status).toBe(200);
      const refused = await run(1);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(BOARD_ERROR.stackDesignNotApproved);
    });

    it('#502: a viewer cannot switch the stack design', async () => {
      await confirmedStack();
      const denied = await h.viewer.send('patch', `${stackPath()}/design`, {
        needed: false,
      });
      expect(denied.status).toBe(403);
    });

    it('a card keeps its own design beside the stack design, and its design turn reads the approved stack design', async () => {
      await confirmedStack();
      const { stack } = await approveStackDesign();
      const on = await h.author.send('patch', h.cardDesignBase(2), {
        needed: true,
      });
      expect(on.status).toBe(200);
      const designs = await h.ctx.prisma.taskDesign.findMany({
        select: { stackId: true, cardId: true },
      });
      expect(designs).toHaveLength(2);
      expect(designs.filter((d) => d.stackId === stack.id)).toHaveLength(1);
      expect(designs.filter((d) => d.cardId !== null)).toHaveLength(1);

      expect(
        (await h.author.send('post', `${h.cardDesignBase(2)}/generate`)).status,
      ).toBe(201);
      const prompt = h.turnPrompts().at(-1) ?? '';
      expect(prompt).toContain(
        "## The stack's approved design (S-1, reference)",
      );
      expect(prompt).toContain('Whole page');
      // The card's own design is drawn for the card, not the stack.
      expect(prompt).toContain('`card-2`');
    });

    it("the stack design turn draws the whole result from the stack's stages", async () => {
      await confirmedStack();
      await h.seedProfile();
      expect(
        (await h.author.send('post', `${stackPath()}/design/generate`)).status,
      ).toBe(201);
      const prompt = h.turnPrompts().at(-1) ?? '';
      expect(prompt).toContain('## The stack');
      expect(prompt).toContain('`stack-1`');
      expect(prompt).toContain('C-3: Compose the Settings page');
      const view = (await h.author.get(`${stackPath()}/design`))
        .body as TaskDesignView;
      expect(view.owner).toMatchObject({ kind: 'stack', number: 1 });
    });
  });
});
