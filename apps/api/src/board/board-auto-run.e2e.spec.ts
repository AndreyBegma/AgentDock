import {
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardCardView,
  type BoardView,
} from '@nautelle/shared';
import { BudgetGate } from '../budgets/budget-gate';
import { BoardAutoRun } from './board-auto-run';
import { BoardWorld } from './testing/board-e2e';

/** #443: Ready / Waiting of a card, and Auto-run when ready. */
describe('card readiness and auto-run (e2e, #443)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const cardPath = (number: number) => `${w.path()}/board/cards/${number}`;
  const link = (number: number, dependsOn: number) =>
    w.operator.send('post', `${cardPath(number)}/dependencies`, { dependsOn });
  const accept = (number: number) =>
    w.operator.send('post', `${cardPath(number)}/move`, {
      column: 'completed',
      index: 0,
    });
  const finish = async (number: number) => {
    expect((await w.runCard(number)).status).toBe(200);
    expect(
      (await w.operator.send('post', `${cardPath(number)}/finish`)).status,
    ).toBe(200);
  };
  const autoRun = (number: number, on = true) =>
    w.operator.send('patch', cardPath(number), { autoRunWhenReady: on });
  const face = async (number: number): Promise<BoardCardView | undefined> => {
    const board = (await w.viewer.get(`${w.path()}/board`)).body as BoardView;
    return board.columns
      .flatMap((c) => c.cards)
      .find((c) => c.number === number);
  };
  const detail = async (number: number) =>
    (await w.viewer.get(cardPath(number))).body as BoardCardDetail;

  /** Cards A and B, and C that runs after both. */
  const world = async () => {
    const a = await w.createCard({ title: 'A', specOnRun: false });
    const b = await w.createCard({ title: 'B', specOnRun: false });
    const c = await w.createCard({ title: 'C', specOnRun: false });
    expect((await link(c.number, a.number)).status).toBe(200);
    expect((await link(c.number, b.number)).status).toBe(200);
    return { a, b, c };
  };

  describe('readiness', () => {
    it('is waiting with the open ones listed, then ready once every one is accepted', async () => {
      const { a, b, c } = await world();
      expect((await face(c.number))?.readiness).toEqual({
        state: 'waiting',
        satisfied: 0,
        total: 2,
        open: [
          { number: a.number, label: `C-${a.number}`, column: 'todo' },
          { number: b.number, label: `C-${b.number}`, column: 'todo' },
        ],
      });

      await accept(a.number);
      expect((await face(c.number))?.readiness).toMatchObject({
        state: 'waiting',
        satisfied: 1,
        open: [expect.objectContaining({ number: b.number })],
      });

      await accept(b.number);
      expect((await detail(c.number)).readiness).toEqual({
        state: 'ready',
        satisfied: 2,
        total: 2,
        open: [],
      });
    });

    it('is none without dependencies, and outside To Do', async () => {
      const { a } = await world();
      expect((await face(a.number))?.readiness).toBeNull();
      const lone = await w.createCard({ specOnRun: false });
      const dependant = await w.createCard({ specOnRun: false });
      await link(dependant.number, lone.number);
      await finish(lone.number);
      await w.runCard(dependant.number);
      expect((await face(dependant.number))?.readiness).toBeNull();
    });

    it('publishes board.changed for the dependants when a card is accepted', async () => {
      const { a, c } = await world();
      const publish = jest.spyOn(w.work, 'publish');
      try {
        await accept(a.number);
        expect(publish).toHaveBeenCalledWith(w.a, c.id);
      } finally {
        publish.mockRestore();
      }
    });
  });

  describe('the switch', () => {
    it('is off by default, turns on in To Do, and is audited', async () => {
      const { c } = await world();
      expect((await detail(c.number)).autoRunWhenReady).toBe(false);

      const on = await autoRun(c.number);
      expect(on.status).toBe(200);
      expect((on.body as BoardCardDetail).autoRunWhenReady).toBe(true);
      const [toggled] = await w.audit('card.auto_run_toggled');
      expect(toggled.after).toEqual({
        number: c.number,
        autoRunWhenReady: true,
      });
      // A switch alone is not a card edit.
      expect(await w.audit('card.updated')).toHaveLength(2);
    });

    it('is refused on outside To Do (409 wrong_column); off is always allowed', async () => {
      const { a } = await world();
      await accept(a.number);
      const refused = await autoRun(a.number);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(BOARD_ERROR.wrongColumn);
      expect((await autoRun(a.number, false)).status).toBe(200);
    });

    it('a viewer cannot set it', async () => {
      const { c } = await world();
      const response = await w.viewer.send('patch', cardPath(c.number), {
        autoRunWhenReady: true,
      });
      expect(response.status).toBe(403);
    });
  });

  describe('auto-run', () => {
    it('starts the Run when the last open dependency is accepted, once, and marks the round', async () => {
      const { a, b, c } = await world();
      await autoRun(c.number);

      await accept(a.number);
      await w.work.settled();
      expect(w.sent('card.run')).toHaveLength(0);

      await accept(b.number);
      await w.work.settled();
      expect(w.sent('card.run')).toHaveLength(1);
      const card = await w.card(c.number);
      expect(card.column).toBe('in_progress');
      expect(card.autoRunWhenReady).toBe(false);
      expect(card.rounds).toEqual([
        expect.objectContaining({
          round: 1,
          trigger: 'run',
          autoRunAfter: b.number,
          authorId: w.operatorId,
        }),
      ]);
      const [started] = await w.audit('card.run_started');
      expect(started.after).toMatchObject({
        number: c.number,
        autoRunAfter: b.number,
      });

      const shown = await detail(c.number);
      expect(shown.rounds[0].autoRunAfter).toBe(b.number);
      expect(shown.round?.autoRunAfter).toBe(b.number);
      expect(shown.autoRunFailure).toBeNull();
    });

    it('starts the Run when the last open dependency reaches Finished, and not again on its Accept (#638)', async () => {
      const { a, b, c } = await world();
      await autoRun(c.number);

      // A is accepted with no PR (landed, #636); C still waits for B.
      await accept(a.number);
      await w.work.settled();
      expect((await w.card(c.number)).column).toBe('todo');

      await finish(b.number);
      await w.work.settled();
      // B's own Run, then C's — after B's collect opened its PR, stacked on
      // B's branch (ADR-0064).
      expect(w.sent('card.run')).toHaveLength(2);
      expect(w.sent('card.run')[1]).toMatchObject({
        base: (await w.card(b.number)).branch,
      });
      const card = await w.card(c.number);
      expect(card.column).toBe('in_progress');
      expect(card.autoRunWhenReady).toBe(false);
      expect(card.rounds).toEqual([
        expect.objectContaining({ round: 1, autoRunAfter: b.number }),
      ]);

      expect((await accept(b.number)).status).toBe(200);
      await w.work.settled();
      expect(w.sent('card.run')).toHaveLength(2);
      expect((await w.card(c.number)).rounds).toHaveLength(1);
      expect(await w.audit('card.auto_run_failed')).toEqual([]);
    });

    it('starts nothing while a Finished dependency goes back In progress (#638)', async () => {
      const { a, b, c } = await world();
      await autoRun(c.number);
      await finish(a.number);
      await w.operator.send('post', `${cardPath(a.number)}/feedback`, {
        text: 'Rename the button.',
      });
      await finish(b.number);
      await w.work.settled();
      expect((await w.card(c.number)).column).toBe('todo');
      expect((await w.card(c.number)).autoRunWhenReady).toBe(true);
      expect((await face(c.number))?.readiness).toMatchObject({
        state: 'waiting',
        open: [expect.objectContaining({ number: a.number })],
      });
    });

    it('publishes board.changed for the dependants when a card reaches or leaves Finished (#638)', async () => {
      const { a, c } = await world();
      expect((await w.runCard(a.number)).status).toBe(200);
      const publish = jest.spyOn(w.work, 'publish');
      try {
        await w.operator.send('post', `${cardPath(a.number)}/finish`);
        expect(publish).toHaveBeenCalledWith(w.a, c.id);
        publish.mockClear();
        await w.operator.send('post', `${cardPath(a.number)}/feedback`, {
          text: 'Rename the button.',
        });
        expect(publish).toHaveBeenCalledWith(w.a, c.id);
      } finally {
        publish.mockRestore();
      }
    });

    it('starts nothing with the switch off, and the manual Run behaves as before', async () => {
      const { a, b, c } = await world();
      await accept(a.number);
      await accept(b.number);
      await w.work.settled();
      expect(w.sent('card.run')).toHaveLength(0);
      expect((await w.card(c.number)).column).toBe('todo');

      expect((await w.runCard(c.number)).status).toBe(200);
      expect((await w.card(c.number)).rounds[0].autoRunAfter).toBeNull();
    });

    it('starts the Run exactly once when the acceptances arrive concurrently', async () => {
      const { a, b, c } = await world();
      await autoRun(c.number);

      const moves = await Promise.all([accept(a.number), accept(b.number)]);
      expect(moves.map((m) => m.status)).toEqual([200, 200]);
      await w.work.settled();

      expect(w.sent('card.run')).toHaveLength(1);
      expect((await w.card(c.number)).rounds).toHaveLength(1);
      expect(await w.audit('card.auto_run_failed')).toEqual([]);
    });

    it('races of the same acceptance claim the card once', async () => {
      const { a, b, c } = await world();
      await w.ctx.prisma.boardCard.updateMany({
        where: { id: { in: [a.id, b.id] } },
        data: { column: 'completed', completedAt: new Date() },
      });
      await w.ctx.prisma.boardCard.update({
        where: { id: c.id },
        data: { autoRunWhenReady: true },
      });

      const auto = w.ctx.app.get(BoardAutoRun);
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          auto.afterSatisfied(w.a, i % 2 === 0 ? a : b),
        ),
      );

      expect(w.sent('card.run')).toHaveLength(1);
      expect((await w.card(c.number)).rounds).toHaveLength(1);
      expect(await w.audit('card.auto_run_failed')).toEqual([]);
    });

    it('leaves a card that is not in To Do alone', async () => {
      const { a, b, c } = await world();
      await autoRun(c.number);
      await w.ctx.prisma.boardCard.updateMany({
        where: { id: { in: [a.id, b.id] } },
        data: { column: 'completed', completedAt: new Date() },
      });
      expect((await w.runCard(c.number)).status).toBe(200);
      await w.ctx.app.get(BoardAutoRun).afterSatisfied(w.a, b);
      expect(w.sent('card.run')).toHaveLength(1);
      expect((await w.card(c.number)).rounds).toHaveLength(1);
    });

    it('with no free slot, refuses like a manual Run and says why on the card', async () => {
      await w.admin.send('put', `${w.path()}/board-settings`, {
        issueOnRun: false,
        specOnRun: false,
        maxRunning: 1,
      });
      const { a, b, c } = await world();
      const busy = await w.createCard({ specOnRun: false });
      expect((await w.runCard(busy.number)).status).toBe(200);
      await autoRun(c.number);

      await accept(a.number);
      await accept(b.number);
      await w.work.settled();

      // Only the busy card's Run was sent; the manual Run is refused the same way.
      expect(w.sent('card.run')).toHaveLength(1);
      const manual = await w.runCard(c.number);
      expect(manual.status).toBe(409);
      expect(manual.body.error).toBe(BOARD_ERROR.maxRunning);

      const shown = await face(c.number);
      expect(shown?.column).toBe('todo');
      expect(shown?.autoRunWhenReady).toBe(false);
      expect(shown?.readiness?.state).toBe('ready');
      expect(shown?.autoRunFailure).toMatchObject({
        code: BOARD_ERROR.maxRunning,
        message: manual.body.message,
        after: b.number,
      });
      const [failed] = await w.audit('card.auto_run_failed');
      expect(failed).toMatchObject({
        result: 'error',
        after: { number: c.number, error: 'max_running', after: b.number },
      });
    });

    it('with the budget reached, refuses like a manual Run', async () => {
      const gate = w.ctx.app.get(BudgetGate);
      const check = jest.spyOn(gate, 'check').mockResolvedValue({
        allowed: false,
        budgetId: 'b1',
        scope: 'project',
        resetsAt: new Date('2026-11-01T00:00:00Z'),
      });
      try {
        const { a, b, c } = await world();
        await autoRun(c.number);
        await accept(a.number);
        await accept(b.number);
        await w.work.settled();

        expect(w.sent('card.run')).toEqual([]);
        expect((await detail(c.number)).autoRunFailure).toMatchObject({
          code: BOARD_ERROR.budgetExceeded,
          after: b.number,
        });
        // A round that starts clears the failure.
        check.mockRestore();
        expect((await w.runCard(c.number)).status).toBe(200);
        expect((await detail(c.number)).autoRunFailure).toBeNull();
      } finally {
        check.mockRestore();
      }
    });
  });

  /**
   * C-181 (D-09, D-10): an auto-run runs as the person who armed it — or who
   * last edited the armed card — never as whoever moved the dependency.
   */
  describe('the principal (C-181)', () => {
    const adminAccept = (number: number) =>
      w.admin.send('post', `${cardPath(number)}/move`, {
        column: 'completed',
        index: 0,
      });
    const adminId = async () =>
      (
        await w.ctx.prisma.user.findUniqueOrThrow({
          where: { email: 'admin@x.test' },
        })
      ).id;
    const bypassByDefault = () =>
      w.ctx.prisma.projectOrchestratorSettings.upsert({
        where: { projectId: w.a },
        create: { projectId: w.a, permissionMode: 'bypassPermissions' },
        update: { permissionMode: 'bypassPermissions' },
      });

    it('runs as the operator who armed it when an admin accepts, charged to the operator', async () => {
      const { a, b, c } = await world();
      await autoRun(c.number);
      await adminAccept(a.number);
      await adminAccept(b.number);
      await w.work.settled();

      expect(w.sent('card.run')).toHaveLength(1);
      const card = await w.card(c.number);
      expect(card.rounds[0]).toMatchObject({ authorId: w.operatorId });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: card.rounds[0].runId },
      });
      expect(run).toMatchObject({
        triggeredByType: 'user',
        triggeredById: w.operatorId,
      });
      const [started] = await w.audit('card.run_started');
      expect(started).toMatchObject({
        actorType: 'system',
        actorOnBehalfOfId: w.operatorId,
      });
    });

    it('never runs an operator-armed card in bypass, whoever accepts the dependency', async () => {
      await bypassByDefault();
      const { a, b, c } = await world();
      await autoRun(c.number);
      await adminAccept(a.number);
      await adminAccept(b.number);
      await w.work.settled();

      expect(w.sent('card.run')).toEqual([]);
      expect((await w.card(c.number)).rounds).toEqual([]);
      expect((await detail(c.number)).autoRunFailure).toMatchObject({
        message: expect.stringContaining('bypassPermissions'),
        after: b.number,
      });
      const [failed] = await w.audit('card.auto_run_failed');
      expect(failed).toMatchObject({
        actorType: 'system',
        actorOnBehalfOfId: w.operatorId,
        result: 'error',
      });
    });

    it('an admin-armed card runs in bypass; once an operator edits it, it runs as the operator', async () => {
      await bypassByDefault();
      const { a, b, c } = await world();
      const armed = await w.admin.send('patch', cardPath(c.number), {
        autoRunWhenReady: true,
      });
      expect(armed.status).toBe(200);
      expect((await w.card(c.number)).autoRunArmedById).toBe(await adminId());

      const edit = await w.operator.send('patch', cardPath(c.number), {
        body: 'Delete the production database.',
      });
      expect(edit.status).toBe(200);
      expect((await w.card(c.number)).autoRunArmedById).toBe(w.operatorId);
      const edits = await w.audit('card.updated');
      expect(edits[edits.length - 1]).toMatchObject({
        actorUserId: w.operatorId,
        meta: { autoRunReowned: true, previousArmedById: await adminId() },
      });

      await adminAccept(a.number);
      await adminAccept(b.number);
      await w.work.settled();
      expect(w.sent('card.run')).toEqual([]);
      expect((await detail(c.number)).autoRunFailure?.message).toContain(
        'bypassPermissions',
      );
    });

    it('an admin-armed card nobody else edited runs in bypass', async () => {
      await bypassByDefault();
      const { a, b, c } = await world();
      await w.admin.send('patch', cardPath(c.number), {
        autoRunWhenReady: true,
      });
      await accept(a.number);
      await accept(b.number);
      await w.work.settled();

      expect(w.sent('card.run')).toEqual([
        expect.objectContaining({ permissionMode: 'bypassPermissions' }),
      ]);
      expect((await w.card(c.number)).rounds[0].authorId).toBe(await adminId());
    });

    it("the arming operator's user budget stops it, not the accepting admin's", async () => {
      const gate = w.ctx.app.get(BudgetGate);
      const check = jest
        .spyOn(gate, 'check')
        .mockImplementation(async ({ userId }) =>
          userId === w.operatorId
            ? {
                allowed: false,
                budgetId: 'b1',
                scope: 'user',
                resetsAt: new Date('2026-11-01T00:00:00Z'),
              }
            : { allowed: true },
        );
      try {
        const { a, b, c } = await world();
        await autoRun(c.number);
        await adminAccept(a.number);
        await adminAccept(b.number);
        await w.work.settled();

        expect(w.sent('card.run')).toEqual([]);
        expect((await detail(c.number)).autoRunFailure).toMatchObject({
          code: BOARD_ERROR.budgetExceeded,
          after: b.number,
        });
      } finally {
        check.mockRestore();
      }
    });

    it('is refused when the arming person no longer runs cards on the project', async () => {
      const { a, b, c } = await world();
      await autoRun(c.number);
      await w.ctx.prisma.projectMember.deleteMany({
        where: { projectId: w.a, userId: w.operatorId },
      });
      await adminAccept(a.number);
      await adminAccept(b.number);
      await w.work.settled();

      expect(w.sent('card.run')).toEqual([]);
      expect((await detail(c.number)).autoRunFailure?.message).toContain(
        'no longer runs cards',
      );
    });
  });
});
