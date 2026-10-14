import { CardDesignHarness } from './testing/card-design-e2e';
import { designResult, profileResult } from './testing/design-e2e';

/** A card's design turns answer the contract under this key (#243 D2). */
const KEY = 'card-1';

describe('card design (e2e, #243)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const generate = (number: number) =>
    h.author.send('post', `${h.cardDesignBase(number)}/generate`);

  it('builds the profile first, then sends one plan.turn per variant with planId = card.id in the card design session', async () => {
    const card = await h.designedCard(2);
    const started = await generate(card.number);
    expect(started.status).toBe(201);
    expect(h.designSent('uiprofile.build')).toHaveLength(1);
    expect(h.sentOf('plan.turn')).toHaveLength(0);
    expect((await h.cardDesign(card.number)).status).toBe('generating');

    await h.finishBuild(profileResult());
    const [first] = h.sentOf('plan.turn');
    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(stored.designSessionId).not.toBeNull();
    expect(first).toMatchObject({
      planId: card.id,
      projectId: h.projectId,
      session: { id: stored.designSessionId, resume: false },
    });
    const prompt = String(first.prompt);
    expect(prompt).toContain('GLOBAL INSTRUCTIONS v1');
    expect(prompt).toContain('Action: `design`');
    expect(prompt).toContain(`whose \`taskKey\` is \`${KEY}\``);
    expect(prompt).toContain('## The card');
    expect(prompt).toContain('C-1: Add login');
    expect(prompt).toContain('Users sign in with a password.');
    expect(prompt).toContain('PROFILE KIT');
    expect(prompt).toContain('Variant: 1 (of 2).');
    // The turn belongs to the card, not to a plan; its run is a plan run.
    const turn = await h.activeCardTurn(card.id);
    expect(turn.planId).toBeNull();
    const run = await h.ctx.prisma.run.findUniqueOrThrow({
      where: { id: turn.runId },
    });
    expect(run.kind).toBe('plan');
    expect(run.title).toBe('Design · C-1 v1');

    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    const turns = h.sentOf('plan.turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      planId: card.id,
      session: { id: stored.designSessionId, resume: true },
    });
    expect(String(turns[1].prompt)).toContain('Variant: 2 (of 2).');

    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 2 }));
    const view = await h.cardDesign(card.number);
    expect(view.owner).toEqual({
      kind: 'card',
      cardId: card.id,
      number: card.number,
    });
    expect(view.planId).toBeNull();
    expect(view.status).toBe('reviewing');
    expect(view.revisions.map((r) => r.variant)).toEqual([1, 2]);
    expect(h.sentOf('plan.turn')).toHaveLength(2);
    // Generating never moves the card.
    const after = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(after.column).toBe('todo');
    const audit = await h.auditOf('design.generated');
    expect(audit).toHaveLength(1);
    expect(audit[0].targetType).toBe('board_card');
    expect(audit[0].targetId).toBe(card.id);
  });

  it.each([
    [designResult({ taskKey: 't1', variant: 1 }), 'task_mismatch'],
    [designResult({ taskKey: KEY, variant: 2 }), 'variant_mismatch'],
    [
      designResult(
        { taskKey: KEY, variant: 1 },
        '<!doctype html><html><body><script src="https://evil.example/x.js"></script></body></html>',
      ),
      'design_host_not_allowed',
    ],
    [
      designResult(
        { taskKey: KEY, variant: 1 },
        '<!doctype html><html><body><script>fetch("/api/me")</script></body></html>',
      ),
      'design_forbidden_feature',
    ],
    [
      designResult(
        { taskKey: KEY, variant: 1 },
        `<!doctype html><html><body><p>${'x'.repeat(161 * 1024)}</p></body></html>`,
      ),
      'design_too_large',
    ],
  ])('fails a card turn that breaks the contract and stores no revision (%#)', async (result, reason) => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    expect((await generate(card.number)).status).toBe(201);
    await h.finishCard(card.id, result);
    const turn = await h.ctx.prisma.planTurn.findFirstOrThrow({
      where: { cardId: card.id, action: 'design' },
    });
    expect(turn.phase).toBe('failed');
    expect(turn.error).toContain('contract_violation');
    expect(turn.error).toContain(reason);
    const view = await h.cardDesign(card.number);
    expect(view.revisions).toHaveLength(0);
    expect(view.status).toBe('idle');
    // At rest again: Generate takes a new turn.
    expect((await generate(card.number)).status).toBe(201);
  });

  it('approving chains no write turn, sends plan.close, and with the switch off starts nothing', async () => {
    await h.seedProfile();
    const card = await h.designedCard(2);
    await generate(card.number);
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 2 }));
    const view = await h.cardDesign(card.number);
    const picked = view.revisions.find((r) => r.variant === 2);
    if (!picked) throw new Error('variant 2 was not drawn');

    const approved = await h.author.send(
      'post',
      `${h.cardDesignBase(card.number)}/approve`,
      { revisionId: picked.id },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      approvedRevisionId: picked.id,
    });
    expect(
      approved.body.revisions.find((r: { variant: number }) => r.variant === 1)
        .archived,
    ).toBe(true);
    expect(
      await h.ctx.prisma.planTurn.count({ where: { action: 'write' } }),
    ).toBe(0);
    expect(h.sentOf('plan.turn')).toHaveLength(2);
    expect(h.sentOf('plan.close')).toEqual([
      { planId: card.id, projectId: h.projectId },
    ]);
    expect(h.cardSentOf('card.run')).toHaveLength(0);
    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
      include: { rounds: true },
    });
    expect(stored.column).toBe('todo');
    expect(stored.rounds).toHaveLength(0);
    const audit = await h.auditOf('design.approved');
    expect(audit).toHaveLength(1);
    expect(audit[0].targetType).toBe('board_card');

    // Approved: no more turns, comments or second approval.
    const base = h.cardDesignBase(card.number);
    expect((await generate(card.number)).body.error).toBe('design_approved');
    expect(
      (
        await h.author.send('post', `${base}/approve`, {
          revisionId: picked.id,
        })
      ).body.error,
    ).toBe('design_approved');
  });

  it('a viewer reads a card design and is refused every write; another project sees nothing', async () => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    const base = h.cardDesignBase(card.number);
    expect((await h.viewer.get(base)).status).toBe(200);
    for (const [method, path, body] of [
      ['patch', base, { needed: false }],
      ['post', `${base}/generate`, undefined],
      ['post', `${base}/revise`, undefined],
      ['post', `${base}/approve`, { revisionId: 'x' }],
      [
        'post',
        `${base}/comments`,
        { revisionId: 'x', kind: 'general', body: 'No.' },
      ],
    ] as const) {
      expect((await h.viewer.send(method, path, body)).status).toBe(403);
    }
    expect((await h.outsider.get(base)).status).toBe(404);
    // No design row yet: 404, not an empty design.
    const bare = await h.createCard({ title: 'Bare' });
    expect((await h.author.get(h.cardDesignBase(bare.number))).status).toBe(
      404,
    );
  });
});
