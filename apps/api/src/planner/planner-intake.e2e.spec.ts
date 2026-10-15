import {
  CARD_DRAFT_SECTIONS,
  PLANNER_INTAKE_CONTRACT,
  PLANNER_INTAKE_MAX_ROUNDS,
  type PlanDetail,
} from '@agentdock/shared';
import { block, PlannerHarness, question } from './testing/planner-e2e';

/** #337 D1–D6, D9, D10: New Card is a `card` plan that interviews, then writes one card. */

const RUSSIAN_BRIEF =
  'Нужна выгрузка доски в CSV из меню доски, чтобы менеджер мог открыть её в Excel.';

const ruQuestion = (id: string, multiple = false) => ({
  id,
  title: 'Какие поля',
  question: 'Какие поля попадают в выгрузку?',
  options: [
    { id: 'title', label: 'Заголовок' },
    { id: 'column', label: 'Колонка' },
    { id: 'cost', label: 'Стоимость' },
  ],
  ...(multiple ? { multiple: true } : {}),
  recommendation: {
    optionId: 'title',
    text: 'Заголовок',
    why: 'Это минимум.',
  },
  blocking: false,
});

const ENGLISH_BODY = [
  '## What to do',
  '',
  'Let a person export the board as a CSV file from the board menu.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] The export holds every card of the board with its column.',
  '- [ ] A viewer can export as well.',
  '',
  '## Out of scope',
  '',
  'Importing a CSV file back into the board.',
  '',
  '## Open questions',
  '',
  '- Which delimiter? Default taken: a comma.',
].join('\n');

const RUSSIAN_BODY = [
  '## What to do',
  '',
  'Добавить выгрузку доски в файл CSV из меню доски для менеджера.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] В выгрузке есть все карточки доски вместе с их колонками.',
  '',
  '## Out of scope',
  '',
  'Загрузка файла обратно на доску не нужна.',
  '',
  '## Open questions',
  '',
  'Нет.',
].join('\n');

const card = (over: Record<string, unknown> = {}) => ({
  action: 'intake',
  cardDraft: {
    title: 'Export the board as CSV',
    kind: 'feature',
    body: ENGLISH_BODY,
    ...over,
  },
});

const roundOf = (...questions: object[]) => ({ action: 'intake', questions });

describe('card intake (e2e, #337)', () => {
  const h = new PlannerHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const start = async (
    body: Record<string, unknown> = {},
    session = h.author,
  ) => {
    const response = await session.send('post', h.base(), {
      brief: RUSSIAN_BRIEF,
      mode: 'card',
      ...body,
    });
    expect(response.status).toBe(201);
    return response.body as PlanDetail;
  };

  const turn = (planId: string, body: object) =>
    h.author.send('post', `${h.base(planId)}/turns`, body);

  const prompts = () =>
    h.sentOf('plan.turn').map((args) => String(args.prompt));

  const cardOf = (planId: string) =>
    h.ctx.prisma.boardCard.findFirst({ where: { planId } });

  it('starts a card plan whose first intake turn runs on the account’s planning model, the brief as typed', async () => {
    const plan = await start();
    expect(plan).toMatchObject({
      mode: 'card',
      status: 'clarifying',
      model: 'sonnet',
      intake: { roundsAsked: 0, maxRounds: PLANNER_INTAKE_MAX_ROUNDS },
    });
    const [args] = h.sentOf('plan.turn');
    expect(args.model).toBe('sonnet');
    expect(args).not.toHaveProperty('attachments');
    const prompt = String(args.prompt);
    expect(prompt.startsWith('# Card intake instructions')).toBe(true);
    expect(prompt).toContain(PLANNER_INTAKE_CONTRACT.trim());
    expect(prompt).toContain(RUSSIAN_BRIEF);
    expect(prompt).toContain('Rounds asked so far: 0 of 4.');
    // The global default speaks about splitting plans: not an intake's.
    expect(prompt).not.toContain('GLOBAL INSTRUCTIONS v1');
    const [turnRow] = await h.ctx.prisma.planTurn.findMany({
      where: { planId: plan.id },
    });
    expect(turnRow.action).toBe('intake');
    // D5: the person's words are not sent to normalization.
    expect(await h.ctx.prisma.textNormalization.count()).toBe(0);
  });

  it('takes the planning model from the account setting, and a pick at the start for that intake only', async () => {
    await h.author.send('put', '/me/settings', { planningModel: 'fable' });
    const first = await start();
    expect(first.model).toBe('fable');
    const picked = await start({ model: 'opus' });
    expect(picked.model).toBe('opus');
    expect(h.sentOf('plan.turn').map((a) => a.model)).toEqual([
      'fable',
      'opus',
    ]);
    const next = await start();
    expect(next.model).toBe('fable');
  });

  it('applies a project’s own instructions to an intake', async () => {
    const override = await h.ctx.prisma.plannerInstructions.create({
      data: { projectId: h.projectId, version: 1, body: 'PROJECT RULES v1' },
    });
    await h.ctx.prisma.plannerSettings.create({
      data: {
        projectId: h.projectId,
        specOutput: 'issue_body',
        overrideInstructionsId: override.id,
      },
    });
    await start();
    expect(prompts()[0]).toContain('PROJECT RULES v1');
  });

  it('asks a round in the person’s language, takes multiple choice, and writes one English card in Todo', async () => {
    const plan = await start();
    await h.finish(plan.id, block(roundOf(ruQuestion('q1', true))));
    const asked = await h.detail(plan.id);
    expect(asked.questions.map((q) => q.title)).toEqual(['Какие поля']);
    expect(asked.intake?.roundsAsked).toBe(1);

    const answered = await turn(plan.id, {
      answers: [{ questionId: 'q1', optionIds: ['title', 'column'] }],
    });
    expect(answered.status).toBe(201);
    const prompt = prompts()[1];
    expect(prompt).toContain('option title: Заголовок; option column: Колонка');
    expect(prompt).toContain('Rounds asked so far: 1 of 4.');

    await h.finish(plan.id, block(card()));
    const done = await h.detail(plan.id);
    expect(done.status).toBe('done');
    expect(done.title).toBe('Export the board as CSV');

    const made = await cardOf(plan.id);
    expect(made).toMatchObject({
      title: 'Export the board as CSV',
      kind: 'feature',
      kindSource: 'auto',
      column: 'todo',
      source: 'manual',
      planId: plan.id,
      createdById: h.authorId,
    });
    for (const section of CARD_DRAFT_SECTIONS) {
      expect(made?.body).toContain(`## ${section}`);
    }
    expect(await h.auditOf('card.created')).toHaveLength(1);
    // A done intake takes no more turns.
    expect((await turn(plan.id, { message: 'ещё' })).status).toBe(409);
  });

  it('refuses two options on a single-choice question, and an option the question lacks (400)', async () => {
    const plan = await start();
    await h.finish(plan.id, block(roundOf(ruQuestion('q1'))));
    for (const answer of [
      { questionId: 'q1', optionIds: ['title', 'column'] },
      { questionId: 'q1', optionId: 'nope' },
      { questionId: 'q9', text: 'что-то' },
    ]) {
      const response = await turn(plan.id, { answers: [answer] });
      expect(response.status).toBe(400);
    }
    // A free answer is accepted on a question with options.
    expect(
      (
        await turn(plan.id, {
          answers: [{ questionId: 'q1', text: 'Все поля' }],
        })
      ).status,
    ).toBe(201);
  });

  it('checks a clarify round’s picks too, and still takes an answer to a question outside it', async () => {
    const plan = await h.createPlan('dialogue');
    await h.finish(
      plan.id,
      block({
        action: 'clarify',
        questions: [question('q1', false)],
        done: false,
      }),
    );
    const two = await turn(plan.id, {
      answers: [{ questionId: 'q1', optionIds: ['yes', 'no'] }],
    });
    expect(two.status).toBe(400);
    // As before #337: the prompt marks it "not in the current round".
    const outside = await turn(plan.id, {
      answers: [{ questionId: 'q9', text: 'Только для админов.' }],
    });
    expect(outside.status).toBe(201);
  });

  it('Enough — generate sends the unanswered questions as their recommendations and the next turn must write the card', async () => {
    const plan = await start();
    await h.finish(
      plan.id,
      block(
        roundOf(ruQuestion('q1'), { ...ruQuestion('q2'), title: 'Формат' }),
      ),
    );
    const response = await turn(plan.id, {
      generate: true,
      answers: [{ questionId: 'q2', text: 'Точка с запятой' }],
    });
    expect(response.status).toBe(201);
    const stored = await h.activeTurn(plan.id);
    expect(stored.input).toEqual({
      generate: true,
      answers: [
        { questionId: 'q1', optionId: 'title' },
        { questionId: 'q2', text: 'Точка с запятой' },
      ],
    });
    expect(prompts()[1]).toContain('The person asked to generate');

    // A round now fails the turn: the contract says write the card.
    await h.finish(plan.id, block(roundOf(ruQuestion('q3'))));
    const failed = await h.ctx.prisma.planTurn.findUniqueOrThrow({
      where: { id: stored.id },
    });
    expect(failed.phase).toBe('failed');
    expect(failed.error).toContain('must_generate');
    expect(await cardOf(plan.id)).toBeNull();
  });

  it('Enough — generate before the first round is answered is a turn on its own', async () => {
    const plan = await start();
    await h.finish(plan.id, block(roundOf(ruQuestion('q1'))));
    expect((await turn(plan.id, { generate: true })).status).toBe(201);
    await h.finish(plan.id, block(card()));
    expect(await cardOf(plan.id)).not.toBeNull();
  });

  it('never asks a fifth round: after four, the next turn must write the card', async () => {
    const plan = await start();
    for (let i = 1; i <= PLANNER_INTAKE_MAX_ROUNDS; i += 1) {
      await h.finish(plan.id, block(roundOf(ruQuestion(`q${i}`))));
      await turn(plan.id, { answers: [{ questionId: `q${i}`, text: 'да' }] });
    }
    expect(prompts().at(-1)).toContain('No more rounds may be asked');
    await h.finish(plan.id, block(roundOf(ruQuestion('q5'))));
    const detail = await h.detail(plan.id);
    expect(detail.intake?.roundsAsked).toBe(PLANNER_INTAKE_MAX_ROUNDS);
    expect(detail.turns.at(-1)?.error).toContain('must_generate');
    expect(detail.status).toBe('clarifying');
  });

  it('asks a non-English card again once, then takes it', async () => {
    const plan = await start();
    await h.finish(plan.id, block(card({ body: RUSSIAN_BODY })));
    let turns = await h.ctx.prisma.planTurn.findMany({
      where: { planId: plan.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(turns.map((t) => t.phase)).toEqual(['failed', 'queued']);
    expect(turns[0].error).toContain('not_english');
    expect(await cardOf(plan.id)).toBeNull();

    await h.finish(plan.id, block(card({ body: RUSSIAN_BODY })));
    turns = await h.ctx.prisma.planTurn.findMany({
      where: { planId: plan.id },
    });
    expect(turns).toHaveLength(2);
    expect((await cardOf(plan.id))?.body).toBe(RUSSIAN_BODY);
  });

  it('Discard archives the intake: no card, and its attachments go back to the sweep', async () => {
    const shot = await pending(h);
    const plan = await start({ attachmentIds: [shot] });
    await h.finish(plan.id, block(roundOf(ruQuestion('q1'))));
    const response = await h.author.send(
      'post',
      `${h.base(plan.id)}/archive`,
      {},
    );
    expect(response.status).toBe(200);
    expect((await h.detail(plan.id)).status).toBe('archived');
    expect(await cardOf(plan.id)).toBeNull();
    const row = await h.ctx.prisma.attachment.findUniqueOrThrow({
      where: { id: shot },
    });
    expect(row.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  describe('attachments (D10)', () => {
    const runnerVersion = (version: string | null) =>
      h.ctx.prisma.runner.update({
        where: { id: h.runnerId },
        data: { version },
      });

    it('claims the uploads, passes every one to a runner ≥ 0.9.2, names them, and hands them to the card', async () => {
      await runnerVersion('0.9.2');
      const shot = await pending(h, 'screen.png');
      const plan = await start({ attachmentIds: [shot] });
      const claimed = await h.ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: shot },
      });
      expect(claimed).toMatchObject({ planId: plan.id, expiresAt: null });

      const [args] = h.sentOf('plan.turn');
      expect(args.attachments).toEqual([
        expect.objectContaining({ id: shot, name: 'screen.png' }),
      ]);
      expect(String(args.prompt)).toContain(
        `.agentdock/attachments/${shot}-screen.png`,
      );

      // A second file in an answer: the turn carries both.
      await h.finish(plan.id, block(roundOf(ruQuestion('q1'))));
      const more = await pending(h, 'more.png');
      await turn(plan.id, {
        answers: [{ questionId: 'q1', text: 'вот' }],
        attachmentIds: [more],
      });
      expect(
        (h.sentOf('plan.turn')[1].attachments as { id: string }[]).map(
          (a) => a.id,
        ),
      ).toEqual([shot, more]);

      await h.finish(plan.id, block(card()));
      const made = await cardOf(plan.id);
      expect(
        (
          await h.ctx.prisma.attachment.findMany({
            where: { cardId: made?.id },
            orderBy: { createdAt: 'asc' },
          })
        ).map((a) => a.id),
      ).toEqual([shot, more]);
    });

    it('starts the turn without the files on an older runner', async () => {
      await runnerVersion('0.9.1');
      const shot = await pending(h);
      await start({ attachmentIds: [shot] });
      const [args] = h.sentOf('plan.turn');
      expect(args).not.toHaveProperty('attachments');
      expect(String(args.prompt)).not.toContain('.agentdock/attachments');
    });

    it('refuses an upload of someone else, and attachments on a non-card plan', async () => {
      const foreign = await pending(h, 'x.png', 'other@example.com');
      const response = await h.author.send('post', h.base(), {
        brief: RUSSIAN_BRIEF,
        mode: 'card',
        attachmentIds: [foreign],
      });
      // #309's refusal: `attachment_error` / `not_claimable`.
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('not_claimable');
      const batch = await h.author.send('post', h.base(), {
        brief: 'Build it',
        mode: 'batch',
        attachmentIds: [await pending(h)],
      });
      expect(batch.status).toBe(409);
      expect(await h.ctx.prisma.plan.count()).toBe(0);
    });
  });

  it('a viewer gets 403 starting an intake', async () => {
    const response = await h.viewer.send('post', h.base(), {
      brief: RUSSIAN_BRIEF,
      mode: 'card',
    });
    expect(response.status).toBe(403);
    expect(await h.ctx.prisma.plan.count()).toBe(0);
  });
});

/** A pending upload of `email` in the harness project. */
const pending = async (
  h: PlannerHarness,
  name = 'shot.png',
  email = 'author@example.com',
): Promise<string> => {
  const uploader = await h.ctx.prisma.user.findUniqueOrThrow({
    where: { email },
  });
  const row = await h.ctx.prisma.attachment.create({
    data: {
      projectId: h.projectId,
      uploaderId: uploader.id,
      name,
      mime: 'image/png',
      size: 10,
      sha256: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return row.id;
};
