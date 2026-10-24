import type {
  BoardCardDetail,
  BoardCardView,
  BoardSettingsView,
  BoardView,
  PendingQuestion,
} from '@nautelle/shared';
import type {
  LocalBoardWaitEvent,
  LocalResponseMessage,
  SessionMessageArgs,
} from '@nautelle/shared/protocol';
import { LocalRequestRouter } from '../local/local-request-router';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { capabilities } from '../runners/testing/runner-e2e';
import { SessionMessageService } from '../session-message/session-message.service';
import { BOARD_WAIT_TICK_MS } from './board-wait.service';
import { BoardWorld, ROOT_A } from './testing/board-e2e';

/** A person's own Claude Code sessions (ids are uuids, as Claude's are). */
const MANUAL = '6f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f601';
const OTHER_MANUAL = '6f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f602';
/** A Board Run worker's session: `origin: run`. */
const CARD_SESSION = '0b7e7c1e-5d0f-4c1a-9a51-2f3c4d5e6f70';

const PR_URL = 'https://github.com/acme/widget/pull/77';

const QUESTION: PendingQuestion = {
  key: '0123456789abcdef',
  header: 'glass-ui',
  text: 'SelectionBar is missing in glass-ui — what now?',
  options: [
    { index: 1, label: 'Add it to glass-ui' },
    { index: 2, label: 'Use a Toolbar' },
  ],
  other: true,
};

const CONTROL = [
  ['card.create', { title: 'Retry the handshake' }],
  ['card.run', { card: 1 }],
  ['card.move', { card: 1, column: 'in_progress' }],
  ['card.feedback', { card: 1, text: 'Handle macOS too.' }],
  ['card.message', { card: 1, kind: 'text', text: 'Use the helper.' }],
  ['card.stop', { card: 1 }],
  ['card.take', { card: 1 }],
  ['card.release', { card: 1 }],
] as const;

/**
 * #845 (ADR-0083): a person's own session works the Board through the local
 * methods — through the real router, so its authorization, the refusals'
 * names and the result schemas are the ones a runner gets.
 */
describe('the Board from a session (#845, e2e)', () => {
  const w = new BoardWorld();
  let router: LocalRequestRouter;
  let commands: RunnerCommandService;
  let nextId = 0;

  beforeAll(async () => {
    await w.init();
    router = w.ctx.app.get(LocalRequestRouter);
    commands = w.ctx.app.get(RunnerCommandService);
    const original = commands.send.bind(commands);
    jest
      .spyOn(commands, 'send')
      .mockImplementation(async (runnerId, name, args, options) =>
        name === 'session.message'
          ? ({
              status: 'ok',
              output: { outcome: 'answered' },
              rttMs: 1,
            } satisfies CommandSendResult<'session.message'> as never)
          : original(runnerId, name, args, options),
      );
    jest
      .spyOn(w.ctx.app.get(SessionMessageService), 'available')
      .mockImplementation(async () => true);
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    await asLocalUser(w.operatorId);
  });
  afterEach(() => w.work.settled());

  const asLocalUser = (userId: string) =>
    w.ctx.prisma.runner.update({
      where: { id: w.runnerId },
      data: { localUserId: userId },
    });

  /** A local request as the runner relays it, answered by the router. */
  const ask = (
    method: string,
    args: unknown,
    sessionId = MANUAL,
    projectId = w.a,
  ): Promise<LocalResponseMessage> => {
    nextId += 1;
    return router.answer(w.runnerId, {
      type: 'local.request',
      id: `lr_${nextId}`,
      method,
      args,
      projectId,
      session: { runtime: 'claude', id: sessionId },
      via: 'mcp',
    });
  };

  const data = async <T>(response: Promise<LocalResponseMessage>) => {
    const answer = await response;
    expect([answer.ok, answer.error]).toEqual([true, undefined]);
    return answer.data as T;
  };

  const refusal = async (response: Promise<LocalResponseMessage>) => {
    const answer = await response;
    expect(answer.ok).toBe(false);
    return answer.error?.code;
  };

  /** The session's hooks reached Nautelle: a `manual` session in `root`. */
  const manualSession = async (externalId = MANUAL, root = ROOT_A) => {
    await w.deliver(
      'hook.session_started',
      {
        source: 'startup',
        cwd: root,
        gitBranch: 'feat/42-pairing',
        permissionMode: 'default',
      },
      {
        source: 'hook',
        session: { runtime: 'claude', id: externalId },
        project: { repo: 'acme/widget', root },
      },
    );
    const row = await w.ctx.prisma.agentSession.findFirstOrThrow({
      where: { externalId },
      select: { id: true, origin: true },
    });
    expect(row.origin).toBe('manual');
    return row.id;
  };

  /** The local user works project B too: its sessions there are answered. */
  const memberOfB = () =>
    w.ctx.prisma.projectMember.create({
      data: { projectId: w.b, userId: w.operatorId },
    });

  const cardSession = () =>
    w.ctx.prisma.agentSession.create({
      data: {
        runnerId: w.runnerId,
        runtime: 'claude',
        externalId: CARD_SESSION,
        projectId: w.a,
        cwd: `${ROOT_A}/.worktrees/c1`,
        origin: 'run',
        startedAt: new Date(),
        lastEventAt: new Date(),
      },
    });

  const boardCard = async (number: number): Promise<BoardCardView> => {
    const board = await w.operator.get(`${w.path()}/board`);
    expect(board.status).toBe(200);
    const card = (board.body as BoardView).columns
      .flatMap((c) => c.cards)
      .find((c) => c.number === number);
    if (!card) throw new Error(`C-${number} is not on the board`);
    return card;
  };

  const moveCard = (number: number, column: string, index = 0) =>
    w.operator.send('post', `${w.path()}/board/cards/${number}/move`, {
      column,
      index,
    });

  /** C-<number> in Finished with an open PR, as a worker would leave it. */
  const finishedWithPr = async (number: number) => {
    await w.ctx.prisma.boardCard.update({
      where: { projectId_number: { projectId: w.a, number } },
      data: {
        column: 'finished',
        prNumber: 77,
        prUrl: PR_URL,
        prState: 'open',
      },
    });
  };

  describe('reads', () => {
    it("lists this project's cards and its merge policy, and never another project's", async () => {
      await w.createCard({ title: 'Add login' });
      await w.createCard({ title: 'Add logout' });
      await w.createCard({ title: 'Gadget work' }, w.admin, w.b);
      await memberOfB();
      const list = await data<{
        settings: { cardMergePolicy: string; maxRunning: number };
        cards: { label: string; column: string; title: string }[];
      }>(ask('board.list', {}));
      expect(list.settings).toMatchObject({ cardMergePolicy: 'ask' });
      expect(list.cards.map((c) => [c.label, c.column, c.title])).toEqual([
        ['C-2', 'todo', 'Add logout'],
        ['C-1', 'todo', 'Add login'],
      ]);

      const other = await data<{ cards: { title: string }[] }>(
        ask('board.list', {}, OTHER_MANUAL, w.b),
      );
      expect(other.cards.map((c) => c.title)).toEqual(['Gadget work']);

      const card = await data<{ number: number; body: string }>(
        ask('board.card', { card: 1 }),
      );
      expect(card).toMatchObject({ number: 1, body: 'Users sign in.' });
      // B's C-1 is not A's: the project is the session's, never an argument.
      const gadget = await data<{ title: string }>(
        ask('board.card', { card: 1 }, OTHER_MANUAL, w.b),
      );
      expect(gadget.title).toBe('Gadget work');
    });

    it('answers a viewer the reads and refuses it every control tool', async () => {
      await w.createCard();
      const viewer = await w.ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'viewer@x.test' },
      });
      await asLocalUser(viewer.id);
      await manualSession();
      await data(ask('board.list', {}));
      await data(ask('board.card', { card: 1 }));
      for (const [method, args] of CONTROL) {
        expect([method, await refusal(ask(method, args))]).toEqual([
          method,
          'forbidden',
        ]);
      }
      expect((await w.card(1)).column).toBe('todo');
    });
  });

  describe('control', () => {
    it('refuses a card session, and a session it does not know, not_a_manual_session', async () => {
      await w.createCard();
      await cardSession();
      for (const [method, args] of [
        ['card.run', { card: 1 }],
        ['card.move', { card: 1, column: 'in_progress' }],
        ['card.take', { card: 1 }],
      ] as const) {
        expect([
          method,
          await refusal(ask(method, args, CARD_SESSION)),
        ]).toEqual([method, 'not_a_manual_session']);
      }
      expect(
        await refusal(ask('card.create', { title: 'X' }, OTHER_MANUAL)),
      ).toBe('not_a_manual_session');
      expect(w.sent('card.run')).toHaveLength(0);
      expect((await w.card(1)).column).toBe('todo');
    });

    it('refuses card.move to completed completed_needs_person, and the card stays', async () => {
      await manualSession();
      await w.createCard();
      await finishedWithPr(1);
      expect(
        await refusal(ask('card.move', { card: 1, column: 'completed' })),
      ).toBe('completed_needs_person');
      expect((await w.card(1)).column).toBe('finished');
    });

    it('passes the Board refusals through by name', async () => {
      await manualSession();
      await w.createCard({ title: 'Schema' });
      await w.createCard({ title: 'API' });
      const added = await w.operator.send(
        'post',
        `${w.path()}/board/cards/2/dependencies`,
        { dependsOn: 1 },
      );
      expect(added.status).toBe(200);
      const answer = await ask('card.run', { card: 2 });
      expect(answer.error?.code).toBe('dependency_open');
      expect(w.sent('card.run')).toHaveLength(0);
      // An Inbox move other than Inbox → To Do is the Board's own refusal.
      expect(
        await refusal(ask('card.move', { card: 1, column: 'inbox' })),
      ).toBe('invalid_move');
    });

    it('creates a requested card in To Do and a candidate in the Inbox', async () => {
      const sessionId = await manualSession();
      const todo = await data<{ label: string; column: string }>(
        ask('card.create', { title: 'Add search', kind: 'feature' }),
      );
      expect(todo).toMatchObject({ label: 'C-1', column: 'todo' });
      const candidate = await data<{ label: string; column: string }>(
        ask('card.create', {
          title: 'Retry flaky uploads',
          body: 'Seen while working C-1.',
          candidate: true,
        }),
      );
      expect(candidate).toMatchObject({ label: 'C-2', column: 'inbox' });
      expect(await w.card(1)).toMatchObject({ column: 'todo' });
      expect(await w.card(2)).toMatchObject({
        column: 'inbox',
        sourceSessionId: sessionId,
        createdById: w.operatorId,
      });
    });

    it('runs, moves, stops and sends feedback through the Board', async () => {
      await manualSession();
      await w.createCard();
      const run = await data<{ number: number; round: number }>(
        ask('card.run', { card: 1 }),
      );
      expect(run).toEqual({ number: 1, round: 1 });
      expect(w.sent('card.run')).toHaveLength(1);
      expect(await data(ask('card.stop', { card: 1 }))).toEqual({
        number: 1,
        stopped: true,
      });
      expect(
        await data(ask('card.move', { card: 1, column: 'finished' })),
      ).toEqual({ number: 1, column: 'finished' });
      const feedback = await data<{ round: number }>(
        ask('card.feedback', { card: 1, text: 'Handle macOS too.' }),
      );
      expect(feedback.round).toBe(2);
      expect((await w.card(1)).rounds[1]).toMatchObject({
        trigger: 'feedback',
        feedback: 'Handle macOS too.',
      });
    });

    it('answers a card session’s question with card.message', async () => {
      await manualSession();
      await w.createCard();
      await data(ask('card.run', { card: 1 }));
      const card = await w.card(1);
      await w.ctx.prisma.boardCardRound.update({
        where: { id: card.rounds[0].id },
        data: { phase: 'waiting', pendingQuestion: QUESTION },
      });
      const detail = await data<{ question: PendingQuestion | null }>(
        ask('board.card', { card: 1 }),
      );
      expect(detail.question).toEqual(QUESTION);
      const answer = await data<{ outcome: string }>(
        ask('card.message', {
          card: 1,
          kind: 'option',
          questionKey: QUESTION.key,
          index: 2,
        }),
      );
      expect(answer).toEqual({ outcome: 'answered' });
    });
  });

  describe('take and release (D1, D2, D10)', () => {
    it('takes a card, queues the next, and finish_card with the PR takes the queued one', async () => {
      const sessionId = await manualSession();
      await w.createCard({ title: 'Add login' });
      await w.createCard({ title: 'Add logout' });
      const first = await data(ask('card.take', { card: 1 }));
      expect(first).toEqual({
        number: 1,
        label: 'C-1',
        title: 'Add login',
        body: 'Users sign in.',
        kind: 'feature',
        branch: null,
        state: 'taken',
        queuePosition: null,
      });
      expect(await w.card(1)).toMatchObject({
        column: 'in_progress',
        trackedSessionId: sessionId,
        takenBranch: 'feat/42-pairing',
      });
      expect((await boardCard(1)).taken).toEqual({
        sessionId,
        alive: true,
        branch: 'feat/42-pairing',
      });

      const second = await data(ask('card.take', { card: 2 }));
      expect(second).toMatchObject({
        number: 2,
        state: 'queued',
        queuePosition: 1,
      });
      expect(await w.card(2)).toMatchObject({
        column: 'todo',
        queuedForSessionId: sessionId,
        trackedSessionId: null,
      });
      // A live session holds C-1: no Run while it works the card.
      expect(await refusal(ask('card.run', { card: 1 }))).toBe('card_running');

      const finished = await data(
        ask('card.finish', { summary: 'Done.', pullRequestUrl: PR_URL }),
      );
      expect(finished).toMatchObject({
        number: 1,
        finished: true,
        next: { number: 2, label: 'C-2', title: 'Add logout' },
      });
      expect(await w.card(1)).toMatchObject({
        column: 'finished',
        prUrl: PR_URL,
        prNumber: 77,
        prState: 'open',
        trackedSessionId: null,
      });
      expect(await w.card(2)).toMatchObject({
        column: 'in_progress',
        trackedSessionId: sessionId,
        queuedForSessionId: null,
      });
      // The session pushed and opened the PR itself: nothing was collected.
      expect(w.sent('card.collect')).toHaveLength(0);
    });

    it('refuses a pull request of another repository, and a card another live session holds', async () => {
      await manualSession();
      await manualSession(OTHER_MANUAL);
      await w.createCard();
      await data(ask('card.take', { card: 1 }));
      expect(await refusal(ask('card.take', { card: 1 }, OTHER_MANUAL))).toBe(
        'card_taken',
      );
      expect(
        await refusal(
          ask('card.finish', {
            summary: 'Done.',
            pullRequestUrl: 'https://github.com/evil/repo/pull/1',
          }),
        ),
      ).toBe('invalid_args');
      expect((await w.card(1)).column).toBe('in_progress');
    });

    it('leaves a card In progress, session ended, when its session ends; another session takes it; release returns it to To Do', async () => {
      await manualSession();
      const other = await manualSession(OTHER_MANUAL);
      await w.createCard();
      await data(ask('card.take', { card: 1 }));
      await w.hook('hook.session_ended', MANUAL, {
        reason: 'prompt_input_exit',
      });
      await w.work.settled();
      const card = await boardCard(1);
      expect(card.column).toBe('in_progress');
      expect(card.taken).toMatchObject({
        alive: false,
        branch: 'feat/42-pairing',
      });

      const taken = await data(ask('card.take', { card: 1 }, OTHER_MANUAL));
      expect(taken).toMatchObject({
        state: 'taken',
        // D10: the branch the first session left.
        branch: 'feat/42-pairing',
      });
      expect((await w.card(1)).trackedSessionId).toBe(other);

      const released = await data(
        ask('card.release', { card: 1 }, OTHER_MANUAL),
      );
      expect(released).toEqual({ number: 1, column: 'todo', next: null });
      expect(await w.card(1)).toMatchObject({
        column: 'todo',
        trackedSessionId: null,
        queuedForSessionId: null,
      });
      expect(
        await refusal(ask('card.release', { card: 1 }, OTHER_MANUAL)),
      ).toBe('not_taken');
    });

    it('refuses to take a card with an active Board Run round', async () => {
      await manualSession();
      await w.createCard();
      expect((await w.runCard(1)).status).toBe(200);
      expect(await refusal(ask('card.take', { card: 1 }))).toBe('card_taken');
    });

    it('track_card from a session holding a taken card names it and edits nothing', async () => {
      await manualSession();
      await w.createCard({ title: 'Add login' });
      await data(ask('card.take', { card: 1 }));
      const tracked = await data(
        ask('card.track', { title: 'Something else', body: 'Overwritten?' }),
      );
      expect(tracked).toMatchObject({ number: 1, label: 'C-1' });
      expect(await w.card(1)).toMatchObject({
        title: 'Add login',
        body: 'Users sign in.',
        source: 'manual',
      });
    });
  });

  describe('board.wait (D8)', () => {
    type Wait = { events: LocalBoardWaitEvent[]; cursor: string };

    it('starts with a cursor, wakes on a column change, and the same cursor answers the same', async () => {
      await w.createCard();
      const start = await data<Wait>(ask('board.wait', {}));
      expect(start.events).toEqual([]);

      const startedAt = Date.now();
      const held = data<Wait>(
        ask('board.wait', { cursor: start.cursor, timeoutSec: 10 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await moveCard(1, 'in_progress')).status).toBe(200);
      const woken = await held;
      expect(Date.now() - startedAt).toBeLessThan(BOARD_WAIT_TICK_MS + 3_000);
      const change = {
        type: 'column',
        card: 1,
        label: 'C-1',
        title: 'Add login',
        from: 'todo',
        to: 'in_progress',
      };
      expect(woken.events).toEqual([change]);
      expect(woken.cursor).not.toBe(start.cursor);

      const again = await data<Wait>(
        ask('board.wait', { cursor: start.cursor, timeoutSec: 0 }),
      );
      expect(again.events).toEqual([change]);
      const next = await data<Wait>(
        ask('board.wait', { cursor: woken.cursor, timeoutSec: 0 }),
      );
      expect(next.events).toEqual([]);
    });

    it('answers empty at its timeout when nothing changes, and ignores another project’s cursor', async () => {
      await w.createCard();
      const start = await data<Wait>(ask('board.wait', {}));
      const startedAt = Date.now();
      const quiet = await data<Wait>(
        ask('board.wait', { cursor: start.cursor, timeoutSec: 1 }),
      );
      expect(quiet.events).toEqual([]);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);

      await memberOfB();
      const foreign = await data<Wait>(
        ask(
          'board.wait',
          { cursor: start.cursor, timeoutSec: 10 },
          OTHER_MANUAL,
          w.b,
        ),
      );
      expect(foreign.events).toEqual([]);
      expect(foreign.cursor).not.toContain(w.a);
    });

    it('reports a card session waiting on a question, with its text and options', async () => {
      await manualSession();
      await w.createCard();
      await data(ask('card.run', { card: 1 }));
      const start = await data<Wait>(ask('board.wait', {}));
      const card = await w.card(1);
      await w.ctx.prisma.boardCardRound.update({
        where: { id: card.rounds[0].id },
        data: { phase: 'waiting', pendingQuestion: QUESTION },
      });
      const woken = await data<Wait>(
        ask('board.wait', { cursor: start.cursor, cards: [1], timeoutSec: 10 }),
      );
      expect(woken.events).toEqual([
        {
          type: 'question',
          card: 1,
          label: 'C-1',
          title: 'Add login',
          question: QUESTION,
        },
      ]);
    });
  });

  describe('#913: a card session’s question on a project that ships no content', () => {
    type Wait = { events: LocalBoardWaitEvent[]; cursor: string };

    /** C-369's selector as the runner reads it from an 80x24 pane. */
    const C369: PendingQuestion = {
      key: '0123456789abcdef',
      header: 'C-369 order',
      text: 'C-369 depends on C-367 and C-368. Run it now on top of develop, or wait until both are accepted?',
      options: [
        {
          index: 1,
          label: 'Wait for both',
          description: 'Run C-369 after C-367 and C-368 are accepted.',
        },
        { index: 2, label: 'Run now', description: 'Start on develop.' },
        { index: 3, label: 'Stack it', description: 'Branch from C-368.' },
      ],
      other: true,
    };

    const messagesSent = () =>
      jest
        .mocked(commands.send)
        .mock.calls.filter(([, name]) => name === 'session.message')
        .map(([, , args]) => args as SessionMessageArgs);

    /** The runner's events for a worker that asks C-369's question. */
    const asks = async () => {
      await manualSession();
      await w.createCard({ title: 'Add login' });
      await data(ask('card.run', { card: 1 }));
      const card = await w.card(1);
      const { runId } = card.rounds[0];
      const at = new Date().toISOString();
      await w.deliver('card_run.question', {
        cardId: card.id,
        runId,
        projectId: w.a,
        at,
      });
      await w.deliver('card_run.pending_question', {
        cardId: card.id,
        runId,
        projectId: w.a,
        at,
        question: C369,
      });
      return { cardId: card.id, runId };
    };

    beforeEach(() => jest.mocked(commands.send).mockClear());

    it('board.list, board.card, board.wait and the card show it, and card.message answers it', async () => {
      const project = await w.ctx.prisma.project.findUniqueOrThrow({
        where: { id: w.a },
      });
      expect(project.shipSessionContent).toBe(false);
      const start = await data<Wait>(ask('board.wait', {}));
      const { cardId, runId } = await asks();

      const list = await data<{
        cards: { number: number; waitingOnQuestion: boolean }[];
      }>(ask('board.list', {}));
      expect(list.cards.find((c) => c.number === 1)?.waitingOnQuestion).toBe(
        true,
      );
      const detail = await data<{ question: PendingQuestion | null }>(
        ask('board.card', { card: 1 }),
      );
      expect(detail.question).toEqual(C369);
      const woken = await data<Wait>(
        ask('board.wait', { cursor: start.cursor, cards: [1], timeoutSec: 10 }),
      );
      expect(woken.events).toContainEqual({
        type: 'question',
        card: 1,
        label: 'C-1',
        title: 'Add login',
        question: C369,
      });
      const web = await w.viewer.get(`${w.path()}/board/cards/1`);
      expect((web.body as BoardCardDetail).round?.pendingQuestion).toEqual(
        C369,
      );
      expect((web.body as BoardCardDetail).sessionMessageRefusal).toBeNull();

      expect(
        await data(
          ask('card.message', {
            card: 1,
            kind: 'option',
            questionKey: C369.key,
            index: 3,
          }),
        ),
      ).toEqual({ outcome: 'answered' });
      expect(
        await data(
          ask('card.message', {
            card: 1,
            kind: 'other',
            questionKey: C369.key,
            text: 'Stack it on C-368 and say so in the PR',
          }),
        ),
      ).toEqual({ outcome: 'answered' });
      const target = { kind: 'card_round', cardId, runId };
      expect(messagesSent()).toEqual([
        {
          projectId: w.a,
          target,
          message: { kind: 'option', questionKey: C369.key, index: 3 },
        },
        {
          projectId: w.a,
          target,
          message: {
            kind: 'other',
            questionKey: C369.key,
            text: 'Stack it on C-368 and say so in the PR',
          },
        },
      ]);
    });

    it('card.message says which runner policy refuses it, and the card says so before; nothing is sent', async () => {
      await w.ctx.prisma.runner.update({
        where: { id: w.runnerId },
        data: {
          capabilities: {
            ...capabilities,
            policy: {
              allowedRoots: [ROOT_A],
              maxPermissionMode: 'auto',
              terminal: { write: false },
              skills: { profileInstall: false },
              commands: { 'session.message': false },
            },
          },
        },
      });
      await asks();
      const fix = '`nautelle-runner policy set commands.session.message true`';

      const web = await w.viewer.get(`${w.path()}/board/cards/1`);
      expect((web.body as BoardCardDetail).sessionMessageRefusal).toContain(
        fix,
      );
      const answer = await ask('card.message', {
        card: 1,
        kind: 'option',
        questionKey: C369.key,
        index: 3,
      });
      expect(answer.ok).toBe(false);
      expect(answer.error?.code).toBe('policy_refused');
      expect(answer.error?.message).toBe(
        `refused by this runner's policy (commands): session.message is off on this runner. On the runner's machine: ${fix}`,
      );
      expect(messagesSent()).toEqual([]);
      const records = await w.audit('card.message');
      expect(records.at(-1)).toMatchObject({ result: 'error' });
      expect(records.at(-1)?.after).toMatchObject({ error: 'policy_refused' });
    });

    it('passes on the runner’s own policy refusal when its policy changed since hello', async () => {
      await asks();
      jest.mocked(commands.send).mockImplementationOnce(
        async () =>
          ({
            status: 'error',
            error: {
              code: 'policy_refused',
              message:
                "refused by this runner's policy (commands): session.message is off on this runner. On the runner's machine: `nautelle-runner policy set commands.session.message true`",
            },
          }) satisfies CommandSendResult<'session.message'> as never,
      );
      const answer = await ask('card.message', {
        card: 1,
        kind: 'option',
        questionKey: C369.key,
        index: 1,
      });
      expect(answer.error?.code).toBe('policy_refused');
      expect(answer.error?.message).toContain('commands.session.message true');
    });
  });

  describe('card_accept (D5)', () => {
    const decide = (id: string, decision: 'approve' | 'deny') =>
      w.operator.send(
        'post',
        `${w.path()}/action-requests/${id}/${decision}`,
        {},
      );

    it('files a pending request bound to the card; approving it merges and accepts', async () => {
      await manualSession();
      await w.createCard();
      await finishedWithPr(1);
      const request = await data<{ id: string; status: string; args: object }>(
        ask('action.request', {
          kind: 'card_accept',
          args: { card: 1, merge: true },
          summary: 'C-1 is green and reviewed.',
        }),
      );
      expect(request).toMatchObject({
        status: 'pending',
        args: {
          card: 1,
          merge: true,
          title: 'Add login',
          prNumber: 77,
          prUrl: PR_URL,
        },
      });
      const notification = await w.ctx.prisma.notification.findFirstOrThrow({
        where: { kind: 'action.requested', projectId: w.a },
      });
      expect(notification.title).toBe('Accept C-1 Add login');
      expect(notification.body).toContain(PR_URL);
      expect(notification.body).toContain('and merge #77');

      const approved = await decide(request.id, 'approve');
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({
        status: 'executed',
        result: { card: 1, column: 'completed', merged: true },
      });
      expect(w.sent('card.merge')).toHaveLength(1);
      expect((await w.card(1)).column).toBe('completed');
    });

    it('leaves the card in Finished when the request is denied, and refuses a card not in Finished', async () => {
      await manualSession();
      await w.createCard();
      expect(
        await refusal(
          ask('action.request', {
            kind: 'card_accept',
            args: { card: 1 },
            summary: 'Accept C-1.',
          }),
        ),
      ).toBe('wrong_column');
      await finishedWithPr(1);
      const request = await data<{ id: string }>(
        ask('action.request', {
          kind: 'card_accept',
          args: { card: 1 },
          summary: 'Accept C-1.',
        }),
      );
      expect((await decide(request.id, 'deny')).status).toBe(200);
      expect((await w.card(1)).column).toBe('finished');
      expect(w.sent('card.merge')).toHaveLength(0);
    });
  });

  describe('cardMergePolicy (D4)', () => {
    it('defaults to ask, is an admin’s to change, and board.list returns it', async () => {
      const settings = await w.operator.get(`${w.path()}/board-settings`);
      expect((settings.body as BoardSettingsView).cardMergePolicy).toBe('ask');
      const body = {
        issueOnRun: false,
        specOnRun: false,
        maxRunning: 3,
        cardMergePolicy: 'agent',
      };
      expect(
        (await w.operator.send('put', `${w.path()}/board-settings`, body))
          .status,
      ).toBe(403);
      const bad = await w.admin.send('put', `${w.path()}/board-settings`, {
        ...body,
        cardMergePolicy: 'robot',
      });
      expect(bad.status).toBe(400);
      const put = await w.admin.send('put', `${w.path()}/board-settings`, body);
      expect(put.status).toBe(200);
      expect((put.body as BoardSettingsView).cardMergePolicy).toBe('agent');
      const list = await data<{ settings: { cardMergePolicy: string } }>(
        ask('board.list', {}),
      );
      expect(list.settings.cardMergePolicy).toBe('agent');
      const [audit] = await w.audit('board.settings_updated');
      expect(audit.before).toMatchObject({ cardMergePolicy: 'ask' });
      expect(audit.after).toMatchObject({ cardMergePolicy: 'agent' });
    });
  });
});
