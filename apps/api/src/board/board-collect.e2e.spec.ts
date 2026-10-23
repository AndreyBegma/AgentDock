import {
  CARD_COLLECT_AUTO_ATTEMPTS_MAX,
  CARD_COLLECT_RETRY_DELAY_MS,
  divergedBranchMessage,
} from '@nautelle/shared';
import { BoardWorld, failed, ok } from './testing/board-e2e';

const PR_URL = 'https://github.com/acme/widget/pull/77';

/**
 * The collect outcome on the card (#329 D2–D5): every attempt stores it, a
 * failure is retried after two minutes and on the runner's next `hello` —
 * three automatic attempts in all — and Create pull request runs it by hand.
 */
describe('board collect (e2e, #329)', () => {
  const w = new BoardWorld();

  beforeAll(() => w.init());
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  const post = (number: number, action: string, body: object = {}) =>
    w.operator.send(
      'post',
      `${w.path()}/board/cards/${number}/${action}`,
      body,
    );

  const collectBy = (session = w.operator, projectId = w.a, number = 1) =>
    session.send(
      'post',
      `${w.path(projectId)}/board/cards/${number}/collect`,
      {},
    );

  /** C-1 run and finished, with the runner failing `card.collect`. */
  const failedCard = async (): Promise<void> => {
    w.handlers['card.collect'] = () => failed('internal');
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    expect((await post(1, 'finish')).status).toBe(200);
    await w.work.settled();
  };

  const runRetry = async (index: number): Promise<void> => {
    w.retries[index].run();
    await w.work.settled();
  };

  const hello = async (): Promise<void> => {
    await w.connectHooks.connected(w.runnerId);
    await w.work.settled();
  };

  it('stores a failed collect on the card and in its view', async () => {
    await failedCard();
    const card = await w.card(1);
    expect(card).toMatchObject({
      column: 'finished',
      collectState: 'failed',
      collectAttempts: 1,
      prUrl: null,
    });
    expect(card.collectError).toContain('card.collect failed on the runner');
    expect(card.collectedAt).toBeInstanceOf(Date);

    const view = await w.operator.get(`${w.path()}/board/cards/1`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      collectState: 'failed',
      collectError: card.collectError,
      prUrl: null,
      prState: null,
    });
  });

  it('stores a success as ok with the PR and its state', async () => {
    await w.createCard();
    await w.runCard(1);
    await post(1, 'finish');
    await w.work.settled();
    expect(await w.card(1)).toMatchObject({
      collectState: 'ok',
      collectError: null,
      collectAttempts: 1,
      prNumber: 77,
      prUrl: PR_URL,
      // An older runner reports no state: its PR is open.
      prState: 'open',
    });
    expect(w.retries).toEqual([]);
  });

  it('#895: a round whose only new commit merges the base reports its head; a round with none reports nothing new', async () => {
    const FIRST = 'a'.repeat(40);
    const MERGE = 'c'.repeat(40);
    const collected = (headSha: string) => {
      w.handlers['card.collect'] = () =>
        ok({ ahead: 2, pushed: true, headSha, prNumber: 77, prUrl: PR_URL });
    };
    const round = async () => {
      expect((await post(1, 'finish')).status).toBe(200);
      await w.work.settled();
    };
    collected(FIRST);
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    await round();

    // The next round only merges the base: the merge is its head.
    collected(MERGE);
    expect((await post(1, 'feedback', { text: 'Merge develop.' })).status).toBe(
      200,
    );
    await round();
    let card = await w.card(1);
    expect(card).toMatchObject({ collectState: 'ok', prUrl: PR_URL });
    expect(card.rounds.map((r) => [r.headSha, r.headAhead])).toEqual([
      [FIRST, 2],
      [MERGE, 2],
    ]);

    // A round that adds no commit leaves the head as it found it.
    expect((await post(1, 'feedback', { text: 'Look again.' })).status).toBe(
      200,
    );
    await round();
    card = await w.card(1);
    expect(card.rounds[2]).toMatchObject({ headSha: null });
  });

  it('retries once after two minutes, then on the next hello, three attempts in all', async () => {
    await failedCard();
    expect(w.retries).toHaveLength(1);
    expect(w.retries[0]).toMatchObject({
      delayMs: CARD_COLLECT_RETRY_DELAY_MS,
    });

    await runRetry(0);
    expect(w.sent('card.collect')).toHaveLength(2);
    expect((await w.card(1)).collectAttempts).toBe(2);
    // "Once": the timer's own failure does not arm another timer.
    expect(w.retries).toHaveLength(1);

    await hello();
    expect(w.sent('card.collect')).toHaveLength(3);
    expect(await w.card(1)).toMatchObject({
      collectState: 'failed',
      collectAttempts: CARD_COLLECT_AUTO_ATTEMPTS_MAX,
    });

    // After three failures, no further automatic attempt.
    await hello();
    await runRetry(0);
    expect(w.sent('card.collect')).toHaveLength(3);
  });

  it('a retry that succeeds stores the PR', async () => {
    await failedCard();
    w.handlers['card.collect'] = undefined;
    await hello();
    expect(await w.card(1)).toMatchObject({
      collectState: 'ok',
      collectAttempts: 2,
      prUrl: PR_URL,
      prState: 'open',
    });
    // Nothing left to retry.
    await runRetry(0);
    expect(w.sent('card.collect')).toHaveLength(2);
  });

  it('a diverged branch needs a person with the reason, audited once; a later success clears it (#630)', async () => {
    const reason = divergedBranchMessage('fix/1-x', 'ab12cd34');
    w.handlers['card.collect'] = () => failed('internal', reason);
    await w.createCard();
    await w.runCard(1);
    await post(1, 'finish');
    await w.work.settled();
    const card = await w.card(1);
    expect(card).toMatchObject({
      column: 'finished',
      collectState: 'failed',
      needsPerson: true,
      needsPersonReason: 'branch_diverged',
    });
    expect(card.collectError).toContain(reason);
    const view = await w.operator.get(`${w.path()}/board/cards/1`);
    expect(view.body).toMatchObject({
      needsPerson: true,
      needsPersonReason: 'branch_diverged',
      collectState: 'failed',
    });
    await runRetry(0);
    expect(w.sent('card.collect')).toHaveLength(2);
    const audits = (await w.audit('card.auto_run_failed')).filter(
      (a) => (a.after as { reason?: string }).reason === 'branch_diverged',
    );
    expect(audits).toHaveLength(1);

    w.handlers['card.collect'] = undefined;
    await hello();
    expect(await w.card(1)).toMatchObject({
      collectState: 'ok',
      needsPerson: false,
      needsPersonReason: null,
      prUrl: PR_URL,
    });
  });

  it('never retries a card a person moved out of Finished', async () => {
    await failedCard();
    // #709: a failed collect left no PR, so the person confirms.
    expect((await post(1, 'accept')).status).toBe(409);
    expect((await post(1, 'accept', { confirmUnlanded: true })).status).toBe(
      200,
    );
    await w.work.settled();
    await runRetry(0);
    await hello();
    expect(w.sent('card.collect')).toHaveLength(1);
  });

  it("retries only the connecting runner's cards", async () => {
    await failedCard();
    await w.connectHooks.connected('another-runner');
    await w.work.settled();
    expect(w.sent('card.collect')).toHaveLength(1);
  });

  describe('POST …/collect (Create pull request)', () => {
    it('runs it again and on success stores prUrl, ok and open', async () => {
      await failedCard();
      await runRetry(0);
      await hello();
      w.handlers['card.collect'] = undefined;

      const response = await collectBy();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        number: 1,
        prUrl: PR_URL,
        prState: 'open',
        collectState: 'ok',
        collectError: null,
        collect: {
          state: 'ok',
          error: null,
          ahead: 2,
          prNumber: 77,
          prUrl: PR_URL,
        },
      });
      // It resets the automatic attempts.
      expect((await w.card(1)).collectAttempts).toBe(0);
      const [audit] = await w.audit('card.collect_requested');
      expect(audit).toMatchObject({
        result: 'ok',
        after: { number: 1, state: 'ok', pr: 77 },
      });
    });

    it('answers a failure with 200, and arms the two-minute retry again', async () => {
      await failedCard();
      await runRetry(0);
      await hello();
      expect((await w.card(1)).collectAttempts).toBe(3);

      const response = await collectBy();
      expect(response.status).toBe(200);
      expect(response.body.collect).toMatchObject({
        state: 'failed',
        ahead: null,
        prUrl: null,
      });
      expect(response.body.collectError).toContain('card.collect failed');
      expect(await w.card(1)).toMatchObject({ collectAttempts: 0 });
      expect(w.retries).toHaveLength(2);

      // Its attempts are reset: automatic retries run again.
      await runRetry(1);
      expect(w.sent('card.collect')).toHaveLength(5);
      expect((await w.card(1)).collectAttempts).toBe(1);
    });

    it('fills a lost link from a PR that is already open (D3)', async () => {
      await w.createCard();
      await w.runCard(1);
      await post(1, 'finish');
      await w.work.settled();
      await w.ctx.prisma.boardCard.updateMany({
        data: { prNumber: null, prUrl: null, prState: null },
      });
      w.handlers['card.collect'] = () =>
        ok({
          ahead: 2,
          pushed: false,
          prNumber: 77,
          prUrl: PR_URL,
          prState: 'draft',
        });
      const response = await collectBy();
      expect(response.status).toBe(200);
      expect(await w.card(1)).toMatchObject({
        prNumber: 77,
        prUrl: PR_URL,
        prState: 'draft',
        collectState: 'ok',
      });
    });

    it('stores no_changes for a branch with nothing ahead', async () => {
      w.handlers['card.collect'] = () => ok({ ahead: 0, pushed: false });
      await w.createCard();
      await w.runCard(1);
      await post(1, 'finish');
      await w.work.settled();
      expect(await w.card(1)).toMatchObject({
        collectState: 'no_changes',
        collectError: null,
        prUrl: null,
      });
      expect(w.retries).toEqual([]);
      const response = await collectBy();
      expect(response.body.collect).toMatchObject({
        state: 'no_changes',
        ahead: 0,
      });
    });

    it('is 409 wrong_column outside Finished and Completed, 409 no_branch without a branch', async () => {
      await w.createCard();
      const todo = await collectBy();
      expect(todo.status).toBe(409);
      expect(todo.body.error).toBe('wrong_column');

      await w.ctx.prisma.boardCard.updateMany({
        data: { column: 'finished' },
      });
      const branchless = await collectBy();
      expect(branchless.status).toBe(409);
      expect(branchless.body.error).toBe('no_branch');
      expect(w.sent('card.collect')).toEqual([]);
    });

    it("is 403 for a viewer and 404 for another project's card number", async () => {
      await failedCard();
      expect((await collectBy(w.viewer)).status).toBe(403);
      // Card C-1 exists in A only: B's route never reaches it.
      expect((await collectBy(w.admin, w.b)).status).toBe(404);
      expect((await collectBy(w.operatorOfB, w.a)).status).toBe(404);
      expect(w.sent('card.collect')).toHaveLength(1);
    });
  });
});
