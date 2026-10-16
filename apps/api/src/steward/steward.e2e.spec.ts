import {
  STEWARD_DEFAULTS,
  STEWARD_NUDGE_REPEAT_DELAY_MS,
  STEWARD_NUDGE_TEXT,
  type StewardIncidentView,
  type StewardSettingsView,
} from '@agentdock/shared';
import type { StewardCommandName } from '@agentdock/shared/protocol';
import { UnprocessableEntityException } from '@nestjs/common';
import { BoardWorld, ROOT_B } from '../board/testing/board-e2e';
import { NotificationMatcher } from '../notifications/notification-matcher';
import { IssueLinkValidator } from './issue-link';
import { StewardChips } from './steward-chips';
import { StewardCommands } from './steward-commands';
import { StewardDecider } from './steward-decider';

type Handler = (args: Record<string, unknown>) => unknown;

describe('Steward (e2e)', () => {
  const w = new BoardWorld();
  let commands: StewardCommands;
  let decider: StewardDecider;
  let matcher: NotificationMatcher;
  let handlers: Partial<Record<StewardCommandName, Handler>> = {};
  let served = true;

  beforeAll(async () => {
    await w.init();
    commands = w.ctx.app.get(StewardCommands);
    decider = w.ctx.app.get(StewardDecider);
    matcher = w.ctx.app.get(NotificationMatcher);
    jest.spyOn(commands, 'available').mockImplementation(async () => served);
    jest
      .spyOn(commands, 'send')
      .mockImplementation(async (_runner, name, args) => {
        const handler = handlers[name];
        if (handler) return handler(args as Record<string, unknown>) as never;
        const defaults: Record<StewardCommandName, unknown> = {
          'session.nudge': { sent: true },
          'session.dismiss': { dismissed: true },
          'card.resume': {
            outcome: 'resumed',
            tmuxSession: 'agentdock-card-abcd1234',
          },
        };
        return { status: 'ok', output: defaults[name], rttMs: 1 } as never;
      });
  });
  afterAll(() => w.close());
  beforeEach(async () => {
    await w.reset();
    jest.mocked(commands.send).mockClear();
    handlers = {};
    served = true;
    // The first pass only places the matcher's cursor.
    await matcher.tick();
  });
  afterEach(async () => {
    await decider.settled();
    await w.work.settled();
  });

  const settingsPath = (projectId = w.a) => `/projects/${projectId}/steward`;
  const incidentsPath = (projectId = w.a, query = '') =>
    `/projects/${projectId}/steward/incidents${query}`;

  const sent = (name: StewardCommandName) =>
    jest
      .mocked(commands.send)
      .mock.calls.filter(([, n]) => n === name)
      .map(([, , args]) => args as Record<string, unknown>);

  /** Card 1, run once: its card id, round id and run id. */
  const ranCard = async () => {
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    const card = await w.card(1);
    const round = card.rounds[0];
    return { cardId: card.id, roundId: round.id, runId: round.runId, card };
  };

  let atSeq = 0;
  /** A runner clock reading after every earlier one. */
  const nextAt = () => {
    atSeq += 1;
    return new Date(Date.UTC(2026, 9, 14, 11, 0, 0, atSeq)).toISOString();
  };

  const observe = async (
    subject: object,
    kind: string,
    reason: string,
    extra: object = {},
    event: object = {},
  ) => {
    await w.deliver(
      'steward.observed',
      { projectId: w.a, at: nextAt(), subject, kind, reason, ...extra },
      event,
    );
    await decider.settled();
  };

  const incidents = () =>
    w.ctx.prisma.stewardIncident.findMany({ orderBy: { openedAt: 'asc' } });

  const stewardEvents = (type?: string) =>
    w.ctx.prisma.event.findMany({
      where: {
        source: 'api',
        type: type ?? { startsWith: 'steward_incident.' },
      },
      orderBy: { id: 'asc' },
    });

  /**
   * The matcher's passes up to now. Earlier tests' deleted rows leave holes
   * in `events.id`; the second pass is late enough to take them as gone.
   */
  const notifications = async () => {
    await matcher.tick();
    await matcher.tick(Date.now() + 10 * 60_000);
    return w.ctx.prisma.notification.findMany({
      where: { kind: 'steward.incident' },
    });
  };

  const setSettings = (over: Partial<typeof STEWARD_DEFAULTS>) =>
    w.ctx.prisma.stewardSettings.upsert({
      where: { projectId: w.a },
      create: { projectId: w.a, ...STEWARD_DEFAULTS, ...over },
      update: over,
    });

  describe('the setting (D16)', () => {
    it('reads the defaults for a project without a row', async () => {
      const response = await w.viewer.get(settingsPath());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ...STEWARD_DEFAULTS, updatedAt: null });
    });

    it('a project admin changes it, audited; an operator cannot', async () => {
      const body = {
        ...STEWARD_DEFAULTS,
        autoNudge: false,
        silenceMinutes: 20,
      };
      expect((await w.operator.send('put', settingsPath(), body)).status).toBe(
        403,
      );
      const saved = await w.admin.send('put', settingsPath(), body);
      expect(saved.status).toBe(200);
      const view = saved.body as StewardSettingsView;
      expect(view).toMatchObject({ autoNudge: false, silenceMinutes: 20 });
      expect(view.updatedAt).not.toBeNull();
      expect((await w.viewer.get(settingsPath())).body).toMatchObject({
        autoNudge: false,
      });
      const [record] = await w.audit('project.update');
      expect(record).toMatchObject({ projectId: w.a, result: 'ok' });
    });

    it('refuses an invalid setting', async () => {
      for (const over of [
        { digestTime: '24:00' },
        { silenceMinutes: 0 },
        { silenceMinutes: 241 },
        { autoNudge: 'yes' },
        { extra: true },
      ]) {
        const response = await w.admin.send('put', settingsPath(), {
          ...STEWARD_DEFAULTS,
          ...over,
        });
        expect(response.status).toBe(400);
      }
    });
  });

  describe('authorization (e2e acceptance)', () => {
    it("a member of project B reads none of project A's Steward", async () => {
      const { cardId, runId } = await ranCard();
      await observe(
        { kind: 'card_round', cardId, runId },
        'silent',
        'waiting at the prompt',
      );
      for (const path of [settingsPath(), incidentsPath()]) {
        expect((await w.operatorOfB.get(path)).status).toBe(404);
        expect((await w.outsider.get(path)).status).toBe(404);
      }
      expect(
        (await w.operatorOfB.send('put', settingsPath(), STEWARD_DEFAULTS))
          .status,
      ).toBe(404);
      const own = await w.operatorOfB.get(incidentsPath(w.b));
      expect(own.status).toBe(200);
      expect(own.body).toEqual([]);
    });
  });

  describe('intake (DA-04, DA-12, DA-13)', () => {
    it('takes an observation only with source runner', async () => {
      const { cardId, runId } = await ranCard();
      await observe(
        { kind: 'card_round', cardId, runId },
        'silent',
        'forged',
        {},
        { source: 'code-sentinel' },
      );
      expect(await incidents()).toHaveLength(0);
    });

    it('takes the project from the envelope, never from the data', async () => {
      const { cardId, runId } = await ranCard();
      // Project A's round, sent for project B's root.
      await observe(
        { kind: 'card_round', cardId, runId },
        'silent',
        'wrong root',
        {},
        { project: { repo: 'acme/gadget', root: ROOT_B } },
      );
      // The data names another project than the envelope.
      await w.deliver('steward.observed', {
        projectId: w.b,
        at: nextAt(),
        subject: { kind: 'card_round', cardId, runId },
        kind: 'silent',
        reason: 'wrong project',
      });
      await decider.settled();
      expect(await incidents()).toHaveLength(0);
    });

    it('drops the pane tail before the event is stored, and stores none', async () => {
      const { cardId, runId } = await ranCard();
      const data = {
        projectId: w.a,
        at: nextAt(),
        subject: { kind: 'card_round', cardId, runId },
        kind: 'silent',
        reason: 'waiting at the prompt',
        paneTail: 'SECRET pane text ❯',
      };
      const event = {
        v: 1 as const,
        seq: 9_001,
        ts: new Date().toISOString(),
        type: 'steward.observed',
        source: 'runner' as const,
        project: { repo: 'acme/widget', root: '/srv/dev/widget' },
        data,
      };
      await w.sinks.dispatch(w.runnerId, [event]);
      await decider.settled();
      expect(event.data).not.toHaveProperty('paneTail');
      const rows = await incidents();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain('SECRET');
      const stored = (await stewardEvents()).map((e) => e.data);
      expect(JSON.stringify(stored)).not.toContain('SECRET');
    });

    it('stores a reason as one safe line', async () => {
      const { cardId, runId } = await ranCard();
      await observe(
        { kind: 'card_round', cardId, runId },
        'unknown',
        `stuck${String.fromCodePoint(0x1b)}[2J on ${String.fromCodePoint(0x202e)}a migration`,
        { classifierSessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
      );
      const [incident] = await incidents();
      expect(incident.reason).toBe('stuck [2J on a migration');
      // D16: haiku's call is a `steward` run of the project, once.
      const runs = await w.ctx.prisma.run.findMany({
        where: { projectId: w.a, kind: 'steward' },
      });
      expect(runs).toHaveLength(1);
    });

    it('records nothing while Steward is off', async () => {
      await setSettings({ enabled: false });
      const { cardId, runId } = await ranCard();
      await observe(
        { kind: 'card_round', cardId, runId },
        'api_error',
        'API Error: Connection lost mid-response',
      );
      expect(await incidents()).toHaveLength(0);
      expect(sent('session.nudge')).toHaveLength(0);
    });
  });

  describe('an API error (D9)', () => {
    const reason = 'API Error: Connection lost mid-response';

    it('nudges at once, again 2 minutes later, and escalates the third once', async () => {
      const { cardId, runId } = await ranCard();
      const subject = { kind: 'card_round', cardId, runId };
      await observe(subject, 'api_error', reason);
      expect(sent('session.nudge')).toEqual([
        { projectId: w.a, subject, text: STEWARD_NUDGE_TEXT },
      ]);
      const [first] = await incidents();
      expect(first.status).toBe('open');
      expect(first.actions).toEqual([
        { action: 'nudge', at: expect.any(String), result: 'ok' },
      ]);

      // The same error again before 2 minutes: nothing yet.
      await observe(subject, 'api_error', `${reason} (again)`);
      expect(sent('session.nudge')).toHaveLength(1);
      await decider.tick(
        new Date(Date.now() + STEWARD_NUDGE_REPEAT_DELAY_MS + 1_000),
      );
      expect(sent('session.nudge')).toHaveLength(2);

      // A third error: no nudge, one notification.
      await observe(subject, 'api_error', `${reason} (third)`);
      expect(sent('session.nudge')).toHaveLength(2);
      const [incident] = await incidents();
      expect(incident.status).toBe('escalated');
      const notified = await notifications();
      expect(notified.length).toBeGreaterThan(0);
      expect(new Set(notified.map((n) => n.userId)).size).toBe(notified.length);
      expect(await stewardEvents('steward_incident.escalated')).toHaveLength(1);
      // The same reason again notifies nobody (D13).
      await decider.decide(incident.id);
      await decider.tick();
      expect(await stewardEvents('steward_incident.escalated')).toHaveLength(1);
      expect(await notifications()).toHaveLength(notified.length);
    });

    it('a changed reason notifies again', async () => {
      await setSettings({ autoNudge: false });
      const { cardId, runId } = await ranCard();
      const subject = { kind: 'card_round', cardId, runId };
      await observe(subject, 'api_error', reason);
      expect(sent('session.nudge')).toHaveLength(0);
      expect(await stewardEvents('steward_incident.escalated')).toHaveLength(1);
      await observe(subject, 'api_error', 'API Error: 529 overloaded');
      expect(await stewardEvents('steward_incident.escalated')).toHaveLength(2);
    });

    it('the session moving on resolves it, with no notification', async () => {
      const { cardId, runId, card } = await ranCard();
      const sessionId = card.sessionId as string;
      await observe({ kind: 'card_round', cardId, runId }, 'api_error', reason);
      await w.hook('hook.prompt_submitted', sessionId, {});
      const [incident] = await incidents();
      expect(incident.status).toBe('resolved');
      expect(await stewardEvents('steward_incident.resolved')).toHaveLength(1);
      expect(await notifications()).toHaveLength(0);
    });

    it('limits nudges per round, across incidents', async () => {
      const { cardId, runId, card } = await ranCard();
      const sessionId = card.sessionId as string;
      const subject = { kind: 'card_round', cardId, runId };
      // The first error: nudged, and the session moves on.
      await observe(subject, 'api_error', `${reason} 1`);
      await w.hook('hook.prompt_submitted', sessionId, {});
      expect(sent('session.nudge')).toHaveLength(1);
      // A second incident of the round waits out the delay, then is nudged.
      await observe(subject, 'api_error', `${reason} 2`);
      expect(sent('session.nudge')).toHaveLength(1);
      await decider.tick(
        new Date(Date.now() + STEWARD_NUDGE_REPEAT_DELAY_MS + 1_000),
      );
      await w.hook('hook.prompt_submitted', sessionId, {});
      expect(sent('session.nudge')).toHaveLength(2);
      await observe(subject, 'api_error', `${reason} again`);
      expect(sent('session.nudge')).toHaveLength(2);
      expect((await incidents()).at(-1)?.status).toBe('escalated');
    });

    it('escalates instead when the runner does not serve Steward', async () => {
      served = false;
      const { cardId, runId } = await ranCard();
      await observe({ kind: 'card_round', cardId, runId }, 'api_error', reason);
      expect(sent('session.nudge')).toHaveLength(0);
      expect((await incidents())[0].status).toBe('escalated');
    });

    it('a starter who lost the project acts no more', async () => {
      const { cardId, runId } = await ranCard();
      await w.ctx.prisma.projectMember.deleteMany({
        where: { projectId: w.a, userId: w.operatorId },
      });
      await observe({ kind: 'card_round', cardId, runId }, 'api_error', reason);
      expect(sent('session.nudge')).toHaveLength(0);
      expect((await incidents())[0].status).toBe('escalated');
    });

    it('acts as the round starter', async () => {
      const { cardId, runId } = await ranCard();
      await observe({ kind: 'card_round', cardId, runId }, 'api_error', reason);
      const [, , , options] = jest.mocked(commands.send).mock.calls[0];
      expect(options).toEqual({
        role: 'operator',
        ctx: { actor: { type: 'system', onBehalfOf: w.operatorId } },
      });
    });
  });

  describe('dialogs and prompts (D11)', () => {
    it('dismisses a listed dialog', async () => {
      const { cardId, runId } = await ranCard();
      await observe(
        { kind: 'card_round', cardId, runId },
        'dialog',
        'the auto mode dialog',
        { dialogId: 'teach-auto-mode' },
      );
      expect(sent('session.dismiss')).toEqual([
        {
          projectId: w.a,
          subject: { kind: 'card_round', cardId, runId },
          dialogId: 'teach-auto-mode',
        },
      ]);
    });

    it('never answers an unknown dialog or a permission prompt', async () => {
      const { cardId, runId } = await ranCard();
      const subject = { kind: 'card_round', cardId, runId };
      await observe(subject, 'dialog', 'an unknown dialog');
      await observe(subject, 'permission_prompt', 'Bash wants to run');
      expect(jest.mocked(commands.send)).not.toHaveBeenCalled();
      const rows = await incidents();
      expect(rows.map((r) => [r.kind, r.status])).toEqual([
        ['dialog', 'resolved'],
        ['permission_prompt', 'escalated'],
      ]);
      expect(await stewardEvents('steward_incident.escalated')).toHaveLength(2);
    });

    it('escalates a listed dialog when dismissing is off', async () => {
      await setSettings({ autoDismiss: false });
      const { cardId, runId } = await ranCard();
      await observe(
        { kind: 'card_round', cardId, runId },
        'dialog',
        'the auto mode dialog',
        { dialogId: 'teach-auto-mode' },
      );
      expect(jest.mocked(commands.send)).not.toHaveBeenCalled();
      expect((await incidents())[0].status).toBe('escalated');
    });
  });

  describe('a dead session (D10, DA-15)', () => {
    /** The round ended by its session alone, the card still In progress. */
    const sessionEnded = async (roundId: string) => {
      await w.ctx.prisma.boardCardRound.update({
        where: { id: roundId },
        data: {
          phase: 'finished',
          finishedBy: 'session_end',
          finishedAt: new Date(),
          endedAt: new Date(),
        },
      });
    };

    it('reopens the round and resumes it in the mode it started in', async () => {
      const { cardId, roundId, runId, card } = await ranCard();
      await sessionEnded(roundId);
      await observe(
        { kind: 'card_round', cardId, runId },
        'dead_session',
        "the card's session is gone",
      );
      const [args] = sent('card.resume');
      expect(args).toMatchObject({
        cardId,
        runId,
        projectId: w.a,
        shortId: card.shortId,
        branch: card.branch,
        sessionId: card.sessionId,
        permissionMode: 'auto',
      });
      const round = await w.ctx.prisma.boardCardRound.findUniqueOrThrow({
        where: { id: roundId },
      });
      expect(round).toMatchObject({ phase: 'starting', finishedBy: null });
      const run = await w.ctx.prisma.run.findUniqueOrThrow({
        where: { id: runId },
      });
      expect(run.status).toBe('running');
      expect(run.args).toMatchObject({ permissionMode: 'auto' });

      // The runner's `running` moves the reopened round on, and the resumed
      // session's start closes the incident.
      await w.deliver('card_run.phase_changed', {
        cardId,
        runId,
        projectId: w.a,
        at: new Date().toISOString(),
        phase: 'running',
        tmuxSession: 'agentdock-card-abcd1234',
      });
      expect(
        (
          await w.ctx.prisma.boardCardRound.findUniqueOrThrow({
            where: { id: roundId },
          })
        ).phase,
      ).toBe('running');
      await w.hook('hook.session_started', card.sessionId as string, {});
      expect((await incidents())[0].status).toBe('resolved');
    });

    it('never resumes a round a person stopped', async () => {
      const { cardId, roundId, runId } = await ranCard();
      await w.ctx.prisma.boardCardRound.update({
        where: { id: roundId },
        data: { phase: 'cancelled', finishedAt: new Date() },
      });
      await observe(
        { kind: 'card_round', cardId, runId },
        'dead_session',
        "the card's session is gone",
      );
      expect(sent('card.resume')).toHaveLength(0);
      expect((await incidents())[0].status).toBe('resolved');
    });

    it('escalates a round without a worktree, as its session left it', async () => {
      handlers['card.resume'] = () => ({
        status: 'ok',
        output: { outcome: 'no_worktree' },
        rttMs: 1,
      });
      const { cardId, roundId, runId } = await ranCard();
      await sessionEnded(roundId);
      await observe(
        { kind: 'card_round', cardId, runId },
        'dead_session',
        "the card's session is gone",
      );
      expect(sent('card.resume')).toHaveLength(1);
      expect((await incidents())[0].status).toBe('escalated');
      const round = await w.ctx.prisma.boardCardRound.findUniqueOrThrow({
        where: { id: roundId },
      });
      expect(round).toMatchObject({
        phase: 'finished',
        finishedBy: 'session_end',
      });
    });

    it('resumes at most twice per round', async () => {
      const { cardId, roundId, runId } = await ranCard();
      for (let i = 0; i < 3; i++) {
        await sessionEnded(roundId);
        await observe(
          { kind: 'card_round', cardId, runId },
          'dead_session',
          `the card's session ended (exit code ${i})`,
        );
      }
      expect(sent('card.resume')).toHaveLength(2);
      expect((await incidents()).at(-1)?.status).toBe('escalated');
    });

    it('bypassPermissions resumes only for a starter who is an admin', async () => {
      const { cardId, roundId, runId } = await ranCard();
      await w.ctx.prisma.projectOrchestratorSettings.upsert({
        where: { projectId: w.a },
        create: { projectId: w.a, permissionMode: 'bypassPermissions' },
        update: { permissionMode: 'bypassPermissions' },
      });
      // The round started before the mode was stored on its run.
      await w.ctx.prisma.run.update({
        where: { id: runId },
        data: { args: { card: 1, round: 1, trigger: 'run' } },
      });
      await sessionEnded(roundId);
      await observe(
        { kind: 'card_round', cardId, runId },
        'dead_session',
        "the card's session is gone",
      );
      expect(sent('card.resume')).toHaveLength(0);
      expect((await incidents())[0].status).toBe('escalated');
    });

    it('escalates instead when resuming is off', async () => {
      await setSettings({ autoResume: false });
      const { cardId, roundId, runId } = await ranCard();
      await sessionEnded(roundId);
      await observe(
        { kind: 'card_round', cardId, runId },
        'dead_session',
        "the card's session is gone",
      );
      expect(sent('card.resume')).toHaveLength(0);
      expect((await incidents())[0].status).toBe('escalated');
    });
  });

  describe('the fleet (D5)', () => {
    it('a stalled slot opens an incident and a notification, and gets no command', async () => {
      await observe(
        { kind: 'fleet_slot', slot: 'i447-api' },
        'api_error',
        'API Error: Connection lost mid-response',
      );
      expect(jest.mocked(commands.send)).not.toHaveBeenCalled();
      const [incident] = await incidents();
      expect(incident).toMatchObject({
        subjectKind: 'fleet_slot',
        subjectId: 'i447-api',
        status: 'escalated',
      });
      expect((await notifications()).length).toBeGreaterThan(0);
      await w.deliver(
        'pane.busy',
        { target: 'slot' },
        { slot: 'i447-api', ts: new Date(Date.now() + 60_000).toISOString() },
      );
      expect((await incidents())[0].status).toBe('resolved');
    });
  });

  describe('the trailer guard (D7)', () => {
    it('records the held push on a trailer incident, closed by the next push', async () => {
      const { cardId, runId, card } = await ranCard();
      await w.deliver('steward.acted', {
        projectId: w.a,
        at: nextAt(),
        subject: { kind: 'card_round', cardId, runId },
        action: 'hold_push',
        result: 'ok',
        detail: '2 commits to rewrite',
      });
      await decider.settled();
      const [incident] = await incidents();
      expect(incident).toMatchObject({ kind: 'trailer', status: 'open' });
      expect(incident.actions).toEqual([
        {
          action: 'hold_push',
          at: expect.any(String),
          result: 'ok',
          detail: '2 commits to rewrite',
        },
      ]);
      expect(await stewardEvents('steward_incident.escalated')).toHaveLength(0);
      await w.deliver(
        'card_run.pushed',
        {
          cardId,
          runId,
          projectId: w.a,
          at: new Date().toISOString(),
          branch: card.branch,
          headSha: 'b'.repeat(40),
        },
        { ts: new Date(Date.now() + 60_000).toISOString() },
      );
      expect((await incidents())[0].status).toBe('resolved');
    });
  });

  describe('the incidents list and the card chip', () => {
    it('lists newest first, filters by status and card, and shows the chip', async () => {
      const { cardId, runId, roundId } = await ranCard();
      await observe(
        { kind: 'card_round', cardId, runId },
        'api_error',
        'API Error: Connection lost mid-response',
      );
      const response = await w.viewer.get(incidentsPath());
      expect(response.status).toBe(200);
      const [view] = response.body as StewardIncidentView[];
      expect(view).toMatchObject({
        subjectKind: 'card_round',
        subjectId: roundId,
        subjectLabel: 'C-1',
        kind: 'api_error',
        status: 'open',
        actions: [{ action: 'nudge', result: 'ok' }],
        resolvedAt: null,
      });
      expect(
        (await w.viewer.get(incidentsPath(w.a, '?status=resolved'))).body,
      ).toEqual([]);
      expect(
        (await w.viewer.get(incidentsPath(w.a, '?card=1'))).body,
      ).toHaveLength(1);
      expect((await w.viewer.get(incidentsPath(w.a, '?card=2'))).body).toEqual(
        [],
      );
      expect(
        (await w.viewer.get(incidentsPath(w.a, '?status=gone'))).status,
      ).toBe(400);
      const chips = await w.ctx.app.get(StewardChips).forRounds([roundId]);
      expect(chips.get(roundId)).toMatchObject({
        kind: 'api_error',
        status: 'open',
        actions: [{ action: 'nudge', result: 'ok' }],
      });
    });
  });

  describe('the issue link (D8)', () => {
    const issue = (number: number, over: object = {}) =>
      w.ctx.prisma.issueCache.create({
        data: {
          projectId: w.a,
          number,
          title: `Issue ${number}`,
          state: 'open',
          labels: [],
          assignees: [],
          body: '',
          url: `https://github.com/acme/widget/issues/${number}`,
          ghUpdatedAt: new Date(),
          snapshotAt: new Date(),
          lastSeq: 1n,
          ...over,
        },
      });

    it('takes an open issue of the project, and refuses a closed, missing or foreign one', async () => {
      const validator = w.ctx.app.get(IssueLinkValidator);
      await issue(12);
      await issue(13, { state: 'closed' });
      await issue(14, { kind: 'pull_request' });
      await expect(validator.assertLinkable(w.a, 12)).resolves.toEqual({
        number: 12,
        url: 'https://github.com/acme/widget/issues/12',
      });
      for (const number of [13, 14, 99]) {
        await expect(validator.assertLinkable(w.a, number)).rejects.toThrow(
          UnprocessableEntityException,
        );
      }
      await expect(validator.assertLinkable(w.b, 12)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('a card with an issue runs without creating one, and its PR closes it', async () => {
      w.checksServed = true;
      const { id } = await w.createCard({ issueOnRun: true });
      await w.ctx.prisma.boardCard.update({
        where: { id },
        data: {
          issueNumber: 12,
          issueUrl: 'https://github.com/acme/widget/issues/12',
        },
      });
      expect((await w.runCard(1)).status).toBe(200);
      expect(w.issues()).toHaveLength(0);
      const [run] = w.sent('card.run');
      expect((run.pullRequest as { body: string } | undefined)?.body).toContain(
        'Closes #12',
      );
    });
  });
});
