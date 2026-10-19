import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  answer,
  english,
  OPUS,
  trailer,
} from '../assistant/testing/scripted-answers';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { LLM_SECRETS_KEY_ENV } from '../llm/llm-secrets';
import { requestOf } from '../llm/providers/testing';
import { type LlmMock, mockLlm } from '../llm/testing/llm-e2e';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { login, type Session } from '../test/e2e-app';
import { ASSISTANT_REPLIES } from './assistant-reply';
import { TelegramAssistantService } from './telegram-assistant.service';
import type { InlineKeyboardButton } from './telegram-client';
import { HELP_TEXT } from './telegram-commands';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  groupMessage,
  mediaMessage,
  privateMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const MASTER_KEY = randomBytes(32).toString('base64');
/** Not a real key: every provider call goes to the mocked fetch. */
const ANTHROPIC_KEY = 'sk-ant-api03-e2e-telegram-value-Zz4-7b2d';
const HAIKU = 'claude-haiku-5-5';
/** A JPEG's first bytes: enough for the upload's type sniffing. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]);

const ADA_CHAT = 8101;
const VIC_CHAT = 8102;
const UNLINKED_CHAT = 8999;

interface ProviderCall {
  model: string;
  system: string;
  body: Record<string, unknown>;
}

describe('Telegram free text goes to the assistant (e2e, #620)', () => {
  let ctx: TelegramE2e;
  let llm: LlmMock;
  let nextUpdate = 1;
  let adaId: string;
  let vicId: string;
  let widget: string;
  let gadget: string;
  let root: Session;
  let ada: Session;
  /** Answers for the chat model, in order; the title model answers itself. */
  let script: Response[];
  let calls: ProviderCall[];

  const poller = () => ctx.app.get(TelegramPoller);
  const assistant = () => ctx.app.get(TelegramAssistantService);

  /** Feeds `update` through one poll and waits for the turn it started. */
  const poll = async (update: { update_id: number }) => {
    const before = ctx.fake.calls.length;
    ctx.fake.updates = [update];
    expect(await poller().pollOnce()).toEqual({ status: 'polled', updates: 1 });
    await assistant().idle();
    return ctx.fake.calls
      .slice(before)
      .filter((c) => c.method !== 'getUpdates');
  };
  const sent = (made: Awaited<ReturnType<typeof poll>>) =>
    made.filter((c) => c.method === 'sendMessage').map((c) => c.body);
  const say = async (chatId: number, text: string) =>
    sent(await poll(privateMessage(nextUpdate++, chatId, text)));

  const conversationsOf = (userId: string) =>
    ctx.prisma.assistantConversation.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

  const seedPrices = () =>
    ctx.prisma.priceVersion.create({
      data: {
        number: 1,
        source: 'admin',
        note: 'telegram assistant e2e',
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

  beforeAll(async () => {
    process.env[LLM_SECRETS_KEY_ENV] = MASTER_KEY;
    ctx = await createTelegramApp(undefined, undefined, {}, (builder) => {
      const mocked = mockLlm(builder);
      llm = mocked.mock;
      return mocked.builder;
    });
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
    await seedPrices();
    const rootUser = await seedUser(ctx.prisma, 'root@example.com', 'admin');
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', rootUser.id, { actor: SYSTEM_ACTOR });
    await ctx.prisma.notificationMatcherState.create({
      data: { id: 1, eventsCursor: 0n },
    });
    const first = await seedRunnerProject(ctx.prisma, {
      root: '/srv/dev/widget',
      repo: 'acme/widget',
    });
    widget = first.projectId;
    gadget = (
      await seedRunnerProject(ctx.prisma, {
        runnerId: first.runnerId,
        root: '/srv/dev/gadget',
        repo: 'acme/gadget',
      })
    ).projectId;
    adaId = (await seedUser(ctx.prisma, 'ada@example.com', 'operator', widget))
      .id;
    await ctx.prisma.projectMember.create({
      data: { projectId: gadget, userId: adaId },
    });
    vicId = (await seedUser(ctx.prisma, 'vic@example.com', 'viewer', widget))
      .id;
    for (const [userId, chatId] of [
      [adaId, ADA_CHAT],
      [vicId, VIC_CHAT],
    ] as const) {
      await ctx.prisma.telegramLink.create({
        data: { userId, chatId: BigInt(chatId) },
      });
    }

    root = await login(ctx, 'root@example.com');
    ada = await login(ctx, 'ada@example.com');
    for (const [method, path, body] of [
      ['put', '/admin/llm/providers/anthropic/key', { key: ANTHROPIC_KEY }],
      ['patch', '/admin/llm/providers/anthropic', { models: [OPUS, HAIKU] }],
      [
        'put',
        '/admin/llm/default-model',
        { provider: 'anthropic', model: OPUS },
      ],
    ] as const) {
      expect((await root.send(method, path, body)).status).toBe(200);
    }

    script = [];
    calls = [];
    llm.clock.now = null;
    llm.providerFetch.mockReset();
    llm.providerFetch.mockImplementation(async (input, init) => {
      const { body } = await requestOf(input, init);
      const model = String(body?.model);
      calls.push({
        model,
        // A cached prompt goes as text blocks (the stable part, then the tail).
        system: Array.isArray(body?.system)
          ? (body.system as { text: string }[]).map((b) => b.text).join('\n\n')
          : String(body?.system ?? ''),
        body: body ?? {},
      });
      if (model === HAIKU) return answer([{ text: ['Queue ', 'blockers'] }]);
      const next = script.shift();
      if (!next) throw new Error('no scripted answer left');
      return next;
    });
  });

  /** The chat-model calls, without the title calls. */
  const chatCalls = () => calls.filter((c) => c.model === OPUS);

  it('answers free text in the person’s language, as a conversation the web rail lists', async () => {
    script.push(
      answer([
        {
          text: [
            'Две вещи.',
            trailer(
              'ru',
              'Two things.',
              'What is blocking the queue right now?',
            ),
          ],
        },
      ]),
    );
    const before = ctx.fake.calls.length;
    const replies = await say(ADA_CHAT, 'что сейчас блокирует очередь?');
    expect(replies).toEqual([
      expect.objectContaining({
        chat_id: ADA_CHAT,
        text: 'Две вещи\\.',
        parse_mode: 'MarkdownV2',
      }),
    ]);
    const methods = ctx.fake.calls.slice(before).map((c) => c.method);
    expect(methods.indexOf('sendChatAction')).toBeLessThan(
      methods.indexOf('sendMessage'),
    );
    expect(
      ctx.fake.calls.find((c) => c.method === 'sendChatAction')?.body,
    ).toEqual({ chat_id: ADA_CHAT, action: 'typing' });

    const rail = await ada.get('/assistant/conversations');
    expect(rail.status).toBe(200);
    expect(rail.body).toHaveLength(1);
    const [conversation] = rail.body as { id: string; title: string }[];
    expect(conversation.title).toBe('Queue blockers');
    const messages = await ada.get(
      `/assistant/conversations/${conversation.id}/messages`,
    );
    expect(messages.body).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'What is blocking the queue right now?',
        displayContent: 'что сейчас блокирует очередь?',
        language: 'ru',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Two things.',
        displayContent: 'Две вещи.',
      }),
    ]);
  });

  it('continues the chat’s conversation until /newchat, which /help lists', async () => {
    script.push(
      answer([{ text: english('First.', 'One') }]),
      answer([{ text: english('Second.', 'Two') }]),
    );
    await say(ADA_CHAT, 'One');
    await say(ADA_CHAT, 'Two');
    expect(await conversationsOf(adaId)).toHaveLength(1);
    // The second turn had the first as history.
    expect(JSON.stringify(chatCalls()[1].body.messages)).toContain('First.');

    const [reply] = await say(ADA_CHAT, '/newchat');
    expect(reply).toMatchObject({ text: ASSISTANT_REPLIES.newChat });
    script.push(answer([{ text: english('Fresh.', 'Three') }]));
    await say(ADA_CHAT, 'Three');
    const conversations = await conversationsOf(adaId);
    expect(conversations).toHaveLength(2);
    expect(JSON.stringify(chatCalls()[2].body.messages)).not.toContain(
      'First.',
    );
    expect(
      (
        await ctx.prisma.telegramLink.findUniqueOrThrow({
          where: { userId: adaId },
        })
      ).assistantConversationId,
    ).toBe(conversations[1].id);

    const [help] = await say(ADA_CHAT, '/help');
    expect(help.text).toBe(HELP_TEXT);
    expect(HELP_TEXT).toContain(
      '/newchat — Start a new conversation with the AI assistant',
    );
  });

  it('ignores text from an unlinked chat and from a group', async () => {
    expect(await say(UNLINKED_CHAT, 'hello?')).toEqual([]);
    expect(
      sent(await poll(groupMessage(nextUpdate++, -100, 'hello?'))),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.assistantConversation.count()).toBe(0);
  });

  it('refuses a write to a member below operator: nothing is queued', async () => {
    script.push(
      answer([
        {
          tool: {
            id: 'toolu_1',
            name: 'queue_card',
            input: { title: 'Fix the flaky test', body: 'board.spec.ts:88' },
          },
        },
      ]),
      answer([{ text: english('You cannot queue cards.', 'Queue a card.') }]),
    );
    const replies = await say(VIC_CHAT, 'Queue a card.');
    expect(replies.map((r) => r.text)).toEqual(['You cannot queue cards\\.']);
    const results = JSON.stringify(chatCalls()[1].body.messages);
    expect(results).toContain('needs the operator role');
    expect(await ctx.prisma.boardCard.count()).toBe(0);
  });

  it('starts the conversation on the chat’s current project', async () => {
    await ctx.prisma.telegramLink.update({
      where: { userId: adaId },
      data: { currentProjectId: gadget },
    });
    script.push(answer([{ text: english('On gadget.', 'Hi') }]));
    await say(ADA_CHAT, 'Hi');
    const [conversation] = await conversationsOf(adaId);
    expect(conversation.projectId).toBe(gadget);
    expect(chatCalls()[0].system).toContain('gadget');
  });

  it('leaves the project to the assistant without a current one', async () => {
    script.push(answer([{ text: english('Which one?', 'Hi') }]));
    await say(ADA_CHAT, 'Hi');
    const [conversation] = await conversationsOf(adaId);
    expect(conversation.projectId).toBeNull();
  });

  it('splits a long reply into messages Telegram takes', async () => {
    const line = 'Card C-1 (bug) is done, and the next one is queued.';
    const long = Array.from({ length: 150 }, () => line).join('\n');
    script.push(answer([{ text: english(long, 'Status?') }]));
    const replies = await say(ADA_CHAT, 'Status?');
    expect(replies.length).toBeGreaterThan(1);
    for (const reply of replies) {
      expect(String(reply.text).length).toBeLessThanOrEqual(4096);
      expect(reply.parse_mode).toBe('MarkdownV2');
    }
    expect(replies.map((r) => r.text).join('\n')).toBe(
      long.replace(/[-().]/g, (c) => `\\${c}`),
    );
  });

  it('sends a fixed message naming the provider and the reset day at the cap', async () => {
    expect(
      (
        await root.send('patch', '/admin/llm/providers/anthropic', {
          capUsd: 1,
        })
      ).status,
    ).toBe(200);
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
    llm.clock.now = new Date('2026-10-17T12:00:00Z');
    const replies = await say(ADA_CHAT, 'Hello');
    expect(replies).toEqual([
      expect.objectContaining({
        text: 'Anthropic reached its monthly AI spending cap. The assistant answers again on 1 November 2026 (UTC).',
      }),
    ]);
    expect(replies[0].parse_mode).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('puts the existing Approve / Deny buttons on a reply that requested an action', async () => {
    await ctx.prisma.telegramLink.update({
      where: { userId: adaId },
      data: { currentProjectId: widget },
    });
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
      answer([{ text: english('Asked in Approvals.', 'Stop the fleet.') }]),
    );
    const replies = await say(ADA_CHAT, 'Stop the fleet.');
    const request = await ctx.prisma.actionRequest.findFirstOrThrow();
    expect(request).toMatchObject({ status: 'pending', requestedById: adaId });
    const buttons = (
      replies.at(-1)?.reply_markup as {
        inline_keyboard: InlineKeyboardButton[][];
      }
    ).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['Approve', 'Deny']);
    expect(buttons[0].callback_data).toMatch(
      new RegExp(`^x:\\d+:${request.id}$`),
    );
    expect(buttons[1].callback_data).toMatch(
      new RegExp(`^y:\\d+:${request.id}$`),
    );
  });

  it('attaches a captioned photo as a file of the conversation', async () => {
    await ctx.prisma.telegramLink.update({
      where: { userId: adaId },
      data: { currentProjectId: widget },
    });
    ctx.fake.addFile('ph-big', JPEG);
    script.push(answer([{ text: english('A screenshot.', 'What is this?') }]));
    const replies = sent(
      await poll(
        mediaMessage(
          nextUpdate++,
          ADA_CHAT,
          {
            photo: [
              {
                file_id: 'ph-small',
                file_unique_id: 's',
                width: 90,
                height: 90,
              },
              {
                file_id: 'ph-big',
                file_unique_id: 'b',
                width: 800,
                height: 600,
              },
            ],
          },
          'What is this?',
        ),
      ),
    );
    expect(replies.map((r) => r.text)).toEqual(['A screenshot\\.']);
    expect(ctx.fake.downloads).toEqual(['ph-big']);
    const [conversation] = await conversationsOf(adaId);
    const attachment = await ctx.prisma.assistantAttachment.findFirstOrThrow({
      where: { conversationId: conversation.id },
      include: { attachment: true },
    });
    expect(attachment).toMatchObject({
      kind: 'file',
      attachment: { projectId: widget, mime: 'image/jpeg' },
    });
    expect(attachment.messageId).not.toBeNull();
    expect(JSON.stringify(chatCalls()[0].body.messages)).toContain(
      '"type":"image"',
    );
  });

  it('asks for a project before storing a photo, and for a caption', async () => {
    const photo = {
      photo: [{ file_id: 'ph', file_unique_id: 'p', width: 9, height: 9 }],
    };
    ctx.fake.addFile('ph', JPEG);
    const noProject = sent(
      await poll(mediaMessage(nextUpdate++, ADA_CHAT, photo, 'Look')),
    );
    expect(noProject.map((r) => r.text)).toEqual([
      ASSISTANT_REPLIES.photoNeedsProject,
    ]);
    const noCaption = sent(
      await poll(mediaMessage(nextUpdate++, ADA_CHAT, photo)),
    );
    expect(noCaption.map((r) => r.text)).toEqual([
      ASSISTANT_REPLIES.photoNeedsCaption,
    ]);
    expect(calls).toHaveLength(0);
    expect(await ctx.prisma.attachment.count()).toBe(0);
  });
});
