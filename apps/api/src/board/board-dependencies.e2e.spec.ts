import {
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardView,
  type CardDependenciesView,
} from '@agentdock/shared';
import { BoardWorld } from './testing/board-e2e';

/** #337 D8: a card's Depends-on links, and Run's warning about an open one. */
describe('card dependencies (e2e, #337)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const cardPath = (number: number) => `${w.path()}/board/cards/${number}`;
  const deps = (number: number) => `${cardPath(number)}/dependencies`;
  const link = (number: number, dependsOn: number, session = w.operator) =>
    session.send('post', deps(number), { dependsOn });

  it('links, lists with columns, shows on the face, and unlinks', async () => {
    const a = await w.createCard({ title: 'A' });
    const b = await w.createCard({ title: 'B' });
    const c = await w.createCard({ title: 'C' });

    const added = await link(c.number, a.number);
    expect(added.status).toBe(200);
    await link(c.number, b.number);
    // An existing link stays as it is.
    expect((await link(c.number, a.number)).status).toBe(200);
    expect(await w.ctx.prisma.boardCardDependency.count()).toBe(2);

    const listed = (await w.viewer.get(deps(c.number)))
      .body as CardDependenciesView;
    expect(listed.dependsOn).toEqual([
      { number: a.number, label: `C-${a.number}`, column: 'todo', title: 'A' },
      { number: b.number, label: `C-${b.number}`, column: 'todo', title: 'B' },
    ]);

    const board = (await w.viewer.get(`${w.path()}/board`)).body as BoardView;
    const face = board.columns
      .flatMap((col) => col.cards)
      .find((card) => card.number === c.number);
    expect(face?.dependsOn?.map((d) => d.number)).toEqual([a.number, b.number]);
    expect(face?.planId).toBeNull();
    const detail = (await w.viewer.get(`${w.path()}/board/cards/${c.number}`))
      .body as BoardCardDetail;
    expect(detail.dependsOn).toHaveLength(2);

    const removed = await w.operator.send(
      'delete',
      `${deps(c.number)}/${a.number}`,
    );
    expect(removed.status).toBe(200);
    expect((removed.body as CardDependenciesView).dependsOn).toEqual([
      expect.objectContaining({ number: b.number }),
    ]);
    expect(await w.audit('card.updated')).toHaveLength(3);
  });

  it('refuses a cycle on insert, naming it', async () => {
    const a = await w.createCard({ title: 'A' });
    const b = await w.createCard({ title: 'B' });
    const c = await w.createCard({ title: 'C' });
    await link(b.number, a.number);
    await link(c.number, b.number);

    const cycle = await link(a.number, c.number);
    expect(cycle.status).toBe(409);
    expect(cycle.body.error).toBe(BOARD_ERROR.dependencyCycle);
    expect(cycle.body.message).toContain(`C-${a.number}`);
    expect(await w.ctx.prisma.boardCardDependency.count()).toBe(2);
  });

  it('refuses itself, a missing number, and a card of another project (400)', async () => {
    const a = await w.createCard();
    const other = await w.createCard({}, w.operatorOfB, w.b);

    for (const target of [a.number, 999, other.number + 50]) {
      const response = await link(a.number, target);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(BOARD_ERROR.invalidDependency);
    }
    // Project B's card 1 is not project A's card: A has its own numbering, so
    // naming a number A lacks is refused, and B's row is never linked.
    const crossNumber = other.number === a.number ? 999_999 : other.number;
    expect((await link(a.number, crossNumber)).status).toBe(400);
    expect(await w.ctx.prisma.boardCardDependency.count()).toBe(0);
  });

  it('Run answers 409 dependency_open while a dependency is open, with no override (#638)', async () => {
    const a = await w.createCard({ title: 'A', specOnRun: false });
    const b = await w.createCard({ title: 'B', specOnRun: false });
    await link(b.number, a.number);

    const refused = await w.runCard(b.number);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(BOARD_ERROR.dependencyOpen);
    expect(refused.body.dependencies).toEqual([
      { number: a.number, label: `C-${a.number}`, column: 'todo' },
    ]);
    expect(refused.body.message).toContain(`C-${a.number}`);

    // The override is gone: the field is no part of the Run any more.
    const forced = await w.runCard(b.number, { ignoreDependencies: true });
    expect(forced.status).toBe(400);
    expect(w.sent('card.run')).toHaveLength(0);
  });

  it('Run refuses while a dependency is In progress, and runs once it is Finished (#638)', async () => {
    const a = await w.createCard({ title: 'A', specOnRun: false });
    const b = await w.createCard({ title: 'B', specOnRun: false });
    await link(b.number, a.number);
    expect((await w.runCard(a.number)).status).toBe(200);

    const running = await w.runCard(b.number);
    expect(running.status).toBe(409);
    expect(running.body.dependencies).toEqual([
      { number: a.number, label: `C-${a.number}`, column: 'in_progress' },
    ]);

    await w.operator.send('post', `${cardPath(a.number)}/finish`);
    expect((await w.card(a.number)).column).toBe('finished');
    expect((await w.runCard(b.number)).status).toBe(200);
  });

  it('a Finished dependency sent back with feedback holds Run again (#638)', async () => {
    const a = await w.createCard({ title: 'A', specOnRun: false });
    const b = await w.createCard({ title: 'B', specOnRun: false });
    await link(b.number, a.number);
    await w.runCard(a.number);
    await w.operator.send('post', `${cardPath(a.number)}/finish`);
    const back = await w.operator.send(
      'post',
      `${cardPath(a.number)}/feedback`,
      { text: 'Rename the button.' },
    );
    expect(back.status).toBe(200);
    expect((await w.card(a.number)).column).toBe('in_progress');

    const refused = await w.runCard(b.number);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(BOARD_ERROR.dependencyOpen);
  });

  it('Run is not refused once the dependency is completed', async () => {
    const a = await w.createCard({ title: 'A', specOnRun: false });
    const b = await w.createCard({ title: 'B', specOnRun: false });
    await link(b.number, a.number);
    await w.ctx.prisma.boardCard.update({
      where: { id: a.id },
      data: { column: 'completed', completedAt: new Date() },
    });
    expect((await w.runCard(b.number)).status).toBe(200);
  });

  it('a viewer reads dependencies but gets 403 editing them', async () => {
    const a = await w.createCard();
    const b = await w.createCard();
    expect((await w.viewer.get(deps(b.number))).status).toBe(200);
    expect((await link(b.number, a.number, w.viewer)).status).toBe(403);
    expect(
      (await w.viewer.send('delete', `${deps(b.number)}/${a.number}`)).status,
    ).toBe(403);
    // An operator of another project does not see this one.
    expect((await link(b.number, a.number, w.operatorOfB)).status).toBe(404);
  });
});
