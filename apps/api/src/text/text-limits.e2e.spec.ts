import { TEXT_OFFLINE_GIVE_UP_MS } from '@agentdock/shared';
import { RU_BODY, RU_TITLE, TextWorld, textBlock } from './testing/text-e2e';

describe('text normalization limits and failures (e2e)', () => {
  const w = new TextWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** A Russian card with a person's kind: one request, no kind asked. */
  const russianCard = async (body = RU_BODY) => {
    const card = await w.createCard({ title: RU_TITLE, body, kind: 'feature' });
    return { ...card, row: await w.latest() };
  };

  it('runner offline: backs off 1, 2, 4… minutes, then fails runner_offline after 24 h (D11)', async () => {
    const { row } = await russianCard();
    w.runnerState = 'offline';
    const now = new Date('2026-10-15T12:00:00Z');
    expect(
      await w.normalizer.process({ normalizationId: row.id }, now),
    ).toEqual({
      kind: 'deferred',
      why: 'runner_offline',
      untilMs: now.getTime() + 60_000,
      offlineAttempts: 1,
      offlineSince: now.getTime(),
    });
    const third = await w.normalizer.process(
      {
        normalizationId: row.id,
        offlineAttempts: 2,
        offlineSince: now.getTime(),
      },
      new Date(now.getTime() + 3 * 60_000),
    );
    expect(third).toMatchObject({
      untilMs: now.getTime() + 3 * 60_000 + 4 * 60_000,
    });
    const late = await w.normalizer.process(
      {
        normalizationId: row.id,
        offlineAttempts: 20,
        offlineSince: now.getTime(),
      },
      new Date(now.getTime() + TEXT_OFFLINE_GIVE_UP_MS),
    );
    expect(late).toEqual({ kind: 'failed', reason: 'runner_offline' });
    expect(await w.latest()).toMatchObject({
      status: 'failed',
      failReason: 'runner_offline',
      runId: null,
    });
    expect(w.normalized()).toHaveLength(0);
    const views = await w.views(`cardId=${row.cardId}`);
    expect(views.get('board_card:title')).toMatchObject({
      status: 'not_normalized',
      reason: 'runner_offline',
      retryable: true,
    });
  });

  it('a runner without text.normalize fails runner_unsupported at once', async () => {
    const { row } = await russianCard();
    w.runnerState = 'unsupported';
    expect(await w.process(row.id)).toEqual({
      kind: 'failed',
      reason: 'runner_unsupported',
    });
  });

  it('no Claude profile fails no_profile at once', async () => {
    const { row } = await russianCard();
    await w.ctx.prisma.project.update({
      where: { id: w.a },
      data: { defaultProfileId: null },
    });
    expect(await w.process(row.id)).toEqual({
      kind: 'failed',
      reason: 'no_profile',
    });
    expect(
      await w.ctx.prisma.run.count({ where: { kind: 'text_normalize' } }),
    ).toBe(0);
  });

  it('a run error is retried twice, then fails run_failed; the text stays as typed', async () => {
    const { number, row } = await russianCard();
    w.sendAnswer = { status: 'error', message: 'internal' };
    for (const attempts of [1, 2]) {
      expect(await w.process(row.id)).toMatchObject({ kind: 'failed' });
      expect(await w.latest()).toMatchObject({ status: 'pending', attempts });
    }
    // The third run errors on the runner itself.
    w.sendAnswer = { status: 'ok' };
    const runId = await w.start(row.id);
    await w.finish(runId, '', { ok: false, error: 'timed out after 120 s' });
    expect(await w.latest()).toMatchObject({
      status: 'failed',
      failReason: 'run_failed',
      attempts: 3,
      error: 'runner: timed out after 120 s',
    });
    expect((await w.card(number)).title).toBe(RU_TITLE);
    expect(
      await w.ctx.prisma.run.count({
        where: { kind: 'text_normalize', status: 'failed' },
      }),
    ).toBe(3);
  });

  it('a structural break is a contract_violation and nothing is applied', async () => {
    const { number, row } = await russianCard();
    const runId = await w.start(row.id);
    await w.finish(
      runId,
      textBlock([
        { id: 'title', english: 'Add login' },
        { id: 'body', english: 'Users sign in.' },
        { id: 'extra', english: 'Nope' },
      ]),
    );
    expect(await w.latest()).toMatchObject({
      status: 'failed',
      failReason: 'contract_violation',
      error: expect.stringMatching(/^contract_violation: unknown_field/),
    });
    expect((await w.card(number)).title).toBe(RU_TITLE);

    // A result cut at its limit is one too.
    const second = await russianCard();
    const secondRun = await w.start(second.row.id);
    await w.finish(secondRun, '```agentdock-text\n{"fie', {
      resultTruncated: true,
    });
    expect(await w.latest()).toMatchObject({
      status: 'failed',
      failReason: 'contract_violation',
    });
  });

  it('a lost placeholder rejects only that field; the rest applies (D6)', async () => {
    const { number, row } = await russianCard('Сломана форма `LoginForm`.');
    const runId = await w.start(row.id);
    await w.finish(
      runId,
      textBlock([
        { id: 'title', english: 'Add login' },
        { id: 'body', english: 'The form is broken.' },
      ]),
    );
    const card = await w.card(number);
    expect(card.title).toBe('Add login');
    expect(card.body).toBe('Сломана форма `LoginForm`.');
    expect(w.fields(await w.latest()).map((f) => [f.field, f.outcome])).toEqual(
      [
        ['title', 'translated'],
        ['body', 'rejected'],
      ],
    );
    const views = await w.views(`cardId=${row.cardId}`);
    expect(views.get('board_card:body')).toMatchObject({
      status: 'not_normalized',
      reason: 'rejected',
      retryable: false,
    });
  });

  it('an operator retries a failed request with the current text; a viewer gets 403, a request not failed 409', async () => {
    const { number, row } = await russianCard();
    w.runnerState = 'unsupported';
    await w.process(row.id);
    w.runnerState = 'ready';
    await w.ctx.prisma.boardCard.update({
      where: { id: row.cardId as string },
      data: { title: 'Добавить вход по SSO' },
    });
    const retry = `${w.path()}/text-normalizations/${row.id}/retry`;

    expect((await w.viewer.send('post', retry)).status).toBe(403);
    expect((await w.outsider.send('post', retry)).status).toBe(404);
    expect((await w.operator.send('post', retry)).status).toBe(204);
    const pending = await w.latest();
    expect(pending).toMatchObject({
      id: row.id,
      status: 'pending',
      attempts: 0,
    });
    expect(w.fields(pending)[0].original).toBe('Добавить вход по SSO');
    expect((await w.operator.send('post', retry)).status).toBe(409);

    const runId = await w.start(row.id);
    await w.finish(
      runId,
      textBlock([
        { id: 'title', english: 'Add SSO login' },
        { id: 'body', english: 'Users sign in with a password.' },
      ]),
    );
    expect((await w.card(number)).title).toBe('Add SSO login');
  });

  it('at most two run per project; a third waits', async () => {
    const rows = [];
    for (let i = 0; i < 3; i += 1) rows.push((await russianCard()).row);
    await w.start(rows[0].id);
    await w.start(rows[1].id);
    expect(await w.process(rows[2].id)).toMatchObject({
      kind: 'deferred',
      why: 'busy',
    });
  });

  it('switched off: nothing is requested and pending requests are skipped (D13)', async () => {
    const { row } = await russianCard();
    const off = await w.admin.send('put', `${w.path()}/text-settings`, {
      normalizeEnabled: false,
    });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ normalizeEnabled: false });
    expect(
      await w.ctx.prisma.textNormalization.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({ status: 'skipped', failReason: 'off' });
    expect(await w.audit('text.settings_updated')).toHaveLength(1);

    await russianCard();
    expect(await w.requests()).toHaveLength(1);
    const settings = await w.viewer.get(`${w.path()}/text-settings`);
    expect(settings.body).toMatchObject({ normalizeEnabled: false });
  });
});
