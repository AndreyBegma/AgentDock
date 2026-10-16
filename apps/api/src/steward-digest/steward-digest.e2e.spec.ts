import type { StewardDigestView } from '@agentdock/shared';
import { digestComposeArgsSchema } from '@agentdock/shared/protocol';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { BudgetGate } from '../budgets/budget-gate';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { RunnerSettingsService } from '../runners/runner-settings.service';
import { StewardCommands } from '../steward/steward-commands';
import { BOT_TOKEN, forbidden } from '../telegram/testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from '../telegram/testing/telegram-e2e';
import { login, type Session } from '../test/e2e-app';
import { StewardDigestService } from './steward-digest.service';
import { StewardDigestWorker } from './steward-digest-worker';

const HOUR = 3_600_000;

describe('Steward digest (e2e, #447 D14)', () => {
  let ctx: TelegramE2e;
  let digests: StewardDigestService;
  let runnerId: string;
  let projectId: string;
  let otherProjectId: string;
  let adminId: string;
  let memberId: string;
  let adminSession: Session;
  let memberSession: Session;
  let outsiderSession: Session;
  let cards = 0;

  const latestPath = (id: string) => `/projects/${id}/steward/digest/latest`;
  const rows = (id = projectId) =>
    ctx.prisma.stewardDigest.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'asc' },
    });

  /** A Board card; `round` adds one round in that phase. */
  const card = async (
    title: string,
    options: {
      round?: { phase: 'waiting' | 'finished' | 'running'; finishedAt?: Date };
      mergedAt?: Date;
      needsPerson?: boolean;
      prUrl?: string;
      project?: string;
    } = {},
  ) => {
    cards += 1;
    const project = options.project ?? projectId;
    const created = await ctx.prisma.boardCard.create({
      data: {
        projectId: project,
        number: cards,
        shortId: `card${String(cards).padStart(4, '0')}`,
        title,
        position: cards,
        issueOnRun: false,
        specOnRun: false,
        movedAt: new Date(),
        mergedAt: options.mergedAt ?? null,
        needsPerson: options.needsPerson ?? false,
        prUrl: options.prUrl ?? null,
      },
    });
    if (options.round) {
      const run = await ctx.prisma.run.create({
        data: {
          kind: 'card',
          projectId: project,
          status: 'running',
          triggeredByType: 'user',
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const round = await ctx.prisma.boardCardRound.create({
        data: {
          cardId: created.id,
          round: 1,
          runId: run.id,
          trigger: 'run',
          cardTitle: title,
          cardBody: '',
          cardKind: 'feature',
          phase: options.round.phase,
          finishedAt: options.round.finishedAt ?? null,
        },
      });
      return { card: created, round };
    }
    return { card: created, round: null };
  };

  const spend = async (costUsd: string, ts: Date, project = projectId) => {
    const session = await ctx.prisma.agentSession.create({
      data: {
        runnerId,
        runtime: 'claude',
        externalId: `ext-${Math.random()}`,
        cwd: '/srv/dev/widget',
        projectId: project,
        startedAt: ts,
        lastEventAt: ts,
      },
    });
    await ctx.prisma.llmRequest.create({
      data: {
        sessionId: session.id,
        requestId: `req-${Math.random()}`,
        ts,
        model: 'claude-sonnet-5-5',
        querySource: 'main',
        costUsd,
      },
    });
  };

  const settings = (digestTime: string, enabled = true, project = projectId) =>
    ctx.prisma.stewardSettings.create({
      data: { projectId: project, digestTime, enabled },
    });

  const telegramText = (index = 0) =>
    ctx.fake.sent()[index]?.body.text as string;

  beforeAll(async () => {
    ctx = await createTelegramApp();
    digests = ctx.app.get(StewardDigestService);
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
    cards = 0;
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    ({ projectId: otherProjectId } = await seedRunnerProject(ctx.prisma, {
      root: '/srv/dev/gadget',
      repo: 'acme/gadget',
      name: 'lab',
    }));
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    adminId = admin.id;
    const member = await seedUser(
      ctx.prisma,
      'bob@example.com',
      'operator',
      projectId,
    );
    memberId = member.id;
    await seedUser(ctx.prisma, 'eve@example.com', 'operator', otherProjectId);
    // The other project makes no digest unless a test asks (no row would mean 09:00).
    await settings('09:00', false, otherProjectId);
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', adminId, { actor: SYSTEM_ACTOR });
    await ctx.prisma.telegramLink.create({
      data: { userId: adminId, chatId: 4242n },
    });
    adminSession = await login(ctx, 'ada@example.com');
    memberSession = await login(ctx, 'bob@example.com');
    outsiderSession = await login(ctx, 'eve@example.com');
  });

  describe('the daily digest', () => {
    it('composes done, stuck, waiting and spend, stores it and sends it to Telegram', async () => {
      const now = new Date();
      await settings('00:00');
      await card('Add login', {
        mergedAt: new Date(now.getTime() - HOUR),
        prUrl: 'https://github.com/acme/widget/pull/9',
      });
      await card('Fix build', {
        round: {
          phase: 'finished',
          finishedAt: new Date(now.getTime() - 2 * HOUR),
        },
      });
      const stuck = await card('Slow job', { round: { phase: 'running' } });
      await ctx.prisma.stewardIncident.create({
        data: {
          projectId,
          subjectKind: 'card_round',
          subjectId: stuck.round?.id ?? '',
          kind: 'api_error',
          reason: 'API Error: Connection lost mid-response',
          status: 'escalated',
        },
      });
      await ctx.prisma.stewardIncident.create({
        data: {
          projectId,
          subjectKind: 'fleet_slot',
          subjectId: 'i42-api',
          kind: 'silent',
          reason: 'No activity for 12 minutes',
        },
      });
      await ctx.prisma.stewardIncident.create({
        data: {
          projectId,
          subjectKind: 'card_round',
          subjectId: stuck.round?.id ?? '',
          kind: 'dialog',
          reason: 'resolved already',
          status: 'resolved',
        },
      });
      await card('Pick a colour', { round: { phase: 'waiting' } });
      await card('Red CI', { needsPerson: true });
      await spend('1.25', new Date(now.getTime() - HOUR));
      await spend('2.50', new Date(now.getTime() - 3 * HOUR));
      await spend('9.00', new Date(now.getTime() - 30 * HOUR)); // outside the window
      await spend('7.00', new Date(now.getTime() - HOUR), otherProjectId);

      expect(await digests.runDaily(now)).toBe(1);

      const [row] = await rows();
      expect(row.trigger).toBe('daily');
      expect(row.prose).toBeNull();
      expect(row.to).toEqual(now);
      const view = (await adminSession.get(latestPath(projectId)))
        .body as StewardDigestView;
      expect(view.trigger).toBe('daily');
      expect(view.prose).toBeNull();
      expect(view.done.map((i) => [i.label, i.reason])).toEqual([
        ['C-1', 'merged'],
        ['C-2', 'finished'],
      ]);
      expect(view.done[0].url).toBe('https://github.com/acme/widget/pull/9');
      expect(view.stuck.map((i) => [i.label, i.reason])).toEqual([
        ['C-3', 'API Error: Connection lost mid-response'],
        ['i42-api', 'No activity for 12 minutes'],
      ]);
      expect(view.waiting.map((i) => [i.label, i.reason])).toEqual([
        ['C-4', 'waiting for you'],
        ['C-5', 'CI still failing, needs you'],
      ]);
      expect(view.spendUsd).toBe('3.75');

      const sent = ctx.fake.sent();
      expect(sent).toHaveLength(1);
      expect(sent[0].body.chat_id).toBe(4242);
      expect(sent[0].token).toBe(BOT_TOKEN);
      expect(telegramText()).toContain('*Daily digest — widget*');
      expect(telegramText()).toContain('*Done \\(2\\)*');
      expect(telegramText()).toContain('*Stuck \\(2\\)*');
      expect(telegramText()).toContain('*Waiting for you \\(2\\)*');
      expect(telegramText()).toContain('Spend: $3\\.75');
    });

    it('makes one digest a day however often it ticks', async () => {
      await settings('00:00');
      const now = new Date();
      expect(await digests.runDaily(now)).toBe(1);
      expect(await digests.runDaily(new Date(now.getTime() + 60_000))).toBe(0);
      expect(await rows()).toHaveLength(1);
      expect(ctx.fake.sent()).toHaveLength(1);
    });

    it('two ticks at once make one', async () => {
      await settings('00:00');
      const now = new Date();
      const made = await Promise.all([
        digests.runDaily(now),
        digests.runDaily(now),
      ]);
      expect(made[0] + made[1]).toBe(1);
      expect(await rows()).toHaveLength(1);
    });

    it('waits for the project digest time, and uses 09:00 without a settings row', async () => {
      await settings('23:59');
      const morning = new Date();
      morning.setHours(8, 0, 0, 0);
      expect(await digests.runDaily(morning)).toBe(0);
      expect(await rows()).toHaveLength(0);
      // No row at all means the defaults: enabled, 09:00.
      await ctx.prisma.stewardSettings.delete({
        where: { projectId: otherProjectId },
      });
      expect(await digests.runDaily(morning)).toBe(0);
      const afternoon = new Date();
      afternoon.setHours(15, 0, 0, 0);
      expect(await digests.runDaily(afternoon)).toBe(1);
      expect(await rows(otherProjectId)).toHaveLength(1);
      expect(await rows(projectId)).toHaveLength(0);
    });

    it('continues from where the last digest ended', async () => {
      await settings('00:00');
      const first = new Date();
      first.setHours(12, 0, 0, 0);
      await digests.runDaily(first);
      const next = new Date(first.getTime() + 24 * HOUR);
      next.setHours(12, 0, 0, 0);
      await digests.runDaily(next);
      const [a, b] = await rows();
      expect(b.from).toEqual(a.to);
      expect(b.to).toEqual(next);
    });

    it('makes none for a project with Steward switched off', async () => {
      await settings('00:00', false);
      await digests.runDaily(new Date());
      expect(await rows()).toHaveLength(0);
      expect(ctx.fake.sent()).toHaveLength(0);
    });

    it('stores one bounded line for a reason with line breaks and a huge length', async () => {
      await settings('00:00');
      const hostile = `line one\nline two\u001b[31m\r\n ${'x'.repeat(1000)}`;
      await ctx.prisma.stewardIncident.create({
        data: {
          projectId,
          subjectKind: 'fleet_slot',
          subjectId: 'i1',
          kind: 'unknown',
          reason: hostile,
        },
      });
      await digests.runDaily(new Date());
      const view = (await adminSession.get(latestPath(projectId)))
        .body as StewardDigestView;
      const reason = view.stuck[0].reason ?? '';
      expect(Array.from(reason).some((c) => c.charCodeAt(0) < 32)).toBe(false);
      expect(Array.from(reason)).toHaveLength(200);
      expect(reason.startsWith('line one line two ')).toBe(true);
    });
  });

  describe('"while you were away"', () => {
    const awayOffAfterOn = async () => {
      const settingsService = ctx.app.get(RunnerSettingsService);
      const actor = {
        userId: adminId,
        isAdmin: true,
        ctx: { actor: userActor(adminId) },
      };
      await settingsService.update(runnerId, { awayMode: true }, actor);
      await new Promise((r) => setTimeout(r, 20));
      await settingsService.update(runnerId, { awayMode: false }, actor);
    };

    it('makes a digest for each project of the runner when away mode is switched off', async () => {
      await settings('23:59');
      await card('Done while away', {
        mergedAt: new Date(Date.now() - 1000),
      });
      await awayOffAfterOn();

      expect(await digests.runAwayOff(new Date())).toBe(1);

      const [row] = await rows();
      expect(row.trigger).toBe('away_off');
      // The window opens when away mode went on, not 24 hours back.
      expect(row.to.getTime() - row.from.getTime()).toBeLessThan(60_000);
      // Only this runner's project.
      expect(await rows(otherProjectId)).toHaveLength(0);
      expect(telegramText()).toContain('*While you were away — widget*');
    });

    it('is not repeated by the next tick', async () => {
      await awayOffAfterOn();
      expect(await digests.runAwayOff(new Date())).toBe(1);
      expect(await digests.runAwayOff(new Date())).toBe(0);
      expect(await rows()).toHaveLength(1);
    });

    it('is sent to the person who switched it off, not to everyone linked', async () => {
      await ctx.prisma.telegramLink.create({
        data: { userId: memberId, chatId: 777n },
      });
      await awayOffAfterOn();
      await digests.runAwayOff(new Date());
      const sent = ctx.fake.sent();
      expect(sent).toHaveLength(1);
      expect(sent[0].body.chat_id).toBe(4242);
    });

    it('ignores away mode switched on, and one older than the lookback', async () => {
      const settingsService = ctx.app.get(RunnerSettingsService);
      await settingsService.update(
        runnerId,
        { awayMode: true },
        {
          userId: adminId,
          isAdmin: true,
          ctx: { actor: userActor(adminId) },
        },
      );
      expect(await digests.runAwayOff(new Date())).toBe(0);
      await settingsService.update(
        runnerId,
        { awayMode: false },
        {
          userId: adminId,
          isAdmin: true,
          ctx: { actor: userActor(adminId) },
        },
      );
      const later = new Date(Date.now() + 20 * 60_000);
      expect(await digests.runAwayOff(later)).toBe(0);
    });

    it('makes none for a project with Steward switched off', async () => {
      await settings('23:59', false);
      await awayOffAfterOn();
      expect(await digests.runAwayOff(new Date())).toBe(0);
    });
  });

  describe('Telegram delivery', () => {
    it('keeps the digest when Telegram refuses the send', async () => {
      await settings('00:00');
      ctx.fake.script('sendMessage', forbidden());
      expect(await digests.runDaily(new Date())).toBe(1);
      expect(await rows()).toHaveLength(1);
    });

    it('stores the digest and sends nothing without a bot token', async () => {
      await settings('00:00');
      await ctx.app.get(BotTokenStore).clear({ actor: SYSTEM_ACTOR });
      expect(await digests.runDaily(new Date())).toBe(1);
      expect(await rows()).toHaveLength(1);
      expect(ctx.fake.sent()).toHaveLength(0);
    });

    it('sends only to linked, active users who can see the project', async () => {
      await settings('00:00');
      const eve = await ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'eve@example.com' },
      });
      await ctx.prisma.telegramLink.create({
        data: { userId: eve.id, chatId: 555n }, // member of the other project only
      });
      await ctx.prisma.telegramLink.create({
        data: { userId: memberId, chatId: 777n },
      });
      await digests.runDaily(new Date());
      const chats = ctx.fake
        .sent()
        .map((c) => c.body.chat_id)
        .sort();
      // Project A: admin + member; project B (no settings row, default 09:00
      // and it is not past it only before 09:00) is covered below.
      expect(chats).toEqual(expect.arrayContaining([777, 4242]));
      expect(chats).not.toContain(555);
    });
  });

  describe('GET /projects/:id/steward/digest/latest', () => {
    it('is 404 before the first digest', async () => {
      const response = await memberSession.get(latestPath(projectId));
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    });

    it('returns the newest digest to any member and to an admin', async () => {
      await settings('00:00');
      await digests.runDaily(new Date());
      await ctx.prisma.stewardDigest.create({
        data: {
          projectId,
          trigger: 'away_off',
          from: new Date(Date.now() - HOUR),
          to: new Date(),
          content: {
            done: [],
            stuck: [],
            waiting: [],
            spendUsd: '0.00',
          },
          createdAt: new Date(Date.now() + 1000),
        },
      });
      for (const session of [memberSession, adminSession]) {
        const response = await session.get(latestPath(projectId));
        expect(response.status).toBe(200);
        expect(response.body.trigger).toBe('away_off');
        expect(response.body.projectId).toBe(projectId);
      }
    });

    it("never shows project A's digest to project B's member (404, not 403)", async () => {
      await settings('00:00');
      await digests.runDaily(new Date());
      expect((await memberSession.get(latestPath(projectId))).status).toBe(200);
      expect((await outsiderSession.get(latestPath(projectId))).status).toBe(
        404,
      );
      // And B's member reading B, which has no digest, gets the same 404 body
      // as a project with none — A's existence is not distinguishable.
      expect(
        (await outsiderSession.get(latestPath(otherProjectId))).status,
      ).toBe(404);
    });

    it('is 401 without a session', async () => {
      expect((await ctx.http().get(latestPath(projectId))).status).toBe(401);
    });
  });

  describe('the prose (#491)', () => {
    let commands: StewardCommands;
    let served: boolean;
    let answer: () => unknown;

    const stewardRuns = () =>
      ctx.prisma.run.findMany({ where: { projectId, kind: 'steward' } });

    beforeEach(async () => {
      commands = ctx.app.get(StewardCommands);
      served = true;
      answer = () => ({
        status: 'ok',
        output: { prose: 'One card merged; C-2 is stuck on its tests.' },
        rttMs: 1,
      });
      jest.spyOn(commands, 'available').mockImplementation(async () => served);
      jest
        .spyOn(commands, 'send')
        .mockImplementation(async () => answer() as never);
      const profile = await ctx.prisma.runtimeProfile.create({
        data: {
          runnerId,
          key: 'claude-main',
          runtime: 'claude',
          label: 'Claude',
          env: {},
          args: [],
          authenticated: true,
        },
      });
      await ctx.prisma.project.update({
        where: { id: projectId },
        data: { defaultProfileId: profile.id },
      });
      await settings('00:00');
    });
    afterEach(() => jest.restoreAllMocks());

    it('with a runner online, haiku writes the stored prose on a steward run', async () => {
      const now = new Date();
      await card('Add login', {
        mergedAt: new Date(now.getTime() - HOUR),
        prUrl: 'https://github.com/acme/widget/pull/9',
      });
      const stuck = await card('Slow job', { round: { phase: 'running' } });
      await ctx.prisma.stewardIncident.create({
        data: {
          projectId,
          subjectKind: 'card_round',
          subjectId: stuck.round?.id ?? '',
          kind: 'api_error',
          reason: 'API Error: Connection lost',
          status: 'escalated',
        },
      });
      await spend('1.25', new Date(now.getTime() - HOUR));

      expect(await digests.runDaily(now)).toBe(1);

      const [row] = await rows();
      expect(row.prose).toBe('One card merged; C-2 is stuck on its tests.');
      const view = (await adminSession.get(latestPath(projectId)))
        .body as StewardDigestView;
      expect(view.prose).toBe(row.prose);
      expect(telegramText()).toContain(
        'One card merged; C\\-2 is stuck on its tests\\.',
      );

      expect(commands.available).toHaveBeenCalledWith(
        runnerId,
        'digest.compose',
      );
      const [call] = jest.mocked(commands.send).mock.calls;
      expect(call[0]).toBe(runnerId);
      expect(call[1]).toBe('digest.compose');
      // DA-12: the stored, bounded lines only — no url, no pane text.
      const args = digestComposeArgsSchema.parse(call[2]);
      expect(args).toMatchObject({
        projectId,
        model: 'haiku',
        profileKey: 'claude-main',
        trigger: 'daily',
        projectName: 'widget',
        spendUsd: '1.25',
        done: {
          total: 1,
          items: [{ label: 'C-1', title: 'Add login', reason: 'merged' }],
        },
        stuck: {
          total: 1,
          items: [
            {
              label: 'C-2',
              title: 'Slow job',
              reason: 'API Error: Connection lost',
            },
          ],
        },
        waiting: { total: 0, items: [] },
      });
      expect(JSON.stringify(call[3].auditArgs)).not.toContain('Add login');

      // D16: counted against the project budget as a `steward` run.
      const [run] = await stewardRuns();
      expect(run).toMatchObject({
        id: args.runId,
        status: 'succeeded',
        model: 'haiku',
        profileKey: 'claude-main',
      });
      expect(run.endedAt).not.toBeNull();
    });

    it('with the runner offline, the digest is the template and no run starts', async () => {
      served = false;
      expect(await digests.runDaily(new Date())).toBe(1);
      const [row] = await rows();
      expect(row.prose).toBeNull();
      expect(commands.send).not.toHaveBeenCalled();
      expect(await stewardRuns()).toHaveLength(0);
      expect(ctx.fake.sent()).toHaveLength(1);
    });

    it('a runner error or no answer keeps the template and fails the run', async () => {
      answer = () => ({
        status: 'error',
        error: { code: 'internal', message: 'haiku wrote no summary' },
      });
      expect(await digests.runDaily(new Date())).toBe(1);
      const [row] = await rows();
      expect(row.prose).toBeNull();
      const [run] = await stewardRuns();
      expect(run.status).toBe('failed');
      expect(run.outcome).toContain('haiku wrote no summary');
      expect(ctx.fake.sent()).toHaveLength(1);

      answer = () => ({ status: 'unknown' });
      const later = new Date(Date.now() + 25 * HOUR);
      expect(await digests.runDaily(later)).toBe(1);
      const [, second] = await rows();
      expect(second.prose).toBeNull();
    });

    it('asks nothing over the project budget', async () => {
      jest.spyOn(ctx.app.get(BudgetGate), 'check').mockResolvedValue({
        allowed: false,
        budgetId: 'b1',
        scope: 'project',
        resetsAt: new Date(),
      });
      expect(await digests.runDaily(new Date())).toBe(1);
      expect((await rows())[0].prose).toBeNull();
      expect(commands.send).not.toHaveBeenCalled();
    });

    it('stores an answer as one bounded line, whatever the runner sent (DA-13)', async () => {
      answer = () => ({
        status: 'ok',
        output: { prose: `first\nsecond\u001b[31m ${'x'.repeat(2000)}` },
        rttMs: 1,
      });
      await digests.runDaily(new Date());
      const prose = (await rows())[0].prose ?? '';
      expect(prose.startsWith('first second')).toBe(true);
      expect(Array.from(prose).some((c) => c.charCodeAt(0) < 32)).toBe(false);
      expect(Array.from(prose)).toHaveLength(600);
    });
  });

  describe('the worker', () => {
    it('runs a tick job and ignores any other', async () => {
      const worker = ctx.app.get(StewardDigestWorker);
      await settings('00:00');
      const pass = await worker.process({ name: 'tick' });
      expect(pass?.daily).toBe(1);
      expect(await worker.process({ name: 'other' })).toBeUndefined();
    });
  });
});
