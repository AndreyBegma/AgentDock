import type { BoardCardDetail } from '@nautelle/shared';
import type { LocalCardReviewReportArgs } from '@nautelle/shared/protocol';
import { BudgetGate } from '../budgets/budget-gate';
import { BoardReview } from './board-review';
import { BoardShipping } from './board-shipping';
import {
  BoardWorld,
  cardChecks,
  failed,
  HEAD_SHA,
  ok,
  ROOT_A,
} from './testing/board-e2e';

const NEW_HEAD = 'b'.repeat(40);

type Finding = LocalCardReviewReportArgs['findings'][number];

const BLOCKER: Finding = {
  severity: 'blocking',
  file: 'src/login.ts',
  line: 12,
  title: 'Password logged',
  body: 'The password is written to the log.',
};
const NIT: Finding = {
  severity: 'nit',
  title: 'Rename the helper',
  body: 'x says nothing.',
};

/**
 * The review gate (issue #884, ADR-0084): with review on, a card whose PR is
 * green runs every enabled review step, in position order, on the PR head
 * before Finished; blocking findings start `review_fix` rounds, at most 3 per
 * PR; a nit never holds a card back; the findings are posted on GitHub when
 * the project asks for it.
 */
describe('a card passes its review steps before Finished (e2e, #884)', () => {
  const w = new BoardWorld();
  let shipping: BoardShipping;
  let review: BoardReview;

  beforeAll(async () => {
    await w.init();
    shipping = w.ctx.app.get(BoardShipping);
    review = w.ctx.app.get(BoardReview);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    w.checksServed = true;
  });
  afterEach(() => w.work.settled());

  const reviewOn = (
    settings: { reviewEnabled?: boolean; publishReviewComments?: boolean } = {},
  ) => {
    const data = {
      reviewEnabled: true,
      publishReviewComments: false,
      ...settings,
    };
    return w.ctx.prisma.boardSettings.upsert({
      where: { projectId: w.a },
      create: { projectId: w.a, ...data },
      update: data,
    });
  };

  const step = (
    position: number,
    name: string,
    extra: { enabled?: boolean; type?: 'skill'; skillName?: string } = {},
  ) =>
    w.ctx.prisma.projectReviewStep.create({
      data: {
        projectId: w.a,
        position,
        name,
        type: extra.type ?? 'peer_review',
        enabled: extra.enabled ?? true,
        ...(extra.type === 'skill'
          ? { skillName: extra.skillName ?? 'cs-review' }
          : { instructions: `Review it as ${name}.` }),
      },
    });

  const detail = async (number = 1): Promise<BoardCardDetail> => {
    const response = await w.operator.get(`${w.path()}/board/cards/${number}`);
    expect(response.status).toBe(200);
    return response.body as BoardCardDetail;
  };

  const latest = async (number = 1) => {
    const card = await w.card(number);
    return { card, round: card.rounds[card.rounds.length - 1] };
  };

  /** The latest round ran a minute and its session ended: the worker is done. */
  const ended = async (number = 1): Promise<void> => {
    const { round } = await latest(number);
    await w.ctx.prisma.boardCardRound.update({
      where: { id: round.id },
      data: { startedAt: new Date(Date.now() - 60_000) },
    });
    const { card } = await latest(number);
    await w.deliver('card_run.phase_changed', {
      cardId: card.id,
      runId: round.runId,
      projectId: card.projectId,
      at: new Date().toISOString(),
      phase: 'ended',
      exitCode: 0,
    });
    await w.work.settled();
  };

  /** C-1 created and run. */
  const started = async (): Promise<void> => {
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
  };

  /** C-1 created, run, and its worker done on a green PR. */
  const greenPr = async (): Promise<void> => {
    await started();
    await ended();
  };

  /**
   * The latest review session calls `report_review`, and the gate is asked
   * again — what the shipping callback does outside tests.
   */
  const reported = async (findings: Finding[], summary?: string) => {
    const session = w.reviews().at(-1)?.session;
    expect(typeof session).toBe('string');
    const result = await review.report(
      { id: w.a, runnerId: w.runnerId },
      session as string,
      { findings, ...(summary === undefined ? {} : { summary }) },
    );
    await shipping.check((await w.card(1)).id);
    await w.work.settled();
    return result;
  };

  describe('review off', () => {
    it('a project with review off ships as before, and the card has no review', async () => {
      await reviewOn({ reviewEnabled: false });
      await step(0, 'Security');
      await greenPr();
      expect(w.reviews()).toEqual([]);
      expect(w.sent('card.merge')).toHaveLength(1);
      const card = await detail();
      expect(card).toMatchObject({ column: 'finished', prState: 'merged' });
      expect(card.review).toBeNull();
      expect(card.reviewFindings).toBeUndefined();
    });

    it('review on without an enabled step ships as before', async () => {
      await reviewOn();
      await step(0, 'Security', { enabled: false });
      await greenPr();
      expect(w.reviews()).toEqual([]);
      expect((await w.card(1)).column).toBe('finished');
      expect(w.sent('card.merge')).toHaveLength(1);
      expect((await detail()).review).toBeNull();
    });
  });

  describe('the steps', () => {
    it('green CI starts the first enabled step; the card stays In progress and is not merged', async () => {
      await reviewOn();
      await step(0, 'Security');
      await greenPr();
      const [started] = w.reviews();
      expect(started).toMatchObject({
        projectId: w.a,
        root: ROOT_A,
        branch: 'card/c1-add-login',
        headSha: HEAD_SHA,
        session: expect.any(String),
        runId: expect.any(String),
      });
      expect(started.prompt).toContain('Review it as Security.');
      expect(started.prompt).toContain('report_review');
      expect(w.sent('card.merge')).toEqual([]);
      const card = await detail();
      expect(card.column).toBe('in_progress');
      expect(card.review).toEqual({
        state: 'running',
        currentStep: 'Security',
        stepIndex: 0,
        stepCount: 1,
        fixRound: 0,
        fixLimit: 3,
        steps: [
          {
            id: expect.any(String),
            name: 'Security',
            state: 'running',
            blockingCount: 0,
            nitCount: 0,
          },
        ],
      });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: started.runId as string },
      });
      expect(run).toMatchObject({
        kind: 'card_review',
        status: 'running',
        triggeredByType: 'user',
        triggeredById: w.operatorId,
      });
      const [record] = await w.audit('card.review_started');
      expect(record.after).toMatchObject({
        number: 1,
        step: 'Security',
        pr: 77,
        headSha: HEAD_SHA,
        pass: 0,
        tmuxSession: expect.stringMatching(/^nautelle-review-/),
      });

      // A poll while the step runs starts nothing more.
      await shipping.poll();
      expect(w.reviews()).toHaveLength(1);
    });

    it('runs the enabled steps in position order, skips a disabled one, and a nit-only review passes', async () => {
      await reviewOn();
      await step(2, 'Style', { type: 'skill', skillName: 'cs-review' });
      await step(1, 'Skipped', {
        type: 'skill',
        skillName: 'cs-security',
        enabled: false,
      });
      await step(0, 'Security');
      await greenPr();
      expect(w.reviews()[0].prompt).toContain('Review it as Security.');

      expect(await reported([], 'Nothing found.')).toEqual({
        number: 1,
        blocking: 0,
        nits: 0,
      });
      expect(w.reviews()).toHaveLength(2);
      expect(w.reviews()[1].prompt).toMatch(
        /^\/cs-review Review pull request #77/,
      );
      expect(w.sent('card.merge')).toEqual([]);

      await reported([NIT]);
      expect(w.reviews()).toHaveLength(2);
      const card = await detail();
      expect(card).toMatchObject({ column: 'finished', prState: 'merged' });
      expect(card.review).toMatchObject({
        state: 'passed',
        stepCount: 2,
        steps: [
          { name: 'Security', state: 'passed', blockingCount: 0, nitCount: 0 },
          { name: 'Style', state: 'passed', blockingCount: 0, nitCount: 1 },
        ],
      });
      // #891: the detail serves the pass's findings with their step's name.
      expect(card.reviewFindings).toEqual([
        expect.objectContaining({
          stepName: 'Style',
          severity: 'nit',
          title: NIT.title,
        }),
      ]);
      expect(w.sent('card.merge')).toEqual([
        expect.objectContaining({ pr: 77, headSha: HEAD_SHA }),
      ]);
      expect(await w.audit('card.review_reported')).toHaveLength(2);
      expect(
        await w.ctx.prisma.boardCardReviewRun.count({
          where: { stepName: 'Skipped' },
        }),
      ).toBe(0);
      // Every review session ran as a `card_review` run, now closed.
      expect(
        await w.ctx.prisma.run.findMany({
          where: { kind: 'card_review' },
          select: { status: true },
        }),
      ).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
    });

    it('blocking findings start a review_fix round with them; CI and the steps run again after the push, then it ships', async () => {
      await reviewOn();
      await step(0, 'Security');
      await greenPr();
      await reported([BLOCKER, NIT]);

      const card = await w.card(1);
      expect(card).toMatchObject({
        column: 'in_progress',
        reviewFixAttempts: 1,
        ciFixAttempts: 0,
        needsPerson: false,
      });
      expect(card.rounds.map((r) => r.trigger)).toEqual(['run', 'review_fix']);
      const runs = w.sent('card.run');
      expect(runs).toHaveLength(2);
      expect(runs[1].session).toMatchObject({ resume: true });
      expect(runs[1].prompt).toContain('[Security] Password logged');
      expect(runs[1].prompt).toContain('src/login.ts:12');
      expect(runs[1].prompt).toContain('The password is written to the log.');
      expect(runs[1].prompt).not.toContain('Rename the helper');
      const [fix] = (await w.audit('card.run_started')).slice(-1);
      expect(fix.after).toMatchObject({ trigger: 'review_fix' });
      expect((await detail()).review).toMatchObject({
        state: 'fixing',
        fixRound: 1,
        steps: [{ name: 'Security', blockingCount: 1, nitCount: 1 }],
      });

      // The fix pushes a new head; CI reads it green, and the step runs on it.
      w.handlers['card.checks'] = () => ok(cardChecks({ headSha: NEW_HEAD }));
      await ended();
      expect(w.reviews()).toHaveLength(2);
      expect(w.reviews()[1].headSha).toBe(NEW_HEAD);
      expect(w.sent('card.merge')).toEqual([]);

      await reported([]);
      const view = await detail();
      expect(view).toMatchObject({ column: 'finished', prState: 'merged' });
      expect(view.review).toMatchObject({ state: 'passed', fixRound: 1 });
      expect(w.sent('card.merge')).toEqual([
        expect.objectContaining({ headSha: NEW_HEAD }),
      ]);
    });

    it('a fix round that pushed nothing new still has its head reviewed again', async () => {
      await reviewOn();
      await step(0, 'Security');
      await greenPr();
      await reported([BLOCKER]);
      await ended();
      expect(w.reviews()).toHaveLength(2);
      expect(w.reviews()[1].headSha).toBe(HEAD_SHA);
    });

    it('after 3 review fix rounds the card needs a person, no 4th starts, and it is never merged', async () => {
      await reviewOn();
      await step(0, 'Security');
      await greenPr();
      for (let i = 0; i < 3; i += 1) {
        await reported([BLOCKER]);
        await ended();
      }
      await reported([BLOCKER]);

      const card = await w.card(1);
      expect(card.rounds.map((r) => r.trigger)).toEqual([
        'run',
        'review_fix',
        'review_fix',
        'review_fix',
      ]);
      expect(card).toMatchObject({
        reviewFixAttempts: 3,
        needsPerson: true,
        needsPersonReason: 'review_still_blocking',
        column: 'finished',
      });
      await shipping.poll();
      expect((await w.card(1)).rounds).toHaveLength(4);
      expect(w.reviews()).toHaveLength(4);
      expect(w.sent('card.merge')).toEqual([]);
      const [record] = await w.audit('card.auto_run_failed');
      expect(record).toMatchObject({ actorType: 'system' });
      expect(record.after).toMatchObject({
        reason: 'review_still_blocking',
        attempts: 3,
        blocking: 1,
      });
      expect((await detail()).review).toMatchObject({
        state: 'needs_person',
        fixRound: 3,
        fixLimit: 3,
      });
    });

    it('a step the runner refuses to start needs a person', async () => {
      await reviewOn();
      await step(0, 'Security');
      w.handlers['card.review'] = () => failed('internal', 'tmux failed');
      await greenPr();
      const card = await w.card(1);
      expect(card).toMatchObject({
        needsPerson: true,
        needsPersonReason: 'review_failed',
        column: 'finished',
      });
      expect(w.sent('card.merge')).toEqual([]);
      const run = await w.ctx.prisma.boardCardReviewRun.findFirstOrThrow();
      expect(run).toMatchObject({ state: 'failed' });
    });

    it('a runner that does not run review steps needs a person', async () => {
      await reviewOn();
      await step(0, 'Security');
      w.reviewServed = false;
      await greenPr();
      expect(w.reviews()).toEqual([]);
      expect(await w.card(1)).toMatchObject({
        needsPerson: true,
        needsPersonReason: 'review_failed',
      });
      expect(w.sent('card.merge')).toEqual([]);
    });

    it("the round starter's budget hard stop holds the step until it lifts", async () => {
      await reviewOn();
      await step(0, 'Security');
      await started();
      const gate = w.ctx.app.get(BudgetGate);
      const check = jest
        .spyOn(gate, 'check')
        .mockImplementation(async ({ userId }) =>
          userId === w.operatorId
            ? {
                allowed: false,
                budgetId: 'b1',
                scope: 'user',
                resetsAt: new Date('2026-11-01T00:00:00Z'),
              }
            : { allowed: true },
        );
      try {
        await ended();
        expect(w.reviews()).toEqual([]);
        expect(await w.card(1)).toMatchObject({
          column: 'in_progress',
          needsPerson: false,
        });
        expect(w.sent('card.merge')).toEqual([]);
      } finally {
        check.mockRestore();
      }
      await shipping.poll();
      expect(w.reviews()).toHaveLength(1);
    });
  });

  describe('publishing on GitHub', () => {
    it('posts each report as a pull request review, inline where a finding has a place', async () => {
      await reviewOn({ publishReviewComments: true });
      await step(0, 'Security');
      await greenPr();
      await reported([BLOCKER, NIT], 'One problem.');
      const [published] = w.reviewPublishes();
      expect(published).toMatchObject({
        projectId: w.a,
        root: ROOT_A,
        prNumber: 77,
        headSha: HEAD_SHA,
        comments: [
          {
            path: 'src/login.ts',
            line: 12,
            body: expect.stringContaining('Password logged'),
          },
        ],
      });
      expect(published.body).toContain('One problem.');
      expect(published.body).toContain('Rename the helper');
      const run = await w.ctx.prisma.boardCardReviewRun.findFirstOrThrow();
      expect(run.publishedAt).not.toBeNull();
    });

    it('posts nothing with publishing off', async () => {
      await reviewOn();
      await step(0, 'Security');
      await greenPr();
      await reported([BLOCKER]);
      expect(w.reviewPublishes()).toEqual([]);
    });

    it.each([
      [
        'refuses',
        () => ok({ published: false, error: 'gh_failed', message: 'HTTP 422' }),
      ],
      ['fails', () => failed('internal', 'gh crashed')],
    ])('a runner that %s the post never holds the card back', async (_, answer) => {
      await reviewOn({ publishReviewComments: true });
      await step(0, 'Security');
      w.handlers['card.reviewPublish'] = answer;
      await greenPr();
      await reported([NIT]);
      expect(w.reviewPublishes()).toHaveLength(1);
      expect((await w.card(1)).column).toBe('finished');
      expect(w.sent('card.merge')).toHaveLength(1);
      const run = await w.ctx.prisma.boardCardReviewRun.findFirstOrThrow();
      expect(run.publishedAt).toBeNull();
    });
  });

  it('a report from a session that is no running review step records nothing', async () => {
    await reviewOn();
    await step(0, 'Security');
    await greenPr();
    expect(
      await review.report(
        { id: w.a, runnerId: w.runnerId },
        '00000000-0000-4000-8000-000000000000',
        { findings: [BLOCKER] },
      ),
    ).toBeNull();
    const session = w.reviews()[0].session as string;
    expect(
      await review.report({ id: w.b, runnerId: w.runnerId }, session, {
        findings: [BLOCKER],
      }),
    ).toBeNull();
    expect(
      await w.ctx.prisma.boardCardReviewRun.findFirstOrThrow(),
    ).toMatchObject({ state: 'running' });
  });
});
