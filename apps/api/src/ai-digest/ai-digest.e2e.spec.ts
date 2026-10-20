import { randomBytes } from 'node:crypto';
import type { AiDigestView } from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import { answer } from '../assistant/testing/scripted-answers';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { LLM_SECRETS_KEY_ENV } from '../llm/llm-secrets';
import { LLM_DEFAULT_MODEL_SETTING_KEY } from '../llm/llm-store';
import { requestOf } from '../llm/providers/testing';
import { type LlmMock, mockLlm } from '../llm/testing/llm-e2e';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { BOT_TOKEN } from '../telegram/testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from '../telegram/testing/telegram-e2e';
import { login, type Session } from '../test/e2e-app';
import { AiDigestService } from './ai-digest.service';
import { AI_DIGEST_TICK_JOB, AiDigestWorker } from './ai-digest-worker';

const MASTER_KEY = randomBytes(32).toString('base64');
/** Not a real key: every provider call goes to the mocked fetch. */
const ANTHROPIC_KEY = 'sk-ant-api03-e2e-digest-value-Qq9-1c4e';
const HAIKU = 'claude-haiku-5-5';
const HOUR = 3_600_000;
const OVERVIEW = 'C-1 merged; C-2 fails its checks and C-3 waits for you.';

const hhmm = (at: Date): string => at.toISOString().slice(11, 16);

describe('Daily AI digest (e2e, #658)', () => {
  let ctx: TelegramE2e;
  let llm: LlmMock;
  let digests: AiDigestService;
  let projectId: string;
  let adminId: string;
  let admin: Session;
  let member: Session;
  let outsider: Session;
  let cards = 0;
  /** A tick time two hours ahead, so a setting saved now is before its occurrence. */
  let at: Date;

  const settingsPath = (id = projectId) => `/projects/${id}/ai/digest/settings`;
  const latestPath = (id = projectId) => `/projects/${id}/ai/digest/latest`;

  const card = async (
    title: string,
    data: Partial<Prisma.BoardCardUncheckedCreateInput> = {},
  ) => {
    cards += 1;
    return ctx.prisma.boardCard.create({
      data: {
        projectId,
        number: cards,
        shortId: `card${String(cards).padStart(4, '0')}`,
        title,
        position: cards,
        issueOnRun: false,
        specOnRun: false,
        movedAt: new Date(),
        column: 'todo',
        ...data,
      },
    });
  };

  const waitingRound = async (cardId: string) => {
    const run = await ctx.prisma.run.create({
      data: {
        kind: 'card',
        projectId,
        status: 'running',
        triggeredByType: 'user',
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await ctx.prisma.boardCardRound.create({
      data: {
        cardId,
        round: 1,
        runId: run.id,
        trigger: 'run',
        cardTitle: 'Ask',
        cardBody: '',
        cardKind: 'feature',
        phase: 'waiting',
      },
    });
  };

  const enable = (time = hhmm(at), timezone = 'UTC') =>
    admin.send('patch', settingsPath(), { enabled: true, time, timezone });

  const events = (type: string) =>
    ctx.prisma.event.findMany({ where: { type }, orderBy: { id: 'asc' } });

  beforeAll(async () => {
    process.env[LLM_SECRETS_KEY_ENV] = MASTER_KEY;
    ctx = await createTelegramApp(undefined, undefined, {}, (builder) => {
      const mocked = mockLlm(builder);
      llm = mocked.mock;
      return mocked.builder;
    });
    digests = ctx.app.get(AiDigestService);
  });
  afterAll(async () => {
    await ctx.close();
    process.env[LLM_SECRETS_KEY_ENV] = '';
  });

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE price_versions, llm_calls, llm_provider_settings CASCADE',
    );
    ctx.fake.reset();
    cards = 0;
    at = new Date(Date.now() + 2 * HOUR);
    llm.clock.now = at;
    await ctx.prisma.priceVersion.create({
      data: {
        number: 1,
        source: 'admin',
        note: 'ai digest e2e',
        models: {
          create: [
            {
              modelName: HAIKU,
              matchPattern: `^${HAIKU}$`,
              priority: 0,
              tiers: [
                {
                  name: 'Standard',
                  isDefault: true,
                  conditions: [],
                  prices: { input: '0.000001', output: '0.000005' },
                },
              ] as unknown as Prisma.InputJsonValue,
            },
          ],
        },
      },
    });
    ({ projectId } = await seedRunnerProject(ctx.prisma));
    const other = await seedRunnerProject(ctx.prisma, {
      root: '/srv/dev/gadget',
      repo: 'acme/gadget',
      name: 'lab',
    });
    adminId = (await seedUser(ctx.prisma, 'ada@example.com', 'admin')).id;
    await seedUser(ctx.prisma, 'bob@example.com', 'operator', projectId);
    await seedUser(ctx.prisma, 'eve@example.com', 'operator', other.projectId);
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', adminId, { actor: SYSTEM_ACTOR });
    await ctx.prisma.telegramLink.create({
      data: { userId: adminId, chatId: 4242n },
    });
    admin = await login(ctx, 'ada@example.com');
    member = await login(ctx, 'bob@example.com');
    outsider = await login(ctx, 'eve@example.com');
    for (const [method, path, body] of [
      ['put', '/admin/llm/providers/anthropic/key', { key: ANTHROPIC_KEY }],
      ['patch', '/admin/llm/providers/anthropic', { models: [HAIKU] }],
      [
        'put',
        '/admin/llm/default-model',
        { provider: 'anthropic', model: HAIKU },
      ],
    ] as const) {
      expect((await admin.send(method, path, body)).status).toBe(200);
    }
    llm.providerFetch.mockReset();
    llm.providerFetch.mockImplementation(async () =>
      answer([{ text: [OVERVIEW] }], { input: 800, output: 40 }),
    );
  });

  describe('settings', () => {
    it('defaults to off at 09:00 UTC; a project admin changes it, audited', async () => {
      const initial = await member.get(settingsPath());
      expect(initial.status).toBe(200);
      expect(initial.body).toEqual({
        enabled: false,
        time: '09:00',
        timezone: 'UTC',
        updatedAt: null,
      });

      const saved = await admin.send('patch', settingsPath(), {
        enabled: true,
        time: '07:30',
        timezone: 'Europe/Kyiv',
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        enabled: true,
        time: '07:30',
        timezone: 'Europe/Kyiv',
      });
      const audit = await ctx.prisma.auditRecord.findFirst({
        where: { action: 'project.update', targetId: projectId },
        orderBy: { seq: 'desc' },
      });
      expect(audit?.after).toEqual({
        aiDigest: { enabled: true, time: '07:30', timezone: 'Europe/Kyiv' },
      });
    });

    it('refuses an operator, a bad time and an unknown timezone; hides the project from outsiders', async () => {
      expect(
        (await member.send('patch', settingsPath(), { enabled: true })).status,
      ).toBe(403);
      expect(
        (await admin.send('patch', settingsPath(), { time: '25:00' })).status,
      ).toBe(400);
      expect(
        (await admin.send('patch', settingsPath(), { timezone: 'Mars/Base' }))
          .status,
      ).toBe(400);
      expect((await outsider.get(settingsPath())).status).toBe(404);
      expect((await outsider.get(latestPath())).status).toBe(404);
    });
  });

  it('arrives at the configured time in Telegram and the web, separating done, stuck and waiting with links', async () => {
    const merged = await card('Add login', {
      column: 'completed',
      mergedAt: new Date(),
      prNumber: 9,
      prState: 'merged',
      prUrl: 'https://github.com/acme/widget/pull/9',
    });
    await card('Retry budget', {
      column: 'finished',
      prNumber: 10,
      prState: 'open',
      prUrl: 'https://github.com/acme/widget/pull/10',
      ciState: 'red',
    });
    const asking = await card('Capsule tab bar', { column: 'in_progress' });
    await waitingRound(asking.id);
    await card('Export usage', { column: 'inbox' });
    expect((await enable()).status).toBe(200);
    expect((await member.get(latestPath())).status).toBe(404);

    // A minute before its time: nothing.
    expect(await digests.tick(new Date(at.getTime() - 60_000))).toEqual({
      sent: 0,
      skipped: 0,
    });
    expect(ctx.fake.sent()).toHaveLength(0);

    expect(await digests.tick(at)).toEqual({ sent: 1, skipped: 0 });

    const latest = await member.get(latestPath());
    expect(latest.status).toBe(200);
    const view = latest.body as AiDigestView;
    expect(view.overview).toBe(OVERVIEW);
    expect(view.model).toBe(HAIKU);
    expect(view.done).toEqual([
      {
        label: `C-${merged.number}`,
        title: 'Add login',
        reason: 'PR merged',
        url: 'https://github.com/acme/widget/pull/9',
      },
    ]);
    expect(view.stuck).toEqual([
      {
        label: 'C-2',
        title: 'Retry budget',
        reason: 'checks failing on PR #10',
        url: 'https://github.com/acme/widget/pull/10',
      },
    ]);
    expect(view.waiting.map((i) => [i.label, i.reason, i.url])).toEqual([
      [
        'C-2',
        'PR #10 ready for review',
        'https://github.com/acme/widget/pull/10',
      ],
      [
        'C-3',
        'the agent asks you',
        `https://dock.example.com/projects/${projectId}/board?card=3`,
      ],
      [
        'C-4',
        'new card to triage',
        `https://dock.example.com/projects/${projectId}/board?card=4`,
      ],
    ]);

    // Telegram: one message to the linked admin, with the sections and links.
    const sent = ctx.fake.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(4242);
    const text = sent[0].body.text as string;
    expect(text).toContain('*Daily digest — ');
    expect(text).toContain('*Done \\(1\\)*');
    expect(text).toContain('*Stuck \\(1\\)*');
    expect(text).toContain('*Waiting for you \\(3\\)*');
    expect(text).toContain('(https://github.com/acme/widget/pull/9)');
    expect(text).toContain(
      `(https://dock.example.com/projects/${projectId}/activity)`,
    );

    // The model got the facts as JSON, without the links; one `digest` row.
    const { body } = await requestOf(
      ...(llm.providerFetch.mock.calls[0] as [unknown, RequestInit]),
    );
    expect(String(body?.system)).toContain('daily digest');
    const calls = await ctx.prisma.llmCall.findMany();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      feature: 'digest',
      model: HAIKU,
      outcome: 'ok',
      userId: null,
    });

    // The web activity view: an `ai_digest.sent` event, projected to an item.
    const recorded = await events('ai_digest.sent');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      source: 'api',
      data: { done: 1, stuck: 1, waiting: 3, delivered: 1 },
    });

    // A repeated tick that day makes nothing.
    expect(await digests.tick(new Date(at.getTime() + 5 * 60_000))).toEqual({
      sent: 0,
      skipped: 0,
    });
    expect(ctx.fake.sent()).toHaveLength(1);
    expect(await ctx.prisma.llmCall.count()).toBe(1);
  });

  it('reads the time in the project’s timezone', async () => {
    // The same instant, written as Kyiv's wall clock.
    const kyiv = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    expect((await enable(kyiv, 'Europe/Kyiv')).status).toBe(200);
    expect(await digests.tick(new Date(at.getTime() - 60_000))).toEqual({
      sent: 0,
      skipped: 0,
    });
    expect(await digests.tick(at)).toEqual({ sent: 1, skipped: 0 });
  });

  it('sends nothing while disabled', async () => {
    await admin.send('patch', settingsPath(), {
      enabled: false,
      time: hhmm(at),
    });
    expect(await digests.tick(at)).toEqual({ sent: 0, skipped: 0 });
    expect(ctx.fake.sent()).toHaveLength(0);
    expect(llm.providerFetch).not.toHaveBeenCalled();
    expect(await ctx.prisma.aiDigest.count()).toBe(0);
  });

  it('starts the day after when it is enabled after today’s time', async () => {
    const earlier = new Date(Date.now() - HOUR);
    expect((await enable(hhmm(earlier))).status).toBe(200);
    // Today's occurrence was before the setting: nothing until tomorrow.
    expect(await digests.tick(new Date())).toEqual({ sent: 0, skipped: 0 });
    expect(
      await digests.tick(new Date(earlier.getTime() + 24 * HOUR + 60_000)),
    ).toEqual({ sent: 1, skipped: 0 });
  });

  it('is skipped with an event when the provider’s cap is reached', async () => {
    expect(
      (
        await admin.send('patch', '/admin/llm/providers/anthropic', {
          capUsd: 5,
        })
      ).status,
    ).toBe(200);
    await ctx.prisma.llmCall.create({
      data: {
        ts: at,
        userId: adminId,
        provider: 'anthropic',
        model: HAIKU,
        feature: 'assistant',
        outcome: 'ok',
        costUsd: '5.00',
        priceVersion: 1,
        durationMs: 1,
      },
    });
    expect((await enable()).status).toBe(200);

    expect(await digests.tick(at)).toEqual({ sent: 0, skipped: 1 });
    expect(ctx.fake.sent()).toHaveLength(0);
    expect(llm.providerFetch).not.toHaveBeenCalled();
    expect(await ctx.prisma.llmCall.count()).toBe(1);
    expect((await member.get(latestPath())).status).toBe(404);
    const skipped = await events('ai_digest.skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].data).toMatchObject({ reason: 'llm_cap_reached' });
    expect(
      await ctx.prisma.aiDigest.findFirst({ where: { projectId } }),
    ).toMatchObject({ status: 'skipped', skipReason: 'llm_cap_reached' });

    // Skipped once: a later tick that day does not try again.
    expect(await digests.tick(new Date(at.getTime() + 60_000))).toEqual({
      sent: 0,
      skipped: 0,
    });
  });

  it('is skipped with an event when no default model is set', async () => {
    await ctx.prisma.setting.deleteMany({
      where: { key: LLM_DEFAULT_MODEL_SETTING_KEY },
    });
    expect((await enable()).status).toBe(200);
    expect(await digests.tick(at)).toEqual({ sent: 0, skipped: 1 });
    expect((await events('ai_digest.skipped'))[0].data).toMatchObject({
      reason: 'no_model',
    });
  });

  it('ticks through the worker job, and ignores any other', async () => {
    expect((await enable()).status).toBe(200);
    const worker = ctx.app.get(AiDigestWorker);
    // The real clock: two hours before the occurrence.
    expect(await worker.process({ name: AI_DIGEST_TICK_JOB })).toEqual({
      sent: 0,
      skipped: 0,
    });
    expect(await worker.process({ name: 'unknown' })).toBeUndefined();
  });
});
