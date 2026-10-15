import type { BoardCardDetail, BoardView } from '@agentdock/shared';
import { BoardWorld } from './testing/board-e2e';

describe('board (e2e)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const board = async (): Promise<BoardView> => {
    const response = await w.operator.get(`${w.path()}/board`);
    expect(response.status).toBe(200);
    return response.body as BoardView;
  };
  const column = (view: BoardView, name: string) =>
    view.columns.find((c) => c.column === name)?.cards.map((c) => c.number);

  const move = (number: number, body: object, session = w.operator) =>
    session.send('post', `${w.path()}/board/cards/${number}/move`, body);

  describe('cards', () => {
    it('creates a card at the top of To Do with the settings as defaults', async () => {
      await w.admin.send('put', `${w.path()}/board-settings`, {
        issueOnRun: true,
        specOnRun: false,
        maxRunning: 3,
      });
      const first = await w.createCard({ title: 'First' });
      const second = await w.createCard({ title: 'Second', kind: 'bug' });
      expect(first.number).toBe(1);
      expect(second.number).toBe(2);

      const detail = (await w.operator.get(`${w.path()}/board/cards/2`))
        .body as BoardCardDetail;
      expect(detail).toMatchObject({
        number: 2,
        label: 'C-2',
        title: 'Second',
        kind: 'bug',
        column: 'todo',
        issueOnRun: true,
        specOnRun: false,
        round: null,
        rounds: [],
        createdBy: { email: 'op@x.test' },
      });
      expect(column(await board(), 'todo')).toEqual([2, 1]);
    });

    it('numbers cards uniquely per project under concurrency', async () => {
      const created = await Promise.all(
        Array.from({ length: 8 }, (_, i) => w.createCard({ title: `C${i}` })),
      );
      expect(created.map((c) => c.number).sort((x, y) => x - y)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      const other = await w.createCard({}, w.operatorOfB, w.b);
      expect(other.number).toBe(1);
    });

    it('edits a card, and clears the model with null', async () => {
      await w.createCard();
      const patched = await w.operator.send(
        'patch',
        `${w.path()}/board/cards/1`,
        { title: 'Renamed', body: 'More.', model: 'sonnet', specOnRun: true },
      );
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        title: 'Renamed',
        body: 'More.',
        model: 'sonnet',
        specOnRun: true,
      });
      const cleared = await w.operator.send(
        'patch',
        `${w.path()}/board/cards/1`,
        { model: null },
      );
      expect((cleared.body as BoardCardDetail).model).toBeNull();
    });

    it('refuses a blank title and an unknown field', async () => {
      for (const body of [{ title: '  ' }, { title: 'x', column: 'done' }]) {
        const response = await w.operator.send(
          'post',
          `${w.path()}/board/cards`,
          body,
        );
        expect(response.status).toBe(400);
      }
    });

    it('is 404 for an unknown or malformed card number', async () => {
      for (const n of ['9', 'abc', '0']) {
        const response = await w.operator.get(`${w.path()}/board/cards/${n}`);
        expect(response.status).toBe(404);
        expect(response.body.error).toBe('not_found');
      }
    });

    it('deletes a card, and refuses while its worker runs', async () => {
      await w.createCard();
      await w.createCard();
      expect((await w.runCard(2)).status).toBe(200);
      const running = await w.operator.send(
        'delete',
        `${w.path()}/board/cards/2`,
      );
      expect(running.status).toBe(409);
      expect(running.body.error).toBe('card_running');

      const deleted = await w.operator.send(
        'delete',
        `${w.path()}/board/cards/1`,
      );
      expect(deleted.status).toBe(204);
      expect(column(await board(), 'todo')).toEqual([]);

      // A card that ran takes its worktree with it.
      await w.operator.send('post', `${w.path()}/board/cards/2/stop`);
      await w.operator.send('delete', `${w.path()}/board/cards/2`);
      await w.work.settled();
      expect(w.sent('card.close')).toEqual([
        expect.objectContaining({ removeWorktree: true }),
      ]);
    });

    it('shows when a drawing card design started (#275 D8)', async () => {
      const drawing = await w.createCard({ title: 'Drawing' });
      const resting = await w.createCard({ title: 'Resting' });
      const since = new Date('2026-10-15T09:00:00.000Z');
      await w.ctx.prisma.taskDesign.createMany({
        data: [
          {
            cardId: drawing.id,
            needed: true,
            status: 'generating',
            busySince: since,
          },
          { cardId: resting.id, needed: true, status: 'reviewing' },
        ],
      });
      const cards = (await board()).columns.flatMap((c) => c.cards);
      expect(cards.find((c) => c.number === drawing.number)?.design).toEqual(
        expect.objectContaining({
          status: 'generating',
          busySince: since.toISOString(),
        }),
      );
      expect(
        cards.find((c) => c.number === resting.number)?.design?.busySince,
      ).toBeNull();
    });
  });

  describe('moves', () => {
    beforeEach(async () => {
      // To Do top to bottom: 3, 2, 1.
      for (const title of ['One', 'Two', 'Three'])
        await w.createCard({ title });
    });

    it('reorders within a column by the index among the other cards', async () => {
      // The first of three to index 2 → last.
      expect((await move(3, { column: 'todo', index: 2 })).status).toBe(200);
      expect(column(await board(), 'todo')).toEqual([2, 1, 3]);
      // And back up: the last to index 0 → first.
      await move(3, { column: 'todo', index: 0 });
      expect(column(await board(), 'todo')).toEqual([3, 2, 1]);
      // The middle one: index 1 among the others (3, 1) keeps it in place…
      await move(2, { column: 'todo', index: 1 });
      expect(column(await board(), 'todo')).toEqual([3, 2, 1]);
      // …and index 2 moves it down by one.
      await move(2, { column: 'todo', index: 2 });
      expect(column(await board(), 'todo')).toEqual([3, 1, 2]);
    });

    it('moves between columns at the drop index', async () => {
      await move(1, { column: 'finished', index: 0 });
      await move(2, { column: 'finished', index: 1 });
      await move(3, { column: 'finished', index: 1 });
      expect(column(await board(), 'finished')).toEqual([1, 3, 2]);
      expect(column(await board(), 'todo')).toEqual([]);
    });

    it('rebalances a column whose neighbours are too close', async () => {
      const ids = await w.ctx.prisma.boardCard.findMany({
        orderBy: { number: 'asc' },
      });
      await w.ctx.prisma.boardCard.update({
        where: { id: ids[0].id },
        data: { position: 1 },
      });
      await w.ctx.prisma.boardCard.update({
        where: { id: ids[1].id },
        data: { position: 1 + Number.EPSILON },
      });
      // Between 1 and 2 (positions 1 and 1+ε) there is no double.
      await move(3, { column: 'todo', index: 1 });
      expect(column(await board(), 'todo')).toEqual([1, 3, 2]);
    });

    it('a drag never starts a worker', async () => {
      await move(1, { column: 'in_progress', index: 0 });
      expect(w.sent('card.run')).toEqual([]);
      expect((await w.card(1)).rounds).toEqual([]);
    });

    it('refuses a move out of In progress while a round is active, except to Finished or with stopWorker', async () => {
      await w.runCard(1);
      const refused = await move(1, { column: 'todo', index: 0 });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('card_running');

      const stopped = await move(1, {
        column: 'todo',
        index: 0,
        stopWorker: true,
      });
      expect(stopped.status).toBe(200);
      expect(w.sent('card.stop')).toHaveLength(1);
      const card = await w.card(1);
      expect(card.column).toBe('todo');
      expect(card.rounds[0].phase).toBe('cancelled');
      expect((await w.audit('card.stopped')).length).toBe(1);
    });

    it('dragging a running card to Finished marks it finished by the person and collects', async () => {
      await w.runCard(1);
      expect((await move(1, { column: 'finished', index: 0 })).status).toBe(
        200,
      );
      await w.work.settled();
      const card = await w.card(1);
      expect(card.rounds[0]).toMatchObject({
        phase: 'finished',
        finishedBy: 'person',
      });
      expect(w.sent('card.collect')).toHaveLength(1);
      expect(card).toMatchObject({ prNumber: 77 });
    });
  });

  describe('accept', () => {
    it('Accept completes a Finished card and closes its worker', async () => {
      await w.createCard();
      await w.runCard(1);
      await w.operator.send('post', `${w.path()}/board/cards/1/finish`);
      const accepted = await w.operator.send(
        'post',
        `${w.path()}/board/cards/1/accept`,
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({
        column: 'completed',
        completedBy: { email: 'op@x.test' },
      });
      await w.work.settled();
      expect(w.sent('card.close')).toEqual([
        expect.objectContaining({ removeWorktree: true }),
      ]);
      const view = await board();
      expect(column(view, 'completed')).toEqual([1]);
    });

    it('refuses Accept outside Finished', async () => {
      await w.createCard();
      const response = await w.operator.send(
        'post',
        `${w.path()}/board/cards/1/accept`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('wrong_column');
    });

    it('nothing automatic reaches Completed, and a late event never pulls a completed card back', async () => {
      await w.createCard();
      await w.runCard(1);
      const card = await w.card(1);
      const round = card.rounds[0];
      await w.deliver('card_run.phase_changed', {
        cardId: card.id,
        runId: round.runId,
        projectId: w.a,
        phase: 'ended',
        at: new Date().toISOString(),
        exitCode: 0,
      });
      await w.work.settled();
      expect((await w.card(1)).column).toBe('finished');

      await w.operator.send('post', `${w.path()}/board/cards/1/accept`);
      await w.deliver('card_run.phase_changed', {
        cardId: card.id,
        runId: round.runId,
        projectId: w.a,
        phase: 'ended',
        at: new Date().toISOString(),
      });
      expect((await w.card(1)).column).toBe('completed');
    });

    it('reopens a completed card a person moves back', async () => {
      await w.createCard();
      await move(1, { column: 'finished', index: 0 });
      await w.operator.send('post', `${w.path()}/board/cards/1/accept`);
      await move(1, { column: 'todo', index: 0 });
      const card = await w.card(1);
      expect(card).toMatchObject({
        column: 'todo',
        completedAt: null,
        completedById: null,
      });
    });

    it('pages Completed newest first', async () => {
      for (let i = 0; i < 3; i += 1) {
        await w.createCard();
        await move(i + 1, { column: 'finished', index: 0 });
        await w.operator.send(
          'post',
          `${w.path()}/board/cards/${i + 1}/accept`,
        );
      }
      const all = await board();
      expect(column(all, 'completed')).toEqual([3, 2, 1]);
      const before = all.columns.find((c) => c.column === 'completed')?.cards[1]
        .completedAt;
      const page = (
        await w.operator.get(
          `${w.path()}/board?completedBefore=${encodeURIComponent(before ?? '')}`,
        )
      ).body as BoardView;
      expect(column(page, 'completed')).toEqual([1]);
    });
  });

  it('writes every D16 audit action', async () => {
    await w.createCard();
    await w.operator.send('patch', `${w.path()}/board/cards/1`, {
      title: 'Renamed',
    });
    await move(1, { column: 'todo', index: 0 });
    await w.runCard(1);
    await w.operator.send('post', `${w.path()}/board/cards/1/stop`);
    await w.runCard(1);
    await w.operator.send('post', `${w.path()}/board/cards/1/finish`);
    await w.operator.send('post', `${w.path()}/board/cards/1/feedback`, {
      text: 'Rename the button.',
    });
    await w.operator.send('post', `${w.path()}/board/cards/1/finish`);
    await w.operator.send('post', `${w.path()}/board/cards/1/accept`);
    await w.admin.send('put', `${w.path()}/board-settings`, {
      issueOnRun: false,
      specOnRun: false,
      maxRunning: 5,
    });
    await w.createCard();
    await w.operator.send('delete', `${w.path()}/board/cards/2`);

    for (const action of [
      'card.created',
      'card.updated',
      'card.deleted',
      'card.moved',
      'card.run_started',
      'card.feedback',
      'card.finished',
      'card.accepted',
      'card.stopped',
      'board.settings_updated',
    ]) {
      const records = await w.audit(action);
      expect({ action, written: records.length > 0 }).toEqual({
        action,
        written: true,
      });
      expect(records.every((r) => r.result === 'ok')).toBe(true);
    }
  });
});
