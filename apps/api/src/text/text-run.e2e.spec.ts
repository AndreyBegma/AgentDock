import { RU_BODY, RU_TITLE, TextWorld, textBlock } from './testing/text-e2e';

describe('text normalization runs (e2e)', () => {
  const w = new TextWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const textRuns = () =>
    w.ctx.prisma.run.findMany({ where: { kind: 'text_normalize' } });

  it('an English save makes no text_normalize run (D5)', async () => {
    const { id } = await w.createCard({
      title: 'Add login',
      body: 'Users sign in with a password and stay signed in for a week.',
      kind: 'feature',
    });
    const row = await w.latest();
    expect(row).toMatchObject({ cardId: id, status: 'done', runId: null });
    expect(w.fields(row).map((f) => f.outcome)).toEqual([
      'already_english',
      'already_english',
    ]);
    expect(await textRuns()).toHaveLength(0);
    expect(w.normalized()).toHaveLength(0);
    const views = await w.views(`cardId=${id}`);
    expect(views.get('board_card:title')?.status).toBe('english');
  });

  it('a non-English save makes exactly one run, priced in History', async () => {
    await w.createCard({ title: RU_TITLE, body: RU_BODY, kind: 'feature' });
    const row = await w.latest();
    const runId = await w.start(row.id);
    const run = await w.ctx.prisma.run.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run).toMatchObject({
      kind: 'text_normalize',
      projectId: w.a,
      runtime: 'claude',
      model: 'haiku',
      profileKey: 'claude-main',
      status: 'running',
      triggeredByType: 'user',
      triggeredById: w.operatorId,
    });
    const started = await w.ctx.prisma.textNormalization.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(started).toMatchObject({ status: 'running', runId });
    const [sent] = w.normalized();
    expect(sent.sessionId).toBe(started.sessionId);

    // The run's own Claude session, in a run directory outside every root.
    const session = await w.ctx.prisma.agentSession.create({
      data: {
        runnerId: w.runnerId,
        runtime: 'claude',
        externalId: started.sessionId as string,
        cwd: '/home/dev/.agentdock/runs/x',
        origin: 'unknown',
        startedAt: new Date(),
        lastEventAt: new Date(),
      },
    });
    await w.ctx.prisma.llmRequest.create({
      data: {
        sessionId: session.id,
        requestId: 'q1',
        ts: new Date(),
        model: 'claude-haiku-5-5',
        querySource: 'main',
        input: 300,
        output: 40,
        costUsd: '0.000900',
      },
    });
    await w.finish(
      runId,
      textBlock([
        { id: 'title', english: 'Add login' },
        { id: 'body', english: 'Users sign in with a password.' },
      ]),
    );

    expect(await textRuns()).toHaveLength(1);
    expect(
      await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({
      status: 'succeeded',
      endedAt: expect.any(Date),
      outcome: '2 translated',
    });
    const history = await w.operator.get(
      `${w.path()}/runs?kind=text_normalize`,
    );
    expect(history.status).toBe(200);
    expect(history.body.items).toEqual([
      expect.objectContaining({
        id: runId,
        kind: 'text_normalize',
        usage: expect.objectContaining({ requests: 1, costUsd: '0.000900' }),
      }),
    ]);
  });

  it('a result delivered twice is applied once', async () => {
    const { number } = await w.createCard({ title: RU_TITLE, kind: 'bug' });
    const row = await w.latest();
    const runId = await w.start(row.id);
    const block = textBlock([{ id: 'title', english: 'Add login' }]);
    await w.finish(runId, block);
    await w.ctx.prisma.boardCard.update({
      where: { id: row.cardId as string },
      data: { title: 'Вход' },
    });
    await w.finish(runId, block);
    expect((await w.card(number)).title).toBe('Вход');
  });
});
