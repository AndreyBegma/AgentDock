import {
  BOARD_ERROR,
  type BoardCardDetail,
  cardDesignPath,
  MOCKUP_PIN_HELPER_ATTRIBUTE,
  type TaskDesignView,
} from '@agentdock/shared';
import type { CardRunFile } from '@agentdock/shared/protocol';
import { CardDesignHarness } from '../design/testing/card-design-e2e';
import { designResult, MOCKUP } from '../design/testing/design-e2e';
import { BoardFailure } from './board-error';

const KEY = 'card-1';

/** The approved variant's HTML: distinct from the other variant's. */
const PICKED = MOCKUP.replace('Export', 'Sign in');

describe('board × design (e2e, #243)', () => {
  const h = new CardDesignHarness();

  beforeAll(() => h.start());
  afterAll(() => h.close());
  beforeEach(() => h.reset());
  afterEach(() => jest.restoreAllMocks());

  const run = (number: number) =>
    h.author.send('post', `${h.cardPath(number)}/run`, {});

  const setContinue = (number: number, on: boolean) =>
    h.author.send('patch', h.cardPath(number), { continueAfterDesign: on });

  /** A card whose one-variant design is drawn and waiting for review. */
  const drawn = async (): Promise<{
    card: BoardCardDetail;
    view: TaskDesignView;
  }> => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    expect(
      (await h.author.send('post', `${h.cardDesignBase(card.number)}/generate`))
        .status,
    ).toBe(201);
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    return { card, view: await h.cardDesign(card.number) };
  };

  const approve = (number: number, revisionId: string) =>
    h.author.send('post', `${h.cardDesignBase(number)}/approve`, {
      revisionId,
    });

  it('refuses Run with 409 design_not_approved while a needed design is not approved', async () => {
    const { card } = await drawn();
    const refused = await run(card.number);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(BOARD_ERROR.designNotApproved);
    expect(h.cardSentOf('card.run')).toHaveLength(0);
    expect(h.cardSentOf('issue.create')).toHaveLength(0);
    expect(
      await h.ctx.prisma.boardCardRound.count({ where: { cardId: card.id } }),
    ).toBe(0);

    // A design switched off holds nothing.
    await h.author.send('patch', h.cardDesignBase(card.number), {
      needed: false,
    });
    expect((await run(card.number)).status).toBe(200);
    expect(h.cardSentOf('card.run')).toHaveLength(1);
    expect(h.cardSentOf('card.run')[0].files).toBeUndefined();
  });

  it('with the switch on, approving starts round 1 once, as the approver', async () => {
    const { card, view } = await drawn();
    const toggled = await setContinue(card.number, true);
    expect(toggled.status).toBe(200);
    expect((toggled.body as BoardCardDetail).continueAfterDesign).toBe(true);
    expect((toggled.body as BoardCardDetail).design).toMatchObject({
      needed: true,
      status: 'reviewing',
      variantCount: 1,
    });
    const audit = await h.auditOf('card.design_continue_toggled');
    expect(audit).toHaveLength(1);
    expect(audit[0].after).toMatchObject({ continueAfterDesign: true });
    expect(await h.auditOf('card.updated')).toHaveLength(0);

    const [revision] = view.revisions;
    expect((await approve(card.number, revision.id)).status).toBe(200);
    expect(h.cardSentOf('card.run')).toHaveLength(1);
    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
      include: { rounds: true },
    });
    expect(stored.rounds).toHaveLength(1);
    expect(stored.rounds[0]).toMatchObject({
      round: 1,
      trigger: 'run',
      authorId: h.authorId,
    });
    expect(stored.column).toBe('in_progress');

    // Once: the approval is not repeated, nor is the round.
    expect((await approve(card.number, revision.id)).status).toBe(409);
    expect(h.cardSentOf('card.run')).toHaveLength(1);
    // The switch is fixed once the design is approved.
    const late = await setContinue(card.number, false);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe(BOARD_ERROR.designApproved);
  });

  it('with the switch off, approving starts nothing and the card stays in To Do', async () => {
    const { card, view } = await drawn();
    expect((await approve(card.number, view.revisions[0].id)).status).toBe(200);
    expect(h.cardSentOf('card.run')).toHaveLength(0);
    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(stored.column).toBe('todo');
    const detail = (await h.author.get(h.cardPath(card.number)))
      .body as BoardCardDetail;
    expect(detail.design).toMatchObject({ status: 'approved' });
  });

  it('keeps the approval when the auto-run cannot start, answers why, and leaves the card in To Do', async () => {
    const { card, view } = await drawn();
    await setContinue(card.number, true);
    jest
      .mocked(h.boardCommands.assertReady)
      .mockImplementation((_runner, name) => {
        if (name === 'card.run') {
          throw new BoardFailure(
            503,
            BOARD_ERROR.commandUnavailable,
            'The runner is not connected',
          );
        }
      });
    // #273 D8: the approval answers 200 with the run's failure.
    const answered = await approve(card.number, view.revisions[0].id);
    expect(answered.status).toBe(200);
    expect(answered.body.run).toMatchObject({
      status: 'run_failed',
      code: BOARD_ERROR.commandUnavailable,
    });
    expect((await h.cardDesign(card.number)).status).toBe('approved');
    const stored = await h.ctx.prisma.boardCard.findUniqueOrThrow({
      where: { id: card.id },
      include: { rounds: true },
    });
    expect(stored.column).toBe('todo');
    expect(stored.rounds).toHaveLength(0);
  });

  it('round 1 commits the approved HTML at the D7 path without the pin helper, and the prompt names it under ## Design', async () => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    const base = h.cardDesignBase(card.number);
    await h.author.send('post', `${base}/generate`);
    await h.finishCard(card.id, designResult({ taskKey: KEY, variant: 1 }));
    const [first] = (await h.cardDesign(card.number)).revisions;
    const commented = await h.author.send('post', `${base}/comments`, {
      revisionId: first.id,
      kind: 'general',
      body: 'Say "Sign in", not "Export".',
    });
    expect(commented.status).toBe(201);
    const [comment] = (commented.body as TaskDesignView).comments;
    expect((await h.author.send('post', `${base}/revise`)).status).toBe(201);
    await h.finishCard(
      card.id,
      designResult(
        {
          taskKey: KEY,
          variant: 1,
          rationale: 'The button says what it does.',
          addressed: [comment.id],
        },
        PICKED,
      ),
    );
    const revised = (await h.cardDesign(card.number)).revisions.find(
      (r) => r.revision === 2,
    );
    if (!revised) throw new Error('revision 2 was not drawn');
    expect((await approve(card.number, revised.id)).status).toBe(200);

    expect((await run(card.number)).status).toBe(200);
    const [args] = h.cardSentOf('card.run');
    const path = cardDesignPath(
      null,
      { number: card.number, title: card.title, issueNumber: null },
      1,
      'mockup',
    );
    expect(path).toBe('docs/design/cards/C-1-add-login/1/mockup.html');
    const files = args.files as CardRunFile[];
    expect(files).toEqual([{ path, content: PICKED }]);
    expect(files[0].content).not.toContain(MOCKUP_PIN_HELPER_ATTRIBUTE);
    const prompt = String(args.prompt);
    expect(prompt).toContain('## Design');
    expect(prompt).toContain(`The approved mockup is ${path}`);
    expect(prompt).toContain('Why this design: The button says what it does.');
    expect(prompt).toContain('- Say "Sign in", not "Export".');

    // Designs freeze once a round exists.
    const frozen = await h.author.send('patch', base, { needed: false });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error).toBe('task_frozen');
  });

  it('places the mockup beside the spec when the project has a specDir', async () => {
    await h.ctx.prisma.project.update({
      where: { id: h.projectId },
      data: { codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } } },
    });
    const { card, view } = await drawn();
    await h.author.send('patch', h.cardPath(card.number), { specOnRun: true });
    await approve(card.number, view.revisions[0].id);
    expect((await run(card.number)).status).toBe(200);
    const files = h.cardSentOf('card.run')[0].files as CardRunFile[];
    expect(files.map((f) => f.path)).toEqual([
      'docs/specs/card-1-add-login.md',
      'docs/specs/card-1-add-login/design/1/mockup.html',
    ]);
  });

  it('round 1 commits every frame of the approved variant and lists them under ## Design (#441)', async () => {
    await h.seedProfile();
    const card = await h.designedCard(1);
    const base = h.cardDesignBase(card.number);
    await h.author.send('post', `${base}/generate`);
    const frames = [
      { name: 'Board page', html: MOCKUP.replace('Export', 'Board') },
      { name: 'Card page', html: MOCKUP.replace('Export', 'Card') },
      { name: 'Frame tabs', html: MOCKUP.replace('Export', 'Tabs') },
    ];
    await h.finishCard(
      card.id,
      designResult({ taskKey: KEY, variant: 1 }, frames),
    );
    const [revision] = (await h.cardDesign(card.number)).revisions;
    const commented = await h.author.send('post', `${base}/comments`, {
      revisionId: revision.id,
      frame: 1,
      kind: 'general',
      body: 'Keep the sidebar.',
    });
    expect(commented.status).toBe(201);
    expect((await approve(card.number, revision.id)).status).toBe(200);
    expect((await run(card.number)).status).toBe(200);
    const [args] = h.cardSentOf('card.run');
    const dir = 'docs/design/cards/C-1-add-login/1';
    expect(args.files as CardRunFile[]).toEqual([
      { path: `${dir}/board-page.html`, content: frames[0].html },
      { path: `${dir}/card-page.html`, content: frames[1].html },
      { path: `${dir}/frame-tabs.html`, content: frames[2].html },
    ]);
    const prompt = String(args.prompt);
    expect(prompt).toContain('The approved design has 3 frames');
    expect(prompt).toContain(`- ${dir}/board-page.html — Board page`);
    expect(prompt).toContain(`- ${dir}/card-page.html — Card page`);
    expect(prompt).toContain(`- ${dir}/frame-tabs.html — Frame tabs`);
  });

  it('deleting a card that had design turns closes its design plan on the runner', async () => {
    const { card } = await drawn();
    const deleted = await h.author.send('delete', h.cardPath(card.number));
    expect(deleted.status).toBe(204);
    await h.work.settled();
    expect(h.cardSentOf('plan.close')).toEqual([
      { planId: card.id, projectId: h.projectId },
    ]);
    expect(
      await h.ctx.prisma.taskDesign.count({ where: { cardId: card.id } }),
    ).toBe(0);
  });
});
