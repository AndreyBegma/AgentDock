import { RU_BODY, textBlock } from '../text/testing/text-e2e';
import { AssessWorld, assessAnswer } from './testing/assess-e2e';

describe('card model assessment (e2e, #322 D5–D8)', () => {
  const w = new AssessWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** The only waiting job runs, and starts its call; its run id. */
  const startOne = async (): Promise<string> => {
    const outcomes = await w.drain();
    const started = outcomes.filter((o) => o.kind === 'started');
    if (started.length !== 1 || started[0].kind !== 'started') {
      throw new Error(`not one start: ${JSON.stringify(outcomes)}`);
    }
    return started[0].runId;
  };

  const detail = async (number: number) => {
    const response = await w.operator.get(`${w.path()}/board/cards/${number}`);
    expect(response.status).toBe(200);
    return response.body;
  };

  it('#445: sends the token saver only to a runner that advertises it', async () => {
    await w.createCard({ kind: 'feature' });
    const off = await startOne();
    expect(w.assessed()[0]).not.toHaveProperty('tokenSaver');
    expect(
      (await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: off } }))
        .tokenSaver,
    ).toBe(false);
    await w.finishAssess(off, assessAnswer('sonnet', 'opus'));

    await w.advertiseTokenSaver();
    await w.createCard({ kind: 'feature', title: 'Add logout' });
    const on = await startOne();
    expect(w.assessed()[1].tokenSaver).toEqual({ enabled: true, mcpAllow: [] });
    expect(
      (await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: on } }))
        .tokenSaver,
    ).toBe(true);
  });

  it('assesses a new card with haiku on the project profile and stores the answer', async () => {
    const { id, number } = await w.createCard({ kind: 'feature' });
    const runId = await startOne();

    const run = await w.ctx.prisma.run.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run).toMatchObject({
      kind: 'card_assess',
      projectId: w.a,
      runtime: 'claude',
      model: 'haiku',
      profileKey: 'claude-main',
      status: 'running',
    });
    const [sent] = w.assessed();
    expect(sent).toMatchObject({
      runId,
      projectId: w.a,
      model: 'haiku',
      profileKey: 'claude-main',
    });
    expect(sent.prompt).toContain('"title": "Add login"');
    expect((await w.card(number)).assessRunId).toBe(runId);

    await w.finishAssess(runId, assessAnswer('sonnet', 'opus', {}, 'low'));
    const card = await w.card(number);
    expect(card).toMatchObject({
      id,
      recommendedModel: 'sonnet',
      recommendedEffort: 'low',
      recommendedReason: 'Work fits sonnet.',
      recommendedDesignModel: 'opus',
      recommendedDesignReason: 'Design fits opus.',
      assessedAt: expect.any(Date),
    });
    expect(card.assessmentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({
      status: 'succeeded',
      outcome: 'work sonnet low · design opus',
    });
    expect((await detail(number)).recommendation).toEqual({
      work: {
        model: 'sonnet',
        effort: 'low',
        reason: 'Work fits sonnet.',
        class: 'mechanical',
        signals: [],
      },
      design: { model: 'opus', reason: 'Design fits opus.' },
      assessedAt: expect.any(String),
    });

    // The same input is never asked again.
    await w.assessor.request(id);
    expect(await w.waiting()).toEqual([]);
  });

  it('stores the class, and a deciding signal makes it deciding (#750 D1, D2)', async () => {
    const { number } = await w.createCard({ kind: 'feature' });
    const answer = (signals: string[]) =>
      JSON.stringify({
        work: {
          model: 'sonnet',
          effort: 'low',
          class: 'mechanical',
          signals,
          reason: 'Work fits sonnet.',
        },
        design: { model: 'opus', reason: 'Design fits opus.' },
      });
    await w.finishAssess(await startOne(), answer(['auth']));
    expect(await w.card(number)).toMatchObject({
      workClass: 'deciding',
      workSignals: ['auth'],
    });

    // In the B arm the card shows the mapping: deciding is opus at high.
    await w.modelByType('on');
    expect((await detail(number)).recommendation.work).toMatchObject({
      model: 'opus',
      effort: 'high',
      class: 'deciding',
      signals: ['auth'],
    });

    await w.operator.send('patch', `${w.path()}/board/cards/${number}`, {
      body: 'Users sign in with a passkey.',
    });
    await w.finishAssess(await startOne(), answer([]));
    expect(await w.card(number)).toMatchObject({
      workClass: 'mechanical',
      workSignals: [],
    });
  });

  it('an answer without class or signals is out of contract and stores no class (#750 D1)', async () => {
    const { number } = await w.createCard({ kind: 'feature' });
    const runId = await startOne();
    await w.finishAssess(
      runId,
      JSON.stringify({
        work: { model: 'sonnet', effort: 'low', reason: 'Fits.' },
        design: { model: 'opus', reason: 'Fits.' },
      }),
    );
    expect((await w.card(number)).workClass).toBeNull();
    expect(
      (await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } }))
        .status,
    ).toBe('failed');
  });

  it('an edited body makes exactly one card_assess run, after its normalization settles', async () => {
    const { number } = await w.createCard({ kind: 'feature' });
    await w.finishAssess(await startOne(), assessAnswer());

    const edited = await w.operator.send(
      'patch',
      `${w.path()}/board/cards/${number}`,
      { body: RU_BODY },
    );
    expect(edited.status).toBe(200);
    // The text is still being normalized: the job asks nothing.
    expect(await w.drain()).toEqual([{ kind: 'none', why: 'normalizing' }]);
    expect(await w.assessRuns()).toHaveLength(1);

    const row = await w.latest();
    const textRun = await w.start(row.id);
    await w.finish(
      textRun,
      textBlock([{ id: 'body', english: 'Users sign in with a password.' }]),
    );
    const runId = await startOne();
    expect(await w.assessRuns()).toHaveLength(2);
    // It assessed the English text.
    expect(w.assessed().at(-1)?.prompt).toContain(
      'Users sign in with a password.',
    );
    await w.finishAssess(runId, assessAnswer('opus', 'sonnet'));
    expect(await w.card(number)).toMatchObject({
      recommendedModel: 'opus',
      recommendedDesignModel: 'sonnet',
    });
  });

  it('discards an answer once the card was edited while it ran (hash gate)', async () => {
    const { number } = await w.createCard({ kind: 'feature' });
    const first = await startOne();
    const edited = await w.operator.send(
      'patch',
      `${w.path()}/board/cards/${number}`,
      { body: 'Users sign in with a passkey.' },
    );
    expect(edited.status).toBe(200);

    await w.finishAssess(first, assessAnswer('haiku', 'sonnet'));
    const card = await w.card(number);
    expect(card.recommendedModel).toBeNull();
    expect(card.assessmentHash).toBeNull();
    expect(
      await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: first } }),
    ).toMatchObject({ status: 'succeeded', outcome: 'superseded' });

    // The edit's own call decides.
    const second = await startOne();
    await w.finishAssess(second, assessAnswer('opus', 'opus'));
    expect((await w.card(number)).recommendedModel).toBe('opus');
  });

  it.each([
    ['prose', 'I would pick sonnet.'],
    ['fable for work', assessAnswer('fable', 'opus')],
    ['haiku for design', assessAnswer('sonnet', 'haiku')],
    ['an extra key', assessAnswer('sonnet', 'opus', { effort: 'high' })],
  ])('an answer out of contract (%s) stores nothing and fails the run', async (_, result) => {
    const { number } = await w.createCard({ kind: 'feature' });
    const runId = await startOne();
    await w.finishAssess(runId, result);
    const card = await w.card(number);
    expect(card.recommendedModel).toBeNull();
    expect(card.recommendedDesignModel).toBeNull();
    expect(card.assessmentHash).toBeNull();
    const run = await w.ctx.prisma.run.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run.status).toBe('failed');
    expect(run.outcome).toMatch(/^contract_violation/);
    expect((await detail(number)).recommendation).toEqual({
      work: null,
      design: null,
      assessedAt: null,
    });
  });

  it('a failed or truncated run stores nothing', async () => {
    const { number } = await w.createCard({ kind: 'feature' });
    const runId = await startOne();
    await w.finishAssess(runId, '', { ok: false, error: 'claude exited 1' });
    expect(
      await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({ status: 'failed', outcome: 'runner: claude exited 1' });

    await w.operator.send('patch', `${w.path()}/board/cards/${number}`, {
      body: 'Users sign in with a passkey.',
    });
    const truncated = await startOne();
    await w.finishAssess(truncated, assessAnswer(), { resultTruncated: true });
    expect(
      await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: truncated } }),
    ).toMatchObject({ status: 'failed' });
    expect((await w.card(number)).recommendedModel).toBeNull();
  });

  it.each([
    ['offline', 'runner offline'],
    ['unsupported', 'runner unsupported'],
  ] as const)('a runner %s yields no call and no run', async (state, why) => {
    w.assessState = state;
    await w.createCard({ kind: 'feature' });
    expect(await w.drain()).toEqual([{ kind: 'none', why }]);
    expect(w.assessed()).toHaveLength(0);
    expect(await w.assessRuns()).toHaveLength(0);
  });

  it('a project without a Claude profile yields no call (D7)', async () => {
    await w.ctx.prisma.project.update({
      where: { id: w.a },
      data: { defaultProfileId: null },
    });
    await w.createCard({ kind: 'feature' });
    expect(await w.drain()).toEqual([{ kind: 'none', why: 'no_profile' }]);
    expect(await w.assessRuns()).toHaveLength(0);
  });

  it('a send the runner refuses fails the run', async () => {
    w.assessSend = { status: 'error', message: 'unknown_command' };
    const { number } = await w.createCard({ kind: 'feature' });
    expect(await w.drain()).toEqual([{ kind: 'none', why: 'run_failed' }]);
    const [run] = await w.assessRuns();
    expect(run).toMatchObject({ status: 'failed' });
    expect((await w.card(number)).recommendedModel).toBeNull();
  });

  it('runs at most two per project, and none while a round of the card is active (D8)', async () => {
    const one = await w.createCard({ title: 'One', kind: 'feature' });
    const two = await w.createCard({ title: 'Two', kind: 'feature' });
    const three = await w.createCard({ title: 'Three', kind: 'feature' });
    const outcomes = await w.drain();
    expect(outcomes.map((o) => o.kind).sort()).toEqual([
      'deferred',
      'started',
      'started',
    ]);
    expect(outcomes.find((o) => o.kind === 'deferred')).toMatchObject({
      why: 'busy',
    });

    expect((await w.runCard(one.number)).status).toBe(200);
    await w.operator.send('patch', `${w.path()}/board/cards/${one.number}`, {
      body: 'Users sign in with a passkey.',
    });
    expect(await w.drain()).toEqual([
      expect.objectContaining({ kind: 'deferred', why: 'round_active' }),
    ]);
    expect(two.number).not.toBe(three.number);
  });
});
