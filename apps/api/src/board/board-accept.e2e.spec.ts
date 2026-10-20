import { BOARD_ERROR } from '@nautelle/shared';
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
          comment: 'Completed as C-1 on the Nautelle board; merged in #77.',
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
      // #709: the open PR #77 has not landed; the person confirms.
      const response = await post(1, 'accept', { confirmUnlanded: true });
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

  describe('#329 D7: merge and delete the branch', () => {
    it('sends deleteBranch, reports branchDeleted, stores merged and closes the worktree', async () => {
      await finished();
      w.handlers['card.merge'] = (args) =>
        ok({
          merged: true,
          alreadyMerged: false,
          method: 'merge',
          mergeCommit: null,
          issueClosed: true,
          branchDeleted: args.deleteBranch === true,
        });
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA, deleteBranch: true },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        column: 'completed',
        prState: 'merged',
        merge: { merged: true, branchDeleted: true },
        prClose: null,
      });
      expect(w.sent('card.merge')[0].deleteBranch).toBe(true);
      await w.work.settled();
      expect(w.sent('card.close')).toEqual([
        expect.objectContaining({ removeWorktree: true }),
      ]);
      const [merged] = await w.audit('card.merged');
      expect(merged.after).toMatchObject({ branchDeleted: true });
    });

    it('a merge without deleteBranch sends no such arg, as an older runner expects', async () => {
      await finished();
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA, deleteBranch: false },
      });
      expect(response.status).toBe(200);
      expect(response.body.merge).toMatchObject({ branchDeleted: false });
      expect(w.sent('card.merge')[0]).not.toHaveProperty('deleteBranch');
    });

    it('a failed deletion never undoes the merge', async () => {
      await finished();
      w.handlers['card.merge'] = () =>
        ok({
          merged: true,
          alreadyMerged: false,
          method: 'merge',
          mergeCommit: null,
          issueClosed: true,
          branchDeleted: false,
          branchError: 'HTTP 422: Reference does not exist',
        });
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA, deleteBranch: true },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        column: 'completed',
        merge: {
          branchDeleted: false,
          branchError: 'HTTP 422: Reference does not exist',
        },
      });
    });

    it('a runner without card.prClose → 503 command_unavailable, nothing sent', async () => {
      await finished();
      w.prCloseAdvertised = false;
      const response = await post(1, 'accept', {
        merge: { headSha: HEAD_SHA, deleteBranch: true },
      });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('command_unavailable');
      expect(w.sent('card.merge')).toEqual([]);
      expect((await w.card(1)).column).toBe('finished');
    });

    it('a terminal card → 422 branch_delete_refused, on merge and on close', async () => {
      await finished();
      await w.ctx.prisma.boardCard.updateMany({
        data: { source: 'terminal' },
      });
      for (const body of [
        { merge: { headSha: HEAD_SHA, deleteBranch: true } },
        { closePr: { deleteBranch: true, closeIssue: false } },
      ]) {
        const response = await post(1, 'accept', body);
        expect(response.status).toBe(422);
        expect(response.body.error).toBe('branch_delete_refused');
      }
      expect(w.sent('card.merge')).toEqual([]);
      expect(w.prCloses()).toEqual([]);
      expect((await w.card(1)).column).toBe('finished');
    });
  });

  describe('#329 D8: accept without merging, closing the PR', () => {
    it('sends card.prClose, moves to Completed, stores closed, audits card.pr_closed', async () => {
      await finished();
      const response = await post(1, 'accept', {
        closePr: { deleteBranch: true, closeIssue: false },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        column: 'completed',
        prState: 'closed',
        merge: null,
        prClose: {
          closed: true,
          alreadyClosed: false,
          branchDeleted: true,
          issueClosed: false,
        },
      });
      const card = await w.card(1);
      expect(w.prCloses()).toEqual([
        {
          cardId: card.id,
          projectId: w.a,
          root: '/srv/dev/widget',
          pr: 77,
          deleteBranch: true,
          issue: null,
          comment: 'Closed from the Nautelle Board (C-1)',
        },
      ]);
      expect(w.sent('card.merge')).toEqual([]);
      const [closed] = await w.audit('card.pr_closed');
      expect(closed.after).toMatchObject({
        pr: 77,
        alreadyClosed: false,
        branchDeleted: true,
        issueClosed: false,
      });
    });

    it('closes the issue as not planned only when ticked', async () => {
      await finished();
      const response = await post(1, 'accept', {
        closePr: { deleteBranch: false, closeIssue: true },
      });
      expect(response.status).toBe(200);
      expect(w.prCloses()[0]).toMatchObject({
        deleteBranch: false,
        issue: 41,
      });
      expect(response.body.prClose).toMatchObject({ issueClosed: true });
    });

    it('a refusal → 409 pr_close_failed with the reason, the card stays in Finished', async () => {
      await finished();
      w.handlers['card.prClose'] = () =>
        ok({
          closed: false,
          error: 'merged',
          message: 'pull request #77 is merged',
        });
      const response = await post(1, 'accept', {
        closePr: { deleteBranch: true, closeIssue: false },
      });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: 'pr_close_failed',
        reason: 'merged',
        message: 'pull request #77 is merged',
      });
      const card = await w.card(1);
      expect(card).toMatchObject({ column: 'finished', prState: 'open' });
      await w.work.settled();
      expect(w.sent('card.close')).toEqual([]);
      const [failure] = await w.audit('card.pr_close_failed');
      expect(failure).toMatchObject({
        result: 'error',
        after: { pr: 77, reason: 'merged' },
      });
    });

    it('leave the PR open: nothing is sent to GitHub', async () => {
      await finished();
      // #709: the open PR #77 has not landed; the person confirms.
      const response = await post(1, 'accept', { confirmUnlanded: true });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        column: 'completed',
        prClose: null,
        prState: 'open',
      });
      expect(w.prCloses()).toEqual([]);
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('a runner without card.prClose → 503 command_unavailable, nothing sent', async () => {
      await finished();
      w.prCloseAdvertised = false;
      const response = await post(1, 'accept', {
        closePr: { deleteBranch: false, closeIssue: false },
      });
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('command_unavailable');
      expect(w.prCloses()).toEqual([]);
      expect((await w.card(1)).column).toBe('finished');
    });

    it('merge with closePr → 400; a closePr missing a field → 400', async () => {
      await finished();
      for (const body of [
        {
          merge: { headSha: HEAD_SHA },
          closePr: { deleteBranch: false, closeIssue: false },
        },
        { closePr: { deleteBranch: true } },
      ]) {
        expect((await post(1, 'accept', body)).status).toBe(400);
      }
      expect(w.prCloses()).toEqual([]);
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('no PR → 409 no_pull_request', async () => {
      await finished();
      await w.ctx.prisma.boardCard.updateMany({
        data: { prNumber: null, prUrl: null },
      });
      const response = await post(1, 'accept', {
        closePr: { deleteBranch: false, closeIssue: false },
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('no_pull_request');
      expect(w.prCloses()).toEqual([]);
    });

    it("is 403 for a viewer, 404 for another project's card", async () => {
      await finished();
      const body = { closePr: { deleteBranch: true, closeIssue: false } };
      expect(
        (await w.viewer.send('post', `${w.path()}/board/cards/1/accept`, body))
          .status,
      ).toBe(403);
      expect(
        (
          await w.admin.send(
            'post',
            `${w.path(w.b)}/board/cards/1/accept`,
            body,
          )
        ).status,
      ).toBe(404);
      expect(w.prCloses()).toEqual([]);
    });
  });
});
