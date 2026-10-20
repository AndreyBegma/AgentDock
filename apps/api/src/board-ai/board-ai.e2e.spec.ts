import { randomBytes, randomUUID } from 'node:crypto';
import type {
  BoardAskResponse,
  BoardTriageCounts,
  CardTriageView,
} from '@agentdock/shared';
import type { Prisma } from '@prisma/client';
import { answer, english, OPUS } from '../assistant/testing/scripted-answers';
import { LLM_SECRETS_KEY_ENV } from '../llm/llm-secrets';
import { requestOf } from '../llm/providers/testing';
import { createLlmE2eApp, type LlmE2eContext } from '../llm/testing/llm-e2e';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { BoardTriage } from './board-triage.service';

const MASTER_KEY = randomBytes(32).toString('base64');
/** Not a real key: every provider call goes to the mocked fetch. */
const ANTHROPIC_KEY = 'sk-ant-api03-e2e-board-ai-value-Zz8-7d2f';

interface ProviderCall {
  system: string;
  body: Record<string, unknown>;
}

const json = (value: object) => answer([{ text: [JSON.stringify(value)] }]);

describe('Ask the Board and triage hints (e2e)', () => {
  let ctx: LlmE2eContext;
  let admin: Session;
  let alice: Session;
  let viewer: Session;
  let aliceId: string;
  let runnerId: string;
  let dock: string;
  let secret: string;
  /** Answers of the search and chat model, in order. */
  let script: Response[];
  /** Answers of triage calls, in order: they run beside other calls. */
  let triage: Response[];
  let calls: ProviderCall[];

  beforeAll(async () => {
    process.env[LLM_SECRETS_KEY_ENV] = MASTER_KEY;
    ctx = await createLlmE2eApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    process.env[LLM_SECRETS_KEY_ENV] = '';
  });

  const project = async (displayName: string, repo: string) =>
    (
      await ctx.prisma.project.create({
        data: {
          runnerId,
          rootPath: `/srv/dev/${displayName}`,
          repo,
          displayName,
          baseBranch: 'develop',
          baseSource: 'config',
          hasClaudeMd: true,
          hasAgentsMd: false,
          lastInspectedAt: new Date('2026-10-01T00:00:00Z'),
        },
      })
    ).id;

  let shortIds = 0;
  const card = (
    projectId: string,
    number: number,
    title: string,
    extra: Partial<Prisma.BoardCardUncheckedCreateInput> = {},
  ) =>
    ctx.prisma.boardCard.create({
      data: {
        projectId,
        number,
        shortId: `card${String(++shortIds).padStart(4, '0')}`,
        title,
        column: 'todo',
        position: number,
        issueOnRun: false,
        specOnRun: false,
        movedAt: new Date(),
        ...extra,
      },
    });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE price_versions, llm_calls, llm_provider_settings, runners, projects CASCADE',
    );
    await ctx.prisma.priceVersion.create({
      data: {
        number: 1,
        source: 'admin',
        note: 'board ai e2e',
        models: {
          create: [
            {
              modelName: OPUS,
              matchPattern: `^${OPUS}$`,
              priority: 0,
              tiers: [
                {
                  name: 'Standard',
                  isDefault: true,
                  conditions: [],
                  prices: { input: '0.000005', output: '0.000025' },
                },
              ] as unknown as Prisma.InputJsonValue,
            },
          ],
        },
      },
    });
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    aliceId = (await createUser(ctx.prisma, 'alice@example.com', 'operator'))
      .id;
    const viewerId = (
      await createUser(ctx.prisma, 'vera@example.com', 'viewer')
    ).id;
    admin = await login(ctx, 'admin@example.com');
    alice = await login(ctx, 'alice@example.com');
    viewer = await login(ctx, 'vera@example.com');
    runnerId = (await ctx.prisma.runner.create({ data: { name: 'desk' } })).id;
    dock = await project('Nautelle', 'acme/agentdock');
    secret = await project('Secret Garden', 'acme/secret-garden');
    for (const userId of [aliceId, viewerId]) {
      await ctx.prisma.projectMember.create({
        data: { projectId: dock, userId },
      });
    }

    expect(
      (
        await admin.send('put', '/admin/llm/providers/anthropic/key', {
          key: ANTHROPIC_KEY,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.send('patch', '/admin/llm/providers/anthropic', {
          models: [OPUS],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.send('put', '/admin/llm/default-model', {
          provider: 'anthropic',
          model: OPUS,
        })
      ).status,
    ).toBe(200);

    script = [];
    triage = [];
    calls = [];
    ctx.clock.now = null;
    ctx.providerFetch.mockReset();
    ctx.providerFetch.mockImplementation(async (input, init) => {
      const { body } = await requestOf(input, init);
      const system = String(body?.system ?? '');
      calls.push({ system, body: body ?? {} });
      const next = (system.startsWith('You triage') ? triage : script).shift();
      if (!next) throw new Error('no scripted answer left');
      return next;
    });
  });

  /** This month's Anthropic spend at its $200 cap. */
  const reachCap = () =>
    ctx.prisma.llmCall.create({
      data: {
        provider: 'anthropic',
        model: OPUS,
        feature: 'assistant',
        outcome: 'ok',
        costUsd: 200,
        priceVersion: 1,
        durationMs: 1,
      },
    });

  describe('Ask the Board', () => {
    beforeEach(async () => {
      await card(dock, 12, 'Digest arrives twice on Mondays', {
        column: 'finished',
        prNumber: 34,
        prUrl: 'https://github.com/acme/agentdock/pull/34',
        prState: 'open',
        ciState: 'red',
      });
      await card(dock, 13, 'Export usage as CSV');
      await card(secret, 1, 'Digest of the secret roadmap', {
        column: 'finished',
        prNumber: 7,
        prUrl: 'https://github.com/acme/secret-garden/pull/7',
        prState: 'open',
        ciState: 'red',
      });
    });

    it('returns linked cards and PRs from accessible projects only', async () => {
      script.push(
        json({
          language: 'en',
          projects: [],
          text: ['digest'],
          columns: [],
          kind: null,
          prState: null,
          checks: 'failed',
          withinDays: null,
          sources: ['cards', 'prs'],
        }),
        answer([{ text: ['[C-12] has failed checks on [PR #34].'] }]),
      );
      const res = await alice.send('post', '/board/ask', {
        question: 'Which digest cards have failed checks?',
      });
      expect(res.status).toBe(200);
      const body = res.body as BoardAskResponse;
      expect(body.answer).toBe('[C-12] has failed checks on [PR #34].');
      expect(body.query.checks).toBe('failed');
      expect(body.hits).toEqual([
        expect.objectContaining({
          type: 'card',
          projectId: dock,
          number: 12,
          label: 'C-12',
          prNumber: 34,
          prUrl: 'https://github.com/acme/agentdock/pull/34',
        }),
      ]);
      // The query model is shown only the person's projects; the answer
      // model only what was found.
      expect(calls[0].system).toContain('Nautelle (acme/agentdock)');
      expect(calls[0].system).not.toContain('Secret Garden');
      expect(calls[1].system).toContain('[C-12] Digest arrives twice');
      expect(calls[1].system).not.toContain('secret roadmap');

      const rows = await ctx.prisma.llmCall.findMany();
      expect(rows.map((r) => [r.feature, r.userId])).toEqual([
        ['search', aliceId],
        ['search', aliceId],
      ]);
    });

    it('never reaches a project the person cannot access, even by name', async () => {
      script.push(
        json({ language: 'en', projects: ['Secret Garden'], text: ['digest'] }),
        answer([{ text: ['Nothing matched.'] }]),
      );
      const res = await alice.send('post', '/board/ask', {
        question: 'Digest cards in Secret Garden',
      });
      expect(res.status).toBe(200);
      expect((res.body as BoardAskResponse).hits).toEqual([]);
    });

    it('answers a Russian question in Russian', async () => {
      script.push(
        json({ language: 'ru', projects: [], text: ['digest'] }),
        answer([{ text: ['Нашлась одна карточка: [C-12].'] }]),
      );
      const res = await alice.send('post', '/board/ask', {
        question: 'Какие карточки про дайджест?',
      });
      expect(res.status).toBe(200);
      const body = res.body as BoardAskResponse;
      expect(body.language).toBe('ru');
      expect(body.answer).toBe('Нашлась одна карточка: [C-12].');
      expect(calls[1].system).toContain('code ru');
      expect(calls[1].body.messages).toEqual([
        { role: 'user', content: 'Какие карточки про дайджест?' },
      ]);
    });

    it('shows the cap message when the cap is reached', async () => {
      await reachCap();
      const res = await alice.send('post', '/board/ask', {
        question: 'Which cards failed?',
      });
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({
        error: 'llm_cap_reached',
        provider: 'anthropic',
        resetsAt: expect.any(String),
      });
      expect(calls).toHaveLength(0);
    });

    it('runs a query again without a model call, still over accessible projects', async () => {
      const query = {
        projects: [],
        text: ['digest'],
        columns: [],
        kind: null,
        prState: null,
        checks: null,
        withinDays: null,
        sources: ['cards'],
      };
      const res = await alice.send('post', '/board/search', { query });
      expect(res.status).toBe(200);
      expect(
        (
          res.body as { hits: { number: number; projectId: string }[] }
        ).hits.map((h) => [h.projectId, h.number]),
      ).toEqual([[dock, 12]]);
      expect(calls).toHaveLength(0);
      expect(
        (
          await alice.send('post', '/board/search', {
            query: { ...query, columns: ['review'] },
          })
        ).status,
      ).toBe(400);
    });

    it('refuses an empty question', async () => {
      const res = await alice.send('post', '/board/ask', { question: '  ' });
      expect(res.status).toBe(400);
    });
  });

  describe('triage hints', () => {
    /** A New work intake with one pending candidate, accepted by Alice. */
    const acceptCandidate = async (title: string, kind: 'bug' | 'feature') => {
      const instructions =
        (await ctx.prisma.plannerInstructions.findFirst()) ??
        (await ctx.prisma.plannerInstructions.create({
          data: { projectId: null, version: 1, body: 'INSTRUCTIONS' },
        }));
      const plan = await ctx.prisma.plan.create({
        data: {
          projectId: dock,
          authorId: aliceId,
          title,
          contractVersion: 3,
          brief: title,
          mode: 'card',
          status: 'reviewing',
          sessionId: randomUUID(),
          instructionsId: instructions.id,
          profileKey: 'claude-main',
          model: 'opus',
        },
      });
      const candidate = await ctx.prisma.planCandidate.create({
        data: { planId: plan.id, position: 0, title, kind, body: '' },
      });
      const res = await alice.send(
        'post',
        `/projects/${dock}/candidates/accept`,
        {
          as: 'cards',
          candidates: [{ id: candidate.id, version: candidate.version }],
        },
      );
      expect(res.status).toBe(200);
      await ctx.app.get(BoardTriage).settled();
      return (res.body as { cards: { number: number }[] }).cards[0].number;
    };

    const triageOf = async (number: number, who: Session = alice) =>
      (await who.get(`/projects/${dock}/board/cards/${number}/triage`))
        .body as CardTriageView;

    beforeEach(async () => {
      await card(dock, 12, 'Digest arrives twice on Mondays');
      await card(dock, 13, 'Export usage as CSV');
      await card(dock, 14, 'Digest is sent twice', { column: 'completed' });
    });

    it('shows a duplicate of an open card, and a kind and a priority to accept', async () => {
      triage.push(
        json({
          duplicates: [
            { number: 12, reason: 'Same double digest' },
            { number: 14, reason: 'Accepted already' },
          ],
          kind: { value: 'bug', reason: 'It used to arrive once' },
          priority: { value: 'low', reason: 'Only a duplicate message' },
        }),
      );
      const number = await acceptCandidate(
        'Daily digest arrives twice on Monday',
        'feature',
      );

      // The model saw the open cards only, the most alike first.
      expect(calls).toHaveLength(1);
      expect(calls[0].system).toContain('C-12 (todo): Digest arrives twice');
      expect(calls[0].system).not.toContain('C-14');
      const row = await ctx.prisma.llmCall.findFirstOrThrow();
      expect([row.feature, row.userId]).toEqual(['triage', aliceId]);

      const view = await triageOf(number, viewer);
      expect(view).toEqual({
        state: 'ready',
        duplicates: [
          {
            number: 12,
            label: 'C-12',
            title: 'Digest arrives twice on Mondays',
            column: 'todo',
            reason: 'Same double digest',
          },
        ],
        kind: { value: 'bug', reason: 'It used to arrive once' },
        priority: { value: 'low', reason: 'Only a duplicate message' },
      });
      const counts = (await alice.get(`/projects/${dock}/board/triage`))
        .body as BoardTriageCounts;
      expect(counts).toEqual({ cards: [{ number, hints: 3 }] });

      // Nothing applied on its own.
      const made = await ctx.prisma.boardCard.findFirstOrThrow({
        where: { projectId: dock, number },
      });
      expect(made.kind).toBe('feature');
    });

    it('dismisses hints and applies only what the person accepts', async () => {
      triage.push(
        json({
          duplicates: [],
          kind: { value: 'bug', reason: 'Broken' },
          priority: { value: 'low', reason: 'Polish' },
        }),
      );
      const number = await acceptCandidate('Digest typo', 'feature');
      const path = `/projects/${dock}/board/cards/${number}/triage`;

      // A viewer reads hints but neither dismisses nor applies them.
      expect(
        (await viewer.send('post', `${path}/dismiss`, { hint: 'kind' })).status,
      ).toBe(403);

      let res = await alice.send('post', `${path}/dismiss`, { hint: 'kind' });
      expect(res.status).toBe(200);
      expect((res.body as CardTriageView).kind).toBeNull();
      expect(
        (await alice.send('post', `${path}/apply`, { hint: 'kind' })).status,
      ).toBe(409);
      let made = await ctx.prisma.boardCard.findFirstOrThrow({
        where: { projectId: dock, number },
      });
      expect(made.kind).toBe('feature');

      // Low priority: the bottom of To Do.
      res = await alice.send('post', `${path}/apply`, { hint: 'priority' });
      expect(res.status).toBe(200);
      expect((res.body as CardTriageView).priority).toBeNull();
      const todo = await ctx.prisma.boardCard.findMany({
        where: { projectId: dock, column: 'todo' },
        orderBy: { position: 'asc' },
      });
      expect(todo.at(-1)?.number).toBe(number);
      made = await ctx.prisma.boardCard.findFirstOrThrow({
        where: { projectId: dock, number },
      });
      expect(made.kind).toBe('feature');
      expect((await alice.get(`/projects/${dock}/board/triage`)).body).toEqual({
        cards: [],
      });
    });

    it('applies a kind as an edit of the card', async () => {
      triage.push(
        json({ kind: { value: 'bug', reason: 'Broken' }, duplicates: [] }),
      );
      const number = await acceptCandidate('Digest crashes', 'feature');
      const res = await alice.send(
        'post',
        `/projects/${dock}/board/cards/${number}/triage/apply`,
        { hint: 'kind' },
      );
      expect(res.status).toBe(200);
      const made = await ctx.prisma.boardCard.findFirstOrThrow({
        where: { projectId: dock, number },
      });
      expect([made.kind, made.kindSource]).toEqual(['bug', 'person']);
    });

    it('leaves the model recommendation alone (ADR-0032)', async () => {
      triage.push(
        json({ kind: { value: 'bug', reason: 'Broken' }, duplicates: [] }),
      );
      const number = await acceptCandidate('Digest crashes', 'feature');
      await alice.send(
        'post',
        `/projects/${dock}/board/cards/${number}/triage/apply`,
        { hint: 'kind' },
      );
      const made = await ctx.prisma.boardCard.findFirstOrThrow({
        where: { projectId: dock, number },
      });
      expect(made).toMatchObject({
        model: null,
        recommendedModel: null,
        recommendedReason: null,
        assessmentHash: null,
      });
      expect(calls[0].system).not.toMatch(/opus|sonnet|haiku/i);
    });

    it('hides hints while the cap is reached', async () => {
      triage.push(
        json({ kind: { value: 'bug', reason: 'Broken' }, duplicates: [] }),
      );
      const number = await acceptCandidate('Digest crashes', 'feature');
      expect((await triageOf(number)).state).toBe('ready');

      await reachCap();
      expect(await triageOf(number)).toEqual({
        state: 'hidden',
        duplicates: null,
        kind: null,
        priority: null,
      });
      expect((await alice.get(`/projects/${dock}/board/triage`)).body).toEqual({
        cards: [],
      });

      // A card made at the cap gets no triage call and no hints.
      const capped = await acceptCandidate('Export fails', 'feature');
      expect(calls).toHaveLength(1);
      expect((await triageOf(capped)).state).toBe('hidden');
    });

    it('triages a card the assistant queues', async () => {
      triage.push(
        json({
          duplicates: [{ number: 12, reason: 'Same digest' }],
          kind: null,
          priority: null,
        }),
      );
      const conversation = (
        await alice.send('post', '/assistant/conversations', {
          projectId: dock,
        })
      ).body as { id: string };
      const draft = {
        title: 'Digest twice on Monday',
        body: 'Seen this week',
        kind: 'bug',
      };
      script.push(
        answer([{ tool: { id: 'toolu_1', name: 'queue_card', input: draft } }]),
        answer([{ text: english('Queued as C-15.', 'Queue it.') }]),
        // The conversation's title.
        answer([{ text: ['Digest card'] }]),
      );
      const res = await alice
        .send('post', `/assistant/conversations/${conversation.id}/stream`, {
          message: 'Queue it.',
        })
        .buffer(true)
        .parse((r, done) => {
          let text = '';
          r.setEncoding('utf8');
          r.on('data', (chunk: string) => {
            text += chunk;
          });
          r.on('end', () => done(null, text));
        });
      expect(res.status).toBe(200);
      await ctx.app.get(BoardTriage).settled();
      const queued = await ctx.prisma.boardCard.findFirstOrThrow({
        where: { projectId: dock, title: draft.title },
      });
      const view = await triageOf(queued.number);
      expect(view.duplicates?.map((d) => d.number)).toEqual([12]);
      expect(view.kind).toBeNull();
    });

    it('is 404 for a project the person cannot see', async () => {
      const res = await alice.get(`/projects/${secret}/board/triage`);
      expect(res.status).toBe(404);
    });
  });
});
