import { CaptureWorld, cardsBlock, LONG_PROMPT } from './testing/capture-e2e';

describe('card capture runs (e2e)', () => {
  const w = new CaptureWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** Starts one extraction of a fresh manual session. */
  const start = async () => {
    const sessionId = await w.manualSession();
    await w.prompt('m1', LONG_PROMPT);
    const outcome = await w.capture.extract({ sessionId });
    if (outcome.kind !== 'started') throw new Error(outcome.kind);
    const [content] = await w.content(sessionId);
    return { ...outcome, sessionId, contentId: String(content.id) };
  };

  it('each extraction is a card_capture run, triggered by capture', async () => {
    const { runId, captureId } = await start();
    const run = await w.ctx.prisma.run.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(run).toMatchObject({
      kind: 'card_capture',
      triggeredByType: 'capture',
      triggeredById: null,
      status: 'running',
      runtime: 'claude',
      model: 'haiku',
      profileKey: 'claude-main',
      endedAt: null,
    });
    const capture = await w.ctx.prisma.cardCapture.findUniqueOrThrow({
      where: { id: captureId },
    });
    const [sent] = w.extracted();
    expect(sent).toMatchObject({
      runId,
      sessionId: capture.extractSessionId,
    });

    await w.finish(runId, cardsBlock([]));
    expect(
      await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({ status: 'succeeded', endedAt: expect.any(Date) });
    expect(
      await w.ctx.prisma.cardCapture.findUniqueOrThrow({
        where: { id: captureId },
      }),
    ).toMatchObject({ status: 'succeeded', suggested: 0 });
  });

  it('shows the run with its cost in History and in the captures list', async () => {
    const { runId, captureId } = await start();
    const capture = await w.ctx.prisma.cardCapture.findUniqueOrThrow({
      where: { id: captureId },
    });
    // The extraction's own Claude session, in the run directory outside
    // every root: no projectId, matched by its id on the project's runner.
    const session = await w.ctx.prisma.agentSession.create({
      data: {
        runnerId: w.runnerId,
        runtime: 'claude',
        externalId: capture.extractSessionId as string,
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
        input: 1000,
        output: 50,
        costUsd: '0.004200',
      },
    });
    await w.finish(runId, cardsBlock([]));

    const history = await w.operator.get(`${w.path()}/runs?kind=card_capture`);
    expect(history.status).toBe(200);
    const run = (
      history.body.items as { id: string; kind: string; usage: unknown }[]
    ).find((r) => r.id === runId);
    expect(run).toMatchObject({
      kind: 'card_capture',
      usage: { requests: 1, costUsd: '0.004200' },
    });

    const list = await w.operator.get(`${w.path()}/board/captures`);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        id: captureId,
        runId,
        status: 'succeeded',
        costUsd: '0.004200',
      }),
    ]);
  });

  it('with no runtime profile, stores a no_profile skip and creates no run (#272 D8)', async () => {
    await w.ctx.prisma.projectOrchestratorSettings.deleteMany({
      where: { projectId: w.a },
    });
    await w.ctx.prisma.project.update({
      where: { id: w.a },
      data: { defaultProfileId: null },
    });
    const sessionId = await w.manualSession();
    await w.prompt('m1', LONG_PROMPT);
    const outcome = await w.capture.extract({ sessionId });
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'no_profile' });
    expect(
      await w.ctx.prisma.cardCapture.findMany({ where: { projectId: w.a } }),
    ).toEqual([
      expect.objectContaining({
        status: 'skipped',
        skipReason: 'no_profile',
        error: null,
        runId: null,
      }),
    ]);
    expect(
      await w.ctx.prisma.run.count({ where: { kind: 'card_capture' } }),
    ).toBe(0);
    expect(w.extracted()).toEqual([]);
  });

  it('a contract violation stores the error and the result, and applies nothing', async () => {
    const { runId, captureId, contentId } = await start();
    const two = `${cardsBlock([])}\n${cardsBlock([
      { title: 'Sneaky', evidence: [contentId] },
    ])}`;
    await w.finish(runId, two);
    const capture = await w.ctx.prisma.cardCapture.findUniqueOrThrow({
      where: { id: captureId },
    });
    expect(capture).toMatchObject({
      status: 'failed',
      suggested: 0,
      resultText: two,
    });
    expect(capture.error).toMatch(/^contract_violation: multiple_blocks/);
    expect(await w.inbox()).toEqual([]);
    expect(
      await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } }),
    ).toMatchObject({ status: 'failed' });
    // Not retried: the same input would break it again.
    expect(await w.queue.getJob(`capture-retry-${captureId}`)).toBeUndefined();
  });

  it('an evidence id outside the input is a contract violation', async () => {
    const { runId, captureId } = await start();
    await w.finish(
      runId,
      cardsBlock([{ title: 'Made up', evidence: ['999999'] }]),
    );
    const capture = await w.ctx.prisma.cardCapture.findUniqueOrThrow({
      where: { id: captureId },
    });
    expect(capture.error).toMatch(/^contract_violation: unknown_evidence/);
    expect(await w.inbox()).toEqual([]);
  });

  it('a runner failure fails the run and queues one retry', async () => {
    const { runId, captureId } = await start();
    await w.finish(runId, '', { ok: false, error: 'timeout after 180 s' });
    expect(
      await w.ctx.prisma.cardCapture.findUniqueOrThrow({
        where: { id: captureId },
      }),
    ).toMatchObject({ status: 'failed', error: 'runner: timeout after 180 s' });
    expect(
      (await w.queue.getJob(`capture-retry-${captureId}`))?.data,
    ).toMatchObject({ retryOf: captureId });
  });

  it('applies a result once: a replayed event changes nothing', async () => {
    const { runId, contentId } = await start();
    const result = cardsBlock([{ title: 'Only once', evidence: [contentId] }]);
    await w.finish(runId, result);
    await w.finish(runId, result);
    expect((await w.inbox()).map((c) => c.title)).toEqual(['Only once']);
  });

  it('ignores a result from another runner', async () => {
    const { runId, captureId, contentId } = await start();
    const other = await w.ctx.prisma.runner.create({
      data: { name: 'other', tokenHash: 'x'.repeat(64) },
    });
    await w.sinks.dispatch(other.id, [
      {
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        type: 'cards_extract.finished',
        source: 'runner',
        data: {
          runId,
          projectId: w.a,
          ok: true,
          at: new Date().toISOString(),
          result: cardsBlock([{ title: 'Forged', evidence: [contentId] }]),
        },
      },
    ]);
    expect(await w.inbox()).toEqual([]);
    expect(
      (
        await w.ctx.prisma.cardCapture.findUniqueOrThrow({
          where: { id: captureId },
        })
      ).status,
    ).toBe('running');
  });
});
