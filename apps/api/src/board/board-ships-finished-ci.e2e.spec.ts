import { BoardShipping } from './board-shipping';
import { BoardWorld, cardChecks, ok } from './testing/board-e2e';

const PENDING = {
  checks: [{ name: 'ci/check', bucket: 'pending', link: null }],
};
const RED = {
  checks: [
    { name: 'ci/check', bucket: 'fail', link: 'https://ci.example/9' },
    { name: 'lint', bucket: 'pass', link: null },
  ],
};

/**
 * #894: auto-merge follows the PR's CI, not the moment the round finished —
 * a card that entered Finished while its checks were still running is
 * merged, or fixed, when the poller reads them settle.
 */
describe('a Finished card whose CI settles later (e2e, #894)', () => {
  const w = new BoardWorld();
  let shipping: BoardShipping;

  beforeAll(async () => {
    await w.init();
    shipping = w.ctx.app.get(BoardShipping);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    w.checksServed = true;
  });
  afterEach(() => w.work.settled());

  const checksAnswer = (extra: Record<string, unknown>) => {
    w.handlers['card.checks'] = () => ok(cardChecks(extra));
  };

  /**
   * C-1 ran, its worker is done and its checks are `ciState`: the card sits
   * in Finished as a person (or a lost race) leaves it, unmerged.
   */
  const finishedWhile = async (ciState: 'pending' | 'none') => {
    checksAnswer(PENDING);
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    const { rounds } = await w.card(1);
    await w.ctx.prisma.boardCardRound.update({
      where: { id: rounds[rounds.length - 1].id },
      data: { startedAt: new Date(Date.now() - 60_000) },
    });
    const card = await w.card(1);
    await w.deliver('card_run.phase_changed', {
      cardId: card.id,
      runId: rounds[rounds.length - 1].runId,
      projectId: card.projectId,
      at: new Date().toISOString(),
      phase: 'ended',
      exitCode: 0,
    });
    await w.work.settled();
    await w.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: { column: 'finished', ciState },
    });
    expect(w.sent('card.merge')).toEqual([]);
  };

  const setAutoMerge = async (autoMergeCards: boolean | null) => {
    const response = await w.admin.send('put', `${w.path()}/board-settings`, {
      issueOnRun: false,
      specOnRun: true,
      maxRunning: 3,
      autoMergeCards,
    });
    expect(response.status).toBe(200);
  };

  it.each([
    'pending',
    'none',
  ] as const)('merges a card that finished with CI %s once the poller reads it green', async (ciState) => {
    await finishedWhile(ciState);
    await shipping.poll();
    await w.work.settled();
    expect(w.sent('card.merge')).toEqual([]);

    checksAnswer({});
    await shipping.poll();
    await w.work.settled();
    const [merge] = w.sent('card.merge');
    expect(merge).toMatchObject({ pr: 77, deleteBranch: true });
    expect(await w.card(1)).toMatchObject({
      column: 'finished',
      ciState: 'green',
    });
    expect((await w.card(1)).mergedAt).not.toBeNull();
  });

  it('attempts a merge a PR refuses once per head, not on every poll', async () => {
    await finishedWhile('pending');
    w.handlers['card.merge'] = () =>
      ok({
        merged: false,
        error: 'not_mergeable',
        message: 'The branch is behind its base',
      });
    checksAnswer({});
    await shipping.poll();
    await shipping.poll();
    await w.work.settled();
    expect(w.sent('card.merge')).toHaveLength(1);
    expect((await w.card(1)).mergedAt).toBeNull();
  });

  it('does not merge a PR that conflicts with its base', async () => {
    await finishedWhile('pending');
    checksAnswer({ mergeable: 'CONFLICTING' });
    await shipping.poll();
    await w.work.settled();
    expect(w.sent('card.merge')).toEqual([]);
  });

  it('starts the ci_fix round of a card that finished pending and went red', async () => {
    await finishedWhile('pending');
    checksAnswer(RED);
    await shipping.poll();
    await w.work.settled();
    const card = await w.card(1);
    expect(card).toMatchObject({
      column: 'in_progress',
      ciState: 'red',
      ciFixAttempts: 1,
    });
    expect(card.rounds).toHaveLength(2);
    expect(card.rounds[1]).toMatchObject({ trigger: 'ci_fix' });
    expect(w.sent('card.merge')).toEqual([]);
  });

  it('does not merge when auto-merge is off', async () => {
    await setAutoMerge(false);
    await finishedWhile('pending');
    checksAnswer({});
    await shipping.poll();
    await w.work.settled();
    expect(w.sent('card.merge')).toEqual([]);
    expect((await w.card(1)).mergedAt).toBeNull();
  });

  it('does not merge a card that needs a person or changed a protected path', async () => {
    await finishedWhile('pending');
    await w.ctx.prisma.boardCard.updateMany({
      data: { protectedPaths: ['.woodpecker/pipeline.yml'] },
    });
    checksAnswer({});
    await shipping.poll();
    await w.work.settled();
    expect(w.sent('card.merge')).toEqual([]);

    await w.ctx.prisma.boardCard.updateMany({
      data: {
        protectedPaths: [],
        needsPerson: true,
        needsPersonReason: 'ci_not_green',
      },
    });
    await shipping.poll();
    await w.work.settled();
    expect(w.sent('card.merge')).toEqual([]);
  });
});
