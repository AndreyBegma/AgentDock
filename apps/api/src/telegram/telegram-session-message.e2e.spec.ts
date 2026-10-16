import { CARD_WAITING_EVENT, type PendingQuestion } from '@agentdock/shared';
import type { SessionMessageArgs } from '@agentdock/shared/protocol';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore } from '../notifications';
import {
  insertEvent,
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import {
  type CommandSendResult,
  RunnerCommandService,
} from '../runners/runner-command.service';
import { SessionMessageService } from '../session-message/session-message.service';
import { decodeSessionOptionCallback } from './session-message-actions';
import type { InlineKeyboardButton } from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  callbackPress,
  replyMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const OPERATOR_CHAT = 6001;
const VIEWER_CHAT = 6002;
const RUN_ID = 'cm1run00000000000000000001';

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

describe('Telegram: a waiting card answered from the chat (#489 M2, e2e)', () => {
  let ctx: TelegramE2e;
  let poller: TelegramPoller;
  let delivery: TelegramDeliveryService;
  let commands: RunnerCommandService;
  let projectId: string;
  let cardId: string;
  let operatorId: string;
  let viewerId: string;
  let nextUpdate = 1;
  let outcome: CommandSendResult<'session.message'>;

  const messagesSent = () =>
    jest
      .mocked(commands.send)
      .mock.calls.filter(([, name]) => name === 'session.message')
      .map(([, , args]) => args as SessionMessageArgs);

  const poll = async (...updates: { update_id: number }[]) => {
    ctx.fake.updates = updates;
    expect(await poller.pollOnce()).toEqual({
      status: 'polled',
      updates: updates.length,
    });
  };

  const sentTo = (chatId: number) =>
    ctx.fake.sent().filter((c) => c.body.chat_id === chatId);
  const buttonsSentTo = (chatId: number): InlineKeyboardButton[] => {
    const markup = sentTo(chatId).find((c) => c.body.reply_markup)?.body
      .reply_markup as
      | { inline_keyboard: InlineKeyboardButton[][] }
      | undefined;
    return markup?.inline_keyboard.flat() ?? [];
  };
  const lastTextTo = (chatId: number) =>
    sentTo(chatId).at(-1)?.body.text as string | undefined;
  /** The text a reply quotes: the waiting message as Telegram shows it. */
  const shownText = (chatId: number) =>
    (sentTo(chatId)[0]?.body.text as string).replace(/\\(.)/g, '$1');

  /** A `card.waiting` notification for `userId`, pending on Telegram. */
  const notify = async (userId: string, eventId: bigint) =>
    ctx.prisma.notification.create({
      data: {
        userId,
        kind: 'card.waiting',
        projectId,
        title: 'Card C-1 is waiting for you',
        body: 'Its worker asks you a question in its session.',
        link: `/projects/${projectId}/board?card=1`,
        eventId,
        firstAt: new Date(),
        lastAt: new Date(),
        deliveries: {
          create: {
            userId,
            channel: 'telegram',
            status: 'pending',
            nextAttemptAt: new Date(),
          },
        },
      },
    });

  beforeAll(async () => {
    ctx = await createTelegramApp();
    poller = ctx.app.get(TelegramPoller);
    delivery = ctx.app.get(TelegramDeliveryService);
    commands = ctx.app.get(RunnerCommandService);
  });
  afterAll(() => ctx.close());

  const setup = async (question: PendingQuestion | null) => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
    let runnerId: string;
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    operatorId = (
      await seedUser(ctx.prisma, 'op@example.com', 'operator', projectId)
    ).id;
    viewerId = (
      await seedUser(ctx.prisma, 'view@example.com', 'viewer', projectId)
    ).id;
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', operatorId, { actor: SYSTEM_ACTOR });
    await ctx.prisma.telegramLink.createMany({
      data: [
        { userId: operatorId, chatId: BigInt(OPERATOR_CHAT) },
        { userId: viewerId, chatId: BigInt(VIEWER_CHAT) },
      ],
    });
    await ctx.prisma.run.create({
      data: {
        id: RUN_ID,
        kind: 'card',
        projectId,
        status: 'waiting_person',
        triggeredByType: 'user',
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const card = await ctx.prisma.boardCard.create({
      data: {
        projectId,
        number: 1,
        shortId: 'ab12cd34',
        title: 'Add login',
        position: 1,
        issueOnRun: false,
        specOnRun: false,
        column: 'in_progress',
        movedAt: new Date(),
        rounds: {
          create: {
            round: 1,
            runId: RUN_ID,
            trigger: 'run',
            cardTitle: 'Add login',
            cardBody: '',
            cardKind: 'feature',
            phase: 'waiting',
            tmuxSession: 'agentdock-card-ab12cd34',
            ...(question ? { pendingQuestion: question } : {}),
          },
        },
      },
    });
    cardId = card.id;
    const eventId = await insertEvent(ctx.prisma, runnerId, {
      type: CARD_WAITING_EVENT,
      source: 'api',
      slot: null,
      issue: null,
      data: {
        cardId,
        number: 1,
        title: 'Add login',
        round: 1,
        reason: 'question',
      },
    });
    await notify(operatorId, eventId);
    await notify(viewerId, eventId);
    jest
      .spyOn(ctx.app.get(SessionMessageService), 'available')
      .mockResolvedValue(true);
    const original = commands.send.bind(commands);
    jest
      .spyOn(commands, 'send')
      .mockImplementation(async (runner, name, args, options) =>
        name === 'session.message'
          ? (outcome as never)
          : original(runner, name, args, options),
      );
    outcome = { status: 'ok', output: { outcome: 'answered' }, rttMs: 1 };
    expect(await delivery.deliverOnce()).toMatchObject({ sent: 2 });
  };
  afterEach(() => jest.restoreAllMocks());

  it('the question arrives with one button per option, and a press answers it', async () => {
    await setup(QUESTION);
    const buttons = buttonsSentTo(OPERATOR_CHAT);
    expect(buttons.map((b) => b.text)).toEqual([
      '1. Add it to glass-ui',
      '2. Use a Toolbar',
    ]);
    expect(lastTextTo(OPERATOR_CHAT)).toContain('SelectionBar is missing');
    const second = buttons[1]?.callback_data ?? '';
    expect(Buffer.byteLength(second)).toBeLessThanOrEqual(64);
    expect(decodeSessionOptionCallback(second)).toMatchObject({
      questionKey: QUESTION.key,
      index: 2,
    });

    await poll(callbackPress(nextUpdate++, OPERATOR_CHAT, second));
    expect(messagesSent()).toEqual([
      {
        projectId,
        target: { kind: 'card_round', cardId, runId: RUN_ID },
        message: { kind: 'option', questionKey: QUESTION.key, index: 2 },
      },
    ]);
    expect(lastTextTo(OPERATOR_CHAT)).toBe('Answered.');
    const [record] = await ctx.prisma.auditRecord.findMany({
      where: { action: 'card.message', actorUserId: operatorId },
    });
    expect(record).toMatchObject({ result: 'ok', projectId });
    expect(record?.after).toMatchObject({ kind: 'option', via: 'telegram' });
  });

  it('a reply while the question offers "Other" is the typed answer', async () => {
    await setup(QUESTION);
    await poll(
      replyMessage(
        nextUpdate++,
        OPERATOR_CHAT,
        'Use a Popover',
        shownText(OPERATOR_CHAT),
      ),
    );
    expect(messagesSent().map((a) => a.message)).toEqual([
      { kind: 'other', questionKey: QUESTION.key, text: 'Use a Popover' },
    ]);
  });

  it('a reply with no question up is a message to the session', async () => {
    await setup(null);
    expect(buttonsSentTo(OPERATOR_CHAT)).toEqual([]);
    expect(lastTextTo(OPERATOR_CHAT)).toContain('Reply to this message');
    outcome = { status: 'ok', output: { outcome: 'sent' }, rttMs: 1 };
    await poll(
      replyMessage(
        nextUpdate++,
        OPERATOR_CHAT,
        'Also update the changelog',
        shownText(OPERATOR_CHAT),
      ),
    );
    expect(messagesSent().map((a) => a.message)).toEqual([
      { kind: 'text', text: 'Also update the changelog' },
    ]);
    expect(lastTextTo(OPERATOR_CHAT)).toContain('Sent.');
  });

  it("a viewer's press, an unlinked chat and another user's message are refused and audited; nothing is sent", async () => {
    await setup(QUESTION);
    const viewerButton = buttonsSentTo(VIEWER_CHAT)[0]?.callback_data ?? '';
    await poll(callbackPress(nextUpdate++, VIEWER_CHAT, viewerButton));
    expect(lastTextTo(VIEWER_CHAT)).toContain('operator role');
    // The operator's button pressed from the viewer's chat names another user's message.
    const operatorButton = buttonsSentTo(OPERATOR_CHAT)[0]?.callback_data ?? '';
    await poll(callbackPress(nextUpdate++, VIEWER_CHAT, operatorButton));
    await poll(callbackPress(nextUpdate++, 9999, operatorButton));
    expect(messagesSent()).toEqual([]);
    const refusals = await ctx.prisma.auditRecord.findMany({
      where: { action: 'card.message', result: 'denied' },
      orderBy: { seq: 'asc' },
    });
    expect(refusals.map((r) => (r.after as { reason: string }).reason)).toEqual(
      ['role', 'unknown_message', 'not_linked'],
    );
  });

  it('a card whose round no longer runs goes out without buttons, and a stale button sends nothing', async () => {
    await setup(QUESTION);
    const button = buttonsSentTo(OPERATOR_CHAT)[0]?.callback_data ?? '';
    await ctx.prisma.boardCardRound.updateMany({
      where: { runId: RUN_ID },
      data: { phase: 'finished' },
    });
    await poll(callbackPress(nextUpdate++, OPERATOR_CHAT, button));
    expect(messagesSent()).toEqual([]);
    expect(lastTextTo(OPERATOR_CHAT)).toContain('not one AgentDock can act on');
  });
});
