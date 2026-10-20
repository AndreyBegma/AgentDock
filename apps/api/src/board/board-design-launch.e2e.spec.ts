import { DESIGN_ERROR } from '@nautelle/shared';
import { CardDesignHarness } from '../design/testing/card-design-e2e';
import { designResult } from '../design/testing/design-e2e';

const KEY = 'card-1';

/** #322 D1–D3, D9: the profile and model a card's design turns run on. */
describe('card design launch overrides (e2e, #322)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    await h.ctx.prisma.runtimeProfile.create({
      data: {
        runnerId: h.runnerId,
        key: 'claude-alt',
        runtime: 'claude',
        label: 'Claude alt',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await h.seedProfile();
  });
  afterEach(() => jest.restoreAllMocks());

  /** A designed card whose assessment recommends `design` for its design. */
  const recommended = async (design: string, variants = 1) => {
    const card = await h.designedCard(variants);
    await h.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: {
        recommendedModel: 'haiku',
        recommendedReason: 'Fits haiku.',
        recommendedDesignModel: design,
        recommendedDesignReason: `Fits ${design}.`,
        assessedAt: new Date(),
      },
    });
    return card;
  };

  const generate = (number: number, body?: object) =>
    h.author.send('post', `${h.cardDesignBase(number)}/generate`, body);

  const stored = (id: string) =>
    h.ctx.prisma.boardCard.findUniqueOrThrow({ where: { id } });

  it('Generate defaults to the design recommendation, not the work one', async () => {
    const card = await recommended('sonnet');
    expect((await generate(card.number)).status).toBe(201);
    const [turn] = h.sentOf('plan.turn');
    expect(turn).toMatchObject({ model: 'sonnet', profileKey: 'claude-main' });
    const run = await h.ctx.prisma.run.findUniqueOrThrow({
      where: { id: String(turn.runId) },
    });
    expect(run.model).toBe('sonnet');
    expect(await stored(card.id)).toMatchObject({
      designModel: null,
      profileKey: null,
    });
  });

  it('a picked model is stored as designModel, for every variant, and leaves model alone', async () => {
    const card = await recommended('sonnet', 2);
    expect((await generate(card.number, { model: 'opus' })).status).toBe(201);
    expect(await stored(card.id)).toMatchObject({
      designModel: 'opus',
      model: null,
    });
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    expect(h.sentOf('plan.turn').map((t) => t.model)).toEqual(['opus', 'opus']);
  });

  it('picking the recommended model again clears designModel', async () => {
    const card = await recommended('sonnet');
    await h.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: { designModel: 'opus' },
    });
    expect((await generate(card.number, { model: 'sonnet' })).status).toBe(201);
    expect(h.sentOf('plan.turn')[0]).toMatchObject({ model: 'sonnet' });
    expect((await stored(card.id)).designModel).toBeNull();
  });

  it("defaults to the card's profile, which a Run chose", async () => {
    const card = await recommended('sonnet');
    await h.ctx.prisma.boardCard.update({
      where: { id: card.id },
      data: { profileKey: 'claude-alt' },
    });
    expect((await generate(card.number)).status).toBe(201);
    expect(h.sentOf('plan.turn')[0]).toMatchObject({
      profileKey: 'claude-alt',
    });
  });

  it('Revise takes the launch too', async () => {
    const card = await recommended('sonnet');
    await generate(card.number);
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    const view = await h.cardDesign(card.number);
    const comment = await h.author.send(
      'post',
      `${h.cardDesignBase(card.number)}/comments`,
      { revisionId: view.revisions[0].id, kind: 'general', body: 'Bigger.' },
    );
    expect(comment.status).toBe(201);
    const revised = await h.author.send(
      'post',
      `${h.cardDesignBase(card.number)}/revise`,
      { profileKey: 'claude-alt', model: 'opus' },
    );
    expect(revised.status).toBe(201);
    expect(h.sentOf('plan.turn').at(-1)).toMatchObject({
      profileKey: 'claude-alt',
      model: 'opus',
    });
    expect(await stored(card.id)).toMatchObject({
      profileKey: 'claude-alt',
      designModel: 'opus',
    });
  });

  it.each([
    ['a Codex profile', 'codex-main'],
    ['a key not on the runner', 'nobody'],
  ])('refuses %s with 422 no_profile, storing nothing', async (_, key) => {
    const card = await recommended('sonnet');
    const response = await generate(card.number, {
      profileKey: key,
      model: 'opus',
    });
    expect(response.status).toBe(422);
    expect(response.body.error).toBe(DESIGN_ERROR.noProfile);
    expect(await stored(card.id)).toMatchObject({
      profileKey: null,
      designModel: null,
    });
    expect(h.sentOf('plan.turn')).toHaveLength(0);
    expect((await h.cardDesign(card.number)).status).toBe('idle');
  });

  it('a viewer gets 403 from generate and revise with a profile key; another project 404', async () => {
    const card = await recommended('sonnet');
    const body = { profileKey: 'claude-alt', model: 'opus' };
    for (const action of ['generate', 'revise']) {
      const path = `${h.cardDesignBase(card.number)}/${action}`;
      expect((await h.viewer.send('post', path, body)).status).toBe(403);
      expect((await h.outsider.send('post', path, body)).status).toBe(404);
    }
    expect(await stored(card.id)).toMatchObject({
      profileKey: null,
      designModel: null,
    });
  });

  it('refuses an unknown body key', async () => {
    const card = await recommended('sonnet');
    expect((await generate(card.number, { effort: 'high' })).status).toBe(400);
  });
});
