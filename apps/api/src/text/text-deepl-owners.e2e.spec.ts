import type { TextOwnerType } from '@agentdock/shared';
import { CardDesignHarness } from '../design/testing/card-design-e2e';
import { designResult } from '../design/testing/design-e2e';
import { decomposed, task } from '../planner/testing/planner-e2e';
import { FAKE_DEEPL_KEY, FakeDeepL } from './testing/deepl-e2e';
import { TextCommands } from './text-commands';

// #324: the app starts with a key, and the fake answers every DeepL call.
process.env.DEEPL_API_KEY = FAKE_DEEPL_KEY;

/**
 * #324 D1: every owner of ADR-0027 §1 answers the save that wrote its text
 * with the English text, translated by DeepL inside the save — and the next
 * prompt built from it is English too.
 */
describe('DeepL at save time, every owner (e2e)', () => {
  const h = new CardDesignHarness();
  const deepl = new FakeDeepL();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(async () => {
    await h.reset();
    const commands = h.ctx.app.get(TextCommands);
    jest.spyOn(commands, 'state').mockReturnValue('ready');
    jest
      .spyOn(commands, 'normalize')
      .mockResolvedValue({ status: 'ok' as const });
    deepl.reset();
    deepl.install();
  });
  afterEach(() => jest.restoreAllMocks());

  const latest = (ownerType: TextOwnerType) =>
    h.ctx.prisma.textNormalization.findFirstOrThrow({
      where: { projectId: h.projectId, ownerType },
      orderBy: { createdAt: 'desc' },
    });

  const planPath = (planId: string, rest = '') =>
    `/projects/${h.projectId}/plans/${planId}${rest}`;

  const noTextRuns = async () =>
    expect(
      await h.ctx.prisma.run.count({ where: { kind: 'text_normalize' } }),
    ).toBe(0);

  it("a round's feedback", async () => {
    deepl.dictionary.set('Переименуйте кнопку.', 'Rename the button.');
    const card = await h.createCard({ kind: 'feature' });
    await h.author.send('post', `${h.cardPath(card.number)}/run`, {});
    await h.author.send('post', `${h.cardPath(card.number)}/finish`, {});
    const response = await h.author.send(
      'post',
      `${h.cardPath(card.number)}/feedback`,
      { text: 'Переименуйте кнопку.' },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain('Rename the button.');
    expect(JSON.stringify(response.body)).not.toContain('Переименуйте');
    expect(await latest('board_card_round')).toMatchObject({
      status: 'done',
      engine: 'deepl',
    });
    await noTextRuns();
  });

  it("a comment on a card's design", async () => {
    deepl.dictionary.set('Сделайте кнопку крупнее.', 'Make the button larger.');
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
    expect(JSON.stringify(posted.body)).toContain('Make the button larger.');
    expect(JSON.stringify(posted.body)).not.toContain('Сделайте');
    expect(await latest('design_comment')).toMatchObject({
      status: 'done',
      engine: 'deepl',
    });
  });

  it('a plan brief: the first turn and the response are English', async () => {
    deepl.dictionary.set('Сделать экспорт', 'Build an export');
    deepl.dictionary.set('в CSV и JSON', 'to CSV and JSON');
    const created = await h.author.send(
      'post',
      `/projects/${h.projectId}/plans`,
      { brief: 'Сделать экспорт\nв CSV и JSON', mode: 'batch' },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      brief: 'Build an export\nto CSV and JSON',
      title: 'Build an export',
    });
    const prompt = h.turnPrompts().at(-1) ?? '';
    expect(prompt).toContain('Build an export');
    expect(prompt).not.toContain('Сделать');
    await noTextRuns();
  });

  it("a task's review comment", async () => {
    deepl.dictionary.set(
      'Разделите на две задачи.',
      'Split it into two tasks.',
    );
    const plan = await decomposed(h, [task('t1')]);
    const reviewed = await h.author.send(
      'post',
      planPath(plan.id, '/tasks/t1/review'),
      { decision: 'rewrite', comment: 'Разделите на две задачи.' },
    );
    expect(reviewed.status).toBeLessThan(300);
    expect(JSON.stringify(reviewed.body)).toContain('Split it into two tasks.');
    expect(JSON.stringify(reviewed.body)).not.toContain('Разделите');
  });

  it("a turn's message and answers", async () => {
    deepl.dictionary.set('Нужен ещё XML.', 'XML is needed too.');
    deepl.dictionary.set('Только для админов.', 'Admins only.');
    const plan = await h.createPlan('dialogue');
    await h.finish(plan.id, '', { phase: 'failed' });
    const sent = await h.author.send('post', planPath(plan.id, '/turns'), {
      message: 'Нужен ещё XML.',
      answers: [{ questionId: 'q1', text: 'Только для админов.' }],
    });
    expect(sent.status).toBeLessThan(300);
    const turn = await h.activeTurn(plan.id);
    const stored = await h.ctx.prisma.planTurn.findUniqueOrThrow({
      where: { id: turn.id },
    });
    expect(stored.input).toEqual({
      message: 'XML is needed too.',
      answers: [{ questionId: 'q1', text: 'Admins only.' }],
    });
    expect(await latest('plan_turn')).toMatchObject({
      status: 'done',
      engine: 'deepl',
    });
  });
});
