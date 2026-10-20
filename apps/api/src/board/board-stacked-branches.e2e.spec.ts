import {
  BOARD_ERROR,
  type BoardCardDetail,
  type BoardStackDetail,
} from '@agentdock/shared';
import { BoardShipping } from './board-shipping';
import { BoardWorld, cardChecks, HEAD_SHA, ok } from './testing/board-e2e';

/**
 * #636 (docs/specs/636-branch-a-dependent-card-from-its-depende.md,
 * ADR-0064): a card with one unmerged dependency that has an open PR is cut
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

  it('two unmerged dependencies refuse Run with dependencies_unmerged, with no override (#638)', async () => {
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
    expect(forced.status).toBe(400);
    expect(w.sent('card.run')).toHaveLength(0);
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
    expect((await w.runCard(todo.number)).status).toBe(200);
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
  describe('the base read from GitHub (#709)', () => {
    const C2_BRANCH = 'feat/2-the-dependant';
    /** When C-1's PR merged on GitHub, and C-2's after it. */
    const C1_MERGED = '2026-10-20T10:00:00.000Z';
    const C2_MERGED = '2026-10-20T11:00:00.000Z';

    /** `card.checks` answers by PR number; any other PR is open. */
    const prs = (byPr: Record<number, Record<string, unknown>>) => {
      w.checksServed = true;
      w.handlers['card.checks'] = (args) =>
        ok(cardChecks(byPr[Number(args.pr)] ?? {}));
    };

    /** C-1 with an open PR #77, and C-2 stacked on its branch with PR #78. */
    const stacked = async () => {
      const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
      const c2 = await withOpenPr('Dependant', C2_BRANCH, 78, {
        prBase: C1_BRANCH,
        prBaseCardId: c1.id,
      });
      await link(c2.number, c1.number);
      return { c1, c2 };
    };

    it('Run reads the dependency PR on GitHub: merged there unseen, the card starts from the base', async () => {
      const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
      const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
      await link(c2.number, c1.number);
      prs({ 77: { state: 'merged', base: BASE, mergedAt: C1_MERGED } });

      expect((await w.runCard(c2.number)).status).toBe(200);
      expect(runBase()).toBe(BASE);
      expect(await w.card(c2.number)).toMatchObject({
        prBase: null,
        prBaseCardId: null,
      });
      expect(w.checks()).toContainEqual(
        expect.objectContaining({ pr: 77 }),
      );
      // The merge the poll missed is recorded on C-1.
      expect(await w.card(c1.number)).toMatchObject({
        prState: 'merged',
        mergedAt: new Date(C1_MERGED),
        prBase: null,
      });
    });

    it('Run on a dependency whose PR closed on GitHub starts from the base', async () => {
      const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
      const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
      await link(c2.number, c1.number);
      prs({ 77: { state: 'closed' } });

      expect((await w.runCard(c2.number)).status).toBe(200);
      expect(runBase()).toBe(BASE);
      expect((await w.card(c1.number)).prState).toBe('closed');
      expect((await w.card(c2.number)).prBase).toBeNull();
    });

    it('a dependency still open on GitHub stacks the card as before', async () => {
      const c1 = await withOpenPr('Dependency', C1_BRANCH, 77);
      const c2 = await w.createCard({ title: 'Dependant', specOnRun: false });
      await link(c2.number, c1.number);
      prs({});

      expect((await w.runCard(c2.number)).status).toBe(200);
      expect(runBase()).toBe(C1_BRANCH);
      expect((await w.card(c1.number)).mergedAt).toBeNull();
    });

    it('a stacked PR merged into a dependency branch that had already merged gets a forward PR into the base', async () => {
      const { c1, c2 } = await stacked();
      prs({
        77: { state: 'merged', base: BASE, mergedAt: C1_MERGED },
        78: { state: 'merged', base: C1_BRANCH, mergedAt: C2_MERGED },
      });
      // GitHub refuses to retarget a PR that is no longer open.
      w.handlers['card.prRetarget'] = () =>
        ok({ retargeted: false, error: 'not_open', message: 'merged' });

      await w.ctx.app.get(BoardShipping).poll();

      expect(w.prOpens()).toEqual([
        expect.objectContaining({
          cardId: c2.id,
          branch: C2_BRANCH,
          base: BASE,
          title: `C-${c2.number}: Dependant`,
        }),
      ]);
      expect(String(w.prOpens()[0]?.body)).toContain('#78');
      expect(await w.card(c2.number)).toMatchObject({
        prNumber: 91,
        prUrl: 'https://github.com/acme/widget/pull/91',
        prState: 'open',
        mergedAt: null,
        prBase: null,
        prBaseCardId: null,
        ciState: 'pending',
        needsPerson: false,
      });
      expect(await w.card(c1.number)).toMatchObject({
        prState: 'merged',
        mergedAt: new Date(C1_MERGED),
      });
      const [audit] = await w.audit('card.pr_forwarded');
      expect(audit.after).toEqual({
        number: c2.number,
        pr: 91,
        mergedPr: 78,
        into: C1_BRANCH,
        base: BASE,
        dependency: c1.number,
        alreadyOpen: false,
        conflict: false,
      });
      expect(
        await w.ctx.prisma.boardCardPullRequest.findMany({
          where: { cardId: c2.id },
          select: { number: true, state: true },
          orderBy: { number: 'asc' },
        }),
      ).toEqual([{ number: 91, state: 'open' }]);
    });

    it('a merge into the dead branch the poll reads itself is carried forward, and a conflicting forward PR needs a person', async () => {
      const { c1, c2 } = await stacked();
      // C-1 merged; C-2's retarget failed, so it is still stacked.
      w.handlers['card.prRetarget'] = () =>
        ok({ retargeted: false, error: 'gh_failed', message: 'HTTP 502' });
      await w.ctx.prisma.boardCard.update({
        where: { id: c1.id },
        data: { prState: 'merged', mergedAt: new Date(C1_MERGED) },
      });
      w.handlers['card.prOpen'] = () =>
        ok({
          opened: true,
          prNumber: 92,
          prUrl: 'https://github.com/acme/widget/pull/92',
          alreadyOpen: false,
          mergeable: 'CONFLICTING',
        });
      prs({ 78: { state: 'merged', base: C1_BRANCH, mergedAt: C2_MERGED } });
      // The retry of the retarget meets the merged PR.
      w.handlers['card.prRetarget'] = () =>
        ok({ retargeted: false, error: 'not_open', message: 'merged' });

      await w.ctx.app.get(BoardShipping).poll();

      expect(w.prOpens()).toHaveLength(1);
      expect(await w.card(c2.number)).toMatchObject({
        prNumber: 92,
        prState: 'open',
        prBase: null,
        needsPerson: true,
        needsPersonReason: 'forward_conflict',
      });
      const [audit] = await w.audit('card.pr_forwarded');
      expect(audit.after).toMatchObject({ pr: 92, conflict: true });
    });

    it('a stacked PR that merged before its dependency lands with it — no forward PR', async () => {
      const { c1, c2 } = await stacked();
      // C-2 merged into C-1's live branch; C-1 merges after.
      await w.work.markMerged(c2.id, 78, {
        state: 'merged',
        base: C1_BRANCH,
        mergedAt: new Date(C1_MERGED),
      });
      expect((await w.card(c2.number)).prBase).toBe(C1_BRANCH);
      await w.work.markMerged(c1.id, 77, {
        state: 'merged',
        base: BASE,
        mergedAt: new Date(C2_MERGED),
      });
      expect(w.prOpens()).toHaveLength(0);
      expect(await w.card(c2.number)).toMatchObject({
        prState: 'merged',
        prBase: null,
        prBaseCardId: null,
      });
    });

    it('a merge on Accept retargets a stacked PR whose dependency merged on GitHub first, or refuses', async () => {
      const { c2 } = await stacked();
      prs({ 77: { state: 'merged', base: BASE, mergedAt: C1_MERGED } });
      w.handlers['card.prRetarget'] = () =>
        ok({ retargeted: false, error: 'gh_failed', message: 'HTTP 502' });

      const refused = await w.operator.send(
        'post',
        `${w.path()}/board/cards/${c2.number}/accept`,
        { merge: { headSha: HEAD_SHA } },
      );
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: BOARD_ERROR.mergeFailed,
        reason: 'base_merged',
      });
      expect(w.sent('card.merge')).toHaveLength(0);
      expect((await w.card(c2.number)).column).toBe('finished');

      w.handlers['card.prRetarget'] = undefined;
      const accepted = await w.operator.send(
        'post',
        `${w.path()}/board/cards/${c2.number}/accept`,
        { merge: { headSha: HEAD_SHA } },
      );
      expect(accepted.status).toBe(200);
      expect(w.prRetargets().at(-1)).toMatchObject({ pr: 78, base: BASE });
      expect(w.sent('card.merge')).toEqual([
        expect.objectContaining({ pr: 78 }),
      ]);
      expect(await w.card(c2.number)).toMatchObject({
        column: 'completed',
        prBase: null,
      });
    });
  });

  describe('Completed means landed (#709)', () => {
    const accept = (number: number, body: object = {}) =>
      w.operator.send('post', `${w.path()}/board/cards/${number}/accept`, body);

    it('Accept of a card whose PR has not merged into the base asks for confirmation', async () => {
      const card = await withOpenPr('Open PR', 'feat/1-open', 77);

      const refused = await accept(card.number);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe(BOARD_ERROR.notLanded);
      expect(refused.body.message).toBe(
        `C-${card.number}'s pull request #77 into ${BASE} has not merged, so its work is not in ${BASE} yet`,
      );
      expect((await w.card(card.number)).column).toBe('finished');

      const confirmed = await accept(card.number, { confirmUnlanded: true });
      expect(confirmed.status).toBe(200);
      expect((await w.card(card.number)).column).toBe('completed');
    });

    it('names a merge into a dependency branch that had already merged', async () => {
      const c1 = await withOpenPr('Dependency', C1_BRANCH, 77, {
        prState: 'merged',
        mergedAt: new Date('2026-10-20T10:00:00.000Z'),
      });
      const c2 = await withOpenPr('Dependant', 'feat/2-the-dependant', 78, {
        prState: 'merged',
        mergedAt: new Date('2026-10-20T11:00:00.000Z'),
        prBase: C1_BRANCH,
        prBaseCardId: c1.id,
      });
      const refused = await accept(c2.number);
      expect(refused.status).toBe(409);
      expect(refused.body.message).toBe(
        `C-${c2.number}'s pull request #78 merged into ${C1_BRANCH} after C-${c1.number}'s own pull request had merged, so its work is not in ${BASE}`,
      );
    });

    it('a landed card, one with nothing to land, or closing the PR is accepted at once', async () => {
      const merged = await withOpenPr('Merged', 'feat/1-merged', 77, {
        prState: 'merged',
        mergedAt: new Date(),
      });
      expect((await accept(merged.number)).status).toBe(200);

      const nothing = await w.createCard({
        title: 'Nothing',
        specOnRun: false,
      });
      await w.ctx.prisma.boardCard.update({
        where: { id: nothing.id },
        data: { column: 'finished', collectState: 'no_changes' },
      });
      expect((await accept(nothing.number)).status).toBe(200);

      // Merged into a dependency branch that is still open: it lands with it.
      const c1 = await withOpenPr('Dependency', C1_BRANCH, 79);
      const c2 = await withOpenPr('Dependant', 'feat/2-the-dependant', 78, {
        prState: 'merged',
        mergedAt: new Date(),
        prBase: C1_BRANCH,
        prBaseCardId: c1.id,
      });
      expect((await accept(c2.number)).status).toBe(200);

      const open = await withOpenPr('Open', 'feat/3-open', 80);
      expect(
        (
          await accept(open.number, {
            closePr: { deleteBranch: false, closeIssue: false },
          })
        ).status,
      ).toBe(200);
    });

    it('a PR the board holds as open but GitHub has merged into the base counts as landed', async () => {
      const card = await withOpenPr('Merged unseen', 'feat/1-unseen', 77);
      w.checksServed = true;
      w.handlers['card.checks'] = () =>
        ok(
          cardChecks({
            state: 'merged',
            base: BASE,
            mergedAt: '2026-10-20T10:00:00.000Z',
          }),
        );
      expect((await accept(card.number)).status).toBe(200);
      expect(await w.card(card.number)).toMatchObject({
        column: 'completed',
        prState: 'merged',
      });
    });
  });
});
