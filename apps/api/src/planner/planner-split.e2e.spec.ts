import {
  CARD_DRAFT_SECTIONS,
  INTAKE_SPLIT_MAX,
  type PlanDetail,
} from '@agentdock/shared';
import { block, PlannerHarness } from './testing/planner-e2e';

/**
 * #409 (docs/specs/409-new-work-intake-can-split.md): New work decides how
 * many cards a request makes — one card as before, or a split the person
 * confirms, edits or declines. #592: what it writes are candidates.
 */

const SEVERAL =
  'Сделай выгрузку доски в CSV, почини кнопку входа на мобильном и добавь тёмную тему.';

const body = (what: string) =>
  [
    '## What to do',
    '',
    `${what} for the people who use the board every day.`,
    '',
    '## Acceptance criteria',
    '',
    '- [ ] The change works on the board and is covered by a test.',
    '',
    '## Out of scope',
    '',
    'None.',
    '',
    '## Open questions',
    '',
    'None.',
  ].join('\n');

const splitCard = (title: string, kind: 'bug' | 'feature' = 'feature') => ({
  title,
  kind,
  summary: `${title}, on its own card.`,
  body: body(title),
});

const SPLIT = {
  action: 'intake',
  split: {
    reason: 'Это три независимые задачи.',
    cards: [
      splitCard('Export the board as CSV'),
      splitCard('Fix the sign-in button on mobile', 'bug'),
      splitCard('Add a dark theme to the board'),
    ],
  },
};

const ONE_CARD = {
  action: 'intake',
  cardDraft: {
    title: 'Export the board, fix mobile sign-in, add a dark theme',
    kind: 'feature',
    body: body(
      'Export the board as CSV, fix the sign-in button on mobile and add a dark theme',
    ),
  },
};

describe('New work intake splits (e2e, #409)', () => {
  const h = new PlannerHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const start = async () => {
    const response = await h.author.send('post', h.base(), {
      brief: SEVERAL,
      mode: 'card',
    });
    expect(response.status).toBe(201);
    return response.body as PlanDetail;
  };

  const proposed = async () => {
    const plan = await start();
    await h.finish(plan.id, block(SPLIT));
    return h.detail(plan.id);
  };

  const confirm = (planId: string, body: object, session = h.author) =>
    session.send('post', `${h.base(planId)}/split`, body);

  const cardsOf = (planId: string) =>
    h.ctx.prisma.boardCard.findMany({
      where: { planId },
      orderBy: { position: 'asc' },
    });

  it('a split proposal waits for the person: no card, no round, the plan stays open', async () => {
    const plan = await proposed();
    expect(plan.status).toBe('clarifying');
    expect(plan.questions).toEqual([]);
    expect(plan.intake).toMatchObject({
      roundsAsked: 0,
      split: {
        reason: 'Это три независимые задачи.',
        cards: [
          {
            index: 0,
            title: 'Export the board as CSV',
            kind: 'feature',
            summary: 'Export the board as CSV, on its own card.',
          },
          { index: 1, kind: 'bug' },
          { index: 2 },
        ],
      },
    });
    const turnId = plan.intake?.split?.turnId;
    const turn = plan.turns.find((t) => t.id === turnId);
    expect(turn).toMatchObject({ phase: 'succeeded', rounds: [] });
    expect(await cardsOf(plan.id)).toHaveLength(0);
  });

  it('Confirm writes every kept card as a candidate — edited, in order, from the model’s bodies — and makes no card', async () => {
    const plan = await proposed();
    const turnId = plan.intake?.split?.turnId;
    const response = await confirm(plan.id, {
      turnId,
      cards: [
        { index: 2, title: 'Add a dark theme', kind: 'feature' },
        { index: 0, title: 'Export the board as CSV', kind: 'bug' },
      ],
    });
    expect(response.status).toBe(201);
    expect(response.body.candidates).toHaveLength(2);
    expect(await cardsOf(plan.id)).toHaveLength(0);

    const review = await h.detail(plan.id);
    expect(review.status).toBe('reviewing');
    expect(review.title).toBe('Add a dark theme');
    expect(review.intake?.split).toBeNull();
    expect(review.intake?.candidateStack).toBeNull();
    const candidates = review.intake?.candidates ?? [];
    expect(candidates.map((c) => [c.title, c.kind, c.status])).toEqual([
      ['Add a dark theme', 'feature', 'pending'],
      ['Export the board as CSV', 'bug', 'pending'],
    ]);
    // The dark-theme candidate keeps the model's body for the third proposal.
    expect(candidates[0].body).toContain('Add a dark theme to the board');
    for (const candidate of candidates) {
      expect(candidate.stage).toBeNull();
      for (const section of CARD_DRAFT_SECTIONS) {
        expect(candidate.body).toContain(`## ${section}`);
      }
    }
    // Once only.
    const again = await confirm(plan.id, {
      turnId,
      cards: [{ index: 1, title: 'Fix it', kind: 'bug' }],
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('split_stale');

    // Accept all makes them independent, in order, and closes the intake.
    const accepted = await h.acceptAll(plan.id);
    expect(accepted.status).toBe(200);
    const cards = await cardsOf(plan.id);
    expect(cards.map((c) => [c.title, c.kind, c.column])).toEqual([
      ['Add a dark theme', 'feature', 'todo'],
      ['Export the board as CSV', 'bug', 'todo'],
    ]);
    for (const card of cards) {
      expect(card.planId).toBe(plan.id);
      expect(card.createdById).toBe(h.authorId);
    }
    expect(
      await h.ctx.prisma.boardCardDependency.count({
        where: { cardId: { in: cards.map((c) => c.id) } },
      }),
    ).toBe(0);
    expect(await h.auditOf('card.created')).toHaveLength(2);
    expect((await h.detail(plan.id)).status).toBe('done');
  });

  it('hands the intake’s attachments to the first confirmed card', async () => {
    const uploader = await h.ctx.prisma.user.findUniqueOrThrow({
      where: { email: 'author@example.com' },
    });
    const shot = await h.ctx.prisma.attachment.create({
      data: {
        projectId: h.projectId,
        uploaderId: uploader.id,
        name: 'shot.png',
        mime: 'image/png',
        size: 10,
        sha256: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const started = await h.author.send('post', h.base(), {
      brief: SEVERAL,
      mode: 'card',
      attachmentIds: [shot.id],
    });
    const planId = (started.body as PlanDetail).id;
    await h.finish(planId, block(SPLIT));
    const plan = await h.detail(planId);
    const response = await confirm(planId, {
      turnId: plan.intake?.split?.turnId,
      cards: [
        { index: 1, title: 'Fix the sign-in button on mobile', kind: 'bug' },
        { index: 0, title: 'Export the board as CSV', kind: 'feature' },
      ],
    });
    expect(response.status).toBe(201);
    expect((await h.acceptAll(planId)).status).toBe(200);
    const [first] = await cardsOf(planId);
    const row = await h.ctx.prisma.attachment.findUniqueOrThrow({
      where: { id: shot.id },
    });
    expect(row.cardId).toBe(first.id);
  });

  it('Keep one card asks for one card for the whole request, and refuses another split', async () => {
    const plan = await proposed();
    const kept = await h.author.send('post', `${h.base(plan.id)}/turns`, {
      keepOne: true,
    });
    expect(kept.status).toBe(201);
    const prompt = String(h.sentOf('plan.turn')[1].prompt);
    expect(prompt).toContain('declined the split and keeps one card');

    // A second split is a contract violation; nothing is made.
    await h.finish(plan.id, block(SPLIT));
    const failed = await h.detail(plan.id);
    expect(failed.turns.at(-1)).toMatchObject({ phase: 'failed' });
    expect(failed.turns.at(-1)?.error).toContain('split_declined');
    expect(await cardsOf(plan.id)).toHaveLength(0);

    await h.author.send(
      'post',
      `${h.base(plan.id)}/turns/${failed.turns.at(-1)?.id}/retry`,
    );
    await h.finish(plan.id, block(ONE_CARD));
    const review = await h.detail(plan.id);
    expect(review.status).toBe('reviewing');
    expect(review.intake?.candidates?.map((c) => c.title)).toEqual([
      ONE_CARD.cardDraft.title,
    ]);
    expect(await cardsOf(plan.id)).toHaveLength(0);
  });

  it('a single clear task is one candidate with no proposal, and no card', async () => {
    const plan = await start();
    await h.finish(plan.id, block(ONE_CARD));
    const review = await h.detail(plan.id);
    expect(review.status).toBe('reviewing');
    expect(review.intake?.split).toBeNull();
    expect(review.intake?.candidates).toHaveLength(1);
    expect(await cardsOf(plan.id)).toHaveLength(0);
  });

  it('refuses a stale proposal, a running turn, a repeated or unknown index, and a non-English title', async () => {
    const plan = await proposed();
    const turnId = plan.intake?.split?.turnId as string;
    const keep = (cards: object[], id = turnId) =>
      confirm(plan.id, { turnId: id, cards });

    const stale = await keep(
      [{ index: 0, title: 'Export', kind: 'feature' }],
      'not-the-turn',
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('split_stale');

    const twice = await keep([
      { index: 0, title: 'Export', kind: 'feature' },
      { index: 0, title: 'Export again', kind: 'feature' },
    ]);
    expect(twice.status).toBe(400);

    const unknown = await keep([{ index: 5, title: 'Nothing', kind: 'bug' }]);
    expect(unknown.status).toBe(400);
    const outOfRange = await keep([
      { index: INTAKE_SPLIT_MAX, title: 'Nothing', kind: 'bug' },
    ]);
    expect(outOfRange.status).toBe(400);

    const russian = await keep([
      { index: 0, title: 'Выгрузка доски', kind: 'feature' },
    ]);
    expect(russian.status).toBe(400);
    expect(russian.body.error).toBe('invalid_args');

    const none = await keep([]);
    expect(none.status).toBe(400);

    await h.author.send('post', `${h.base(plan.id)}/turns`, { keepOne: true });
    const running = await keep([
      { index: 0, title: 'Export the board as CSV', kind: 'feature' },
    ]);
    expect(running.status).toBe(409);
    expect(running.body.error).toBe('turn_in_progress');
    expect(await cardsOf(plan.id)).toHaveLength(0);
  });

  it('a viewer cannot confirm; a non-intake plan has no split', async () => {
    const plan = await proposed();
    const viewer = await confirm(
      plan.id,
      {
        turnId: plan.intake?.split?.turnId,
        cards: [{ index: 0, title: 'Export', kind: 'feature' }],
      },
      h.viewer,
    );
    expect(viewer.status).toBe(403);

    const batch = await h.author.send('post', h.base(), {
      brief: 'Build it',
      mode: 'batch',
    });
    const wrong = await confirm(batch.body.id, {
      turnId: 'x',
      cards: [{ index: 0, title: 'Export', kind: 'feature' }],
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('wrong_mode');
    // Keep one card is an intake's alone.
    const keepOne = await h.author.send(
      'post',
      `${h.base(batch.body.id)}/turns`,
      { keepOne: true },
    );
    expect(keepOne.status).toBe(409);
  });
});
