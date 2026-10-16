import type { BoardCardDetail } from '@agentdock/shared';
import { BoardService } from './board.service';
import { BoardShipping } from './board-shipping';
import {
  BoardWorld,
  cardChecks,
  HEAD_SHA,
  ok,
  ROOT_A,
  ROOT_B,
} from './testing/board-e2e';

const PR_URL = 'https://github.com/acme/widget/pull/77';
const RED = {
  checks: [
    { name: 'ci/check', bucket: 'fail', link: 'https://ci.example/9' },
    { name: 'lint', bucket: 'pass', link: null },
  ],
};

/**
 * A card ships itself (#359, ADR-0035), the API's half: the draft PR the
 * runner reports while the round runs (D1), the issue a bug gets (D4), CI
 * watched (D5) and fixed in `ci_fix` rounds (D6), Finished only when done and
 * green, then the auto-merge (D7), and the follow-up PR of a merged card (D8).
 */
describe('a card ships itself (e2e, #359)', () => {
  const w = new BoardWorld();
  let shipping: BoardShipping;

  beforeAll(async () => {
    await w.init();
    shipping = w.ctx.app.get(BoardShipping);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    w.checksServed = true;
  });
  afterEach(() => w.work.settled());

  const post = (number: number, action: string, body: object = {}) =>
    w.operator.send(
      'post',
      `${w.path()}/board/cards/${number}/${action}`,
      body,
    );

  const detail = async (number = 1): Promise<BoardCardDetail> => {
    const response = await w.operator.get(`${w.path()}/board/cards/${number}`);
    expect(response.status).toBe(200);
    return response.body as BoardCardDetail;
  };

  /** C-1 created and run: its id and the latest round's run. */
  const started = async (body: Record<string, unknown> = {}) => {
    await w.createCard(body);
    expect((await w.runCard(1)).status).toBe(200);
    return latest();
  };

  const latest = async (number = 1) => {
    const card = await w.card(number);
    return { card, round: card.rounds[card.rounds.length - 1] };
  };

  /** The round's session ends: the worker is done (#242 D6). */
  const ended = async (number = 1): Promise<void> => {
    const { card, round } = await latest(number);
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

  const pushed = async (extra: Record<string, unknown> = {}, number = 1) => {
    const { card, round } = await latest(number);
    await w.deliver('card_run.pushed', {
      cardId: card.id,
      runId: round.runId,
      projectId: card.projectId,
      at: new Date().toISOString(),
      branch: card.branch,
      headSha: HEAD_SHA,
      ...extra,
    });
  };

  const checksAnswer = (extra: Record<string, unknown>) => {
    w.handlers['card.checks'] = () => ok(cardChecks(extra));
  };

  describe('D1: the draft PR while working', () => {
    it('card.run asks for the draft PR, titled C-n with the card marker', async () => {
      await started();
      const [run] = w.sent('card.run');
      expect(run.pullRequest).toEqual({
        title: 'C-1: Add login',
        body: expect.stringContaining('AgentDock-Card: C-1'),
      });
      expect(run).not.toHaveProperty('newBranch');
    });

    it('a runner that does not serve card.checks gets no pullRequest, and the card goes to Finished as before', async () => {
      w.checksServed = false;
      await started();
      expect(w.sent('card.run')[0]).not.toHaveProperty('pullRequest');
      await ended();
      expect((await w.card(1)).column).toBe('finished');
      expect(w.commands.checks).not.toHaveBeenCalled();
    });

    it('card_run.pushed shows the draft PR on the card in In progress and lists it', async () => {
      await started();
      await pushed({ prNumber: 77, prUrl: PR_URL, prState: 'draft' });
      const card = await detail();
      expect(card).toMatchObject({
        column: 'in_progress',
        prUrl: PR_URL,
        prState: 'draft',
        ciState: 'none',
      });
      expect(card.pullRequests).toEqual([
        expect.objectContaining({
          number: 77,
          url: PR_URL,
          branch: 'card/c1-add-login',
          state: 'draft',
          round: 1,
        }),
      ]);
      expect((await w.card(1)).ciHeadSha).toBe(HEAD_SHA);
    });

    it('a push naming another project, or a branch the card left, changes nothing', async () => {
      await started();
      await pushed({ prNumber: 77, prUrl: PR_URL, projectId: w.b });
      await pushed({ prNumber: 77, prUrl: PR_URL, branch: 'card/other' });
      const card = await w.card(1);
      expect(card.prUrl).toBeNull();
      expect(card.ciHeadSha).toBeNull();
    });
  });

  describe('D4: an issue for a bug, a spec file for every card', () => {
    it('a bug card gets an issue at Run, and its auto-merge closes it', async () => {
      await started({ kind: 'bug', title: 'Crash' });
      expect(w.issues()).toHaveLength(1);
      expect(w.sent('card.run')[0].pullRequest).toMatchObject({
        body: expect.stringContaining('Closes #41'),
      });
      await ended();
      const [merge] = w.sent('card.merge');
      expect(merge.issue).toBe(41);
    });

    it('a feature card gets no issue but its spec file, without specOnRun', async () => {
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: {
          codeSentinelConfig: { orchestrator: { specDir: 'docs/specs' } },
        },
      });
      await started({ specOnRun: false });
      expect(w.issues()).toEqual([]);
      expect(w.sent('card.run')[0].files).toEqual([
        expect.objectContaining({ path: 'docs/specs/card-1-add-login.md' }),
      ]);
    });

    it('the issue follows the kind unless the person sets it', async () => {
      await w.createCard({ kind: 'bug' });
      expect((await w.card(1)).issueOnRun).toBe(true);
      await w.operator.send('patch', `${w.path()}/board/cards/1`, {
        kind: 'feature',
      });
      expect((await w.card(1)).issueOnRun).toBe(false);
      await w.operator.send('patch', `${w.path()}/board/cards/1`, {
        kind: 'bug',
        issueOnRun: false,
      });
      expect((await w.card(1)).issueOnRun).toBe(false);
    });
  });

  describe('D7: Finished = done + green, then auto-merge', () => {
    it('green CI and a finished worker move the card to Finished and merge it (base develop)', async () => {
      await started();
      await ended();
      expect(w.commands.checks).toHaveBeenCalledWith(
        w.runnerId,
        { cardId: expect.any(String), projectId: w.a, root: ROOT_A, pr: 77 },
        expect.anything(),
      );
      const [merge] = w.sent('card.merge');
      expect(merge).toMatchObject({
        pr: 77,
        headSha: HEAD_SHA,
        deleteBranch: true,
        issue: null,
      });
      const card = await detail();
      expect(card).toMatchObject({
        column: 'finished',
        prState: 'merged',
        ciState: 'green',
      });
      expect(card.mergedAt).not.toBeNull();
      expect(card.pullRequests).toEqual([
        expect.objectContaining({ number: 77, state: 'merged' }),
      ]);
      const [record] = await w.audit('card.merged');
      expect(record).toMatchObject({ actorType: 'system', result: 'ok' });
    });

    it('the worker finishing — not only the session ending — runs the same gate', async () => {
      const { card } = await started();
      await w.ctx.app
        .get(BoardService)
        .finishByWorker(
          { id: w.a, runnerId: w.runnerId },
          card.sessionId as string,
          'Done.',
        );
      await w.work.settled();
      expect((await w.card(1)).column).toBe('finished');
      expect(w.sent('card.merge')).toHaveLength(1);
    });

    it('with auto-merge off — a main base — Finished waits for Accept', async () => {
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: { baseBranch: 'main' },
      });
      await started();
      await ended();
      expect((await w.card(1)).column).toBe('finished');
      expect(w.sent('card.merge')).toEqual([]);
      expect((await detail()).mergedAt).toBeNull();
    });

    it("the repository's real default branch decides, not the name", async () => {
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: { baseBranch: 'develop', baseSource: 'origin_head' },
      });
      const settings = await w.admin.get(`${w.path()}/board-settings`);
      expect(settings.body).toMatchObject({
        autoMergeCards: null,
        autoMergeCardsDefault: false,
      });
      await started();
      await ended();
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('pending checks keep the card In progress until the poller reads green', async () => {
      checksAnswer({
        checks: [{ name: 'ci/check', bucket: 'pending', link: null }],
      });
      await started();
      await ended();
      let card = await detail();
      expect(card).toMatchObject({ column: 'in_progress', ciState: 'pending' });
      expect(card.round?.phase).toBe('finished');

      await shipping.poll();
      expect((await w.card(1)).column).toBe('in_progress');

      checksAnswer({});
      await shipping.poll();
      await w.work.settled();
      card = await detail();
      expect(card).toMatchObject({ column: 'finished', ciState: 'green' });
      expect(w.sent('card.merge')).toHaveLength(1);
    });

    it('a PR with no checks is green on its second read of the same head', async () => {
      checksAnswer({ checks: [] });
      await started();
      await ended();
      expect((await w.card(1)).column).toBe('in_progress');
      await shipping.poll();
      await w.work.settled();
      expect((await w.card(1)).column).toBe('finished');
    });

    it('a refused merge is audited and the card waits for Accept', async () => {
      w.handlers['card.merge'] = () =>
        ok({ merged: false, error: 'not_mergeable', message: 'blocked' });
      await started();
      await ended();
      const card = await detail();
      expect(card).toMatchObject({ column: 'finished', mergedAt: null });
      const [record] = await w.audit('card.merge_failed');
      expect(record).toMatchObject({ actorType: 'system', result: 'error' });
    });
  });

  describe('#484: a head CI never reported on', () => {
    /** Another card of project A whose PR CI reported on. */
    const projectHasCi = async () => {
      await w.createCard({ title: 'Earlier work' });
      const other = await w.card(2);
      await w.ctx.prisma.boardCard.update({
        where: { id: other.id },
        data: { ciState: 'green' },
      });
    };

    /** The head has had no checks for longer than `CARD_CI_MISSING_MS`. */
    const minutesPass = async () => {
      const card = await w.card(1);
      await w.ctx.prisma.boardCard.update({
        where: { id: card.id },
        data: { ciNoneSince: new Date(Date.now() - 6 * 60_000) },
      });
    };

    const setup = async () => {
      await w.createCard();
      await projectHasCi();
      expect((await w.runCard(1)).status).toBe(200);
      checksAnswer({ checks: [] });
      await ended();
      await shipping.poll();
      await w.work.settled();
    };

    it('waits, then sends the PR event again once, and ships on the checks it brings', async () => {
      await setup();
      expect((await w.card(1)).column).toBe('in_progress');
      expect(w.ciRetriggers()).toEqual([]);

      await minutesPass();
      await shipping.poll();
      const card = await w.card(1);
      expect(w.ciRetriggers()).toEqual([
        {
          cardId: card.id,
          projectId: w.a,
          root: ROOT_A,
          pr: 77,
          headSha: HEAD_SHA,
        },
      ]);
      expect(card).toMatchObject({
        column: 'in_progress',
        ciRetriggeredSha: HEAD_SHA,
        needsPerson: false,
      });
      const [record] = await w.audit('card.ci_retriggered');
      expect(record).toMatchObject({ actorType: 'system', result: 'ok' });
      expect(record.after).toMatchObject({ pr: 77, headSha: HEAD_SHA });

      // The wait starts again: the next read retriggers nothing.
      await shipping.poll();
      expect(w.ciRetriggers()).toHaveLength(1);

      checksAnswer({});
      await shipping.poll();
      await w.work.settled();
      expect((await w.card(1)).column).toBe('finished');
      expect(w.sent('card.merge')).toHaveLength(1);
    });

    it('a head still without checks after its retrigger needs a person and is never merged', async () => {
      await setup();
      await minutesPass();
      await shipping.poll();
      await minutesPass();
      await shipping.poll();
      await w.work.settled();
      expect(w.ciRetriggers()).toHaveLength(1);
      expect(await w.card(1)).toMatchObject({
        column: 'finished',
        needsPerson: true,
      });
      expect(w.sent('card.merge')).toEqual([]);
      const [record] = await w.audit('card.auto_run_failed');
      expect(record.after).toMatchObject({
        reason: 'ci_not_reported',
        retriggered: true,
      });
    });

    it('a PR the reopen left closed needs a person at once', async () => {
      w.handlers['card.ciRetrigger'] = () =>
        ok({ retriggered: false, error: 'reopen_failed', message: 'HTTP 502' });
      await setup();
      await minutesPass();
      await shipping.poll();
      await w.work.settled();
      expect(await w.card(1)).toMatchObject({
        column: 'finished',
        needsPerson: true,
      });
      const [retriggered] = await w.audit('card.ci_retriggered');
      expect(retriggered).toMatchObject({ result: 'error' });
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('a PR that moved on is not counted as retriggered', async () => {
      w.handlers['card.ciRetrigger'] = () =>
        ok({ retriggered: false, error: 'head_moved', message: 'moved' });
      await setup();
      await minutesPass();
      await shipping.poll();
      expect(await w.card(1)).toMatchObject({
        column: 'in_progress',
        ciRetriggeredSha: null,
        needsPerson: false,
      });
      expect(await w.audit('card.ci_retriggered')).toEqual([]);
    });

    it('a runner without card.ciRetrigger marks the card after the wait', async () => {
      w.ciRetriggerServed = false;
      await setup();
      await minutesPass();
      await shipping.poll();
      await w.work.settled();
      expect(w.ciRetriggers()).toEqual([]);
      expect(await w.card(1)).toMatchObject({
        column: 'finished',
        needsPerson: true,
      });
    });

    it('checks arriving clear the wait', async () => {
      await setup();
      checksAnswer({
        checks: [{ name: 'ci/check', bucket: 'pending', link: null }],
      });
      await shipping.poll();
      expect((await w.card(1)).ciNoneSince).toBeNull();
    });
  });

  describe('D6: red CI is an automatic round', () => {
    it('a red check starts a ci_fix round naming the check and its link: "Fixing CI (1/3)"', async () => {
      checksAnswer(RED);
      await started();
      await ended();
      const card = await w.card(1);
      expect(card).toMatchObject({
        column: 'in_progress',
        ciState: 'red',
        ciFixAttempts: 1,
        needsPerson: false,
      });
      expect(card.rounds).toHaveLength(2);
      expect(card.rounds[1]).toMatchObject({
        trigger: 'ci_fix',
        authorId: null,
      });
      const runs = w.sent('card.run');
      expect(runs).toHaveLength(2);
      expect(runs[1].session).toMatchObject({ resume: true });
      expect(runs[1].prompt).toContain('ci/check — https://ci.example/9');
      expect(runs[1].prompt).not.toContain('lint');
      const view = await detail();
      expect(view.ciChecks).toEqual([
        { name: 'ci/check', link: 'https://ci.example/9' },
      ]);
      const [started_] = (await w.audit('card.run_started')).slice(-1);
      expect(started_).toMatchObject({ actorType: 'system' });
      expect(started_.after).toMatchObject({ trigger: 'ci_fix', ciFix: 'red' });
    });

    it('names the project checks in the fix prompt', async () => {
      await w.ctx.prisma.project.update({
        where: { id: w.a },
        data: {
          codeSentinelConfig: {
            orchestrator: { checks: ['bun run check', 'bun run test'] },
          },
        },
      });
      checksAnswer(RED);
      await started();
      await ended();
      expect(w.sent('card.run')[1].prompt).toContain(
        'bun run check\nbun run test',
      );
    });

    it('after 3 red rounds sets needsPerson, starts no 4th, and hands the card to a person', async () => {
      checksAnswer(RED);
      await started();
      for (let i = 0; i < 4; i += 1) await ended();
      const card = await w.card(1);
      expect(card.rounds.map((r) => r.trigger)).toEqual([
        'run',
        'ci_fix',
        'ci_fix',
        'ci_fix',
      ]);
      expect(card).toMatchObject({
        ciFixAttempts: 3,
        needsPerson: true,
        column: 'finished',
      });
      await shipping.poll();
      expect((await w.card(1)).rounds).toHaveLength(4);
      expect(w.sent('card.merge')).toEqual([]);
      const [record] = await w.audit('card.auto_run_failed');
      expect(record).toMatchObject({ actorType: 'system' });
      expect(record.after).toMatchObject({ reason: 'ci_still_failing' });

      // A person acting resumes automation; the PR's budget stays spent.
      expect(
        (await post(1, 'feedback', { text: 'Fix the lint.' })).status,
      ).toBe(200);
      expect((await w.card(1)).needsPerson).toBe(false);
    });

    it('a PR that conflicts with the base starts a fix round with the merge prompt, counted', async () => {
      checksAnswer({ mergeable: 'CONFLICTING' });
      await started();
      await ended();
      const card = await w.card(1);
      expect(card).toMatchObject({ column: 'in_progress', ciFixAttempts: 1 });
      expect(card.rounds[1].trigger).toBe('ci_fix');
      expect(w.sent('card.run')[1].prompt).toContain(
        'git merge origin/develop',
      );
    });

    it('red during the round waits for the round to be over', async () => {
      checksAnswer({
        checks: [{ name: 'ci/check', bucket: 'pending', link: null }],
      });
      await started();
      await pushed({ prNumber: 77, prUrl: PR_URL, prState: 'draft' });
      await w.ctx.prisma.boardCard.update({
        where: { id: (await w.card(1)).id },
        data: { ciState: 'pending' },
      });
      checksAnswer(RED);
      await shipping.poll();
      const card = await w.card(1);
      expect(card.ciState).toBe('red');
      expect(card.rounds).toHaveLength(1);
    });
  });

  describe('D8: a merged card stays, and a follow-up opens a second PR', () => {
    it('Send back on a merged card resumes the session on <branch>-2 from the base, and lists both PRs', async () => {
      await started();
      await ended();
      expect((await w.card(1)).mergedAt).not.toBeNull();

      w.handlers['card.collect'] = () =>
        ok({
          ahead: 1,
          pushed: true,
          prNumber: 78,
          prUrl: 'https://github.com/acme/widget/pull/78',
        });
      expect(
        (await post(1, 'feedback', { text: 'One more thing.' })).status,
      ).toBe(200);
      const [, second] = w.sent('card.run');
      expect(second).toMatchObject({
        branch: 'card/c1-add-login-2',
        newBranch: true,
        session: expect.objectContaining({ resume: true }),
      });
      let card = await w.card(1);
      expect(card).toMatchObject({
        column: 'in_progress',
        branch: 'card/c1-add-login-2',
        prNumber: null,
        mergedAt: null,
        ciState: 'none',
        ciFixAttempts: 0,
      });

      await pushed({
        prNumber: 78,
        prUrl: 'https://github.com/acme/widget/pull/78',
        prState: 'draft',
        headSha: 'b'.repeat(40),
      });
      const view = await detail();
      expect(view.pullRequests.map((pr) => [pr.number, pr.branch])).toEqual([
        [77, 'card/c1-add-login'],
        [78, 'card/c1-add-login-2'],
      ]);
      card = await w.card(1);
      expect(card.prUrl).toBe('https://github.com/acme/widget/pull/78');
    });

    it('Completed runs the cleanup: card.close removes the worktree', async () => {
      await started();
      await ended();
      expect((await post(1, 'accept')).status).toBe(200);
      await w.work.settled();
      expect(w.sent('card.close')).toEqual([
        expect.objectContaining({ removeWorktree: true }),
      ]);
    });
  });

  describe('D9 and authorization', () => {
    it('the auto-merge switch needs a project admin, and is audited', async () => {
      const path = `${w.path()}/board-settings`;
      const base = { issueOnRun: false, specOnRun: true, maxRunning: 3 };
      expect(
        (await w.operator.send('put', path, { ...base, autoMergeCards: false }))
          .status,
      ).toBe(403);
      const response = await w.admin.send('put', path, {
        ...base,
        autoMergeCards: false,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        autoMergeCards: false,
        autoMergeCardsDefault: true,
      });
      const [record] = await w.audit('board.settings_updated');
      expect(record.after).toMatchObject({ autoMergeCards: false });

      await started();
      await ended();
      expect((await w.card(1)).column).toBe('finished');
      expect(w.sent('card.merge')).toEqual([]);

      expect(
        (await w.admin.send('put', path, { ...base, autoMergeCards: null }))
          .body,
      ).toMatchObject({ autoMergeCards: null });
    });

    it('a card a person dragged back to In progress, without a round, is left to them', async () => {
      checksAnswer({
        checks: [{ name: 'ci/check', bucket: 'pending', link: null }],
      });
      await started();
      await ended();
      expect((await post(1, 'move', { column: 'todo', index: 0 })).status).toBe(
        200,
      );
      expect(
        (await post(1, 'move', { column: 'in_progress', index: 0 })).status,
      ).toBe(200);
      checksAnswer({});
      await shipping.poll();
      await w.work.settled();
      expect((await w.card(1)).column).toBe('in_progress');
      expect(w.sent('card.merge')).toEqual([]);
    });

    it("the poller reads each card through its own project's runner and root", async () => {
      checksAnswer({
        checks: [{ name: 'ci/check', bucket: 'pending', link: null }],
      });
      await started();
      await ended();
      await w.createCard({}, w.operatorOfB, w.b);
      expect(
        (
          await w.operatorOfB.send(
            'post',
            `${w.path(w.b)}/board/cards/1/run`,
            {},
          )
        ).status,
      ).toBe(200);
      const b = await w.card(1, w.b);
      await w.deliver('card_run.phase_changed', {
        cardId: b.id,
        runId: b.rounds[0].runId,
        projectId: w.b,
        at: new Date().toISOString(),
        phase: 'ended',
        exitCode: 0,
      });
      await w.work.settled();
      jest.mocked(w.commands.checks).mockClear();
      await shipping.poll();
      const calls = jest.mocked(w.commands.checks).mock.calls.map(([, a]) => a);
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ projectId: w.a, root: ROOT_A }),
          expect.objectContaining({ projectId: w.b, root: ROOT_B }),
        ]),
      );
      expect(calls).toHaveLength(2);
    });
  });
});
