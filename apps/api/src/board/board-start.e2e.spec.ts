import type { BoardCardDetail } from '@agentdock/shared';
import { BoardWorld } from './testing/board-e2e';

/**
 * #640 (ADR-0064): round 1 of a card branches from its one unmerged
 * dependency's branch; from the project's base with none or several, naming
 * the several. Later rounds keep it; the pull request targets the base.
 */
describe('card start base (e2e, #640)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    await w.advertiseCardStartFrom();
  });
  afterEach(() => w.work.settled());

  const post = (number: number, action: string, body: object = {}) =>
    w.operator.send(
      'post',
      `${w.path()}/board/cards/${number}/${action}`,
      body,
    );
  const link = (number: number, dependsOn: number) =>
    w.operator.send('post', `${w.path()}/board/cards/${number}/dependencies`, {
      dependsOn,
    });
  const detail = async (number: number) =>
    (await w.viewer.get(`${w.path()}/board/cards/${number}`))
      .body as BoardCardDetail;

  /** A Finished dependency whose pull request is open, or merged. */
  const dependency = async (title: string, merged = false) => {
    const created = await w.createCard({ title, specOnRun: false });
    const branch = `feat/c${created.number}-${title.toLowerCase()}`;
    await w.ctx.prisma.boardCard.update({
      where: { id: created.id },
      data: {
        column: 'finished',
        branch,
        prNumber: 100 + created.number,
        prUrl: `https://github.com/acme/widget/pull/${100 + created.number}`,
        prState: merged ? 'merged' : 'open',
        mergedAt: merged ? new Date() : null,
      },
    });
    return { ...created, branch };
  };

  const dependant = async (...dependsOn: number[]) => {
    const card = await w.createCard({
      title: 'Export button',
      specOnRun: false,
    });
    for (const d of dependsOn) await link(card.number, d);
    return card;
  };

  it("starts from the one unmerged dependency's branch and keeps it for feedback", async () => {
    const api = await dependency('Api');
    const card = await dependant(api.number);

    expect(
      (await w.runCard(card.number, { ignoreDependencies: true })).status,
    ).toBe(200);
    const [first] = w.sent('card.run');
    expect(first).toMatchObject({ base: 'develop', startFrom: api.branch });
    expect(String(first.prompt)).toContain(
      `created from C-${api.number}'s branch ${api.branch}, which is not merged yet; the pull request targets develop`,
    );
    expect(await detail(card.number)).toMatchObject({
      start: {
        base: api.branch,
        card: { number: api.number, label: `C-${api.number}` },
        missing: [],
      },
    });
    const [started] = await w.audit('card.run_started');
    expect(started.after).toMatchObject({
      startFrom: api.branch,
      startCard: api.number,
    });

    // A feedback round keeps the base, does not re-branch, targets the base.
    await post(card.number, 'finish');
    expect(
      (await post(card.number, 'feedback', { text: 'Rename it.' })).status,
    ).toBe(200);
    const second = w.sent('card.run')[1];
    expect(second).toMatchObject({
      base: 'develop',
      branch: first.branch,
      startFrom: api.branch,
      session: { resume: true },
    });
    expect(second).not.toHaveProperty('newBranch');
    expect((await detail(card.number)).start?.base).toBe(api.branch);
  });

  it('starts from the project base when every dependency is merged', async () => {
    const merged = await dependency('Api', true);
    const card = await dependant(merged.number);

    expect(
      (await w.runCard(card.number, { ignoreDependencies: true })).status,
    ).toBe(200);
    const [run] = w.sent('card.run');
    expect(run).toMatchObject({ base: 'develop' });
    expect(run).not.toHaveProperty('startFrom');
    expect(String(run.prompt)).toContain('(based on develop)');
    expect((await detail(card.number)).start).toEqual({
      base: 'develop',
      card: null,
      missing: [],
    });
  });

  it('starts from the project base with two unmerged dependencies and names them', async () => {
    const a = await dependency('Api');
    const b = await dependency('Store');
    const card = await dependant(b.number, a.number);

    expect(
      (await w.runCard(card.number, { ignoreDependencies: true })).status,
    ).toBe(200);
    const [run] = w.sent('card.run');
    expect(run).not.toHaveProperty('startFrom');
    expect(String(run.prompt)).toContain(
      `Not merged yet, so not on this branch: C-${a.number} (${a.branch}), C-${b.number} (${b.branch}).`,
    );
    expect((await detail(card.number)).start).toEqual({
      base: 'develop',
      card: null,
      missing: [`C-${a.number}`, `C-${b.number}`],
    });
    const [started] = await w.audit('card.run_started');
    expect(started.after).toMatchObject({
      missingDependencies: [a.number, b.number],
    });
  });

  it('starts from the base, naming the dependency, on a runner without cardStartFrom', async () => {
    await w.advertiseCardStartFrom(false);
    const api = await dependency('Api');
    const card = await dependant(api.number);

    expect(
      (await w.runCard(card.number, { ignoreDependencies: true })).status,
    ).toBe(200);
    expect(w.sent('card.run')[0]).not.toHaveProperty('startFrom');
    expect((await detail(card.number)).start?.missing).toEqual([
      `C-${api.number}`,
    ]);
  });
});
