import { CardDesignHarness } from '../design/testing/card-design-e2e';

/**
 * #272 D1, D2: every model-running action resolves its profile through one
 * rule — the explicit key, else the orchestrator profile, else the project
 * default — and refuses with one error, `422 no_profile`.
 */
describe('runtime profile rule (e2e)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());

  const ORCH = 'claude-orch';

  /** An orchestrator profile and no project default. */
  const orchestratorOnly = async (): Promise<string> => {
    const profile = await h.ctx.prisma.runtimeProfile.create({
      data: {
        runnerId: h.runnerId,
        key: ORCH,
        runtime: 'claude',
        label: 'Orchestrator',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await h.ctx.prisma.projectOrchestratorSettings.create({
      data: { projectId: h.projectId, profileId: profile.id },
    });
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { defaultProfileId: null },
    });
    return profile.id;
  };

  /** Neither an orchestrator profile nor a project default. */
  const noProfile = async (): Promise<void> => {
    await h.ctx.prisma.projectOrchestratorSettings.deleteMany({
      where: { projectId: h.projectId },
    });
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { defaultProfileId: null },
    });
  };

  const NONE = {
    error: 'no_profile',
    reason: 'none',
    source: null,
    message:
      'This project has no runtime profile. An admin sets the default in Settings › General.',
  };

  const cardAction = (number: number, action: string, body: object = {}) =>
    h.author.send('post', `${h.cardPath(number)}/${action}`, body);
  const generate = (number: number) =>
    h.author.send('post', `${h.cardDesignBase(number)}/generate`);
  const createPlan = (body: object = {}) =>
    h.author.send('post', h.base(), {
      brief: 'Plan it',
      mode: 'batch',
      ...body,
    });

  describe('with an orchestrator profile and no default', () => {
    beforeEach(() => orchestratorOnly());

    it('a card design turn runs on the orchestrator profile', async () => {
      await h.seedProfile();
      const card = await h.designedCard();
      expect((await generate(card.number)).status).toBe(201);
      expect(h.sentOf('plan.turn')).toEqual([
        expect.objectContaining({ profileKey: ORCH }),
      ]);
    });

    it('a UI-profile build runs on the orchestrator profile', async () => {
      const card = await h.designedCard();
      expect((await generate(card.number)).status).toBe(201);
      expect(h.designSent('uiprofile.build')).toEqual([
        expect.objectContaining({ profileKey: ORCH }),
      ]);
    });

    it('card Run and feedback run on the orchestrator profile', async () => {
      const card = await h.createCard();
      expect((await cardAction(card.number, 'run')).status).toBe(200);
      expect((await cardAction(card.number, 'finish')).status).toBe(200);
      const feedback = await cardAction(card.number, 'feedback', {
        text: 'Rename the button.',
      });
      expect(feedback.status).toBe(200);
      expect(h.cardSentOf('card.run')).toEqual([
        expect.objectContaining({ profileKey: ORCH }),
        expect.objectContaining({ profileKey: ORCH }),
      ]);
    });

    it('plan create and a plan turn run on the orchestrator profile', async () => {
      const created = await createPlan();
      expect(created.status).toBe(201);
      const plan = await h.ctx.prisma.plan.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(plan.profileKey).toBe(ORCH);
      expect(h.sentOf('plan.turn')).toEqual([
        expect.objectContaining({ profileKey: ORCH }),
      ]);
    });

    it('an explicit key wins over the orchestrator profile', async () => {
      const created = await createPlan({ profileKey: 'claude-main' });
      expect(created.status).toBe(201);
      expect(h.sentOf('plan.turn')).toEqual([
        expect.objectContaining({ profileKey: 'claude-main' }),
      ]);
    });

    it('an unusable orchestrator profile refuses and never falls through to the default', async () => {
      const main = await h.ctx.prisma.runtimeProfile.findFirstOrThrow({
        where: { key: 'claude-main' },
      });
      await h.ctx.prisma.project.update({
        where: { id: h.projectId },
        data: { defaultProfileId: main.id },
      });
      await h.ctx.prisma.runtimeProfile.updateMany({
        where: { key: ORCH },
        data: { missing: true },
      });
      const refused = await createPlan();
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        error: 'no_profile',
        reason: 'missing',
        source: 'orchestrator',
        profileKey: ORCH,
      });
      expect(refused.body.message).toContain('Settings › Orchestrator');
      expect(h.sentOf('plan.turn')).toEqual([]);
    });
  });

  describe('with neither', () => {
    it('a card design turn answers 422 no_profile', async () => {
      await h.seedProfile();
      const card = await h.designedCard();
      await noProfile();
      const refused = await generate(card.number);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject(NONE);
      expect(h.sentOf('plan.turn')).toEqual([]);
    });

    it('a UI-profile build answers 422 no_profile', async () => {
      const card = await h.designedCard();
      await noProfile();
      const refused = await generate(card.number);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject(NONE);
      expect(h.designSent('uiprofile.build')).toEqual([]);
    });

    it('card Run answers 422 no_profile, never unsupported_runtime', async () => {
      await noProfile();
      const card = await h.createCard();
      const refused = await cardAction(card.number, 'run');
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject(NONE);
      expect(h.cardSentOf('card.run')).toEqual([]);
    });

    it('card feedback answers 422 no_profile', async () => {
      const card = await h.createCard();
      expect((await cardAction(card.number, 'run')).status).toBe(200);
      expect((await cardAction(card.number, 'finish')).status).toBe(200);
      await noProfile();
      const refused = await cardAction(card.number, 'feedback', {
        text: 'Again.',
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject(NONE);
      expect(h.cardSentOf('card.run')).toHaveLength(1);
    });

    it('plan create answers 422 no_profile', async () => {
      await noProfile();
      const refused = await createPlan();
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject(NONE);
    });

    it('a plan turn runs on the key its plan stored, and refuses with source explicit once it is unusable', async () => {
      const created = await createPlan();
      expect(created.status).toBe(201);
      await noProfile();
      await h.ctx.prisma.runtimeProfile.updateMany({
        where: { key: 'claude-main' },
        data: { missing: true },
      });
      const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
        where: { planId: created.body.id },
      });
      await h.ctx.prisma.planTurn.update({
        where: { id: turn.id },
        data: { phase: 'failed' },
      });
      const refused = await h.author.send(
        'post',
        `${h.base(created.body.id)}/turns/${turn.id}/retry`,
      );
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        error: 'no_profile',
        reason: 'missing',
        source: 'explicit',
        profileKey: 'claude-main',
      });
    });
  });

  describe('a Codex default profile', () => {
    beforeEach(async () => {
      const codex = await h.ctx.prisma.runtimeProfile.findFirstOrThrow({
        where: { key: 'codex-main' },
      });
      await h.ctx.prisma.project.update({
        where: { id: h.projectId },
        data: { defaultProfileId: codex.id },
      });
    });

    const NOT_CLAUDE = {
      error: 'no_profile',
      reason: 'not_claude',
      source: 'default',
      profileKey: 'codex-main',
    };

    it('card Run answers 422 no_profile naming the profile and Settings › General', async () => {
      const card = await h.createCard();
      const refused = await cardAction(card.number, 'run');
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject(NOT_CLAUDE);
      expect(refused.body.message).toBe(
        'codex-main is a codex profile; this needs a Claude profile. An admin can change the default in Settings › General.',
      );
    });

    it('plan create answers the same', async () => {
      const refused = await createPlan();
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject(NOT_CLAUDE);
      expect(refused.body.message).toContain('Settings › General');
    });
  });
});
