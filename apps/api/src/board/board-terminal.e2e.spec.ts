import type {
  BoardCardView,
  BoardView,
  FleetCardEdit,
} from '@agentdock/shared';
import type { LocalMethodArgs } from '@agentdock/shared/protocol';
import type { LocalCall } from '../local/local-call';
import { LocalError } from '../local/local-error';
import { LocalHandlers } from '../local/local-handlers';
import { FleetCardEditsRef } from './board.service';
import {
  BOARD_SYSTEM_ACTOR,
  TERMINAL_NO_BRANCH,
  terminalOnBase,
} from './board-work';
import { BoardWorld, ROOT_A, ROOT_B } from './testing/board-e2e';

/** A person's own Claude Code session (ids are uuids, as Claude's are). */
const MANUAL = '6f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f601';
const OTHER_MANUAL = '6f1c2b3a-4d5e-4f60-8a71-b2c3d4e5f602';

/**
 * Terminal work on the Board (issue #282 D1–D3, D5; ADR-0030 §1–§3): the
 * `card.track` local method, the tracked session's end, Automatic work, and
 * the board-side rules of fleet cards (D4).
 */
describe('terminal cards (e2e)', () => {
  const w = new BoardWorld();
  let handlers: LocalHandlers;

  beforeAll(async () => {
    await w.init();
    handlers = w.ctx.app.get(LocalHandlers);
  });
  afterAll(() => w.close());
  beforeEach(() => w.reset());
  afterEach(() => w.work.settled());

  /** A local request as the router hands it over (spec 201 D8). */
  const call = (
    sessionId: string,
    projectId = w.a,
    root = ROOT_A,
  ): LocalCall => ({
    runnerId: w.runnerId,
    requestId: 'lr_1',
    user: { id: w.operatorId, email: 'op@x.test', role: 'operator' },
    role: 'operator',
    project: {
      id: projectId,
      runnerId: w.runnerId,
      rootPath: root,
      repo: 'acme/widget',
      displayName: 'widget',
      baseBranch: 'develop',
      baseOverride: null,
    },
    session: { runtime: 'claude', id: sessionId },
    via: 'mcp',
    ctx: { actor: { type: 'runner', runnerId: w.runnerId } },
    meta: { onBehalfOf: w.operatorId, via: 'mcp' },
  });

  const track = (
    args: LocalMethodArgs<'card.track'>,
    sessionId = MANUAL,
    projectId = w.a,
  ) => handlers.table['card.track'](args, call(sessionId, projectId));

  /** The session's hooks reached Nautelle: it is a `manual` session in `root`. */
  const manualSession = async (externalId = MANUAL, root = ROOT_A) => {
    await w.deliver(
      'hook.session_started',
      {
        source: 'startup',
        cwd: root,
        gitBranch: 'fix/12-pairing',
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

  /** The `SessionEnd` hook of the tracked session. */
  const endSession = () =>
    w.hook('hook.session_ended', MANUAL, { reason: 'prompt_input_exit' });

  const boardCard = async (number: number): Promise<BoardCardView> => {
    const board = await w.operator.get(`${w.path()}/board`);
    expect(board.status).toBe(200);
    const card = (board.body as BoardView).columns
      .flatMap((c) => c.cards)
      .find((c) => c.number === number);
    if (!card) throw new Error(`C-${number} is not on the board`);
    return card;
  };

  const localError = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      if (error instanceof LocalError) return error.code;
      throw error;
    }
    throw new Error('expected a LocalError');
  };

  describe('card.track', () => {
    it('creates one In progress terminal card linked to the session, and a second call updates it', async () => {
      const sessionRow = await manualSession();
      const first = await track({
        title: '  Fix the pairing flake ',
        body: 'It fails on macOS.',
        kind: 'bug',
      });
      expect(first).toEqual({
        number: 1,
        label: 'C-1',
        url: expect.stringMatching(
          new RegExp(`/projects/${w.a}/board\\?card=1$`),
        ),
      });
      const card = await w.card(1);
      expect(card).toMatchObject({
        column: 'in_progress',
        source: 'terminal',
        trackedSessionId: sessionRow,
        title: 'Fix the pairing flake',
        body: 'It fails on macOS.',
        kind: 'bug',
        kindSource: 'person',
        autoCollect: false,
        branch: null,
        createdById: w.operatorId,
      });
      expect(card.rounds).toEqual([]);
      // No worker is started.
      expect(w.sent('card.run')).toEqual([]);

      const second = await track({
        title: 'Fix the pairing flake for good',
        body: 'Also on Linux.',
      });
      expect(second.number).toBe(1);
      expect(await w.ctx.prisma.boardCard.count()).toBe(1);
      expect(await w.card(1)).toMatchObject({
        title: 'Fix the pairing flake for good',
        body: 'Also on Linux.',
        kind: 'bug',
      });

      const view = await boardCard(1);
      expect(view).toMatchObject({
        column: 'in_progress',
        source: 'terminal',
        tracking: { sessionId: sessionRow, alive: true },
        fleet: null,
        autoCollect: false,
      });
      const created = (await w.audit('card.created')).map((a) => a.after);
      expect(created).toMatchObject([
        { number: 1, source: 'terminal', sessionId: sessionRow },
      ]);
      expect(await w.audit('card.updated')).toHaveLength(1);
    });

    it('two calls of one session racing make one card', async () => {
      await manualSession();
      const [a, b] = await Promise.all([
        track({ title: 'One' }),
        track({ title: 'Two' }),
      ]);
      expect(a.number).toBe(1);
      expect(b.number).toBe(1);
      expect(await w.ctx.prisma.boardCard.count()).toBe(1);
    });

    it('each session tracks its own card', async () => {
      await manualSession(MANUAL);
      await manualSession(OTHER_MANUAL);
      expect((await track({ title: 'One' }, MANUAL)).number).toBe(1);
      expect((await track({ title: 'Two' }, OTHER_MANUAL)).number).toBe(2);
    });

    it('starts Automatic work from the board setting', async () => {
      const put = await w.admin.send('put', `${w.path()}/board-settings`, {
        issueOnRun: false,
        specOnRun: false,
        maxRunning: 3,
        autoCollectTracked: true,
      });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ autoCollectTracked: true });
      const settings = await w.operator.get(`${w.path()}/board-settings`);
      expect(settings.body).toMatchObject({
        autoCollectTracked: true,
        isDefault: false,
      });
      expect((await w.audit('board.settings_updated'))[0]).toMatchObject({
        before: { autoCollectTracked: false },
        after: { autoCollectTracked: true },
      });

      await manualSession();
      await track({ title: 'Ship it' });
      expect((await w.card(1)).autoCollect).toBe(true);
    });

    it("refuses not_a_manual_session for a card worker's session, an unknown session and another project's session", async () => {
      await w.createCard();
      expect((await w.runCard(1)).status).toBe(200);
      const worker = (await w.card(1)).sessionId as string;
      await w.hook('hook.session_started', worker, {
        source: 'startup',
        cwd: ROOT_A,
        permissionMode: 'default',
      });
      expect(await localError(track({ title: 'x' }, worker))).toBe(
        'not_a_manual_session',
      );
      expect(await localError(track({ title: 'x' }, MANUAL))).toBe(
        'not_a_manual_session',
      );
      // A manual session of project B, asked about in project A.
      await manualSession(OTHER_MANUAL, ROOT_B);
      expect(await localError(track({ title: 'x' }, OTHER_MANUAL))).toBe(
        'not_a_manual_session',
      );
      expect(await w.ctx.prisma.boardCard.count()).toBe(1);
    });
  });

  describe('the tracked session ends', () => {
    it('SessionEnd moves the card to Finished; with Automatic work off nothing is sent', async () => {
      await manualSession();
      await track({ title: 'Fix the pairing flake' });
      await endSession();
      await w.work.settled();
      const card = await w.card(1);
      expect(card.column).toBe('finished');
      expect(card.prNumber).toBeNull();
      expect(card.autoRunError).toBeNull();
      expect(w.sent('card.collect')).toEqual([]);
      expect((await boardCard(1)).tracking).toMatchObject({ alive: false });

      // A replay changes nothing; only a person completes it.
      await endSession();
      expect((await w.card(1)).column).toBe('finished');
      await expect(
        w.work.move(
          await w.work.project(w.a),
          await w.work.card(w.a, 1),
          { to: 'completed', index: 0, source: 'automatic' },
          BOARD_SYSTEM_ACTOR,
        ),
      ).rejects.toMatchObject({ code: 'move_refused' });
      const accept = await w.operator.send(
        'post',
        `${w.path()}/board/cards/1/accept`,
        {},
      );
      expect(accept.status).toBe(200);
      expect((await w.card(1)).column).toBe('completed');
      expect(w.sent('card.close')).toEqual([]);
    });

    it('finish_card from the tracked session moves its card to Finished', async () => {
      await manualSession();
      await track({ title: 'Fix the pairing flake' });
      const finished = await handlers.table['card.finish'](
        { summary: 'Done.' },
        call(MANUAL),
      );
      expect(finished).toEqual({ number: 1, finished: true });
      expect((await w.card(1)).column).toBe('finished');
    });

    it('a card a person moved elsewhere stays where it is', async () => {
      await manualSession();
      await track({ title: 'Fix the pairing flake' });
      const moved = await w.operator.send(
        'post',
        `${w.path()}/board/cards/1/move`,
        { column: 'todo', index: 0 },
      );
      expect(moved.status).toBe(200);
      await endSession();
      expect((await w.card(1)).column).toBe('todo');
    });

    /** A tracked card with Automatic work on. */
    const autoCollected = async () => {
      await manualSession();
      await track({ title: 'Fix the pairing flake' });
      const patch = await w.operator.send(
        'patch',
        `${w.path()}/board/cards/1`,
        { autoCollect: true },
      );
      expect(patch.status).toBe(200);
      expect(patch.body).toMatchObject({ autoCollect: true });
    };

    it("with Automatic work on, collects in the session's cwd and branch and stores the PR", async () => {
      await autoCollected();
      await endSession();
      await w.work.settled();
      const card = await w.card(1);
      expect(card.column).toBe('finished');
      expect(w.sent('card.collect')).toEqual([
        expect.objectContaining({
          cardId: card.id,
          projectId: w.a,
          root: ROOT_A,
          base: (await w.work.project(w.a)).base,
          branch: 'fix/12-pairing',
          cwd: ROOT_A,
          number: 1,
          title: 'C-1: Fix the pairing flake',
        }),
      ]);
      expect(card).toMatchObject({
        prNumber: 77,
        prUrl: 'https://github.com/acme/widget/pull/77',
        autoRunError: null,
      });
      expect((await boardCard(1)).autoRunFailure).toBeNull();
    });

    it('with Automatic work on, a runner refusal is shown on the card and no PR is stored', async () => {
      w.handlers['card.collect'] = () => ({
        status: 'error',
        error: {
          code: 'path_not_allowed',
          message: `${ROOT_A} is not in a checkout of ${ROOT_A}`,
        },
      });
      await autoCollected();
      await endSession();
      await w.work.settled();
      const card = await w.card(1);
      expect(card.column).toBe('finished');
      expect(card.prNumber).toBeNull();
      expect(w.sent('card.collect')).toHaveLength(1);
      expect((await boardCard(1)).autoRunFailure).toMatchObject({
        code: 'command_unavailable',
        message: expect.stringContaining('path_not_allowed'),
      });
      expect(
        (await w.audit('card.auto_run_failed')).map((a) => a.after),
      ).toEqual([
        {
          number: 1,
          reason: 'terminal_collect_failed',
          error: 'command_unavailable',
        },
      ]);
    });

    it('with Automatic work on, a session on the base branch is never collected', async () => {
      await autoCollected();
      const base = (await w.work.project(w.a)).base;
      await w.ctx.prisma.agentSession.updateMany({
        where: { externalId: MANUAL },
        data: { gitBranch: base },
      });
      await endSession();
      await w.work.settled();
      expect(w.sent('card.collect')).toEqual([]);
      expect((await boardCard(1)).autoRunFailure).toMatchObject({
        code: 'unknown',
        message: terminalOnBase(base),
      });
    });

    it('with Automatic work on, a session with no branch says why and sends nothing', async () => {
      await autoCollected();
      await w.ctx.prisma.agentSession.updateMany({
        where: { externalId: MANUAL },
        data: { gitBranch: null },
      });
      await endSession();
      await w.work.settled();
      expect(w.sent('card.collect')).toEqual([]);
      expect((await boardCard(1)).autoRunFailure).toMatchObject({
        code: 'unknown',
        message: TERMINAL_NO_BRANCH,
      });
    });
  });

  describe('Automatic work on a card', () => {
    it('is refused not_tracked on a card that is not a terminal card', async () => {
      await w.createCard();
      const patch = await w.operator.send(
        'patch',
        `${w.path()}/board/cards/1`,
        { autoCollect: true, title: 'Renamed' },
      );
      expect(patch.status).toBe(422);
      expect(patch.body).toMatchObject({ error: 'not_tracked' });
      expect(await w.card(1)).toMatchObject({
        autoCollect: false,
        title: 'Add login',
      });
    });

    it('is toggled and audited on a terminal card', async () => {
      await manualSession();
      await track({ title: 'Fix the pairing flake' });
      const patch = await w.operator.send(
        'patch',
        `${w.path()}/board/cards/1`,
        { autoCollect: true },
      );
      expect(patch.status).toBe(200);
      expect((await w.audit('card.updated')).map((a) => a.after)).toEqual([
        { number: 1, autoCollect: true },
      ]);
    });
  });

  describe('fleet cards, board side (#282 D4)', () => {
    const fleetCard = (column: 'in_progress' | 'finished') =>
      w.ctx.prisma.boardCard.create({
        data: {
          projectId: w.a,
          number: 1,
          shortId: 'flt00001',
          title: 'Pairing flake',
          column,
          position: 0,
          issueOnRun: false,
          specOnRun: false,
          source: 'fleet',
          fleetIssue: 12,
          fleetSlot: 'i12-pairing',
          fleetStage: 'plan_ready',
          prNumber: column === 'finished' ? 77 : null,
          prUrl:
            column === 'finished'
              ? 'https://github.com/acme/widget/pull/77'
              : null,
          movedAt: new Date(),
        },
      });

    it('maps the slot, refuses a drag fleet_slot, and accepts without merging', async () => {
      await fleetCard('in_progress');
      expect(await boardCard(1)).toMatchObject({
        source: 'fleet',
        fleet: {
          issue: 12,
          slot: 'i12-pairing',
          stage: 'plan_ready',
          slotGone: false,
        },
        tracking: null,
      });
      const drag = await w.operator.send(
        'post',
        `${w.path()}/board/cards/1/move`,
        { column: 'todo', index: 0 },
      );
      expect(drag.status).toBe(409);
      expect(drag.body).toMatchObject({
        error: 'move_refused',
        reason: 'fleet_slot',
      });

      await w.ctx.prisma.boardCard.update({
        where: { projectId_number: { projectId: w.a, number: 1 } },
        data: { column: 'finished', prNumber: 77 },
      });
      const accept = await w.operator.send(
        'post',
        `${w.path()}/board/cards/1/accept`,
        { merge: { headSha: 'a'.repeat(40) } },
      );
      expect(accept.status).toBe(200);
      expect(accept.body).toMatchObject({ column: 'completed', merge: null });
      expect(w.sent('card.merge')).toEqual([]);
    });

    it('tells the fleet port about a text edit, once', async () => {
      await fleetCard('in_progress');
      const edits: FleetCardEdit[] = [];
      const ref = w.ctx.app.get(FleetCardEditsRef);
      ref.set({ cardEdited: async (edit) => void edits.push(edit) });
      try {
        const patch = await w.operator.send(
          'patch',
          `${w.path()}/board/cards/1`,
          { body: 'Also on Linux.' },
        );
        expect(patch.status).toBe(200);
        expect(edits).toEqual([
          expect.objectContaining({
            projectId: w.a,
            number: 1,
            label: 'C-1',
            change: expect.objectContaining({ fields: ['body'] }),
            editor: { userId: w.operatorId, email: 'op@x.test' },
          }),
        ]);
        // Nothing changed: the slot is not told.
        await w.operator.send('patch', `${w.path()}/board/cards/1`, {
          body: 'Also on Linux.',
        });
        expect(edits).toHaveLength(1);
      } finally {
        ref.set(null);
      }
    });
  });
});
