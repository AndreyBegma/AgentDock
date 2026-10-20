import {
  BOARD_ERROR,
  type BoardStackDetail,
  type BoardView,
} from '@nautelle/shared';
import { BoardWorld } from './testing/board-e2e';

/**
 * #588 (docs/specs/588-let-users-group-board-cards-into-a-manua.md,
 * ADR-0044): a person groups cards of the Board into a stack by hand — one
 * stage, no dependencies between its cards, a shared design only when asked.
 */
describe('manual stacks (e2e, #588)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const stacks = (projectId = w.a) => `${w.path(projectId)}/board/stacks`;
  const group = (body: object, session = w.operator) =>
    session.send('post', stacks(), body);

  const cards = async (count: number) => {
    const made: { id: string; number: number }[] = [];
    for (let i = 0; i < count; i += 1) {
      made.push(
        await w.createCard({ title: `Security ${i + 1}`, specOnRun: false }),
      );
    }
    return made;
  };

  it('groups cards into one stage with no dependencies; each card still runs on its own', async () => {
    const [a, b, c] = await cards(3);
    const response = await group({
      title: '  Security hardening ',
      cards: [a.number, b.number, c.number],
    });
    expect(response.status).toBe(201);
    const detail = response.body as BoardStackDetail;
    expect(detail).toMatchObject({
      label: 'S-1',
      title: 'Security hardening',
      body: '',
      planId: null,
      design: null,
      total: 3,
      accepted: 0,
      currentStage: 0,
    });
    expect(detail.stages).toHaveLength(1);
    expect(
      detail.stages[0].cards.map((x) => [x.number, x.after]).sort(),
    ).toEqual([
      [a.number, []],
      [b.number, []],
      [c.number, []],
    ]);
    expect(await w.ctx.prisma.boardCardDependency.count()).toBe(0);

    const board = (await w.viewer.get(`${w.path()}/board`)).body as BoardView;
    expect(board.stacks).toEqual([
      expect.objectContaining({ label: 'S-1', column: 'todo', total: 3 }),
    ]);

    const [audit] = await w.audit('stack.created');
    expect(audit.after).toMatchObject({
      number: 1,
      stages: 1,
      cards: [a.number, b.number, c.number],
      design: false,
      planId: null,
    });

    expect((await w.runCard(b.number)).status).toBe(200);
  });

  it('a shared design is made only when asked, and then holds Run until it is approved', async () => {
    const [a, b] = await cards(2);
    const response = await group({
      title: 'Security hardening',
      body: 'Close the audit gaps.',
      design: true,
      cards: [a.number, b.number],
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      body: 'Close the audit gaps.',
      design: { needed: true },
    });
    const refused = await w.runCard(a.number);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(BOARD_ERROR.stackDesignNotApproved);
    expect(w.sent('card.run')).toHaveLength(0);
  });

  it('refuses the whole request for an Inbox card, a card in a stack or one the project lacks, and makes nothing', async () => {
    const [a, b, c, d] = await cards(4);
    await w.ctx.prisma.boardCard.update({
      where: { id: c.id },
      data: { column: 'inbox' },
    });
    expect(
      (await group({ title: 'First', cards: [a.number, d.number] })).status,
    ).toBe(201);
    const other = await w.createCard({}, w.operatorOfB, w.b);
    const foreign = Math.max(other.number, d.number) + 100;

    for (const [bad, message] of [
      [c.number, 'is a suggestion'],
      [d.number, 'is in S-1 already'],
      [foreign, 'is not a card of this project'],
    ] as const) {
      const response = await group({ title: 'Second', cards: [b.number, bad] });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe(BOARD_ERROR.stackRefused);
      expect(response.body.cards).toEqual([bad]);
      expect(response.body.message).toContain(`C-${bad} ${message}`);
    }
    expect(await w.ctx.prisma.boardStack.count()).toBe(1);
    expect(await w.ctx.prisma.boardStackStage.count()).toBe(1);
    expect((await w.card(b.number)).stageId).toBeNull();
    expect(await w.audit('stack.created')).toHaveLength(1);
  });

  it('a card joins and leaves the single stage later without dependencies', async () => {
    const [a, b, c] = await cards(3);
    await group({ title: 'Security hardening', cards: [a.number, b.number] });

    const added = await w.operator.send('post', `${stacks()}/1/cards`, {
      card: c.number,
      stage: 0,
    });
    expect(added.status).toBe(201);
    const detail = added.body as BoardStackDetail;
    expect(detail.stages).toHaveLength(1);
    expect(detail.stages[0].cards.map((x) => x.number).sort()).toEqual([
      a.number,
      b.number,
      c.number,
    ]);

    const removed = await w.operator.send(
      'delete',
      `${stacks()}/1/cards/${a.number}`,
    );
    expect(removed.status).toBe(200);
    expect(
      (removed.body as BoardStackDetail).stages[0].cards
        .map((x) => x.number)
        .sort(),
    ).toEqual([b.number, c.number]);
    expect(await w.ctx.prisma.boardCardDependency.count()).toBe(0);
  });

  it('validates the request and is for operators only', async () => {
    const [a, b] = await cards(2);
    const both = [a.number, b.number];
    expect((await group({ title: 'One', cards: [a.number] })).status).toBe(400);
    expect((await group({ title: '   ', cards: both })).status).toBe(400);
    expect(
      (await group({ title: 'Dup', cards: [a.number, a.number] })).status,
    ).toBe(400);
    expect((await group({ title: 'X', cards: both }, w.viewer)).status).toBe(
      403,
    );
    expect(await w.ctx.prisma.boardStack.count()).toBe(0);
  });
});
