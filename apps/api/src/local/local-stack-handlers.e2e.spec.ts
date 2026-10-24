import type { LocalResponseMessage } from '@nautelle/shared/protocol';
import { CardDesignHarness } from '../design/testing/card-design-e2e';
import { designResult } from '../design/testing/design-e2e';
import { ROOT } from '../planner/testing/planner-e2e';
import { LocalRequestRouter } from './local-request-router';

/** A person's own Claude Code session (ids are uuids, as Claude's are). */
const MANUAL = '7a2d3c4b-5e6f-4a71-8b82-c3d4e5f6a701';
/** A Board Run worker's session: `origin: run`. */
const CARD_SESSION = '1c8f8d2f-6e1a-4d2b-8b62-3a4d5e6f7a81';

interface Stack {
  number: number;
  label: string;
  title: string;
  column: string;
  stages: { position: number; title: string; cards: number[] }[];
  design: { needed: boolean; status: string; busy: boolean } | null;
  run: { state: string } | null;
}

interface Design {
  owner: 'card' | 'stack';
  number: number;
  status: string;
  revisions: { id: string; variant: number; archived: boolean }[];
  openComments: { revisionId: string; body: string }[];
}

/**
 * C-377 (ADR-0087): stacks, designs and dependencies from a person's session —
 * through the real router, so its authorization, the refusals' names and the
 * result schemas are the ones a runner gets. Writes answer only a person's
 * own `manual` session; Approve from any other is `needs_person`.
 */
describe('stacks, designs and dependencies from a session (C-377, e2e)', () => {
  const h = new CardDesignHarness();
  let router: LocalRequestRouter;
  let nextId = 0;

  beforeAll(async () => {
    await h.start();
    router = h.ctx.app.get(LocalRequestRouter);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    await asLocalUser(h.authorId);
  });
  afterEach(async () => {
    await h.work.settled();
    jest.restoreAllMocks();
  });

  const asLocalUser = (userId: string) =>
    h.ctx.prisma.runner.update({
      where: { id: h.runnerId },
      data: { localUserId: userId },
    });

  /** A local request as the runner relays it, answered by the router. */
  const ask = (
    method: string,
    args: unknown,
    sessionId = MANUAL,
  ): Promise<LocalResponseMessage> => {
    nextId += 1;
    return router.answer(h.runnerId, {
      type: 'local.request',
      id: `lr_${nextId}`,
      method,
      args,
      projectId: h.projectId,
      session: { runtime: 'claude', id: sessionId },
      via: 'mcp',
    });
  };

  const data = async <T>(response: Promise<LocalResponseMessage>) => {
    const answer = await response;
    expect([answer.ok, answer.error]).toEqual([true, undefined]);
    return answer.data as T;
  };

  const refusal = async (response: Promise<LocalResponseMessage>) => {
    const answer = await response;
    expect(answer.ok).toBe(false);
    return answer.error?.code;
  };

  /** The session's hooks reached Nautelle: a `manual` session in the project. */
  const manualSession = async () => {
    await h.sinks.dispatch(h.runnerId, [
      {
        ...h.event('hook.session_started', {
          source: 'startup',
          cwd: ROOT,
          gitBranch: 'feat/42-stacks',
          permissionMode: 'default',
        }),
        source: 'hook',
        session: { runtime: 'claude', id: MANUAL },
      },
    ]);
    const row = await h.ctx.prisma.agentSession.findFirstOrThrow({
      where: { externalId: MANUAL },
      select: { origin: true },
    });
    expect(row.origin).toBe('manual');
  };

  const cardSession = () =>
    h.ctx.prisma.agentSession.create({
      data: {
        runnerId: h.runnerId,
        runtime: 'claude',
        externalId: CARD_SESSION,
        projectId: h.projectId,
        cwd: `${ROOT}/.worktrees/c1`,
        origin: 'run',
        startedAt: new Date(),
        lastEventAt: new Date(),
      },
    });

  /** C-1 … C-<count> in To Do. */
  const cards = async (count: number) => {
    for (let n = 1; n <= count; n += 1) {
      await h.createCard({ title: `Card ${n}` });
    }
  };

  const dependsOn = async (number: number) => {
    const card = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { projectId_number: { projectId: h.projectId, number } },
      select: {
        dependsOn: { select: { dependsOn: { select: { number: true } } } },
      },
    });
    return card.dependsOn.map((d) => d.dependsOn.number).sort();
  };

  const STAGED = {
    title: 'Redesign the Settings page',
    body: 'Components first, then the page.',
    stages: [
      { title: 'Components', cards: [1, 2] },
      { title: 'Page', cards: [3] },
    ],
  };

  describe('stack.create', () => {
    it('makes the stack with every stage and its dependencies in one call, audited as the person', async () => {
      await manualSession();
      await cards(3);
      const stack = await data<Stack>(ask('stack.create', STAGED));
      // A stage lists its cards in board order: the newest on top.
      expect(stack).toMatchObject({
        number: 1,
        label: 'S-1',
        title: 'Redesign the Settings page',
        design: null,
        stages: [
          { position: 0, title: 'Components', cards: [2, 1] },
          { position: 1, title: 'Page', cards: [3] },
        ],
      });
      expect(await dependsOn(3)).toEqual([1, 2]);
      expect(await dependsOn(1)).toEqual([]);

      const created = await h.auditOf('stack.created');
      expect(created).toHaveLength(1);
      // As every local write (ADR-0083): the runner, on the person's behalf.
      expect(created[0]).toMatchObject({
        actorType: 'runner',
        actorRunnerId: h.runnerId,
      });
      const writes = await h.auditOf('local.request');
      expect(
        writes.map((w) => [
          (w.after as { method: string }).method,
          w.result,
          (w.meta as { onBehalfOf: string }).onBehalfOf,
        ]),
      ).toEqual([['stack.create', 'ok', h.authorId]]);
    });

    it('refuses the whole call for a card in a stack already, and for a cycle', async () => {
      await manualSession();
      await cards(5);
      await data(ask('stack.create', STAGED));
      expect(
        await refusal(
          ask('stack.create', {
            title: 'Again',
            stages: [{ cards: [3, 4] }],
          }),
        ),
      ).toBe('stack_refused');

      // C-4 already runs after C-5: a stage of C-5 after C-4 closes a cycle.
      await data(ask('card.depend', { card: 4, dependsOn: 5 }));
      expect(
        await refusal(
          ask('stack.create', {
            title: 'Loop',
            stages: [{ cards: [4] }, { cards: [5] }],
          }),
        ),
      ).toBe('dependency_cycle');
      expect(await h.ctx.prisma.boardStack.count()).toBe(1);
      expect(await dependsOn(5)).toEqual([]);
    });

    it('a card in two stages, or one card in all, fails the schema', async () => {
      await manualSession();
      expect(
        await refusal(
          ask('stack.create', {
            title: 'Twice',
            stages: [{ cards: [1, 2] }, { cards: [2] }],
          }),
        ),
      ).toBe('invalid_args');
      expect(
        await refusal(
          ask('stack.create', { title: 'One', stages: [{ cards: [1] }] }),
        ),
      ).toBe('invalid_args');
    });
  });

  describe('stack edits', () => {
    it('adds a card to a stage, removes one, and renames the stack and its stages', async () => {
      await manualSession();
      await cards(4);
      await data(ask('stack.create', STAGED));

      const added = await data<Stack>(
        ask('stack.addCard', { stack: 1, card: 4, stage: 2 }),
      );
      expect(added.stages.map((s) => s.cards)).toEqual([[2, 1], [3], [4]]);

      const removed = await data<Stack>(
        ask('stack.removeCard', { stack: 1, card: 2 }),
      );
      expect(removed.stages.map((s) => s.cards)).toEqual([[1], [3], [4]]);

      const renamed = await data<Stack>(
        ask('stack.update', {
          stack: 1,
          title: 'Settings, again',
          stages: [
            { position: 0, title: 'Foundations' },
            { position: 1, title: 'Features' },
          ],
        }),
      );
      expect(renamed.title).toBe('Settings, again');
      expect(renamed.stages.map((s) => s.title)).toEqual([
        'Foundations',
        'Features',
        '',
      ]);

      expect(
        await refusal(
          ask('stack.update', {
            stack: 1,
            stages: [{ position: 7, title: 'Nowhere' }],
          }),
        ),
      ).toBe('stack_refused');
      expect(
        await refusal(ask('stack.removeCard', { stack: 9, card: 1 })),
      ).toBe('not_found');
    });

    it('REST PATCH board/stacks/:n renames stages too', async () => {
      await manualSession();
      await cards(3);
      await data(ask('stack.create', STAGED));
      const patched = await h.author.send(
        'patch',
        `/projects/${h.projectId}/board/stacks/1`,
        {
          stages: [
            { position: 0, title: 'Foundations' },
            { position: 1, title: 'Features' },
          ],
        },
      );
      expect(patched.status).toBe(200);
      const stages = await h.ctx.prisma.boardStackStage.findMany({
        orderBy: { position: 'asc' },
        select: { title: true },
      });
      expect(stages.map((s) => s.title)).toEqual(['Foundations', 'Features']);

      const missing = await h.author.send(
        'patch',
        `/projects/${h.projectId}/board/stacks/1`,
        { stages: [{ position: 5, title: 'Nowhere' }] },
      );
      expect(missing.status).toBe(409);
      const viewer = await h.viewer.send(
        'patch',
        `/projects/${h.projectId}/board/stacks/1`,
        { stages: [{ position: 0, title: 'Mine' }] },
      );
      expect(viewer.status).toBe(403);
    });

    it('board.list returns the stacks with their stages and design', async () => {
      await manualSession();
      await cards(3);
      await data(ask('stack.create', { ...STAGED, design: true }));
      const list = await data<{ stacks: Stack[] }>(ask('board.list', {}));
      expect(list.stacks).toEqual([
        expect.objectContaining({
          number: 1,
          title: 'Redesign the Settings page',
          stages: [
            { position: 0, title: 'Components', cards: [2, 1] },
            { position: 1, title: 'Page', cards: [3] },
          ],
          design: expect.objectContaining({ needed: true, busy: false }),
        }),
      ]);
    });
  });

  describe('dependencies', () => {
    it('card.depend and card.undepend set one dependency; the board refusals pass unchanged', async () => {
      await manualSession();
      await cards(3);
      expect(await data(ask('card.depend', { card: 2, dependsOn: 1 }))).toEqual(
        { number: 2, dependsOn: [1] },
      );
      expect(await data(ask('card.depend', { card: 3, dependsOn: 2 }))).toEqual(
        { number: 3, dependsOn: [2] },
      );
      expect(await refusal(ask('card.depend', { card: 1, dependsOn: 3 }))).toBe(
        'dependency_cycle',
      );
      expect(
        await refusal(ask('card.depend', { card: 1, dependsOn: 42 })),
      ).toBe('invalid_dependency');
      expect(await refusal(ask('card.depend', { card: 1, dependsOn: 1 }))).toBe(
        'invalid_args',
      );
      expect(
        await data(ask('card.undepend', { card: 2, dependsOn: 1 })),
      ).toEqual({ number: 2, dependsOn: [] });
      expect(await dependsOn(2)).toEqual([]);
    });
  });

  describe('designs', () => {
    it('a stack design: generate, status, approve — then the stack runs and stops', async () => {
      await manualSession();
      await h.seedProfile();
      await cards(3);
      await data(ask('stack.create', { ...STAGED, design: true }));
      expect(await refusal(ask('stack.run', { stack: 1 }))).toBe(
        'stack_design_not_approved',
      );

      const generating = await data<Design>(
        ask('stack.design', { stack: 1, action: 'generate' }),
      );
      expect(generating).toMatchObject({ owner: 'stack', number: 1 });
      expect(
        await refusal(ask('stack.design', { stack: 1, action: 'generate' })),
      ).toBe('design_busy');

      const stack = await h.ctx.prisma.boardStack.findFirstOrThrow();
      const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
        where: { stackId: stack.id, phase: { in: ['queued', 'running'] } },
      });
      await h.sinks.dispatch(h.runnerId, [
        h.event('plan_turn.finished', {
          planId: stack.id,
          turnId: turn.id,
          runId: turn.runId,
          projectId: h.projectId,
          phase: 'succeeded',
          at: new Date().toISOString(),
          exitCode: 0,
          resultText: designResult({ taskKey: 'stack-1', variant: 1 }),
          resultTruncated: false,
        }),
      ]);
      const status = await data<Design>(ask('stack.designView', { stack: 1 }));
      expect(status.status).toBe('reviewing');
      expect(status.revisions).toHaveLength(1);

      const approved = await data<Design>(
        ask('stack.design', { stack: 1, action: 'approve' }),
      );
      expect(approved.status).toBe('approved');
      expect(
        await refusal(ask('stack.design', { stack: 1, action: 'generate' })),
      ).toBe('design_approved');

      const running = await data<Stack>(ask('stack.run', { stack: 1 }));
      expect(running.run?.state).not.toBeUndefined();
      expect(h.cardSentOf('card.run').length).toBeGreaterThan(0);
      const stopped = await data<Stack>(ask('stack.stop', { stack: 1 }));
      expect(stopped.number).toBe(1);
    });

    it("a card's design: design_off, then revise with comments and no_open_comments", async () => {
      await manualSession();
      await h.seedProfile();
      const plain = await h.createCard({ title: 'No design' });
      expect(
        await refusal(
          ask('card.design', { card: plain.number, action: 'generate' }),
        ),
      ).toBe('design_off');

      const card = await h.designedCard(1);
      await data(ask('card.design', { card: card.number, action: 'generate' }));
      await h.finishCard(
        card.id,
        designResult({ taskKey: `card-${card.number}`, variant: 1 }),
      );
      expect(
        await refusal(
          ask('card.design', { card: card.number, action: 'revise' }),
        ),
      ).toBe('no_open_comments');
      expect(
        await refusal(
          ask('card.design', {
            card: card.number,
            action: 'approve',
            comments: ['Bigger'],
          }),
        ),
      ).toBe('invalid_args');

      const revising = await data<Design>(
        ask('card.design', {
          card: card.number,
          action: 'revise',
          comments: ['Make the button bigger.'],
        }),
      );
      expect(revising.status).toBe('revising');
      const comments = await h.ctx.prisma.designComment.findMany({
        select: { body: true },
      });
      expect(comments.map((c) => c.body)).toEqual(['Make the button bigger.']);
    });

    it('approve with several variants names the revisions to pick from', async () => {
      await manualSession();
      await h.seedProfile();
      const card = await h.designedCard(2);
      await data(ask('card.design', { card: card.number, action: 'generate' }));
      const key = `card-${card.number}`;
      await h.finishCard(card.id, designResult({ taskKey: key, variant: 1 }));
      await h.finishCard(card.id, designResult({ taskKey: key, variant: 2 }));
      const answer = await ask('card.design', {
        card: card.number,
        action: 'approve',
      });
      expect(answer.error?.code).toBe('invalid_args');
      expect(answer.error?.message).toContain('variant 2');

      const view = await data<Design>(
        ask('card.designView', { card: card.number }),
      );
      const second = view.revisions.find((r) => r.variant === 2);
      const approved = await data<Design>(
        ask('card.design', {
          card: card.number,
          action: 'approve',
          revisionId: second?.id,
        }),
      );
      expect(approved.status).toBe('approved');
    });
  });

  describe('the manual-only rule', () => {
    it("a card worker's session is refused every write; Approve is needs_person; the views answer", async () => {
      await cardSession();
      await cards(3);
      const writes = [
        ['stack.create', STAGED],
        ['stack.addCard', { stack: 1, card: 3, stage: 0 }],
        ['stack.removeCard', { stack: 1, card: 1 }],
        ['stack.update', { stack: 1, title: 'New' }],
        ['stack.run', { stack: 1 }],
        ['stack.stop', { stack: 1 }],
        ['stack.design', { stack: 1, action: 'generate' }],
        ['card.design', { card: 1, action: 'revise' }],
        ['card.depend', { card: 2, dependsOn: 1 }],
        ['card.undepend', { card: 2, dependsOn: 1 }],
      ] as const;
      for (const [method, args] of writes) {
        expect([
          method,
          await refusal(ask(method, args, CARD_SESSION)),
        ]).toEqual([method, 'not_a_manual_session']);
      }
      expect(
        await refusal(
          ask('card.design', { card: 1, action: 'approve' }, CARD_SESSION),
        ),
      ).toBe('needs_person');
      expect(
        await refusal(
          ask('stack.design', { stack: 1, action: 'approve' }, CARD_SESSION),
        ),
      ).toBe('needs_person');
      expect(await h.ctx.prisma.boardStack.count()).toBe(0);
      expect(await h.ctx.prisma.boardCardDependency.count()).toBe(0);

      const designed = await h.designedCard(1);
      const view = await data<Design>(
        ask('card.designView', { card: designed.number }, CARD_SESSION),
      );
      expect(view).toMatchObject({
        owner: 'card',
        number: designed.number,
        status: 'idle',
      });
    });

    it('a viewer is forbidden the writes and answered the views', async () => {
      await manualSession();
      await cards(3);
      const designed = await h.designedCard(1);
      const viewer = await h.ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'viewer@example.com' },
      });
      await asLocalUser(viewer.id);
      expect(await refusal(ask('stack.create', STAGED))).toBe('forbidden');
      expect(await refusal(ask('card.depend', { card: 2, dependsOn: 1 }))).toBe(
        'forbidden',
      );
      expect(
        await refusal(ask('card.design', { card: 1, action: 'approve' })),
      ).toBe('forbidden');
      const view = await data<Design>(
        ask('card.designView', { card: designed.number }),
      );
      expect(view.status).toBe('idle');
    });
  });
});
