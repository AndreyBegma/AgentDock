import type { BoardCardDetail } from '@agentdock/shared';
import type { LocalCall } from '../local/local-call';
import { LocalError } from '../local/local-error';
import { LocalHandlers } from '../local/local-handlers';
import { BoardBackgroundStall } from './board-background-stall';
import { BoardWorld, ROOT_A } from './testing/board-e2e';

describe('board sink (e2e)', () => {
  const w = new BoardWorld();
  let handlers: LocalHandlers;

  beforeAll(async () => {
    await w.init();
    handlers = w.ctx.app.get(LocalHandlers);
  });
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** Card 1, run once: its id, session, round and run. */
  const running = async (body: Record<string, unknown> = {}) => {
    await w.createCard(body);
    expect((await w.runCard(1)).status).toBe(200);
    const card = await w.card(1);
    return {
      card,
      sessionId: card.sessionId as string,
      round: card.rounds[0],
    };
  };

  const phase = (
    card: { id: string },
    runId: string,
    data: Record<string, unknown>,
  ) =>
    w.deliver('card_run.phase_changed', {
      cardId: card.id,
      runId,
      projectId: w.a,
      at: new Date().toISOString(),
      ...data,
    });

  /** `card.finish` as the local router hands it over (spec 201 D8). */
  const finishCard = (
    sessionId: string,
    summary: string,
    projectId = w.a,
    runnerId = w.runnerId,
  ) =>
    handlers.table['card.finish']({ summary }, {
      runnerId,
      requestId: 'lr_1',
      user: { id: w.operatorId, email: 'op@x.test', role: 'operator' },
      role: 'operator',
      project: {
        id: projectId,
        runnerId,
        rootPath: ROOT_A,
        repo: 'acme/widget',
        displayName: 'widget',
        baseBranch: 'develop',
        baseOverride: null,
      },
      session: { runtime: 'claude', id: sessionId },
      via: 'mcp',
      ctx: { actor: { type: 'runner', runnerId } },
      meta: { onBehalfOf: w.operatorId, via: 'mcp' },
    } satisfies LocalCall);

  const serverEvents = (type: string) =>
    w.ctx.prisma.event.findMany({ where: { type }, orderBy: { id: 'asc' } });

  describe('card_run.phase_changed', () => {
    it('moves a round forward and never back', async () => {
      const { card, round } = await running();
      await phase(card, round.runId, {
        phase: 'running',
        worktree: '/srv/dev/.wt-widget-card-x',
      });
      expect((await w.card(1)).rounds[0].phase).toBe('running');
      expect((await w.card(1)).worktree).toBe('/srv/dev/.wt-widget-card-x');
      await phase(card, round.runId, { phase: 'starting' });
      expect((await w.card(1)).rounds[0].phase).toBe('running');
    });

    it('a session that ends finishes the round by session_end, moves the card to Finished and collects', async () => {
      const { card, round } = await running();
      await phase(card, round.runId, { phase: 'ended', exitCode: 0 });
      await w.work.settled();
      const after = await w.card(1);
      expect(after.column).toBe('finished');
      expect(after.rounds[0]).toMatchObject({
        phase: 'finished',
        finishedBy: 'session_end',
        exitCode: 0,
      });
      expect(after.rounds[0].endedAt).not.toBeNull();
      expect(w.sent('card.collect')).toHaveLength(1);
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: round.runId },
      });
      expect(run.status).toBe('succeeded');
      expect(run.endedAt).not.toBeNull();

      // A replay changes nothing.
      await phase(card, round.runId, { phase: 'ended', exitCode: 0 });
      await w.work.settled();
      expect(w.sent('card.collect')).toHaveLength(1);
      expect(await serverEvents('card.finished')).toHaveLength(1);
    });

    it('a round that could not start fails, and the card stays', async () => {
      const { card, round } = await running();
      await phase(card, round.runId, {
        phase: 'failed',
        error: 'worktree exists',
      });
      const after = await w.card(1);
      expect(after.column).toBe('in_progress');
      expect(after.rounds[0]).toMatchObject({
        phase: 'failed',
        error: 'worktree exists',
      });
    });

    it('ignores a round of another runner or project', async () => {
      const { card, round } = await running();
      await w.deliver('card_run.phase_changed', {
        cardId: card.id,
        runId: round.runId,
        projectId: w.b,
        phase: 'ended',
        at: new Date().toISOString(),
      });
      expect((await w.card(1)).rounds[0].phase).toBe('starting');
    });
  });

  describe('hooks of the card session (D6, D14)', () => {
    it('hook.stopped → waiting and card.waiting; hook.prompt_submitted → running', async () => {
      const { round, sessionId } = await running({ title: 'Add login' });
      await w.hook('hook.stopped', sessionId);
      let after = await w.card(1);
      expect(after.rounds[0].phase).toBe('waiting');
      expect(after.rounds[0].waitingAt).not.toBeNull();
      expect(
        (
          await w.ctx.prisma.run.findUniqueOrThrow({
            where: { id: round.runId },
          })
        ).status,
      ).toBe('waiting_person');

      const [waiting] = await serverEvents('card.waiting');
      expect(waiting).toMatchObject({ source: 'api' });
      expect(waiting.data).toEqual({
        cardId: after.id,
        number: 1,
        title: 'Add login',
        round: 1,
      });

      // Again while waiting: no second notification.
      await w.hook('hook.stopped', sessionId);
      expect(await serverEvents('card.waiting')).toHaveLength(1);

      await w.hook('hook.prompt_submitted', sessionId, { chars: 12 });
      after = await w.card(1);
      expect(after.rounds[0].phase).toBe('running');
    });

    describe('a turn that stops with its own background tasks running (#390)', () => {
      const runStatus = async (runId: string) =>
        (await w.ctx.prisma.run.findUniqueOrThrow({ where: { id: runId } }))
          .status;
      const stall = () => w.ctx.app.get(BoardBackgroundStall);
      const minutesAfter = (at: Date | null, minutes: number) =>
        new Date((at as Date).getTime() + minutes * 60_000);

      it('is background, not waiting, and raises no card.waiting', async () => {
        const { round, sessionId } = await running();
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 2 });
        const after = (await w.card(1)).rounds[0];
        expect(after.phase).toBe('background');
        expect(after.backgroundAt).not.toBeNull();
        expect(after.backgroundTasks).toBe(2);
        expect(after.waitingAt).toBeNull();
        expect(await runStatus(round.runId)).toBe('running');
        expect(await serverEvents('card.waiting')).toEqual([]);
      });

      it('keeps the command only for a project that ships content', async () => {
        const { sessionId } = await running();
        const background = {
          text: 'bunx jest --selectProjects e2e',
          truncated: false,
        };
        await w.hook('hook.stopped', sessionId, {
          backgroundTasks: 1,
          background,
        });
        expect((await w.card(1)).rounds[0].backgroundCommand).toBeNull();

        await w.ctx.prisma.project.update({
          where: { id: w.a },
          data: { shipSessionContent: true },
        });
        await w.hook('hook.stopped', sessionId, {
          backgroundTasks: 1,
          background,
        });
        expect((await w.card(1)).rounds[0].backgroundCommand).toBe(
          'bunx jest --selectProjects e2e',
        );
      });

      it('a stop with no background work still waits for the person', async () => {
        const { sessionId } = await running();
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 0 });
        expect((await w.card(1)).rounds[0].phase).toBe('waiting');
        expect(await serverEvents('card.waiting')).toHaveLength(1);
      });

      it('tool activity after a stop is running again, without a prompt', async () => {
        const { round, sessionId } = await running();
        const tool = { toolUseId: 'tu_1', toolName: 'Bash', ok: true };
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 1 });
        await w.hook('hook.tool_finished', sessionId, tool);
        let after = (await w.card(1)).rounds[0];
        expect(after.phase).toBe('running');
        expect(after.backgroundAt).toBeNull();
        expect(after.backgroundTasks).toBeNull();

        // From Waiting for you too: a task notification woke the worker.
        await w.hook('hook.stopped', sessionId);
        expect(await runStatus(round.runId)).toBe('waiting_person');
        await w.hook('hook.tool_finished', sessionId, tool);
        after = (await w.card(1)).rounds[0];
        expect(after.phase).toBe('running');
        expect(await runStatus(round.runId)).toBe('running');
      });

      it('the background work done, the next stop waits for the person', async () => {
        const { sessionId } = await running();
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 1 });
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 0 });
        const after = (await w.card(1)).rounds[0];
        expect(after.phase).toBe('waiting');
        expect(after.backgroundAt).toBeNull();
        expect(await serverEvents('card.waiting')).toHaveLength(1);
      });

      it('a stall past the threshold warns once, and again after a resume', async () => {
        const { card, sessionId } = await running({ title: 'Add login' });
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 1 });
        const first = (await w.card(1)).rounds[0];

        expect(await stall().tick(minutesAfter(first.backgroundAt, 29))).toBe(
          0,
        );
        expect(await stall().tick(minutesAfter(first.backgroundAt, 30))).toBe(
          1,
        );
        expect(await stall().tick(minutesAfter(first.backgroundAt, 31))).toBe(
          0,
        );
        // Another stop while still in the background is the same stall.
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 2 });
        expect(await stall().tick(minutesAfter(first.backgroundAt, 90))).toBe(
          0,
        );

        const [stalled] = await serverEvents('card.background_stalled');
        expect(stalled).toMatchObject({ source: 'api' });
        expect(stalled.data).toEqual({
          cardId: card.id,
          number: 1,
          title: 'Add login',
          round: 1,
          minutes: 30,
        });

        await w.hook('hook.tool_finished', sessionId, {
          toolUseId: 'tu_2',
          toolName: 'Bash',
          ok: true,
        });
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 1 });
        const second = (await w.card(1)).rounds[0];
        expect(second.backgroundStalledAt).toBeNull();
        expect(await stall().tick(minutesAfter(second.backgroundAt, 30))).toBe(
          1,
        );
        expect(await serverEvents('card.background_stalled')).toHaveLength(2);
      });

      it('follows the board setting', async () => {
        const { sessionId } = await running();
        await w.ctx.prisma.boardSettings.create({
          data: { projectId: w.a, backgroundStallMinutes: 10 },
        });
        await w.hook('hook.stopped', sessionId, { backgroundTasks: 1 });
        const { backgroundAt } = (await w.card(1)).rounds[0];
        expect(await stall().tick(minutesAfter(backgroundAt, 9))).toBe(0);
        expect(await stall().tick(minutesAfter(backgroundAt, 10))).toBe(1);
        const [stalled] = await serverEvents('card.background_stalled');
        expect(stalled.data).toMatchObject({ minutes: 10 });
      });
    });

    it('claims the card session as origin run, and keeps it', async () => {
      const { sessionId } = await running();
      await w.hook('hook.prompt_submitted', sessionId, { chars: 3 });
      const session = await w.ctx.prisma.agentSession.findFirst({
        where: { externalId: sessionId },
      });
      expect(session?.origin).toBe('run');
      await w.hook('hook.stopped', sessionId);
      const again = await w.ctx.prisma.agentSession.findFirst({
        where: { externalId: sessionId },
      });
      expect(again?.origin).toBe('run');
    });

    it('ignores a hook of a session that is not a card', async () => {
      await running();
      await w.hook('hook.stopped', '11111111-2222-4333-8444-555555555555');
      expect((await w.card(1)).rounds[0].phase).toBe('starting');
      expect(await serverEvents('card.waiting')).toEqual([]);
    });

    it('says hooks are missing when none arrived within the grace', async () => {
      const { round, sessionId } = await running();
      await w.ctx.prisma.boardCardRound.update({
        where: { id: round.id },
        data: { startedAt: new Date(Date.now() - 3 * 60 * 1000) },
      });
      const detail = async () =>
        (await w.operator.get(`${w.path()}/board/cards/1`))
          .body as BoardCardDetail;
      expect((await detail()).round?.hooksMissing).toBe(true);
      await w.hook('hook.prompt_submitted', sessionId, { chars: 3 });
      expect((await detail()).round?.hooksMissing).toBe(false);
    });

    it('says why hooks are missing from what the runner reports (#348 D1)', async () => {
      const { round } = await running();
      await w.ctx.prisma.boardCardRound.update({
        where: { id: round.id },
        data: { startedAt: new Date(Date.now() - 3 * 60 * 1000) },
      });
      const report = async (agentdock?: { plugin: string | null }) =>
        w.ctx.prisma.runner.update({
          where: { id: w.runnerId },
          data: {
            capabilities: {
              profiles: [
                {
                  id: 'claude-main',
                  runtime: 'claude',
                  env: {},
                  args: [],
                  ...(agentdock && {
                    agentdock: { ...agentdock, telemetry: false },
                  }),
                },
              ],
            },
          },
        });
      const detail = async () =>
        (
          (await w.operator.get(`${w.path()}/board/cards/1`))
            .body as BoardCardDetail
        ).rounds[0];

      await report({ plugin: null });
      expect(await detail()).toMatchObject({
        hooksMissing: true,
        hooksCause: 'no_plugin',
        hooksProfile: 'claude-main',
      });
      await report({ plugin: '0.4.2' });
      expect((await detail()).hooksCause).toBe('session_predates');
      await report();
      expect((await detail()).hooksCause).toBe('unknown');
    });
  });

  describe('card.finish over the local channel', () => {
    it('finishes the round by the worker, moves to Finished, collects once and stores the PR', async () => {
      const { sessionId } = await running({ title: 'Add login' });
      await expect(
        finishCard(sessionId, 'Added the login form; tests pass.'),
      ).resolves.toEqual({ number: 1, finished: true });
      await w.work.settled();

      const after = await w.card(1);
      expect(after.column).toBe('finished');
      expect(after.rounds[0]).toMatchObject({
        phase: 'finished',
        finishedBy: 'worker',
        summary: 'Added the login form; tests pass.',
      });
      const [collect] = w.sent('card.collect');
      expect(collect).toMatchObject({
        cardId: after.id,
        branch: 'card/c1-add-login',
        base: 'develop',
        number: 1,
        title: 'C-1: Add login',
      });
      expect(collect.body).toBe(
        'Added the login form; tests pass.\n\nAgentDock-Card: C-1',
      );
      expect(after).toMatchObject({
        prNumber: 77,
        prUrl: 'https://github.com/acme/widget/pull/77',
      });

      const [finished] = await serverEvents('card.finished');
      expect(finished.data).toEqual({
        cardId: after.id,
        number: 1,
        title: 'Add login',
        round: 1,
        finishedBy: 'worker',
        prNumber: 77,
        prUrl: 'https://github.com/acme/widget/pull/77',
      });

      // The session then ends: the round is already finished, nothing moves.
      await phase(after, after.rounds[0].runId, { phase: 'ended' });
      await w.work.settled();
      expect(w.sent('card.collect')).toHaveLength(1);
      expect((await w.card(1)).rounds[0].finishedBy).toBe('worker');
    });

    it('carries Closes #n when the card has an issue', async () => {
      const { sessionId } = await running({ issueOnRun: true });
      await finishCard(sessionId, 'Done.');
      await w.work.settled();
      expect(w.sent('card.collect')[0].body).toBe(
        'Done.\n\nCloses #41\n\nAgentDock-Card: C-1',
      );
    });

    it('is not_a_card_session for another session or another project', async () => {
      const { sessionId } = await running();
      await expect(finishCard('sess-manual-1', 'x')).rejects.toBeInstanceOf(
        LocalError,
      );
      await expect(finishCard(sessionId, 'x', w.b)).rejects.toMatchObject({
        code: 'not_a_card_session',
      });
      expect((await w.card(1)).column).toBe('in_progress');
    });
  });
});
