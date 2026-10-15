import { BOARD_ERROR } from '@agentdock/shared';
import { BoardFailure } from './board-error';
import { BoardWorld, HEAD_SHA, ok, prInspection } from './testing/board-e2e';

/**
 * Accept with merge (#273 D10–D16, ADR-0029): the card's PR is read through
 * `pr.inspect` and merged through `card.merge` on the runner, bound to the
 * head the person saw; a refusal leaves the card in Finished.
 */
describe('board accept with merge (e2e, #273)', () => {
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

  const pullRequest = (number: number) =>
    w.operator.get(`${w.path()}/board/cards/${number}/pull-request`);

  /** C-1 run, finished, and collected into PR #77 with issue #41. */
  const finished = async (config: object | null = null): Promise<void> => {
    if (config !== null) {
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: { codeSentinelConfig: config },
      });
    }
    await w.createCard({ issueOnRun: true });
    expect((await w.runCard(1)).status).toBe(200);
    expect((await post(1, 'finish')).status).toBe(200);
    await w.work.settled();
    const card = await w.card(1);
    expect(card).toMatchObject({
      column: 'finished',
      prNumber: 77,
      issueNumber: 41,
    });
  };

  describe('GET …/pull-request', () => {
    it("reads the PR through pr.inspect with the project's method", async () => {
      await finished({ orchestrator: { mergeMethod: 'squash' } });
      const response = await pullRequest(1);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        number: 77,
        url: 'https://github.com/acme/widget/pull/77',
        state: 'open',
        headSha: HEAD_SHA,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        checks: 'pass',
        method: 'squash',
        canMerge: true,
      });
      expect(jest.mocked(w.commands.inspectPr).mock.calls[0][1]).toEqual({
        projectId: w.a,
        root: '/srv/dev/widget',
        pr: 77,
      });
    });

    it('cannot merge a merged PR, nor on a runner without card.merge', async () => {
      await finished();
      w.handlers['pr.inspect'] = () => ok(prInspection({ state: 'merged' }));
      expect((await pullRequest(1)).body).toMatchObject({
        state: 'merged',
        method: null,
        canMerge: false,
      });

      w.handlers['pr.inspect'] = undefined;
      const assertReady = jest.mocked(w.commands.assertReady);
      const previous = assertReady.getMockImplementation();
      assertReady.mockImplementation((_runner, name) => {
        if (name === 'card.merge') {
          throw new BoardFailure(
            503,
            BOARD_ERROR.commandUnavailable,
            'The runner does not serve card.merge; update it',
          );
        }
      });
      try {
        expect((await pullRequest(1)).body).toMatchObject({
          state: 'open',
          canMerge: false,
        });
      } finally {
        if (previous) assertReady.mockImplementation(previous);
      }
    });

    it('is 404 no_pull_request without one, 503 with the runner offline', async () => {
      await w.createCard();
      const none = await pullRequest(1);
      expect(none.status).toBe(404);
      expect(none.body.error).toBe('no_pull_request');

      await w.ctx.prisma.boardCard.updateMany({ data: { prNumber: 77 } });
      w.offline = true;
      const offline = await pullRequest(1);
      expect(offline.status).toBe(503);
      expect(offline.body.error).toBe('command_unavailable');
    });
  });

  describe('POST …/accept', () => {
    it("merges with the project's method, closes the issue, moves to Completed and schedules card.close", async () => {
      await finished({ orchestrator: { mergeMethod: 'squash' } });
      w.handlers['card.merge'] = () =>
        ok({
          merged: true,
          alreadyMerged: false,
          method: 'squash',
          mergeCommit: 'b'.repeat(40),
          issueClosed: true,
        });
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        column: 'completed',
        merge: {
          merged: true,
          alreadyMerged: false,
          method: 'squash',
          mergeCommit: 'b'.repeat(40),
          issueClosed: true,
        },
      });
      const card = await w.card(1);
      expect(w.sent('card.merge')).toEqual([
        {
          cardId: card.id,
          projectId: w.a,
          root: '/srv/dev/widget',
          pr: 77,
          headSha: HEAD_SHA,
          method: 'squash',
          issue: 41,
          comment: 'Completed as C-1 on the AgentDock board; merged in #77.',
        },
      ]);
      await w.work.settled();
      expect(w.sent('card.close')).toHaveLength(1);
      const [merged] = await w.audit('card.merged');
      expect(merged.after).toMatchObject({
        pr: 77,
        method: 'squash',
        mergeCommit: 'b'.repeat(40),
        issueClosed: true,
      });
    });

    it('sends method null without a mergeMethod, and accepts an issue close that failed', async () => {
      await finished();
      w.handlers['card.merge'] = () =>
        ok({
          merged: true,
          alreadyMerged: true,
          method: 'merge',
          mergeCommit: null,
          issueClosed: false,
          issueError: 'gh: issue not found',
        });
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA },
      });
      expect(response.status).toBe(200);
      expect(w.sent('card.merge')[0].method).toBeNull();
      expect(response.body.column).toBe('completed');
      expect(response.body.merge).toMatchObject({
        alreadyMerged: true,
        issueClosed: false,
        issueError: 'gh: issue not found',
      });
    });

    it('head_changed → 409 merge_failed, the card stays in Finished, audit card.merge_failed', async () => {
      await finished();
      w.handlers['card.merge'] = () =>
        ok({
          merged: false,
          error: 'head_changed',
          message: 'The head moved to cccc',
        });
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA },
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: 'merge_failed',
        reason: 'head_changed',
        message: 'The head moved to cccc',
      });
      expect((await w.card(1)).column).toBe('finished');
      await w.work.settled();
      expect(w.sent('card.close')).toHaveLength(0);
      const [failure] = await w.audit('card.merge_failed');
      expect(failure.result).toBe('error');
      expect(failure.after).toMatchObject({ pr: 77, reason: 'head_changed' });
      expect(await w.audit('card.merged')).toHaveLength(0);
    });

    it('no PR → 409 no_pull_request, nothing sent', async () => {
      await w.createCard();
      await w.runCard(1);
      await post(1, 'finish');
      await w.work.settled();
      await w.ctx.prisma.boardCard.updateMany({
        data: { prNumber: null, prUrl: null },
      });
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA },
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('no_pull_request');
      expect(w.sent('card.merge')).toEqual([]);
      expect((await w.card(1)).column).toBe('finished');
    });

    it('an empty body is the move only: no card.merge, merge null', async () => {
      await finished();
      const response = await post(1, 'accept');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ column: 'completed', merge: null });
      expect(w.sent('card.merge')).toEqual([]);
      expect(await w.audit('card.merged')).toHaveLength(0);
    });

    it('refuses a headSha that is not 40 lower-case hex, and extra keys', async () => {
      await finished();
      for (const body of [
        { merge: { headSha: 'abc' } },
        { merge: { headSha: 'A'.repeat(40) } },
        { merge: {} },
        { merge: { headSha: HEAD_SHA, method: 'rebase' } },
        { force: true },
      ]) {
        expect((await post(1, 'accept', body)).status).toBe(400);
      }
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('outside Finished → 409 wrong_column, nothing sent', async () => {
      await w.createCard();
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA },
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('wrong_column');
      expect(w.sent('card.merge')).toEqual([]);
    });
  });
});
