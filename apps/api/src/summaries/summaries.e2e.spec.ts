import { randomBytes } from 'node:crypto';
import type { AiSummaryView } from '@agentdock/shared';
import { answer } from '../assistant/testing/scripted-answers';
import { LLM_SECRETS_KEY_ENV } from '../llm/llm-secrets';
import { LLM_DEFAULT_MODEL_SETTING_KEY } from '../llm/llm-store';
import { requestOf } from '../llm/providers/testing';
import {
  createLlmE2eApp,
  type LlmE2eContext,
  seedLlmPrices,
} from '../llm/testing/llm-e2e';
import {
  resetNotifications,
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { login, type Session } from '../test/e2e-app';

const MASTER_KEY = randomBytes(32).toString('base64');
/** Not a real key: every provider call goes to the mocked fetch. */
const ANTHROPIC_KEY = 'sk-ant-api03-e2e-summary-value-Ww3-9f0a';
const HAIKU = 'claude-haiku-5-5';

describe('Card and session summaries (e2e, #658)', () => {
  let ctx: LlmE2eContext;
  let projectId: string;
  let runnerId: string;
  let adminId: string;
  let viewerId: string;
  let admin: Session;
  let viewer: Session;
  let outsider: Session;
  let cardId: string;
  /** The system prompt and user text of every provider call, in order. */
  let calls: { system: string; text: string }[];

  const cardPath = (number = 1) =>
    `/projects/${projectId}/board/cards/${number}/summary`;
  const sessionPath = (id: string) =>
    `/projects/${projectId}/sessions/${id}/summary`;

  const seedSession = (shipContent: boolean) =>
    ctx.prisma.agentSession
      .create({
        data: {
          runnerId,
          runtime: 'claude',
          externalId: `ext-${Math.random()}`,
          cwd: '/srv/dev/widget',
          projectId,
          title: 'Fix the flaky drag test',
          startedAt: new Date('2026-10-19T08:00:00Z'),
          lastEventAt: new Date('2026-10-19T09:00:00Z'),
        },
      })
      .then(async (session) => {
        await ctx.prisma.project.update({
          where: { id: projectId },
          data: { shipSessionContent: shipContent },
        });
        return session;
      });

  const content = (
    sessionId: string,
    kind: 'prompt' | 'response',
    text: string,
  ) =>
    ctx.prisma.sessionContent.create({
      data: { sessionId, projectId, kind, at: new Date(), text },
    });

  beforeAll(async () => {
    process.env[LLM_SECRETS_KEY_ENV] = MASTER_KEY;
    ctx = await createLlmE2eApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    process.env[LLM_SECRETS_KEY_ENV] = '';
  });

  beforeEach(async () => {
    await resetNotifications(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE price_versions, llm_calls, llm_provider_settings CASCADE',
    );
    await seedLlmPrices(ctx.prisma, [HAIKU]);
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    const other = await seedRunnerProject(ctx.prisma, {
      root: '/srv/dev/gadget',
      repo: 'acme/gadget',
      name: 'lab',
    });
    adminId = (await seedUser(ctx.prisma, 'ada@example.com', 'admin')).id;
    viewerId = (
      await seedUser(ctx.prisma, 'vic@example.com', 'viewer', projectId)
    ).id;
    await seedUser(ctx.prisma, 'eve@example.com', 'operator', other.projectId);
    admin = await login(ctx, 'ada@example.com');
    viewer = await login(ctx, 'vic@example.com');
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
    cardId = (
      await ctx.prisma.boardCard.create({
        data: {
          projectId,
          number: 1,
          shortId: 'card0001',
          title: 'Capsule replaces the tab bar',
          body: 'Replace the phone tab bar with a floating capsule.',
          position: 1,
          issueOnRun: false,
          specOnRun: false,
          movedAt: new Date(),
          column: 'finished',
          branch: 'feat/521-capsule',
          prNumber: 536,
          prUrl: 'https://github.com/acme/widget/pull/536',
          prState: 'open',
          ciState: 'red',
          ciChecks: [{ name: 'e2e', link: null }],
        },
      })
    ).id;
    calls = [];
    ctx.clock.now = null;
    ctx.providerFetch.mockReset();
    ctx.providerFetch.mockImplementation(async (input, init) => {
      const { body } = await requestOf(input, init);
      const messages = (body?.messages ?? []) as {
        content: string | { text: string }[];
      }[];
      const first = messages[0]?.content;
      calls.push({
        system: String(body?.system ?? ''),
        text: typeof first === 'string' ? first : (first?.[0]?.text ?? ''),
      });
      return answer([{ text: ['Готово к слиянию, ', 'кроме e2e.'] }], {
        input: 1_000,
        output: 50,
      });
    });
  });

  describe('a card', () => {
    it('summarizes the card and its PR in the reader’s language, as a `summary` call', async () => {
      const response = await viewer.send('post', cardPath(), {
        language: 'ru',
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        subject: 'card',
        subjectId: cardId,
        language: 'ru',
        text: 'Готово к слиянию, кроме e2e.',
        provider: 'anthropic',
        model: HAIKU,
        cached: false,
      } satisfies Partial<AiSummaryView>);
      expect(Number((response.body as AiSummaryView).costUsd)).toBeGreaterThan(
        0,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].system).toContain('BCP 47 code is "ru"');
      expect(calls[0].text).toContain('Card C-1 (feature): Capsule replaces');
      expect(calls[0].text).toContain(
        'Pull request: #536 https://github.com/acme/widget/pull/536',
      );
      expect(calls[0].text).toContain('CI: failing: e2e');
      expect(calls[0].text).toContain(
        'Review state: waiting for a person to review and accept it',
      );
      const rows = await ctx.prisma.llmCall.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        feature: 'summary',
        userId: viewerId,
        outcome: 'ok',
      });
    });

    it('serves a repeat with no changes from the cache, with no new usage row', async () => {
      expect(
        (await admin.send('post', cardPath(), { language: 'en' })).status,
      ).toBe(200);
      const again = await admin.send('post', cardPath(), { language: 'en' });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ cached: true, language: 'en' });
      expect(calls).toHaveLength(1);
      expect(await ctx.prisma.llmCall.count()).toBe(1);
    });

    it('makes it again when the source changes, in another language, or on Regenerate', async () => {
      await admin.send('post', cardPath(), { language: 'en' });

      await ctx.prisma.boardCard.update({
        where: { id: cardId },
        data: { ciState: 'green', ciChecks: [] },
      });
      const changed = await admin.send('post', cardPath(), { language: 'en' });
      expect(changed.body).toMatchObject({ cached: false });
      expect(calls[1].text).toContain('CI: all checks passed');

      const other = await admin.send('post', cardPath(), { language: 'uk' });
      expect(other.body).toMatchObject({ cached: false, language: 'uk' });

      const regenerated = await admin.send('post', cardPath(), {
        language: 'en',
        regenerate: true,
      });
      expect(regenerated.body).toMatchObject({ cached: false });
      expect(calls).toHaveLength(4);
      expect(await ctx.prisma.llmCall.count()).toBe(4);
      expect(await ctx.prisma.aiSummary.count()).toBe(2);
    });

    it('answers the cap message when the provider’s cap is reached', async () => {
      expect(
        (
          await admin.send('patch', '/admin/llm/providers/anthropic', {
            capUsd: 5,
          })
        ).status,
      ).toBe(200);
      await ctx.prisma.llmCall.create({
        data: {
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
      const refused = await admin.send('post', cardPath(), { language: 'en' });
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({
        error: 'llm_cap_reached',
        provider: 'anthropic',
      });
      expect(refused.body.message).toContain('reached its $5.00 monthly cap');
      expect(calls).toHaveLength(0);
      expect(await ctx.prisma.aiSummary.count()).toBe(0);
    });

    it('says when no default model is set', async () => {
      await ctx.prisma.setting.deleteMany({
        where: { key: LLM_DEFAULT_MODEL_SETTING_KEY },
      });
      const refused = await admin.send('post', cardPath(), { language: 'en' });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: 'summary_no_model' });
    });

    it('refuses a bad language, an unknown card and another project’s outsider', async () => {
      expect(
        (await admin.send('post', cardPath(), { language: 'English' })).status,
      ).toBe(400);
      expect(
        (await admin.send('post', cardPath(7), { language: 'en' })).status,
      ).toBe(404);
      expect(
        (await outsider.send('post', cardPath(), { language: 'en' })).status,
      ).toBe(404);
      expect(calls).toHaveLength(0);
    });
  });

  describe('a session', () => {
    it('is refused without session content: the project does not ship it, or the session has none', async () => {
      const off = await seedSession(false);
      await content(off.id, 'prompt', 'Fix the drag test');
      const refused = await admin.send('post', sessionPath(off.id), {
        language: 'en',
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({
        error: 'summary_no_session_content',
      });

      const empty = await seedSession(true);
      expect(
        (await admin.send('post', sessionPath(empty.id), { language: 'en' }))
          .status,
      ).toBe(409);
      expect(calls).toHaveLength(0);
    });

    it('summarizes the stored transcript of an opted-in project, cached until it grows', async () => {
      const session = await seedSession(true);
      await content(
        session.id,
        'prompt',
        'Fix the flaky drag test in board.spec.ts',
      );
      await content(session.id, 'response', 'The timeout comes from develop.');

      const first = await viewer.send('post', sessionPath(session.id), {
        language: 'en',
      });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        subject: 'session',
        subjectId: session.id,
        cached: false,
      });
      expect(calls[0].text).toContain(
        '[person] Fix the flaky drag test in board.spec.ts',
      );
      expect(calls[0].text).toContain(
        '[agent] The timeout comes from develop.',
      );
      expect(calls[0].system).toContain('AI coding agent session');

      const again = await viewer.send('post', sessionPath(session.id), {
        language: 'en',
      });
      expect(again.body).toMatchObject({ cached: true });

      await content(session.id, 'response', 'Skipped the test; PR updated.');
      const grown = await viewer.send('post', sessionPath(session.id), {
        language: 'en',
      });
      expect(grown.body).toMatchObject({ cached: false });
      expect(calls).toHaveLength(2);
      expect(
        await ctx.prisma.llmCall.count({ where: { feature: 'summary' } }),
      ).toBe(2);
    });

    it('is 404 for a session of another project', async () => {
      const other = await ctx.prisma.agentSession.create({
        data: {
          runnerId,
          runtime: 'claude',
          externalId: 'ext-other',
          cwd: '/srv/dev/gadget',
          projectId: null,
          startedAt: new Date(),
          lastEventAt: new Date(),
        },
      });
      expect(
        (await admin.send('post', sessionPath(other.id), { language: 'en' }))
          .status,
      ).toBe(404);
    });
  });
});
