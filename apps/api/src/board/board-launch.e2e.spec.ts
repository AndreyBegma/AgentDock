import { BOARD_ERROR } from '@nautelle/shared';
import { capabilities } from '../runners/testing/runner-e2e';
import { BoardWorld, failed } from './testing/board-e2e';

/** #322 D2, D3, D9: the profile and model a card's Run starts with. */
describe('board launch overrides (e2e, #322)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    for (const [key, runtime] of [
      ['claude-alt', 'claude'],
      ['codex-main', 'codex'],
    ] as const) {
      await w.ctx.prisma.runtimeProfile.create({
        data: {
          runnerId: w.runnerId,
          key,
          runtime,
          label: key,
          env: {},
          args: [],
          authenticated: true,
        },
      });
    }
  });
  afterEach(() => w.work.settled());

  /** A card whose assessment recommends `work` for its work. */
  const recommended = async (work: string) => {
    const card = await w.createCard();
    await w.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        recommendedModel: work,
        recommendedReason: `Fits ${work}.`,
        recommendedDesignModel: 'opus',
        recommendedDesignReason: 'Fits opus.',
        assessedAt: new Date(),
      },
    });
    return card;
  };

  const roundRun = async (number: number, index = 0) => {
    const card = await w.card(number);
    return w.ctx.prisma.run.findUniqueOrThrow({
      where: { id: card.rounds[index].runId },
    });
  };

  it('defaults to the recommendation, and choosing it stores no override', async () => {
    const { number } = await recommended('sonnet');
    const response = await w.runCard(number, { model: 'sonnet' });
    expect(response.status).toBe(200);
    expect((await roundRun(number)).model).toBe('sonnet');
    expect(w.sent('card.run')[0]).toMatchObject({
      model: 'sonnet',
      profileKey: 'claude-main',
    });
    const card = await w.card(number);
    expect(card.model).toBeNull();
    expect(card.profileKey).toBeNull();
  });

  it('starts on the recommendation with no model sent', async () => {
    const { number } = await recommended('haiku');
    expect((await w.runCard(number)).status).toBe(200);
    expect((await roundRun(number)).model).toBe('haiku');
  });

  it('remembers a different model, which wins over a later recommendation', async () => {
    const { id, number } = await recommended('sonnet');
    w.handlers['card.run'] = () => failed('internal');
    expect((await w.runCard(number, { model: 'opus' })).status).toBe(502);
    expect((await w.card(number)).model).toBe('opus');

    await w.ctx.prisma.boardCard.update({
      where: { id },
      data: { recommendedModel: 'haiku' },
    });
    w.handlers = {};
    // Run again with no choice — as an auto-run starts — keeps opus.
    expect((await w.runCard(number)).status).toBe(200);
    expect((await roundRun(number, 1)).model).toBe('opus');
  });

  it('choosing the default again clears a remembered model', async () => {
    const { id, number } = await recommended('sonnet');
    await w.ctx.prisma.boardCard.update({
      where: { id },
      data: { model: 'opus' },
    });
    expect((await w.runCard(number, { model: 'sonnet' })).status).toBe(200);
    expect((await roundRun(number)).model).toBe('sonnet');
    expect((await w.card(number)).model).toBeNull();
  });

  it('without a recommendation, falls back to the project model', async () => {
    const { number } = await w.createCard();
    await w.ctx.prisma.projectOrchestratorSettings.upsert({
      where: { projectId: w.a },
      create: { projectId: w.a, model: 'sonnet' },
      update: { model: 'sonnet' },
    });
    expect((await w.runCard(number)).status).toBe(200);
    expect((await roundRun(number)).model).toBe('sonnet');
  });

  describe('#663: effort beside the model', () => {
    const withEffort = async (effort: 'low' | 'medium' | 'high') => {
      const card = await recommended('sonnet');
      await w.ctx.prisma.boardCard.update({
        where: { id: card.id },
        data: { recommendedEffort: effort },
      });
      return card;
    };

    it('starts on the recommended effort and stores no override', async () => {
      await w.advertiseCardEffort();
      const { number } = await withEffort('medium');
      expect((await w.runCard(number)).status).toBe(200);
      expect(w.sent('card.run')[0]).toMatchObject({
        model: 'sonnet',
        effort: 'medium',
      });
      expect((await roundRun(number)).args).toMatchObject({
        effort: 'medium',
      });
      expect((await w.card(number)).effort).toBeNull();
    });

    it('remembers a different effort; choosing the default again clears it', async () => {
      await w.advertiseCardEffort();
      const { number } = await withEffort('medium');
      w.handlers['card.run'] = () => failed('internal');
      expect((await w.runCard(number, { effort: 'high' })).status).toBe(502);
      expect((await w.card(number)).effort).toBe('high');
      expect(w.sent('card.run')[0]).toMatchObject({ effort: 'high' });

      expect((await w.runCard(number, { effort: 'medium' })).status).toBe(502);
      expect((await w.card(number)).effort).toBeNull();
    });

    it('sends no effort without a recommendation or a choice', async () => {
      await w.advertiseCardEffort();
      const { number } = await recommended('sonnet');
      expect((await w.runCard(number)).status).toBe(200);
      expect(w.sent('card.run')[0].effort).toBeUndefined();
    });

    it('sends no effort to a runner that does not advertise it', async () => {
      const { number } = await withEffort('low');
      expect((await w.runCard(number, { effort: 'high' })).status).toBe(200);
      expect(w.sent('card.run')[0].effort).toBeUndefined();
      expect((await roundRun(number)).args).toMatchObject({ effort: null });
    });

    it('refuses an effort outside the list with 400', async () => {
      const { number } = await recommended('sonnet');
      expect((await w.runCard(number, { effort: 'max' })).status).toBe(400);
    });

    it('shows the effort and the recommended one on the card', async () => {
      const { number } = await withEffort('low');
      const detail = await w.operator.get(`${w.path()}/board/cards/${number}`);
      expect(detail.body).toMatchObject({
        effort: null,
        recommendation: {
          work: { model: 'sonnet', effort: 'low', reason: 'Fits sonnet.' },
        },
      });
    });
  });

  describe('C-369: a demo round', () => {
    const recordDemos = async (cardDemo: boolean) => {
      await w.ctx.prisma.boardSettings.upsert({
        where: { projectId: w.a },
        create: { projectId: w.a, demoVideosEnabled: true },
        update: { demoVideosEnabled: true },
      });
      await w.ctx.prisma.projectDemoSecret.create({
        data: { projectId: w.a, name: 'DEMO_PASSWORD', valueCiphertext: 'x' },
      });
      await w.ctx.prisma.runner.update({
        where: { id: w.runnerId },
        data: { capabilities: { ...capabilities, cardDemo } },
      });
    };

    it('gives the session DemoFlow and the scenario section when the runner records', async () => {
      await recordDemos(true);
      const { number } = await w.createCard();
      expect((await w.runCard(number)).status).toBe(200);
      const [sent] = w.sent('card.run');
      expect(sent.demo).toBe(true);
      expect(sent.prompt).toContain('## Demo video');
      expect(sent.prompt).toContain('`DEMO_PASSWORD`');
      expect(sent.prompt).not.toContain('valueCiphertext');
    });

    it('leaves the round alone on a runner that does not record', async () => {
      await recordDemos(false);
      const { number } = await w.createCard();
      expect((await w.runCard(number)).status).toBe(200);
      const [sent] = w.sent('card.run');
      expect(sent.demo).toBeUndefined();
      expect(sent.prompt).not.toContain('## Demo video');
    });
  });

  it('starts on a chosen Claude profile and remembers it', async () => {
    const { number } = await recommended('sonnet');
    const response = await w.runCard(number, { profileKey: 'claude-alt' });
    expect(response.status).toBe(200);
    expect(w.sent('card.run')[0]).toMatchObject({ profileKey: 'claude-alt' });
    expect((await roundRun(number)).profileKey).toBe('claude-alt');
    expect((await w.card(number)).profileKey).toBe('claude-alt');
    expect(response.body.profileKey).toBe('claude-alt');
  });

  it('choosing the resolver profile stores no override', async () => {
    const { number } = await recommended('sonnet');
    expect(
      (await w.runCard(number, { profileKey: 'claude-main' })).status,
    ).toBe(200);
    expect((await w.card(number)).profileKey).toBeNull();
  });

  it.each([
    ['a Codex profile', 'codex-main'],
    ['a key not on the runner', 'nobody'],
  ])('refuses %s with 422 no_profile, storing nothing', async (_, key) => {
    const { number } = await recommended('sonnet');
    const response = await w.runCard(number, {
      profileKey: key,
      model: 'opus',
    });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: BOARD_ERROR.noProfile,
      source: 'explicit',
      profileKey: key,
    });
    const card = await w.card(number);
    expect(card.profileKey).toBeNull();
    expect(card.model).toBeNull();
    expect(card.rounds).toHaveLength(0);
    expect(await w.ctx.prisma.run.count({ where: { kind: 'card' } })).toBe(0);
    expect(w.sent('card.run')).toHaveLength(0);
  });

  it('PATCH refuses a profile that is not a Claude profile of the runner', async () => {
    const { number } = await w.createCard();
    const path = `${w.path()}/board/cards/${number}`;
    const codex = await w.operator.send('patch', path, {
      profileKey: 'codex-main',
    });
    expect(codex.status).toBe(422);
    expect(codex.body).toMatchObject({
      error: BOARD_ERROR.noProfile,
      reason: 'not_claude',
    });
    expect((await w.card(number)).profileKey).toBeNull();
    const alt = await w.operator.send('patch', path, {
      profileKey: 'claude-alt',
    });
    expect(alt.status).toBe(200);
    expect((await w.card(number)).profileKey).toBe('claude-alt');
  });

  it('a viewer gets 403 and another project 404, with a profile key', async () => {
    const { number } = await w.createCard();
    const body = { profileKey: 'claude-alt', model: 'opus' };
    const viewer = await w.viewer.send(
      'post',
      `${w.path()}/board/cards/${number}/run`,
      body,
    );
    expect(viewer.status).toBe(403);
    // Project A's card is not reachable through project B's routes.
    const other = await w.operatorOfB.send(
      'post',
      `${w.path(w.b)}/board/cards/${number}/run`,
      body,
    );
    expect(other.status).toBe(404);
    const card = await w.card(number);
    expect(card.profileKey).toBeNull();
    expect(card.rounds).toHaveLength(0);
  });
});
