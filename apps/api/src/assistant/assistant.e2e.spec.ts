import { randomBytes } from 'node:crypto';
import type {
  AssistantConversationView,
  AssistantMessageView,
  AssistantStreamEvent,
} from '@nautelle/shared';
import type { Prisma } from '@prisma/client';
import type request from 'supertest';
import { ControlService } from '../control/control.service';
import { LLM_SECRETS_KEY_ENV } from '../llm/llm-secrets';
import { requestOf } from '../llm/providers/testing';
import { createLlmE2eApp, type LlmE2eContext } from '../llm/testing/llm-e2e';
import { RunnerCommandService } from '../runners/runner-command.service';
import { RunnerPresence } from '../runners/runner-presence';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { answer, english, OPUS, trailer } from './testing/scripted-answers';

const MASTER_KEY = randomBytes(32).toString('base64');
/** Not a real key: every provider call goes to the mocked fetch. */
const ANTHROPIC_KEY = 'sk-ant-api03-e2e-assistant-value-Qq7-9c1e';
const HAIKU = 'claude-haiku-5-5';

interface ProviderCall {
  model: string;
  system: string;
  body: Record<string, unknown>;
}

/** Collects the whole SSE body of a stream request. */
const readSse = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      text += chunk;
    });
    res.on('end', () => done(null, text));
  });

const eventsOf = (body: unknown): AssistantStreamEvent[] =>
  String(body)
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as AssistantStreamEvent);

describe('Assistant (e2e)', () => {
  let ctx: LlmE2eContext;
  let admin: Session;
  let alice: Session;
  let bob: Session;
  let aliceId: string;
  let runnerId: string;
  let projects: Record<'dock' | 'billingApi' | 'billingWeb' | 'other', string>;
  /** Answers for the chat model, in order; the title model answers itself. */
  let script: Response[];
  let calls: ProviderCall[];
  let globalFetch: jest.SpyInstance;

  beforeAll(async () => {
    process.env[LLM_SECRETS_KEY_ENV] = MASTER_KEY;
    // With a DeepL key set, DeepL would be called if the assistant used it.
    process.env.DEEPL_API_KEY = 'e2e-deepl-key:fx';
    ctx = await createLlmE2eApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    process.env[LLM_SECRETS_KEY_ENV] = '';
    process.env.DEEPL_API_KEY = '';
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

  const member = (projectId: string, userId: string) =>
    ctx.prisma.projectMember.create({ data: { projectId, userId } });

  /** Two prices, so the cheapest model is the title model. */
  const seedPrices = () =>
    ctx.prisma.priceVersion.create({
      data: {
        number: 1,
        source: 'admin',
        note: 'assistant e2e',
        models: {
          create: [
            [OPUS, '0.000005', '0.000025'],
            [HAIKU, '0.000001', '0.000005'],
          ].map(([modelName, input, output]) => ({
            modelName,
            matchPattern: `^${modelName}$`,
            priority: 0,
            tiers: [
              {
                name: 'Standard',
                isDefault: true,
                conditions: [],
                prices: { input, output },
              },
            ] as unknown as Prisma.InputJsonValue,
          })),
        },
      },
    });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await ctx.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE price_versions, llm_calls, llm_provider_settings, runners, projects CASCADE',
    );
    await seedPrices();
    await createUser(ctx.prisma, 'admin@example.com', 'admin');
    aliceId = (await createUser(ctx.prisma, 'alice@example.com', 'operator'))
      .id;
    const bobId = (await createUser(ctx.prisma, 'bob@example.com', 'operator'))
      .id;
    admin = await login(ctx, 'admin@example.com');
    alice = await login(ctx, 'alice@example.com');
    bob = await login(ctx, 'bob@example.com');
    runnerId = (await ctx.prisma.runner.create({ data: { name: 'desk' } })).id;
    projects = {
      dock: await project('Nautelle', 'acme/agentdock'),
      billingApi: await project('billing-api', 'acme/billing-api'),
      billingWeb: await project('billing-web', 'acme/billing-web'),
      other: await project('Secret Garden', 'acme/secret-garden'),
    };
    for (const id of [
      projects.dock,
      projects.billingApi,
      projects.billingWeb,
    ]) {
      await member(id, aliceId);
    }
    await member(projects.other, bobId);
    await ctx.prisma.boardCard.create({
      data: {
        projectId: projects.other,
        number: 1,
        shortId: 'secret01',
        title: 'Hidden roadmap item',
        fingerprint: 'hidden roadmap item',
        column: 'todo',
        position: 1,
        issueOnRun: false,
        specOnRun: false,
        movedAt: new Date(),
      },
    });

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
          models: [OPUS, HAIKU],
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
    calls = [];
    ctx.clock.now = null;
    ctx.providerFetch.mockReset();
    ctx.providerFetch.mockImplementation(async (input, init) => {
      const { body } = await requestOf(input, init);
      const model = String(body?.model);
      // A cached prompt goes as text blocks (the stable part, then the tail).
      const system = Array.isArray(body?.system)
        ? (body.system as { text: string }[]).map((b) => b.text).join('\n\n')
        : String(body?.system ?? '');
      // #660: a queued card's triage runs beside the chat; it gets no hints.
      if (system.startsWith('You triage')) return answer([{ text: ['{}'] }]);
      calls.push({ model, system, body: body ?? {} });
      if (model === HAIKU) {
        return answer([{ text: ['Queue ', 'blockers'] }], {
          input: 50,
          output: 5,
        });
      }
      const next = script.shift();
      if (!next) throw new Error('no scripted answer left');
      return next;
    });
    globalFetch = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => jest.restoreAllMocks());

  const open = async (
    who: Session = alice,
    body: object = {},
  ): Promise<AssistantConversationView> => {
    const res = await who.send('post', '/assistant/conversations', body);
    expect(res.status).toBe(201);
    return res.body as AssistantConversationView;
  };

  const say = async (
    conversationId: string,
    message: string,
    who: Session = alice,
  ): Promise<AssistantStreamEvent[]> => {
    const res = await readSse(
      who.send('post', `/assistant/conversations/${conversationId}/stream`, {
        message,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    return eventsOf(res.body);
  };

  const messagesOf = async (conversationId: string) => {
    const res = await alice.get(
      `/assistant/conversations/${conversationId}/messages`,
    );
    expect(res.status).toBe(200);
    return res.body as AssistantMessageView[];
  };

  /** What the chat model was sent back for each tool call of the turn. */
  const toolResults = (call: ProviderCall): string[] =>
    (call.body.messages as { role: string; content: unknown }[]).flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as { type: string; content?: unknown }[])
            .filter((b) => b.type === 'tool_result')
            .map((b) => JSON.stringify(b.content))
        : [],
    );

  it('keeps a conversation to its owner: anyone else gets 404', async () => {
    const mine = await open(alice, { projectId: projects.dock });
    const base = `/assistant/conversations/${mine.id}`;
    for (const res of [
      await bob.get(base),
      await bob.get(`${base}/messages`),
      await bob.get(`${base}/attachments`),
      await bob.send('patch', base, { title: 'Mine now' }),
      await bob.send('post', `${base}/attachments`, {
        kind: 'card',
        projectId: projects.other,
        cardNumber: 1,
      }),
      await bob.send('post', `${base}/stream`, { message: 'hello' }),
      await bob.send('delete', base),
      // An admin has no way into a person's conversation either.
      await admin.get(`${base}/messages`),
    ]) {
      expect(res.status).toBe(404);
    }
    expect((await bob.get('/assistant/conversations')).body).toEqual([]);
    expect(
      (await alice.get('/assistant/conversations')).body.map(
        (c: AssistantConversationView) => c.id,
      ),
    ).toEqual([mine.id]);
    // No model was called for bob's stream.
    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.assistantConversation.count()).toBe(1);
  });

  it('validates every input', async () => {
    const mine = await open();
    for (const [path, body] of [
      ['/assistant/conversations', { projectId: 'x y' }],
      ['/assistant/conversations', { model: OPUS }],
      ['/assistant/conversations', { extra: true }],
      [`/assistant/conversations/${mine.id}/stream`, { message: '   ' }],
      [`/assistant/conversations/${mine.id}/stream`, {}],
      [`/assistant/conversations/${mine.id}/attachments`, { kind: 'card' }],
    ] as const) {
      expect((await alice.send('post', path, body)).status).toBe(400);
    }
    const unknownModel = await alice.send('post', '/assistant/conversations', {
      provider: 'anthropic',
      model: 'claude-unknown-1',
    });
    expect(unknownModel.status).toBe(400);
    expect(unknownModel.body.error).toBe('assistant_model_not_enabled');
  });

  it('lists the enabled models with the default', async () => {
    const res = await alice.get('/assistant/models');
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      { provider: 'anthropic', model: OPUS, isDefault: true, vision: true },
      { provider: 'anthropic', model: HAIKU, isDefault: false, vision: true },
    ]);
  });

  it('streams the reply as incremental deltas, meters it and titles it', async () => {
    const conversation = await open(alice, { projectId: projects.dock });
    script.push(
      answer([
        {
          text: english(
            'Two cards are ready to run.',
            'What is ready on the board?',
          ),
        },
      ]),
    );
    const events = await say(conversation.id, 'What is ready on the board?');

    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((e) => e.text).join('')).toBe(
      'Two cards are ready to run.\n',
    );
    expect(JSON.stringify(deltas)).not.toContain('agentdock:english');
    expect(events.at(-1)?.type).toBe('done');
    expect(events.find((e) => e.type === 'title')).toEqual({
      type: 'title',
      title: 'Queue blockers',
    });

    // The default model answered; the cheapest enabled model wrote the title.
    expect(calls.map((c) => c.model)).toEqual([OPUS, HAIKU]);
    const ledger = await ctx.prisma.llmCall.findMany({
      orderBy: { ts: 'asc' },
    });
    expect(
      ledger.map((c) => [c.feature, c.model, c.userId, c.outcome]),
    ).toEqual([
      ['assistant', OPUS, aliceId, 'ok'],
      ['title', HAIKU, aliceId, 'ok'],
    ]);

    const stored = await messagesOf(conversation.id);
    expect(stored.map((m) => [m.role, m.content, m.language])).toEqual([
      ['user', 'What is ready on the board?', 'en'],
      ['assistant', 'Two cards are ready to run.', 'en'],
    ]);
    const reply = await ctx.prisma.assistantMessage.findFirstOrThrow({
      where: { role: 'assistant' },
    });
    expect(reply.llmCallIds).toEqual([
      ledger.find((c) => c.feature === 'assistant')?.id,
    ]);
    expect(reply.model).toBe(OPUS);
    expect(
      (await alice.get(`/assistant/conversations/${conversation.id}`)).body,
    ).toMatchObject({ title: 'Queue blockers', projectId: projects.dock });
  });

  it('caches the stable prompt and tools, and sends 20 messages plus a stored summary (ADR-0068 §10)', async () => {
    const conversation = await open(alice, { projectId: projects.dock });
    // 60 earlier messages, 30 exchanges.
    const base = Date.parse('2026-10-01T00:00:00Z');
    await ctx.prisma.assistantMessage.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        id: `m${String(i).padStart(2, '0')}`,
        conversationId: conversation.id,
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `message ${i}`,
        displayContent: `message ${i}`,
        language: 'en',
        createdAt: new Date(base + i * 1_000),
      })),
    });
    script.push(
      answer([{ text: english('Done.', 'And now?') }]),
      answer([{ text: english('Again.', 'Once more?') }]),
    );

    await say(conversation.id, 'And now?');
    const chat = calls.find((c) => c.model === OPUS);
    if (!chat) throw new Error('the chat model was not called');
    const sent = chat.body.messages as { content: unknown }[];
    // The newest 20 of the 60, then the new message.
    expect(sent).toHaveLength(21);
    expect(JSON.stringify(sent[0])).toContain('message 40');
    expect(chat.system).not.toContain('Earlier in this conversation');
    // The stable part and the last tool carry a cache breakpoint; the tail
    // (date, person, project) does not.
    const blocks = chat.body.system as {
      text: string;
      cache_control?: object;
    }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toBeUndefined();
    const tools = chat.body.tools as { cache_control?: object }[];
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.slice(0, -1).some((t) => t.cache_control)).toBe(false);

    // The messages that slid out were folded into the stored summary by the
    // cheapest model, tagged as its own feature.
    const stored = await ctx.prisma.assistantConversation.findUniqueOrThrow({
      where: { id: conversation.id },
    });
    expect(stored.summary).toBe('Queue blockers');
    expect(stored.summaryUpTo).not.toBeNull();
    const ledger = await ctx.prisma.llmCall.findMany({
      orderBy: { ts: 'asc' },
    });
    expect(ledger.map((c) => c.feature)).toEqual(
      expect.arrayContaining(['assistant', 'assistant_summary']),
    );

    // The next turn sends the summary, and no new summary is made until the
    // window slides again... it slides each turn, so one more is made.
    await say(conversation.id, 'Once more?');
    const next = calls.filter((c) => c.model === OPUS).at(-1);
    expect(next?.system).toContain('Earlier in this conversation');
    expect(next?.system).toContain('Queue blockers');
  });

  it('ends with a typed error once the provider cap is reached, and stores nothing', async () => {
    await admin.send('patch', '/admin/llm/providers/anthropic', { capUsd: 1 });
    await ctx.prisma.llmCall.create({
      data: {
        provider: 'anthropic',
        model: OPUS,
        feature: 'assistant',
        outcome: 'ok',
        costUsd: '1.50',
        priceVersion: 1,
        durationMs: 10,
      },
    });
    const conversation = await open();
    const events = await say(conversation.id, 'Hello');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'llm_cap_reached',
      provider: 'anthropic',
    });
    expect(calls).toHaveLength(0);
    expect(await messagesOf(conversation.id)).toEqual([]);
    expect(await ctx.prisma.llmCall.count()).toBe(1);
  });

  it('on Auto, binds the conversation to the one accessible project a message names', async () => {
    const conversation = await open();
    expect(conversation.projectId).toBeNull();
    script.push(
      answer([
        {
          text: english(
            'Nautelle has nothing queued.',
            'What is in the Nautelle queue?',
          ),
        },
      ]),
    );
    const events = await say(conversation.id, 'What is in the Nautelle queue?');
    expect(events[0]).toEqual({
      type: 'project',
      projectId: projects.dock,
      projectName: 'Nautelle',
    });
    expect(calls[0].system).toContain(
      `The conversation is about Nautelle (acme/agentdock), id ${projects.dock}`,
    );
    const view = (
      await alice.get(`/assistant/conversations/${conversation.id}`)
    ).body as AssistantConversationView;
    expect(view.projectId).toBe(projects.dock);
  });

  it('on Auto, a project the person cannot access is never bound', async () => {
    const conversation = await open();
    script.push(
      answer([{ text: english('Which project?', 'Secret Garden?') }]),
    );
    const events = await say(conversation.id, 'What about Secret Garden?');
    expect(events.some((e) => e.type === 'project')).toBe(false);
    expect(calls[0].system).not.toContain('Secret Garden');
    expect(
      (await alice.get(`/assistant/conversations/${conversation.id}`)).body
        .projectId,
    ).toBeNull();
  });

  it('on Auto, asks which project when the message could mean several', async () => {
    const conversation = await open();
    script.push(
      answer([
        {
          text: english(
            'Which one do you mean: billing-api or billing-web?',
            'How is billing doing?',
          ),
        },
      ]),
      answer([
        {
          tool: {
            id: 'toolu_1',
            name: 'choose_project',
            input: { project: projects.billingWeb },
          },
        },
      ]),
      answer([{ text: english('billing-web is idle.', 'The web one.') }]),
    );
    const first = await say(conversation.id, 'How is billing doing?');
    expect(first.some((e) => e.type === 'project')).toBe(false);
    expect(calls[0].system).toContain(
      'the latest message could mean several projects',
    );
    expect(calls[0].system).toContain(
      `billing-api (acme/billing-api), id ${projects.billingApi}`,
    );
    expect(calls[0].system).toContain(
      `billing-web (acme/billing-web), id ${projects.billingWeb}`,
    );
    expect(calls[0].system).toContain('ask the person which one they mean');
    expect(
      (await alice.get(`/assistant/conversations/${conversation.id}`)).body
        .projectId,
    ).toBeNull();

    // The answer resolves it: the model records it with choose_project.
    const second = await say(conversation.id, 'The web one.');
    expect(second).toContainEqual({
      type: 'project',
      projectId: projects.billingWeb,
      projectName: 'billing-web',
    });
    expect(
      (await alice.get(`/assistant/conversations/${conversation.id}`)).body
        .projectId,
    ).toBe(projects.billingWeb);
  });

  it('replies to a Russian message in Russian and stores English content, without DeepL', async () => {
    const conversation = await open(alice, { projectId: projects.dock });
    script.push(
      answer([
        {
          text: [
            'В очереди ',
            'две карточки.',
            trailer(
              'ru',
              'There are two cards in the queue.',
              'What is in the queue?',
            ),
          ],
        },
      ]),
    );
    const events = await say(conversation.id, 'Что в очереди?');
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('В очереди две карточки.\n');
    const done = events.at(-1);
    expect(done?.type).toBe('done');

    const [question, reply] = await messagesOf(conversation.id);
    expect(question).toMatchObject({
      role: 'user',
      content: 'What is in the queue?',
      displayContent: 'Что в очереди?',
      language: 'ru',
    });
    expect(reply).toMatchObject({
      role: 'assistant',
      content: 'There are two cards in the queue.',
      displayContent: 'В очереди две карточки.',
      language: 'ru',
    });
    // One model call made both texts; nothing went to DeepL.
    expect(calls.filter((c) => c.model === OPUS)).toHaveLength(1);
    const urls = [
      ...globalFetch.mock.calls,
      ...ctx.providerFetch.mock.calls,
    ].map(([input]) => String(input instanceof Request ? input.url : input));
    expect(urls.some((url) => /deepl/i.test(url))).toBe(false);

    // The next turn sends the English text as context.
    script.push(answer([{ text: english('Yes.', 'Sure?') }]));
    await say(conversation.id, 'Точно?');
    const context = calls.at(-1)?.body.messages as {
      role: string;
      content: unknown;
    }[];
    expect(context.slice(0, 2)).toEqual([
      { role: 'user', content: 'What is in the queue?' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'There are two cards in the queue.' }],
      },
    ]);
  });

  it('returns read-tool data only from projects the person can access', async () => {
    const conversation = await open(alice, { projectId: projects.dock });
    script.push(
      answer([
        { text: ['Let me look.'] },
        { tool: { id: 'toolu_1', name: 'list_projects', input: {} } },
        {
          tool: {
            id: 'toolu_2',
            name: 'read_board',
            input: { project: projects.other },
          },
        },
        {
          tool: {
            id: 'toolu_3',
            name: 'read_card',
            input: { project: projects.other, card: 1 },
          },
        },
        { tool: { id: 'toolu_4', name: 'read_board', input: {} } },
      ]),
      answer([{ text: english('Done.', 'Look around.') }]),
    );
    const events = await say(conversation.id, 'Look around.');
    const done = events.filter(
      (
        e,
      ): e is Extract<AssistantStreamEvent, { type: 'tool'; status: 'done' }> =>
        e.type === 'tool' && e.status === 'done',
    );
    expect(done.map((e) => [e.name, e.ok])).toEqual([
      ['list_projects', true],
      ['read_board', false],
      ['read_card', false],
      ['read_board', true],
    ]);
    const results = toolResults(calls[1]);
    expect(results).toHaveLength(4);
    expect(results.join('\n')).not.toContain('Hidden roadmap item');
    expect(results.join('\n')).not.toContain('Secret Garden');
    expect(results[0]).toContain('Nautelle');
    expect(results[0]).toContain('billing-web');
    expect(results[1]).toContain('no access to that project');
    // The stored reply keeps the steps.
    const [, reply] = await messagesOf(conversation.id);
    expect(reply.tools.map((t) => t.name)).toEqual([
      'list_projects',
      'read_board',
      'read_card',
      'read_board',
    ]);
    expect(reply.displayContent).toBe('Let me look.\n\nDone.');
  });

  it('drafts and queues a card as the person', async () => {
    const conversation = await open(alice, { projectId: projects.dock });
    const card = {
      title: 'Stabilise the Board drag e2e test',
      body: 'Wait for the drop target.',
      kind: 'bug',
    };
    script.push(
      answer([{ tool: { id: 'toolu_1', name: 'draft_card', input: card } }]),
      answer([{ text: english('Here is a draft.', 'Draft one.') }]),
      answer([{ tool: { id: 'toolu_2', name: 'queue_card', input: card } }]),
      answer([{ text: english('Queued as C-1.', 'Queue it.') }]),
    );
    const first = await say(conversation.id, 'Draft one.');
    expect(first).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        status: 'done',
        name: 'draft_card',
        ok: true,
        draft: { projectId: projects.dock, ...card },
      }),
    );
    // A draft writes nothing to the Board.
    expect(
      await ctx.prisma.boardCard.count({ where: { projectId: projects.dock } }),
    ).toBe(0);

    await say(conversation.id, 'Queue it.');
    // The earlier draft is in the context of the next turn.
    const chat = calls.filter((c) => c.model === OPUS);
    expect(JSON.stringify(chat[2].body.messages)).toContain(
      'Stabilise the Board drag e2e test',
    );
    const queued = await ctx.prisma.boardCard.findMany({
      where: { projectId: projects.dock },
    });
    expect(
      queued.map((c) => [c.title, c.column, c.kind, c.createdById]),
    ).toEqual([[card.title, 'todo', 'bug', aliceId]]);
  });

  it('turns a requested action into a pending action request, never running it', async () => {
    const stop = jest.spyOn(ctx.app.get(ControlService), 'stop');
    const conversation = await open(alice, { projectId: projects.dock });
    script.push(
      answer([
        {
          tool: {
            id: 'toolu_1',
            name: 'request_action',
            input: { action: 'stop', reason: 'The fleet is burning budget.' },
          },
        },
      ]),
      answer([
        { text: english('Asked; approve it in Approvals.', 'Stop it.') },
      ]),
    );
    const events = await say(conversation.id, 'Stop the fleet.');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        status: 'done',
        name: 'request_action',
        ok: true,
      }),
    );
    const requests = await ctx.prisma.actionRequest.findMany();
    expect(
      requests.map((r) => [
        r.projectId,
        r.kind,
        r.status,
        r.requestedById,
        r.summary,
      ]),
    ).toEqual([
      [
        projects.dock,
        'orchestrator_stop',
        'pending',
        aliceId,
        'The fleet is burning budget.',
      ],
    ]);
    expect(stop).not.toHaveBeenCalled();
    expect(await ctx.prisma.commandRun.count()).toBe(0);
  });

  it('refuses a write tool to a viewer of the project', async () => {
    const viewerId = (
      await createUser(ctx.prisma, 'vera@example.com', 'viewer')
    ).id;
    await member(projects.dock, viewerId);
    const vera = await login(ctx, 'vera@example.com');
    const conversation = await open(vera, { projectId: projects.dock });
    script.push(
      answer([
        {
          tool: {
            id: 'toolu_1',
            name: 'request_action',
            input: { action: 'stop', reason: 'Stop.' },
          },
        },
      ]),
      answer([{ text: english('You cannot.', 'Stop.') }]),
    );
    const events = await say(conversation.id, 'Stop the fleet.', vera);
    expect(events).toContainEqual(
      expect.objectContaining({ name: 'request_action', ok: false }),
    );
    expect(toolResults(calls[1])[0]).toContain('needs the operator role');
    expect(await ctx.prisma.actionRequest.count()).toBe(0);
  });

  describe('code tools (#622)', () => {
    const toolNames = (call: ProviderCall) =>
      ((call.body.tools ?? []) as { name: string }[]).map((t) => t.name);

    it('with the runner offline, returns a typed error and the assistant says so', async () => {
      const send = jest.spyOn(ctx.app.get(RunnerCommandService), 'send');
      const conversation = await open(alice, { projectId: projects.dock });
      script.push(
        answer([
          {
            tool: {
              id: 'toolu_1',
              name: 'search_code',
              input: { query: 'computeInvoice' },
            },
          },
        ]),
        answer([
          {
            text: english(
              "I can't read the code: the project's runner is offline.",
              'Where is computeInvoice implemented?',
            ),
          },
        ]),
      );
      const events = await say(
        conversation.id,
        'Where is computeInvoice implemented?',
      );
      expect(toolNames(calls[0])).toEqual(
        expect.arrayContaining(['search_code', 'read_file', 'ask_code_agent']),
      );
      expect(calls[0].system).toContain('runner_offline');
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool',
          status: 'done',
          name: 'search_code',
          ok: false,
        }),
      );
      const [result] = toolResults(calls[1]);
      expect(result).toContain('runner_offline');
      expect(result).toContain('offline');
      expect(send).not.toHaveBeenCalled();
    });

    it("with the runner online, reads the code through the project's runner and cites its files", async () => {
      const presence = ctx.app.get(RunnerPresence);
      jest.spyOn(presence, 'isConnected').mockReturnValue(true);
      jest.spyOn(presence, 'commandSupport').mockReturnValue('supported');
      const send = jest
        .spyOn(ctx.app.get(RunnerCommandService), 'send')
        .mockImplementation(async (_runner, name) => {
          if (name === 'repo.search') {
            return {
              status: 'ok',
              rttMs: 3,
              output: {
                matches: [
                  {
                    path: 'src/billing/invoice.ts',
                    line: 12,
                    text: 'export function computeInvoice(total: number) {',
                  },
                ],
                truncated: false,
                withheld: 0,
              },
            } as never;
          }
          return {
            status: 'ok',
            rttMs: 3,
            output: {
              path: 'src/billing/invoice.ts',
              content: 'export function computeInvoice(total: number) {\n',
              startLine: 12,
              endLine: 12,
              totalLines: 40,
              truncated: false,
            },
          } as never;
        });
      const conversation = await open(alice, { projectId: projects.dock });
      script.push(
        answer([
          {
            tool: {
              id: 'toolu_1',
              name: 'search_code',
              input: { query: 'computeInvoice' },
            },
          },
        ]),
        answer([
          {
            tool: {
              id: 'toolu_2',
              name: 'read_file',
              input: { path: 'src/billing/invoice.ts', startLine: 12 },
            },
          },
        ]),
        answer([
          {
            text: english(
              'It is in `src/billing/invoice.ts:12`.',
              'Where is computeInvoice implemented?',
            ),
          },
        ]),
      );
      const events = await say(
        conversation.id,
        'Where is computeInvoice implemented?',
      );
      expect(send.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
        [
          runnerId,
          'repo.search',
          {
            projectId: projects.dock,
            root: '/srv/dev/Nautelle',
            query: 'computeInvoice',
          },
        ],
        [
          runnerId,
          'repo.read',
          {
            projectId: projects.dock,
            root: '/srv/dev/Nautelle',
            path: 'src/billing/invoice.ts',
            startLine: 12,
          },
        ],
      ]);
      expect(toolResults(calls[1])[0]).toContain('src/billing/invoice.ts');
      expect(toolResults(calls[2])[1]).toContain('computeInvoice(total');
      const done = events.at(-1);
      expect(done).toMatchObject({ type: 'done' });
      const [, reply] = await messagesOf(conversation.id);
      expect(reply.displayContent).toContain('src/billing/invoice.ts:12');
      expect(reply.tools.map((t) => [t.name, t.ok])).toEqual([
        ['search_code', true],
        ['read_file', true],
      ]);
    });

    it('delegates to the code agent as a code_ask run of the project', async () => {
      const presence = ctx.app.get(RunnerPresence);
      jest.spyOn(presence, 'isConnected').mockReturnValue(true);
      jest.spyOn(presence, 'commandSupport').mockReturnValue('supported');
      const profile = await ctx.prisma.runtimeProfile.create({
        data: {
          runnerId,
          key: 'claude-work',
          label: 'Claude',
          runtime: 'claude',
          env: {},
          args: [],
          authenticated: true,
        },
      });
      await ctx.prisma.project.update({
        where: { id: projects.dock },
        data: { defaultProfileId: profile.id },
      });
      jest.spyOn(ctx.app.get(RunnerCommandService), 'send').mockResolvedValue({
        status: 'ok',
        rttMs: 9,
        output: {
          answer: 'Invoices are computed in `src/billing/invoice.ts:12`.',
          truncated: false,
        },
      } as never);
      const conversation = await open(alice, { projectId: projects.dock });
      script.push(
        answer([
          {
            tool: {
              id: 'toolu_1',
              name: 'ask_code_agent',
              input: { question: 'Where are invoices computed?' },
            },
          },
        ]),
        answer([{ text: english('See `src/billing/invoice.ts:12`.', 'Q') }]),
      );
      await say(conversation.id, 'Where are invoices computed?');
      expect(toolResults(calls[1])[0]).toContain('src/billing/invoice.ts:12');
      const run = await ctx.prisma.run.findFirstOrThrow({
        where: { kind: 'code_ask' },
      });
      expect(run).toMatchObject({
        projectId: projects.dock,
        status: 'succeeded',
        triggeredByType: 'user',
        triggeredById: aliceId,
      });
    });
  });

  describe('attachments', () => {
    const session = async (projectId: string) =>
      (
        await ctx.prisma.agentSession.create({
          data: {
            runnerId,
            runtime: 'claude',
            externalId: randomBytes(8).toString('hex'),
            projectId,
            cwd: '/srv/dev/x',
            title: 'Fix the flaky drag test',
            startedAt: new Date(),
            lastEventAt: new Date(),
          },
        })
      ).id;

    it('refuses a session of a project without session content opted in', async () => {
      const conversation = await open(alice, { projectId: projects.dock });
      const sessionId = await session(projects.dock);
      const res = await alice.send(
        'post',
        `/assistant/conversations/${conversation.id}/attachments`,
        { kind: 'session', sessionId },
      );
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('session_content_off');
      expect(await ctx.prisma.assistantAttachment.count()).toBe(0);
    });

    it('attaches a session of an opted-in project and sends its content with the next message', async () => {
      await ctx.prisma.project.update({
        where: { id: projects.dock },
        data: { shipSessionContent: true },
      });
      const sessionId = await session(projects.dock);
      await ctx.prisma.sessionContent.create({
        data: {
          sessionId,
          projectId: projects.dock,
          kind: 'prompt',
          at: new Date(),
          text: 'Make the drag test wait for the drop target',
        },
      });
      const conversation = await open(alice, { projectId: projects.dock });
      const res = await alice.send(
        'post',
        `/assistant/conversations/${conversation.id}/attachments`,
        { kind: 'session', sessionId },
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: 'session',
        label: 'Fix the flaky drag test',
        messageId: null,
      });

      script.push(
        answer([{ text: english('It waits now.', 'What did it do?') }]),
      );
      await say(conversation.id, 'What did it do?');
      expect(JSON.stringify(calls[0].body.messages)).toContain(
        'Make the drag test wait for the drop target',
      );
      const [question] = await messagesOf(conversation.id);
      expect(question.attachments.map((a) => a.id)).toEqual([res.body.id]);
    });

    it('refuses a card or session of a project the person cannot access', async () => {
      const conversation = await open();
      const card = await alice.send(
        'post',
        `/assistant/conversations/${conversation.id}/attachments`,
        { kind: 'card', projectId: projects.other, cardNumber: 1 },
      );
      expect(card.status).toBe(404);
      const sessionRes = await alice.send(
        'post',
        `/assistant/conversations/${conversation.id}/attachments`,
        { kind: 'session', sessionId: await session(projects.other) },
      );
      expect(sessionRes.status).toBe(404);
    });

    it('stores a file on the conversation project and sends an image to a vision model', async () => {
      const auto = await open();
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const upload = (id: string) =>
        alice
          .send('post', `/assistant/conversations/${id}/attachments/files`)
          .attach('file', png, 'screen.png');
      const refused = await upload(auto.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('project_required');

      const conversation = await open(alice, { projectId: projects.dock });
      const stored = await upload(conversation.id);
      expect(stored.status).toBe(201);
      expect(stored.body).toMatchObject({
        kind: 'file',
        label: 'screen.png',
        mime: 'image/png',
        projectId: projects.dock,
      });
      const row = await ctx.prisma.attachment.findUniqueOrThrow({
        where: { id: stored.body.attachmentId },
      });
      // Claimed: the pending-upload sweep leaves it alone.
      expect(row.expiresAt).toBeNull();

      script.push(
        answer([{ text: english('A tiny image.', 'What is this?') }]),
      );
      await say(conversation.id, 'What is this?');
      const sent = calls[0].body.messages as {
        content: { type: string; source?: { media_type: string } }[];
      }[];
      expect(
        sent
          .at(-1)
          ?.content.some(
            (b) => b.type === 'image' && b.source?.media_type === 'image/png',
          ),
      ).toBe(true);

      // Deleting the conversation deletes the stored file's row.
      expect(
        (
          await alice.send(
            'delete',
            `/assistant/conversations/${conversation.id}`,
          )
        ).status,
      ).toBe(204);
      expect(await ctx.prisma.attachment.count({ where: { id: row.id } })).toBe(
        0,
      );
    });
  });
});
