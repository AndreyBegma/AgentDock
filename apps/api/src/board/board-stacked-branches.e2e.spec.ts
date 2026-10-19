import {
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardStackDetail,
} from '@agentdock/shared';
import { BoardShipping } from './board-shipping';
import { BoardWorld, HEAD_SHA, ok } from './testing/board-e2e';

/**
 * #636 (docs/specs/636-branch-a-dependent-card-from-its-depende.md,
 * ADR-0063): a card with one unmerged dependency that has an open PR is cut
 * from that dependency's branch and opens a stacked PR into it; merging the
 * dependency retargets the stacked PR onto the project base through
 * `card.prRetarget`.
 */
describe('stacked card branches (e2e, #636)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** The seeded project's base. */
  const BASE = 'develop';
  const C1_BRANCH = 'feat/1-the-dependency';
  /** The `card.collect` answer of C-2's stacked PR. */
  const PR_78 = {
    ahead: 1,
    pushed: true,
    prNumber: 78,
    prUrl: 'https://github.com/acme/widget/pull/78',
  };

  const link = (number: number, dependsOn: number) =>
    w.operator.send('post', `${w.path()}/board/cards/${number}/dependencies`, {
      dependsOn,
    });

  const detail = async (number: number) =>
    (await w.viewer.get(`${w.path()}/board/cards/${number}`))
      .body as BoardCardDetail;

  /** The base of the latest `card.run` sent. */
  const runBase = () => w.sent('card.run').at(-1)?.base;

  /** A card that has run and has an open PR on `branch`, its round over. */
  const withOpenPr = async (
    title: string,
    branch: string,
    pr: number,
    extra: object = {},
  ) => {
    const card = await w.createCard({ title, specOnRun: false });
    await w.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        column: 'finished',
        branch,
        prNumber: pr,
        prUrl: `https://github.com/acme/widget/pull/${pr}`,
        prState: 'open',
        ...extra,
      },
    });
    return card;
  };

  it('a card without dependencies branches from and targets the project base', async () => {
    const card = await w.createCard({ specOnRun: false });
    expect((await w.runCard(card.number)).status).toBe(200);
    expect(runBase()).toBe(BASE);
    expect(await w.card(card.number)).toMatchObject({
      prBase: null,
      prBaseCardId: null,
    });
    expect((await detail(card.number)).prTarget).toEqual({
      branch: BASE,
      stackedOn: null,
    });
  });

  it('C-2 after C-1 with an open PR is cut from C-1’s branch and its PR goes into it', async () => {
    const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
    const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
    await link(c2.number, c1.number);

    const response = await w.runCard(c2.number);
    expect(response.status).toBe(200);
    expect(runBase()).toBe(C1_BRANCH);
    expect(await w.card(c2.number)).toMatchObject({
      prBase: C1_BRANCH,
      prBaseCardId: c1.id,
    });
    expect((response.body as BoardCardDetail).prTarget).toEqual({
      branch: C1_BRANCH,
      stackedOn: { number: c1.number, label: `C-${c1.number}` },
    });

    // The round's collect opens the PR into C-1's branch too.
    expect(
      (
        await w.operator.send(
          'post',
          `${w.path()}/board/cards/${c2.number}/finish`,
        )
      ).status,
    ).toBe(200);
    await w.work.settled();
    expect(w.sent('card.collect').at(-1)).toMatchObject({ base: C1_BRANCH });
  });

  it('a dependency that merged, or was accepted with no open PR, leaves the project base', async () => {
    const merged = await withOpenPr('Merged', C1_BRANCH, 77, {
      prState: 'merged',
      mergedAt: new Date(),
    });
    const accepted = await w.createCard({
      title: 'Accepted',
      specOnRun: false,
    });
    await w.ctx.prisma.boardCard.update({
      where: { id: accepted.id },
      data: { column: 'completed', completedAt: new Date() },
    });
    const card = await w.createCard({ title: 'After both', specOnRun: false });
    await link(card.number, merged.number);
    await link(card.number, accepted.number);

    expect((await w.runCard(card.number)).status).toBe(200);
    expect(runBase()).toBe(BASE);
    expect((await w.card(card.number)).prBase).toBeNull();
  });

  it('two unmerged dependencies refuse Run with dependencies_unmerged; ignoreDependencies starts from the base', async () => {
    const a = await withOpenPr('A', 'feat/1-a', 77);
    const b = await withOpenPr('B', 'feat/2-b', 78);
    const card = await w.createCard({
      title: 'After A and B',
      specOnRun: false,
    });
    await link(card.number, a.number);
    await link(card.number, b.number);

    const refused = await w.runCard(card.number);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(BOARD_ERROR.dependenciesUnmerged);
    expect(refused.body.dependencies).toEqual([
      { number: a.number, label: `C-${a.number}`, column: 'finished' },
      { number: b.number, label: `C-${b.number}`, column: 'finished' },
    ]);
    expect(w.sent('card.run')).toHaveLength(0);

    const forced = await w.runCard(card.number, { ignoreDependencies: true });
    expect(forced.status).toBe(200);
    expect(runBase()).toBe(BASE);
    expect((await w.card(card.number)).prBase).toBeNull();
  });

  it('two dependencies, once both merged, start the card from the base', async () => {
    const a = await withOpenPr('A', 'feat/1-a', 77, {
      prState: 'merged',
      mergedAt: new Date(),
    });
    const b = await withOpenPr('B', 'feat/2-b', 78, {
      prState: 'merged',
      mergedAt: new Date(),
    });
    const card = await w.createCard({
      title: 'After A and B',
      specOnRun: false,
    });
    await link(card.number, a.number);
    await link(card.number, b.number);
    expect((await w.runCard(card.number)).status).toBe(200);
    expect(runBase()).toBe(BASE);
  });

  it('a single dependency with no pushed branch or PR, or a round still running, is not ready', async () => {
    const todo = await w.createCard({ title: 'Not run', specOnRun: false });
    const card = await w.createCard({ title: 'Dependant', specOnRun: false });
    await link(card.number, todo.number);
    const refused = await w.runCard(card.number);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(BOARD_ERROR.dependencyOpen);

    // An open PR whose round is still working is not built on either.
    await w.ctx.prisma.boardCard.update({
      where: { id: todo.id },
      data: { branch: C1_BRANCH, prNumber: 77, prState: 'open' },
    });
    expect(
      (await w.runCard(todo.number, { ignoreDependencies: true })).status,
    ).toBe(200);
    const running = await w.runCard(card.number);
    expect(running.status).toBe(409);
    expect(running.body.error).toBe(BOARD_ERROR.dependencyOpen);
  });

  it('merging C-1 retargets C-2’s stacked PR onto the base and clears its stored base', async () => {
    const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
    const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
    await link(c2.number, c1.number);
    expect((await w.runCard(c2.number)).status).toBe(200);
    w.handlers['card.collect'] = () => ok(PR_78);
    expect(
      (
        await w.operator.send(
          'post',
          `${w.path()}/board/cards/${c2.number}/finish`,
        )
      ).status,
    ).toBe(200);
    await w.work.settled();

    const accepted = await w.operator.send(
      'post',
      `${w.path()}/board/cards/${c1.number}/accept`,
      { merge: { headSha: HEAD_SHA } },
    );
    expect(accepted.status).toBe(200);
    expect(w.prRetargets()).toEqual([
      {
        cardId: c2.id,
        projectId: w.a,
        root: '/srv/dev/widget',
        pr: 78,
        base: BASE,
      },
    ]);
    expect(await w.card(c2.number)).toMatchObject({
      prBase: null,
      prBaseCardId: null,
    });
    expect((await detail(c2.number)).prTarget).toEqual({
      branch: BASE,
      stackedOn: null,
    });
    const [audit] = await w.audit('card.pr_retargeted');
    expect(audit.after).toEqual({
      number: c2.number,
      pr: 78,
      from: C1_BRANCH,
      base: BASE,
      dependency: c1.number,
    });

    // C-2's next round starts from the updated base.
    await w.ctx.prisma.boardCard.update({
      where: { id: c2.id },
      data: { column: 'todo' },
    });
    expect((await w.runCard(c2.number)).status).toBe(200);
    expect(runBase()).toBe(BASE);
  });

  it('a retarget the runner could not do keeps the card stacked, and the PR poll tries again', async () => {
    w.checksServed = true;
    const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
    const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
    await link(c2.number, c1.number);
    expect((await w.runCard(c2.number)).status).toBe(200);
    w.handlers['card.collect'] = () => ok(PR_78);
    expect(
      (
        await w.operator.send(
          'post',
          `${w.path()}/board/cards/${c2.number}/finish`,
        )
      ).status,
    ).toBe(200);
    await w.work.settled();

    w.handlers['card.prRetarget'] = () =>
      ok({ retargeted: false, error: 'gh_failed', message: 'HTTP 502' });
    await w.work.markMerged(c1.id, 77);
    expect(w.prRetargets()).toHaveLength(1);
    expect((await w.card(c2.number)).prBase).toBe(C1_BRANCH);
    expect(await w.audit('card.pr_retargeted')).toHaveLength(0);

    w.handlers['card.prRetarget'] = undefined;
    await w.ctx.app.get(BoardShipping).poll();
    expect(w.prRetargets()).toHaveLength(2);
    expect((await w.card(c2.number)).prBase).toBeNull();
    expect(await w.audit('card.pr_retargeted')).toHaveLength(1);
  });

  it('a stacked card without a PR, its round over, just goes back to the base', async () => {
    const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
    const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
    await link(c2.number, c1.number);
    expect((await w.runCard(c2.number)).status).toBe(200);
    w.handlers['card.collect'] = () => ok({ ahead: 0, pushed: false });
    expect(
      (
        await w.operator.send(
          'post',
          `${w.path()}/board/cards/${c2.number}/finish`,
        )
      ).status,
    ).toBe(200);
    await w.work.settled();

    await w.work.markMerged(c1.id, 77);
    expect(w.prRetargets()).toHaveLength(0);
    expect((await w.card(c2.number)).prBase).toBeNull();
  });

  it('the stack page shows which branch each card’s PR targets', async () => {
    const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
    const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
    const grouped = await w.operator.send('post', `${w.path()}/board/stacks`, {
      title: 'Stack',
      cards: [c1.number, c2.number],
    });
    expect(grouped.status).toBe(201);
    await link(c2.number, c1.number);
    expect((await w.runCard(c2.number)).status).toBe(200);

    const stack = (await w.viewer.get(`${w.path()}/board/stacks/1`))
      .body as BoardStackDetail;
    const byNumber = new Map(
      stack.stages.flatMap((s) => s.cards).map((c) => [c.number, c]),
    );
    expect(byNumber.get(c1.number)).toMatchObject({
      prNumber: 77,
      prTarget: { branch: BASE, stackedOn: null },
    });
    expect(byNumber.get(c2.number)?.prTarget).toEqual({
      branch: C1_BRANCH,
      stackedOn: { number: c1.number, label: `C-${c1.number}` },
    });
  });
});
