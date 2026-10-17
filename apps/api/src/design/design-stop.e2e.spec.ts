import type { TaskDesignView } from '@agentdock/shared';
import { decomposed, ok, task } from '../planner/testing/planner-e2e';
import { CardDesignHarness } from './testing/card-design-e2e';
import { profileResult } from './testing/design-e2e';

/** #275 D5, D10: Stop a busy design, for a plan task and a board card. */
describe('design stop (e2e)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => {
    return h.reset().then(() => {
      h.designHandlers['uiprofile.cancel'] = () => ok({ cancelled: true });
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const uiPlan = () =>
    decomposed(h, [
      task('t1', { design: { needed: true, why: 'A screen.', variants: 1 } }),
    ]);

  const cardGenerate = (number: number) =>
    h.author.send('post', `${h.cardDesignBase(number)}/generate`);
  const cardStop = (number: number, session = h.author) =>
    session.send('post', `${h.cardDesignBase(number)}/stop`);

  it('cancels a task design turn with the plan id, audits it, and the cancelled turn reads stopped', async () => {
    await h.seedProfile();
    const plan = await uiPlan();
    const base = h.designBase(plan.id, 't1');
    expect((await h.author.send('post', `${base}/generate`)).status).toBe(201);
    const turn = await h.activeTurn(plan.id);

    const stopped = await h.author.send('post', `${base}/stop`);
    expect(stopped.status).toBe(200);
    expect(h.sentOf('plan.cancel')).toEqual([
      { planId: plan.id, turnId: turn.id },
    ]);
    const [record] = await h.auditOf('design.stopped');
    expect(record.after).toMatchObject({
      key: 't1',
      stage: 'draw',
      runId: turn.runId,
      turnId: turn.id,
    });

    await h.endTurn(plan.id, 'cancelled', 'cancelled by the operator');
    const rest = (await h.author.get(base)).body as TaskDesignView;
    expect(rest.status).toBe('idle');
    expect(rest.busySince).toBeNull();
    expect(rest.lastFailure).toMatchObject({
      stage: 'draw',
      reason: 'stopped',
    });
  });

  it("cancels a card design turn with the card's id", async () => {
    await h.seedProfile();
    const card = await h.designedCard();
    expect((await cardGenerate(card.number)).status).toBe(201);
    const turn = await h.activeCardTurn(card.id);

    expect((await cardStop(card.number)).status).toBe(200);
    expect(h.sentOf('plan.cancel')).toEqual([
      { planId: card.id, turnId: turn.id },
    ]);
    expect((await h.auditOf('design.stopped')).length).toBe(1);
  });

  it('cancels the build when this design is its only waiter', async () => {
    const card = await h.designedCard();
    expect((await cardGenerate(card.number)).status).toBe(201);
    const build = await h.activeBuild();

    const stopped = await cardStop(card.number);
    expect(stopped.status).toBe(200);
    expect((stopped.body as TaskDesignView).status).toBe('idle');
    expect((stopped.body as TaskDesignView).progress).toBeNull();
    expect(h.designSent('uiprofile.cancel')).toEqual([{ runId: build.id }]);
    const run = await h.ctx.prisma.run.findUniqueOrThrow({
      where: { id: build.id },
    });
    expect((run.args as { waiting: unknown[] }).waiting).toEqual([]);
    const [record] = await h.auditOf('design.stopped');
    expect(record.after).toMatchObject({
      number: card.number,
      stage: 'profile',
      runId: build.id,
    });
  });

  it('leaves a build that another design waits for running, and only this design rests', async () => {
    const first = await h.designedCard();
    const second = await h.designedCard();
    expect((await cardGenerate(first.number)).status).toBe(201);
    expect((await cardGenerate(second.number)).status).toBe(201);
    const build = await h.activeBuild();

    expect((await cardStop(first.number)).status).toBe(200);
    expect(h.designSent('uiprofile.cancel')).toHaveLength(0);
    expect((await h.cardDesign(first.number)).status).toBe('idle');
    const other = await h.cardDesign(second.number);
    expect(other.status).toBe('generating');
    expect(other.progress).toMatchObject({ stage: 'profile', runId: build.id });

    await h.finishBuild(profileResult());
    expect(h.sentOf('plan.turn')).toEqual([
      expect.objectContaining({ planId: second.id }),
    ]);
    expect((await h.cardDesign(first.number)).status).toBe('idle');
  });

  it('is 409 design_not_running at rest, and runner_outdated when the runner cannot cancel a build', async () => {
    const card = await h.designedCard();
    const idle = await cardStop(card.number);
    expect(idle.status).toBe(409);
    expect(idle.body.error).toBe('design_not_running');

    expect((await cardGenerate(card.number)).status).toBe(201);
    h.advert = {
      commands: ['plan.turn', 'uiprofile.fingerprint', 'uiprofile.build'],
      disabled: [],
    };
    const outdated = await cardStop(card.number);
    expect(outdated.status).toBe(409);
    expect(outdated.body.error).toBe('runner_outdated');
    expect(h.designSent('uiprofile.cancel')).toHaveLength(0);
    expect((await h.cardDesign(card.number)).status).toBe('generating');
    expect((await h.auditOf('design.stopped')).length).toBe(0);
  });

  it('puts a design left busy with nothing running back to rest (#606)', async () => {
    const card = await h.designedCard();
    // A batch whose next turn never started: busy, no turn, no build.
    await h.ctx.prisma.taskDesign.update({
      where: { cardId: card.id },
      data: { status: 'generating', busySince: new Date() },
    });
    const before = await h.cardDesign(card.number);
    expect(before.progress).toBeNull();
    expect((await cardGenerate(card.number)).status).toBe(409);

    const stopped = await cardStop(card.number);
    expect(stopped.status).toBe(200);
    expect((stopped.body as TaskDesignView).status).toBe('idle');
    expect((stopped.body as TaskDesignView).busySince).toBeNull();
    expect(h.sentOf('plan.cancel')).toHaveLength(0);
    const [record] = await h.auditOf('design.stopped');
    expect(record.after).toMatchObject({ number: card.number, stage: null });
    expect((await cardGenerate(card.number)).status).toBe(201);
  });

  it('is 403 for a viewer and 404 for a non-member; a viewer reads progress', async () => {
    const card = await h.designedCard();
    expect((await cardGenerate(card.number)).status).toBe(201);

    const viewer = await cardStop(card.number, h.viewer);
    expect(viewer.status).toBe(403);
    const seen = await h.cardDesign(card.number, h.viewer);
    expect(seen.progress).toMatchObject({ stage: 'profile', step: 1 });

    expect((await cardStop(card.number, h.outsider)).status).toBe(404);
    expect((await h.outsider.get(h.cardDesignBase(card.number))).status).toBe(
      404,
    );
    expect(h.designSent('uiprofile.cancel')).toHaveLength(0);
  });
});
