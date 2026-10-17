import type {
  AcceptCandidatesResponse,
  PlanCandidateView,
  PlanDetail,
} from '@agentdock/shared';
import { block, PlannerHarness } from './testing/planner-e2e';

/**
 * #592 (docs/specs/592-make-new-work-cards-candidates-the-perso.md,
 * ADR-0055): New work writes candidates; the person edits, rejects or
 * accepts them — alone, as independent cards, or as one stack — and only
 * Accept makes board cards.
 */

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

const ONE_CARD = {
  action: 'intake',
  cardDraft: {
    title: 'Export the board as CSV',
    kind: 'feature',
    body: body('Export the board as CSV'),
  },
};

const SPLIT = {
  action: 'intake',
  split: {
    reason: 'Это две независимые задачи.',
    cards: [
      splitCard('Fix the sign-in button on mobile', 'bug'),
      splitCard('Add a dark theme to the board'),
    ],
  },
};

const STACK = {
  action: 'intake',
  stack: {
    reason: 'Сначала компоненты, потом страница.',
    title: 'Redesign the Settings page',
    body: 'Components first, then the page.',
    design: true,
    stages: [
      {
        title: 'Components',
        cards: [
          splitCard('Add the form section component'),
          splitCard('Toggle row with description'),
        ],
      },
      { title: 'Page', cards: [splitCard('Compose the Settings page')] },
    ],
  },
};

describe('New work candidates (e2e, #592)', () => {
  const h = new PlannerHarness();

  beforeAll(() => h.start());
  afterAll(() => h.ctx.app.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const attachment = () =>
    h.ctx.prisma.attachment.create({
      data: {
        projectId: h.projectId,
        uploaderId: h.authorId,
        name: 'shot.png',
        mime: 'image/png',
        size: 10,
        sha256: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

  /** An intake that wrote one card, with `attachmentIds`. */
  const oneCard = async (attachmentIds: string[] = []) => {
    const created = await h.author.send('post', h.base(), {
      brief: 'Сделай выгрузку доски в CSV.',
      mode: 'card',
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
    expect(created.status).toBe(201);
    const plan = created.body as PlanDetail;
    await h.finish(plan.id, block(ONE_CARD));
    return h.detail(plan.id);
  };

  /** An intake whose proposal the person confirmed as proposed. */
  const confirmed = async (output: typeof SPLIT | typeof STACK) => {
    const created = await h.author.send('post', h.base(), {
      brief: 'Сделай несколько вещей.',
      mode: 'card',
    });
    const planId = (created.body as PlanDetail).id;
    await h.finish(planId, block(output));
    const split = (await h.detail(planId)).intake?.split;
    const response = await h.author.send('post', `${h.base(planId)}/split`, {
      turnId: split?.turnId,
      cards: split?.cards.map((c) => ({
        index: c.index,
        title: c.title,
        kind: c.kind,
      })),
      ...(split?.stack
        ? {
            stack: {
              title: split.stack.title,
              body: split.stack.body,
              design: split.stack.design,
              stages: split.stack.stages,
            },
          }
        : {}),
    });
    expect(response.status).toBe(201);
    return h.detail(planId);
  };

  const candidates = (plan: PlanDetail): PlanCandidateView[] =>
    plan.intake?.candidates ?? [];

  const path = (c: Pick<PlanCandidateView, 'id' | 'planId'>) =>
    `${h.base(c.planId)}/candidates/${c.id}`;

  const edit = (c: PlanCandidateView, changes: object, session = h.author) =>
    session.send('patch', path(c), { version: c.version, ...changes });

  const reject = (c: PlanCandidateView, session = h.author) =>
    session.send('post', `${path(c)}/reject`, {});

  const accept = (
    as: 'cards' | 'stack',
    refs: { c: PlanCandidateView; stage?: number }[],
    session = h.author,
  ) =>
    session.send('post', `/projects/${h.projectId}/candidates/accept`, {
      as,
      candidates: refs.map(({ c, stage }) => ({
        id: c.id,
        version: c.version,
        ...(stage !== undefined ? { stage } : {}),
      })),
    });

  const cards = () =>
    h.ctx.prisma.boardCard.findMany({
      orderBy: { number: 'asc' },
      include: { dependsOn: true },
    });

  it('a written card is a candidate in Drafts: no card, the intake under review', async () => {
    const plan = await oneCard();
    expect(plan.status).toBe('reviewing');
    expect(plan.title).toBe('Export the board as CSV');
    expect(candidates(plan)).toEqual([
      expect.objectContaining({
        position: 0,
        title: 'Export the board as CSV',
        kind: 'feature',
        body: body('Export the board as CSV'),
        stage: null,
        status: 'pending',
        version: 1,
        card: null,
      }),
    ]);
    expect(await cards()).toHaveLength(0);
  });

  it('edits title, kind and body; Accept makes the card in Todo with the edited text, the plan as origin and the attachments', async () => {
    const shot = await attachment();
    const plan = await oneCard([shot.id]);
    expect(plan.intake?.attachments).toBe(1);
    const [candidate] = candidates(plan);

    const edited = await edit(candidate, {
      title: 'Export the board as a CSV file',
      kind: 'bug',
      body: '## What to do\n\nExport it.',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      title: 'Export the board as a CSV file',
      kind: 'bug',
      body: '## What to do\n\nExport it.',
      version: 2,
      status: 'pending',
    });
    expect(await h.auditOf('plan.candidate_edited')).toHaveLength(1);
    expect(await cards()).toHaveLength(0);

    // The version the person saw before the edit is stale now.
    const stale = await accept('cards', [{ c: candidate }]);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('candidate_stale');

    const response = await accept('cards', [{ c: edited.body }]);
    expect(response.status).toBe(200);
    const made = response.body as AcceptCandidatesResponse;
    expect(made.stack).toBeNull();
    expect(made.cards).toEqual([
      { candidateId: candidate.id, number: 1, label: 'C-1' },
    ]);
    const [card] = await cards();
    expect(card).toMatchObject({
      title: 'Export the board as a CSV file',
      kind: 'bug',
      body: '## What to do\n\nExport it.',
      column: 'todo',
      planId: plan.id,
      createdById: h.authorId,
    });
    const row = await h.ctx.prisma.attachment.findUniqueOrThrow({
      where: { id: shot.id },
    });
    expect(row.cardId).toBe(card.id);
    expect(await h.auditOf('card.created')).toHaveLength(1);
    expect(await h.auditOf('attachment.claimed')).toHaveLength(1);

    const done = await h.detail(plan.id);
    expect(done.status).toBe('done');
    expect(candidates(done)[0]).toMatchObject({
      status: 'accepted',
      card: { number: 1, label: 'C-1' },
      attachments: 1,
    });
  });

  it('refuses an edited title with a non-ASCII letter, an empty one, and a stale edit', async () => {
    const plan = await oneCard();
    const [candidate] = candidates(plan);
    const russian = await edit(candidate, { title: 'Выгрузка доски в CSV' });
    expect(russian.status).toBe(400);
    expect(russian.body.error).toBe('invalid_args');
    const accented = await edit(candidate, { title: 'Exporter la planche' });
    expect(accented.status).toBe(200);
    const blank = await edit(accented.body, { title: '   ' });
    expect(blank.status).toBe(400);
    // `candidate` is version 1; the candidate is version 2.
    const stale = await edit(candidate, { body: 'Older tab' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('candidate_stale');
    const row = await h.ctx.prisma.planCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    expect(row).toMatchObject({ title: 'Exporter la planche', version: 2 });
  });

  it('Reject makes nothing; the intake is done once no candidate is pending', async () => {
    const plan = await confirmed(SPLIT);
    expect(plan.status).toBe('reviewing');
    const [first, second] = candidates(plan);

    const rejected = await reject(first);
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
    expect(await h.auditOf('plan.candidate_rejected')).toHaveLength(1);
    expect((await h.detail(plan.id)).status).toBe('reviewing');

    // Decided already: no second decision, no edit.
    const twice = await reject(first);
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({
      error: 'candidate_decided',
      candidateId: first.id,
      status: 'rejected',
      card: null,
    });
    expect((await edit(first, { title: 'Again' })).body.error).toBe(
      'candidate_decided',
    );
    expect((await accept('cards', [{ c: first }])).status).toBe(409);

    expect((await reject(second)).status).toBe(200);
    expect(await cards()).toHaveLength(0);
    const done = await h.detail(plan.id);
    expect(done.status).toBe('done');
    expect(candidates(done).map((c) => c.status)).toEqual([
      'rejected',
      'rejected',
    ]);
  });

  it('accepts candidates of two intakes as independent cards: no dependencies, each intake’s attachments to its first card', async () => {
    const shot = await attachment();
    const single = await oneCard([shot.id]);
    const split = await confirmed(SPLIT);
    const [bug, theme] = candidates(split);
    const [csv] = candidates(single);

    const response = await accept('cards', [
      { c: bug },
      { c: csv },
      { c: theme },
    ]);
    expect(response.status).toBe(200);
    const made = await cards();
    expect(made.map((c) => [c.title, c.planId])).toEqual([
      ['Fix the sign-in button on mobile', split.id],
      ['Export the board as CSV', single.id],
      ['Add a dark theme to the board', split.id],
    ]);
    expect(made.every((c) => c.dependsOn.length === 0)).toBe(true);
    expect(await h.ctx.prisma.boardStack.count()).toBe(0);
    const row = await h.ctx.prisma.attachment.findUniqueOrThrow({
      where: { id: shot.id },
    });
    expect(row.cardId).toBe(made[1].id);
    expect((await h.detail(single.id)).status).toBe('done');
    expect((await h.detail(split.id)).status).toBe('done');
  });

  it('accepts candidates of two intakes as one stack in the stage order chosen, with its dependencies', async () => {
    const single = await oneCard();
    const split = await confirmed(SPLIT);
    const [bug, theme] = candidates(split);
    const [csv] = candidates(single);

    const response = await accept('stack', [
      { c: theme, stage: 4 },
      { c: csv, stage: 0 },
      { c: bug, stage: 0 },
    ]);
    expect(response.status).toBe(200);
    const made = response.body as AcceptCandidatesResponse;
    expect(made.stack).toEqual({ number: 1, label: 'S-1' });
    // Stage order; the gap between stages closes up.
    expect(made.cards.map((c) => c.candidateId)).toEqual([
      csv.id,
      bug.id,
      theme.id,
    ]);
    const stack = await h.ctx.prisma.boardStack.findFirstOrThrow({
      include: {
        stages: {
          orderBy: { position: 'asc' },
          include: { cards: { orderBy: { number: 'asc' } } },
        },
      },
    });
    expect(stack).toMatchObject({
      title: 'Export the board as CSV',
      body: '',
      planId: single.id,
    });
    expect(
      stack.stages.map((s) => [s.title, s.cards.map((c) => c.title)]),
    ).toEqual([
      [
        'Stage 1',
        ['Export the board as CSV', 'Fix the sign-in button on mobile'],
      ],
      ['Stage 2', ['Add a dark theme to the board']],
    ]);
    const all = await cards();
    const third = all.find((c) => c.title === 'Add a dark theme to the board');
    expect(third?.dependsOn.map((d) => d.dependsOnId).sort()).toEqual(
      all
        .filter((c) => c.id !== third?.id)
        .map((c) => c.id)
        .sort(),
    );
    // Neither intake proposed a design: the stack has none.
    expect(await h.ctx.prisma.taskDesign.count()).toBe(0);
    expect(await h.auditOf('stack.created')).toHaveLength(1);
  });

  it('Accept all on a proposed stack makes it as proposed — its title, stage names, dependencies and design — in one step', async () => {
    const plan = await confirmed(STACK);
    expect(plan.intake?.candidateStack).toEqual({
      title: 'Redesign the Settings page',
      body: 'Components first, then the page.',
      design: true,
      stages: ['Components', 'Page'],
    });
    expect(candidates(plan).map((c) => c.stage)).toEqual([0, 0, 1]);
    expect(await cards()).toHaveLength(0);

    const response = await h.acceptAll(plan.id);
    expect(response.status).toBe(200);
    const stack = await h.ctx.prisma.boardStack.findFirstOrThrow({
      include: {
        stages: { orderBy: { position: 'asc' }, include: { cards: true } },
        design: true,
      },
    });
    expect(stack).toMatchObject({
      title: 'Redesign the Settings page',
      body: 'Components first, then the page.',
      planId: plan.id,
    });
    expect(stack.stages.map((s) => [s.title, s.cards.length])).toEqual([
      ['Components', 2],
      ['Page', 1],
    ]);
    expect(stack.design).toMatchObject({ needed: true });
    const page = (await cards()).find(
      (c) => c.title === 'Compose the Settings page',
    );
    expect(page?.dependsOn).toHaveLength(2);
    expect((await h.detail(plan.id)).status).toBe('done');
  });

  it('a regrouped stack keeps a design a candidate’s intake asked for', async () => {
    const stacked = await confirmed(STACK);
    const split = await confirmed(SPLIT);
    const [form] = candidates(stacked);
    const [bug] = candidates(split);
    const response = await accept('stack', [
      { c: form, stage: 0 },
      { c: bug, stage: 1 },
    ]);
    expect(response.status).toBe(200);
    const stack = await h.ctx.prisma.boardStack.findFirstOrThrow({
      include: { design: true },
    });
    expect(stack.title).toBe('Add the form section component');
    expect(stack.design).toMatchObject({ needed: true });
    // Each intake keeps its other candidates under review.
    expect((await h.detail(stacked.id)).status).toBe('reviewing');
    expect((await h.detail(split.id)).status).toBe('reviewing');
  });

  it('refuses a malformed accept and makes nothing', async () => {
    const plan = await confirmed(SPLIT);
    const [a, b] = candidates(plan);
    const send = (body: object) =>
      h.author.send('post', `/projects/${h.projectId}/candidates/accept`, body);

    expect((await accept('stack', [{ c: a, stage: 0 }])).status).toBe(400);
    expect((await accept('stack', [{ c: a, stage: 0 }, { c: b }])).status).toBe(
      400,
    );
    expect((await accept('cards', [{ c: a }, { c: a }])).status).toBe(400);
    expect((await send({ as: 'cards', candidates: [] })).status).toBe(400);
    expect((await send({ as: 'pile', candidates: [] })).status).toBe(400);
    const unknown = await send({
      as: 'cards',
      candidates: [{ id: 'nope', version: 1 }],
    });
    expect(unknown.status).toBe(404);
    expect(await cards()).toHaveLength(0);
  });

  it('two tabs accepting the same candidate at once make one card; the other is told which', async () => {
    const plan = await oneCard();
    const [candidate] = candidates(plan);
    const [one, two] = await Promise.all([
      accept('cards', [{ c: candidate }]),
      accept('cards', [{ c: candidate }]),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const refused = one.status === 409 ? one : two;
    expect(refused.body).toMatchObject({
      error: 'candidate_decided',
      status: 'accepted',
      card: { number: 1, label: 'C-1' },
    });
    expect(await cards()).toHaveLength(1);
  });

  it('an accept naming one decided candidate refuses the whole request', async () => {
    const plan = await confirmed(SPLIT);
    const [a, b] = candidates(plan);
    expect((await reject(a)).status).toBe(200);
    const response = await accept('cards', [{ c: b }, { c: a }]);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('candidate_decided');
    expect(await cards()).toHaveLength(0);
    const row = await h.ctx.prisma.planCandidate.findUniqueOrThrow({
      where: { id: b.id },
    });
    expect(row.status).toBe('pending');
  });

  it('a viewer cannot decide, another member cannot reach a private intake, and a discarded intake is closed', async () => {
    const plan = await oneCard();
    const [candidate] = candidates(plan);
    expect((await accept('cards', [{ c: candidate }], h.viewer)).status).toBe(
      403,
    );
    expect((await reject(candidate, h.viewer)).status).toBe(403);
    expect((await edit(candidate, { title: 'X' }, h.viewer)).status).toBe(403);
    expect((await accept('cards', [{ c: candidate }], h.other)).status).toBe(
      404,
    );
    expect((await reject(candidate, h.other)).status).toBe(404);

    const archived = await h.author.send(
      'post',
      `${h.base(plan.id)}/archive`,
      {},
    );
    expect(archived.status).toBe(200);
    const closed = await accept('cards', [{ c: candidate }]);
    expect(closed.status).toBe(409);
    expect(closed.body.error).toBe('plan_closed');
    expect((await reject(candidate)).body.error).toBe('plan_closed');
    expect(await cards()).toHaveLength(0);
  });
});
