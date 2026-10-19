import {
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardStackDetail,
  type BoardView,
  type StackCardRunState,
} from '@agentdock/shared';
import { BudgetGate } from '../budgets/budget-gate';
import { BoardStackRuns } from './board-stack-runs';
import { BoardWorld } from './testing/board-e2e';

/**
 * #652 (docs/specs/652-add-a-run-stack-button-that-queues-cards.md): Run
 * stack queues the stack's To Do cards and starts them through the card Run
 * as they become ready — in parallel within `maxRunning`, stage 2 after its
 * dependency under the stacked-branch rules. A `max_running` refusal keeps
 * a card queued; any other refusal or a failed round pauses the run. Stop
 * removes the queue and leaves running cards alone.
 */
describe('Run stack (e2e, #652)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const BASE = 'develop';
  const stacks = () => `${w.path()}/board/stacks`;
  const runStack = (number = 1, session = w.operator) =>
    session.send('post', `${stacks()}/${number}/run`, {});
  const stopStack = (number = 1, session = w.operator) =>
    session.send('post', `${stacks()}/${number}/stop`, {});
  const stack = async (number = 1) =>
    (await w.viewer.get(`${stacks()}/${number}`)).body as BoardStackDetail;
  const detail = async (number: number) =>
    (await w.viewer.get(`${w.path()}/board/cards/${number}`))
      .body as BoardCardDetail;
  const maxRunning = (value: number) =>
    w.admin.send('put', `${w.path()}/board-settings`, {
      issueOnRun: false,
      specOnRun: false,
      maxRunning: value,
    });

  /** The run state of each card of the stack, by number. */
  const cardStates = async (number = 1) => {
    const states: Record<number, StackCardRunState | null> = {};
    for (const stage of (await stack(number)).stages) {
      for (const card of stage.cards) states[card.number] = card.run;
    }
    return states;
  };

  /** The numbers of the cards a `card.run` was sent for, in order. */
  const started = async () => {
    const ids = w.sent('card.run').map((args) => String(args.cardId));
    const cards = await w.ctx.prisma.boardCard.findMany({
      where: { id: { in: ids } },
      select: { id: true, number: true },
    });
    const byId = new Map(cards.map((c) => [c.id, c.number]));
    return ids.map((id) => byId.get(id));
  };

  const cards = async (count: number) => {
    const made: { id: string; number: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      made.push(
        await w.createCard({ title: `Part ${i + 1}`, specOnRun: false }),
      );
    }
    return made;
  };

  /** S-1 of `first` in stage 1, then `second` in stage 2. */
  const staged = async (
    first: readonly { number: number }[],
    second: readonly { number: number }[],
    design = false,
  ) => {
    const extra = first.length < 2 ? await cards(1) : [];
    const response = await w.operator.send('post', stacks(), {
      title: 'Payments',
      design,
      cards: [...first, ...extra].map((c) => c.number),
    });
    expect(response.status).toBe(201);
    for (const card of second) {
      const added = await w.operator.send('post', `${stacks()}/1/cards`, {
        card: card.number,
        stage: 1,
      });
      expect(added.status).toBe(201);
    }
    // A stage-1 filler leaves, so stage 2 waits on `first` only.
    for (const card of extra) {
      const removed = await w.operator.send(
        'delete',
        `${stacks()}/1/cards/${card.number}`,
      );
      expect(removed.status).toBe(200);
    }
  };

  /**
   * The card's latest round ends as `phase`; a finished one leaves the card
   * in Finished with its branch pushed and an open PR. Published, as the
   * runner's events do.
   */
  const endRound = async (
    card: { id: string; number: number },
    phase: 'finished' | 'failed' = 'finished',
    pr = 70 + card.number,
  ) => {
    const round = await w.ctx.prisma.boardCardRound.findFirstOrThrow({
      where: { cardId: card.id },
      orderBy: { round: 'desc' },
    });
    await w.ctx.prisma.boardCardRound.update({
      where: { id: round.id },
      data: {
        phase,
        finishedAt: new Date(),
        ...(phase === 'failed' ? { error: 'the runner could not start' } : {}),
      },
    });
    if (phase === 'finished') {
      await w.ctx.prisma.boardCard.update({
        where: { id: card.id },
        data: {
          column: 'finished',
          branch: `feat/${card.number}-part`,
          prNumber: pr,
          prUrl: `https://github.com/acme/widget/pull/${pr}`,
          prState: 'open',
        },
      });
    }
    w.work.publish(w.a, card.id);
    await w.work.settled();
  };

  const merge = async (card: { id: string; number: number }) => {
    await w.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: { prState: 'merged', mergedAt: new Date() },
    });
    w.work.publish(w.a, card.id);
    await w.work.settled();
  };

  it('starts every stage-1 card up to maxRunning; the rest stay queued and start as slots free', async () => {
    await maxRunning(2);
    const [a, b, c] = await cards(3);
    await staged([a, b, c], []);

    const response = await runStack();
    expect(response.status).toBe(200);
    expect(await started()).toEqual([a.number, b.number]);
    const shown = response.body as BoardStackDetail;
    expect(shown.run).toMatchObject({
      state: 'running',
      pause: null,
      running: 2,
      queued: 1,
      waiting: 0,
    });
    expect(await cardStates()).toEqual({
      [a.number]: 'running',
      [b.number]: 'running',
      [c.number]: 'queued',
    });

    // A `max_running` refusal never fails the queued card.
    const queued = await detail(c.number);
    expect(queued.column).toBe('todo');
    expect(queued.autoRunFailure).toBeNull();

    await endRound(a);
    expect(await started()).toEqual([a.number, b.number, c.number]);
    expect((await stack()).run).toMatchObject({
      state: 'running',
      running: 2,
      queued: 0,
    });

    await endRound(b);
    await endRound(c);
    expect((await stack()).run).toMatchObject({ state: 'done', running: 0 });

    const [audit] = await w.audit('stack.run_started');
    expect(audit).toMatchObject({
      result: 'ok',
      after: { number: 1, cards: [a.number, b.number, c.number] },
    });
    const board = (await w.viewer.get(`${w.path()}/board`)).body as BoardView;
    expect(board.stacks?.[0].run).toMatchObject({ state: 'done' });
  });

  it('keeps a card queued while a card outside the stack holds the only slot', async () => {
    await maxRunning(1);
    const busy = await w.createCard({ specOnRun: false });
    expect((await w.runCard(busy.number)).status).toBe(200);
    const [a, b] = await cards(2);
    await staged([a, b], []);

    expect((await runStack()).status).toBe(200);
    expect(await started()).toEqual([busy.number]);
    expect((await stack()).run).toMatchObject({ state: 'running', queued: 2 });

    await endRound(busy);
    expect(await started()).toEqual([busy.number, a.number]);
    expect((await detail(b.number)).autoRunFailure).toBeNull();
    expect(await w.audit('stack.run_paused')).toEqual([]);
  });

  it('starts a stage-2 card with one dependency once that round finishes with an open PR, stacked on its branch', async () => {
    const [a, c] = await cards(2);
    await staged([a], [c]);

    expect((await runStack()).status).toBe(200);
    expect(await started()).toEqual([a.number]);
    expect(await cardStates()).toMatchObject({
      [a.number]: 'running',
      [c.number]: 'waiting',
    });
    expect((await stack()).run).toMatchObject({ running: 1, waiting: 1 });

    await endRound(a);
    expect(await started()).toEqual([a.number, c.number]);
    expect(w.sent('card.run').at(-1)?.base).toBe(`feat/${a.number}-part`);
    expect(await w.card(c.number)).toMatchObject({
      prBase: `feat/${a.number}-part`,
      prBaseCardId: a.id,
    });
  });

  it('starts a card with several dependencies only once all of them are merged', async () => {
    const [a, b, c] = await cards(3);
    await staged([a, b], [c]);

    await runStack();
    expect(await started()).toEqual([a.number, b.number]);
    await endRound(a);
    await endRound(b);
    expect(await started()).toEqual([a.number, b.number]);
    expect((await cardStates())[c.number]).toBe('waiting');

    await merge(a);
    expect(await started()).toEqual([a.number, b.number]);
    await merge(b);
    expect(await started()).toEqual([a.number, b.number, c.number]);
    expect(w.sent('card.run').at(-1)?.base).toBe(BASE);
  });

  it('pauses on a budget refusal, says why, and resumes when Run stack is pressed again', async () => {
    const gate = w.ctx.app.get(BudgetGate);
    const check = jest.spyOn(gate, 'check').mockResolvedValue({
      allowed: false,
      budgetId: 'b1',
      scope: 'project',
      resetsAt: new Date('2026-11-01T00:00:00Z'),
    });
    try {
      const [a, b] = await cards(2);
      await staged([a, b], []);

      expect((await runStack()).status).toBe(200);
      expect(w.sent('card.run')).toEqual([]);
      const shown = await stack();
      expect(shown.run).toMatchObject({
        state: 'paused',
        pause: { code: BOARD_ERROR.budgetExceeded, card: a.number },
        queued: 2,
      });
      expect((await cardStates())[a.number]).toBe('paused');
      expect((await detail(a.number)).autoRunFailure).toMatchObject({
        code: BOARD_ERROR.budgetExceeded,
        stack: 1,
        after: null,
      });
      const [paused] = await w.audit('stack.run_paused');
      expect(paused).toMatchObject({
        result: 'error',
        after: { number: 1, card: a.number, error: 'budget_exceeded' },
      });

      // A paused run starts nothing on its own.
      w.work.publish(w.a, b.id);
      await w.work.settled();
      expect(w.sent('card.run')).toEqual([]);

      check.mockRestore();
      expect((await runStack()).status).toBe(200);
      expect(await started()).toEqual([a.number, b.number]);
      expect((await stack()).run).toMatchObject({
        state: 'running',
        pause: null,
      });
      expect((await detail(a.number)).autoRunFailure).toBeNull();
    } finally {
      check.mockRestore();
    }
  });

  it('pauses when a profile refusal stops a start', async () => {
    await w.ctx.prisma.project.updateMany({ data: { defaultProfileId: null } });
    await w.ctx.prisma.runtimeProfile.deleteMany();
    const [a, b] = await cards(2);
    await staged([a, b], []);

    await runStack();
    expect((await stack()).run).toMatchObject({
      state: 'paused',
      pause: { code: BOARD_ERROR.noProfile, card: a.number },
    });
  });

  it('pauses when a round the run started fails', async () => {
    const [a, b, c] = await cards(3);
    await staged([a, b], [c]);
    await runStack();

    await endRound(a, 'failed');
    const shown = await stack();
    expect(shown.run).toMatchObject({
      state: 'paused',
      pause: {
        code: 'round_failed',
        card: a.number,
        message: expect.stringContaining('the runner could not start'),
      },
    });
    expect((await cardStates())[a.number]).toBe('paused');
    expect(await w.audit('stack.run_paused')).toHaveLength(1);
  });

  it('Stop clears the queue, leaves running cards alone, and Run stack resumes from the rest', async () => {
    await maxRunning(1);
    const [a, b] = await cards(2);
    await staged([a, b], []);
    await runStack();
    expect(await started()).toEqual([a.number]);

    const stopped = await stopStack();
    expect(stopped.status).toBe(200);
    expect((stopped.body as BoardStackDetail).run).toMatchObject({
      state: 'stopped',
      queued: 0,
      running: 1,
    });
    expect(w.sent('card.stop')).toEqual([]);
    expect((await w.card(a.number)).column).toBe('in_progress');
    const [audit] = await w.audit('stack.run_stopped');
    expect(audit).toMatchObject({
      result: 'ok',
      after: { number: 1, removed: [b.number] },
    });

    await endRound(a);
    expect(await started()).toEqual([a.number]);

    expect((await runStack()).status).toBe(200);
    expect(await started()).toEqual([a.number, b.number]);
  });

  it('resumes a persisted queue after a restart', async () => {
    const [a, b] = await cards(2);
    await staged([a, b], []);
    const row = await w.ctx.prisma.boardStack.findFirstOrThrow();
    await w.ctx.prisma.boardStackRun.create({
      data: {
        stackId: row.id,
        state: 'running',
        startedById: w.operatorId,
        startedByRole: 'operator',
        startedAt: new Date(),
        cards: { create: [{ cardId: a.id }, { cardId: b.id }] },
      },
    });

    await w.ctx.app.get(BoardStackRuns).resumeAll();
    expect(await started()).toEqual([a.number, b.number]);
    expect((await w.card(a.number)).rounds[0].authorId).toBe(w.operatorId);
  });

  it('is refused for viewers and while the stack design is not approved', async () => {
    const [a, b] = await cards(2);
    await staged([a, b], [], true);

    expect((await runStack(1, w.viewer)).status).toBe(403);
    expect((await stopStack(1, w.viewer)).status).toBe(403);
    const gated = await runStack();
    expect(gated.status).toBe(409);
    expect(gated.body.error).toBe(BOARD_ERROR.stackDesignNotApproved);
    expect(w.sent('card.run')).toEqual([]);
    expect((await stack()).run).toBeNull();
    expect((await runStack(9)).status).toBe(404);
  });
});
