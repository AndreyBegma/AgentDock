import { BoardWorld } from './testing/board-e2e';

/**
 * Bulk actions (#452): one action for several cards, each through the path of
 * its single-card action, each outcome reported.
 */
describe('board bulk actions (e2e, #452)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const bulk = (
    numbers: number[],
    action: string,
    session = w.operator,
    extra: object = {},
  ) =>
    session.send('post', `${w.path()}/board/cards/bulk`, {
      numbers,
      action,
      ...extra,
    });

  const post = (number: number, action: string) =>
    w.operator.send('post', `${w.path()}/board/cards/${number}/${action}`, {});

  /**
   * A card run and finished by the person: Finished, with PR #77 — merged into
   * the base unless `open`, since Completed takes only landed work (#709).
   */
  const finished = async ({ open = false } = {}): Promise<number> => {
    const { number } = await w.createCard();
    expect((await w.runCard(number)).status).toBe(200);
    expect((await post(number, 'finish')).status).toBe(200);
    await w.work.settled();
    if (!open) {
      await w.ctx.prisma.boardCard.updateMany({
        where: { projectId: w.a, number },
        data: { prState: 'merged', mergedAt: new Date() },
      });
    }
    return number;
  };

  const running = async (): Promise<number> => {
    const { number } = await w.createCard();
    expect((await w.runCard(number)).status).toBe(200);
    return number;
  };

  const column = async (number: number) => (await w.card(number)).column;

  describe('complete', () => {
    it('moves every Finished card to Completed and leaves the pull requests alone', async () => {
      const a = await finished();
      const b = await finished();
      w.handlers['card.prClose'] = undefined;
      const response = await bulk([a, b], 'complete');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        action: 'complete',
        results: [
          { number: a, status: 'done' },
          { number: b, status: 'done' },
        ],
      });
      expect(await column(a)).toBe('completed');
      expect(await column(b)).toBe('completed');
      // Move only (#273 D14): nothing merged, nothing closed.
      expect(w.sent('card.merge')).toEqual([]);
      expect(w.prCloses()).toEqual([]);
      expect(w.sent('card.close')).toHaveLength(2);
      const moved = await w.audit('card.moved');
      expect(moved.filter((r) => r.result === 'ok').length).toBeGreaterThan(0);
      expect(
        moved.filter(
          (r) =>
            (r.after as { column?: string } | null)?.column === 'completed',
        ),
      ).toHaveLength(2);
    });

    it('skips what it cannot do and still runs the rest', async () => {
      const done = await finished();
      const busy = await running();
      const { number: todo } = await w.createCard();
      const already = await finished();
      expect((await post(already, 'accept')).status).toBe(200);
      const response = await bulk([busy, done, todo, already, 999], 'complete');
      expect(response.status).toBe(200);
      expect(response.body.results).toEqual([
        { number: busy, status: 'skipped', reason: 'wrong_column' },
        { number: done, status: 'done' },
        { number: todo, status: 'skipped', reason: 'wrong_column' },
        { number: already, status: 'skipped', reason: 'already_in_column' },
        { number: 999, status: 'skipped', reason: 'not_found' },
      ]);
      expect(await column(done)).toBe('completed');
      expect(await column(busy)).toBe('in_progress');
    });

    it('leaves a card whose PR has not landed in Finished, as an error naming the PR (#709)', async () => {
      const open = await finished({ open: true });
      const done = await finished();
      const response = await bulk([open, done], 'complete');
      expect(response.body.results).toEqual([
        {
          number: open,
          status: 'error',
          code: 'not_landed',
          message: expect.stringContaining('#77'),
        },
        { number: done, status: 'done' },
      ]);
      expect(await column(open)).toBe('finished');
    });

    it('completes a fleet card, whose one person move is Accept', async () => {
      const number = await finished();
      await w.ctx.prisma.boardCard.updateMany({
        where: { projectId: w.a, number },
        data: { source: 'fleet', fleetSlot: 'i42' },
      });
      const response = await bulk([number], 'complete');
      expect(response.body.results).toEqual([{ number, status: 'done' }]);
    });
  });

  describe('todo', () => {
    it('moves Finished cards back to To Do and Completed ones reopen', async () => {
      const a = await finished();
      const b = await finished();
      expect((await post(b, 'accept')).status).toBe(200);
      const response = await bulk([a, b], 'todo');
      expect(response.body.results).toEqual([
        { number: a, status: 'done' },
        { number: b, status: 'done' },
      ]);
      expect(await w.card(b)).toMatchObject({
        column: 'todo',
        completedAt: null,
      });
    });

    it('skips a running card, a fleet card with a live slot and a card already there', async () => {
      const busy = await running();
      const fleet = await finished();
      await w.ctx.prisma.boardCard.updateMany({
        where: { projectId: w.a, number: fleet },
        data: { source: 'fleet', fleetSlot: 'i42', fleetSlotGone: false },
      });
      const { number: todo } = await w.createCard();
      const response = await bulk([busy, fleet, todo], 'todo');
      expect(response.body.results).toEqual([
        { number: busy, status: 'skipped', reason: 'card_running' },
        { number: fleet, status: 'skipped', reason: 'fleet_slot' },
        { number: todo, status: 'skipped', reason: 'already_in_column' },
      ]);
      expect(w.sent('card.stop')).toEqual([]);
    });
  });

  describe('finished', () => {
    it('marks the running cards finished like the single path, collecting', async () => {
      const a = await running();
      const b = await running();
      const { number: todo } = await w.createCard();
      const response = await bulk([a, todo, b], 'finished');
      expect(response.body.results).toEqual([
        { number: a, status: 'done' },
        { number: todo, status: 'skipped', reason: 'not_running' },
        { number: b, status: 'done' },
      ]);
      await w.work.settled();
      expect(await column(a)).toBe('finished');
      expect(await column(b)).toBe('finished');
      expect(w.sent('card.collect')).toHaveLength(2);
      const rounds = await w.ctx.prisma.boardCardRound.findMany({
        where: { cardId: (await w.card(a)).id },
      });
      expect(rounds).toMatchObject([
        { phase: 'finished', finishedBy: 'person' },
      ]);
    });
  });

  describe('delete', () => {
    it('deletes the cards, skips a running one and never stops it', async () => {
      const gone = await finished();
      const { number: todo } = await w.createCard();
      const busy = await running();
      const response = await bulk([gone, busy, todo], 'delete');
      expect(response.body.results).toEqual([
        { number: gone, status: 'done' },
        { number: busy, status: 'skipped', reason: 'card_running' },
        { number: todo, status: 'done' },
      ]);
      expect(
        await w.ctx.prisma.boardCard.count({ where: { projectId: w.a } }),
      ).toBe(1);
      expect(w.sent('card.stop')).toEqual([]);
      expect(await w.audit('card.deleted')).toHaveLength(2);
    });
  });

  describe('validation and authorization', () => {
    it('rejects an empty list, more than 100 numbers, duplicates, an unknown action and extra fields with 400', async () => {
      const many = Array.from({ length: 101 }, (_, i) => i + 1);
      const hundred = many.slice(0, 100);
      expect((await bulk([], 'delete')).status).toBe(400);
      expect((await bulk(many, 'delete')).status).toBe(400);
      expect((await bulk([1, 1], 'delete')).status).toBe(400);
      expect((await bulk([0], 'delete')).status).toBe(400);
      expect((await bulk([1], 'merge')).status).toBe(400);
      expect(
        (await bulk([1], 'delete', w.operator, { merge: true })).status,
      ).toBe(400);
      const none = await bulk(hundred, 'delete');
      expect(none.status).toBe(200);
      expect(none.body.results).toHaveLength(100);
    });

    it('is 403 for a viewer, 404 for a project the caller cannot see', async () => {
      const { number } = await w.createCard();
      expect((await bulk([number], 'delete', w.viewer)).status).toBe(403);
      expect((await bulk([number], 'delete', w.outsider)).status).toBe(404);
      expect(await column(number)).toBe('todo');
    });
  });
});
