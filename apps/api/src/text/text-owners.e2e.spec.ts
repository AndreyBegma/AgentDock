import type { TextOwnerType } from '@nautelle/shared';
import { CardDesignHarness } from '../design/testing/card-design-e2e';
import { designResult } from '../design/testing/design-e2e';
import { decomposed, task } from '../planner/testing/planner-e2e';
import { textBlock } from './testing/text-e2e';
import { TextCommands } from './text-commands';
import { TextNormalizer } from './text-normalizer';

/**
 * Every owner of D1 other than the card itself: its text is requested on
 * save, the English result replaces the column, and the next prompt built
 * from it is English.
 */
describe('text normalization of every owner (e2e)', () => {
  const h = new CardDesignHarness();
  let normalizer: TextNormalizer;

  beforeAll(async () => {
    await h.start();
    normalizer = h.ctx.app.get(TextNormalizer);
  });
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    const commands = h.ctx.app.get(TextCommands);
    jest.spyOn(commands, 'state').mockReturnValue('ready');
    jest
      .spyOn(commands, 'normalize')
      .mockResolvedValue({ status: 'ok' as const });
  });
  afterEach(() => jest.restoreAllMocks());

  /** Runs the owner type's pending request and answers it with `english`. */
  const translate = async (
    ownerType: TextOwnerType,
    english: Record<string, string>,
  ) => {
    const row = await h.ctx.prisma.textNormalization.findFirstOrThrow({
      where: { projectId: h.projectId, ownerType, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    const outcome = await normalizer.process({ normalizationId: row.id });
    if (outcome.kind !== 'started') throw new Error(outcome.kind);
    await h.sinks.dispatch(h.runnerId, [
      h.event('text_normalize.finished', {
        runId: outcome.runId,
        projectId: h.projectId,
        ok: true,
        at: new Date().toISOString(),
        result: textBlock(
          Object.entries(english).map(([id, text]) => ({
            id,
            english: text,
          })),
        ),
      }),
    ]);
    return h.ctx.prisma.textNormalization.findUniqueOrThrow({
      where: { id: row.id },
    });
  };

  const planPath = (planId: string, rest = '') =>
    `/projects/${h.projectId}/plans/${planId}${rest}`;

  /** Ends the plan's active turn as failed, so it can be retried. */
  const failTurn = (planId: string) =>
    h.finish(planId, '', { phase: 'failed' });

  it("a round's feedback", async () => {
    const card = await h.createCard({ kind: 'feature' });
    await h.author.send('post', `${h.cardPath(card.number)}/run`, {});
    await h.author.send('post', `${h.cardPath(card.number)}/finish`, {});
    const response = await h.author.send(
      'post',
      `${h.cardPath(card.number)}/feedback`,
      { text: 'Переименуйте кнопку.' },
    );
    expect(response.status).toBe(200);
    // D3: the round started with the feedback as typed.
    const [, second] = h.cardSentOf('card.run');
    expect(String(second.prompt)).toContain('Переименуйте кнопку.');

    const row = await translate('board_card_round', {
      feedback: 'Rename the button.',
    });
    expect(row.status).toBe('done');
    const round = await h.ctx.prisma.boardCardRound.findFirstOrThrow({
      where: { cardId: card.id, round: 2 },
    });
    expect(round.feedback).toBe('Rename the button.');
    const views = await h.author.get(
      `/projects/${h.projectId}/text-normalizations?cardId=${card.id}`,
    );
    expect(views.body.fields).toContainEqual(
      expect.objectContaining({
        ownerType: 'board_card_round',
        ownerId: round.id,
        field: 'feedback',
        status: 'normalized',
        original: 'Переименуйте кнопку.',
      }),
    );
  });

  it("a comment on a card's design; Revise reads it in English", async () => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    await h.author.send('post', `${h.cardDesignBase(card.number)}/generate`);
    await h.finishCard(
      card.id,
      designResult({ taskKey: 'card-1', variant: 1 }),
    );
    const revision = await h.ctx.prisma.designRevision.findFirstOrThrow({
      where: { design: { cardId: card.id } },
    });
    const posted = await h.author.send(
      'post',
      `${h.cardDesignBase(card.number)}/comments`,
      {
        revisionId: revision.id,
        kind: 'general',
        body: 'Сделайте кнопку крупнее.',
      },
    );
    expect(posted.status).toBeLessThan(300);
    await translate('design_comment', { body: 'Make the button larger.' });
    const comment = await h.ctx.prisma.designComment.findFirstOrThrow({
      where: { revisionId: revision.id },
    });
    expect(comment.body).toBe('Make the button larger.');

    await h.author.send('post', `${h.cardDesignBase(card.number)}/revise`);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('Make the button larger.');
    expect(prompt).not.toContain('Сделайте');
  });

  it("a comment on a plan task's design; the plan view shows its original", async () => {
    await h.seedProfile();
    const plan = await decomposed(h, [
      task('t1', {
        design: { needed: true, why: 'A new screen.', variants: 1 },
      }),
    ]);
    const base = h.designBase(plan.id, 't1');
    expect((await h.author.send('post', `${base}/generate`)).status).toBe(201);
    await h.finish(plan.id, designResult({ taskKey: 't1', variant: 1 }));
    const revision = await h.ctx.prisma.designRevision.findFirstOrThrow({
      where: { design: { planId: plan.id, taskKey: 't1' } },
    });
    const posted = await h.author.send('post', `${base}/comments`, {
      revisionId: revision.id,
      kind: 'general',
      body: 'Добавьте фильтр по дате.',
    });
    expect(posted.status).toBeLessThan(300);
    await translate('design_comment', { body: 'Add a date filter.' });
    const comment = await h.ctx.prisma.designComment.findFirstOrThrow({
      where: { revisionId: revision.id },
    });
    expect(comment.body).toBe('Add a date filter.');
    const views = await h.author.get(
      `/projects/${h.projectId}/text-normalizations?planId=${plan.id}`,
    );
    expect(views.body.fields).toContainEqual(
      expect.objectContaining({
        ownerType: 'design_comment',
        ownerId: comment.id,
        status: 'normalized',
        original: 'Добавьте фильтр по дате.',
      }),
    );

    await h.author.send('post', `${base}/revise`);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('Add a date filter.');
    expect(prompt).not.toContain('Добавьте');
  });

  it('a plan brief, and the title derived from it; a retried turn reads it in English', async () => {
    const created = await h.author.send(
      'post',
      `/projects/${h.projectId}/plans`,
      {
        brief: 'Сделать экспорт\nв CSV и JSON',
        mode: 'batch',
      },
    );
    expect(created.status).toBe(201);
    const planId = created.body.id as string;
    expect(created.body.title).toBe('Сделать экспорт');

    await translate('plan', { brief: 'Build an export\nto CSV and JSON' });
    const plan = await h.ctx.prisma.plan.findUniqueOrThrow({
      where: { id: planId },
    });
    expect(plan).toMatchObject({
      brief: 'Build an export\nto CSV and JSON',
      title: 'Build an export',
    });

    const turn = await h.activeTurn(planId);
    await failTurn(planId);
    const retried = await h.author.send(
      'post',
      planPath(planId, `/turns/${turn.id}/retry`),
    );
    expect(retried.status).toBeLessThan(300);
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('Build an export');
    expect(prompt).not.toContain('Сделать');
  });

  it("a task's review comment; Revise reads it in English", async () => {
    const plan = await decomposed(h, [task('t1')]);
    const reviewed = await h.author.send(
      'post',
      planPath(plan.id, '/tasks/t1/review'),
      { decision: 'rewrite', comment: 'Разделите на две задачи.' },
    );
    expect(reviewed.status).toBeLessThan(300);
    await translate('plan_task', {
      rewriteComment: 'Split it into two tasks.',
    });
    const stored = await h.ctx.prisma.planTask.findFirstOrThrow({
      where: { planId: plan.id, key: 't1' },
    });
    expect(stored.rewriteComment).toBe('Split it into two tasks.');

    await h.author.send('post', planPath(plan.id, '/revise'));
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('Split it into two tasks.');
    expect(prompt).not.toContain('Разделите');
  });

  it("a turn's message and answers; a retried turn reads them in English", async () => {
    const plan = await h.createPlan('dialogue');
    await failTurn(plan.id);
    const sent = await h.author.send('post', planPath(plan.id, '/turns'), {
      message: 'Нужен ещё XML.',
      answers: [{ questionId: 'q1', text: 'Только для админов.' }],
    });
    expect(sent.status).toBeLessThan(300);
    const turn = await h.activeTurn(plan.id);

    const row = await translate('plan_turn', {
      message: 'XML is needed too.',
      'answers.q1': 'Admins only.',
    });
    expect(row.turnId).toBe(turn.id);
    const stored = await h.ctx.prisma.planTurn.findUniqueOrThrow({
      where: { id: turn.id },
    });
    expect(stored.input).toEqual({
      message: 'XML is needed too.',
      answers: [{ questionId: 'q1', text: 'Admins only.' }],
    });

    await failTurn(plan.id);
    await h.author.send('post', planPath(plan.id, `/turns/${turn.id}/retry`));
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('XML is needed too.');
    expect(prompt).toContain('Admins only.');
    expect(prompt).not.toContain('Нужен');
  });
});
