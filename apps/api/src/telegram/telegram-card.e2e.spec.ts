import { CARD_FINISHED_EVENT, CARDS_SUGGESTED_EVENT } from '@agentdock/shared';
import type { SessionMessageArgs } from '@agentdock/shared/protocol';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import {
  BoardWorld,
  HEAD_SHA,
  ok,
  prInspection,
  ROOT_A,
} from '../board/testing/board-e2e';
import { BotTokenStore } from '../notifications';
import {
  insertEvent,
  resetNotifications,
} from '../notifications/testing/notifications-e2e';
import { RunnerCommandService } from '../runners/runner-command.service';
import { SessionMessageService } from '../session-message/session-message.service';
import { CARD_ACTION_CALLBACK } from './card-actions';
import type { InlineKeyboardButton } from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  callbackPress,
  type FakeCall,
  FakeTelegram,
  privateMessage,
  replyMessage,
} from './testing/fake-telegram';
import { createTelegramApp } from './testing/telegram-e2e';

const OPERATOR_CHAT = 7001;
const VIEWER_CHAT = 7002;

type Markup = {
  inline_keyboard?: InlineKeyboardButton[][];
  force_reply?: boolean;
};

/**
 * #578: a card's review actions from Telegram, on the fake Bot API, through
 * the Board services the web calls (`BoardWorld` answers the runner).
 */
describe('Telegram: feedback, accept, finish and message cards (#578, e2e)', () => {
  const w = new BoardWorld();
  let fake: FakeTelegram;
  let poller: TelegramPoller;
  let delivery: TelegramDeliveryService;
  let runnerCommands: RunnerCommandService;
  let viewerId: string;
  let nextUpdate = 1;

  beforeAll(async () => {
    fake = await FakeTelegram.start();
    await w.init(() => createTelegramApp(undefined, fake));
    poller = w.ctx.app.get(TelegramPoller);
    delivery = w.ctx.app.get(TelegramDeliveryService);
    runnerCommands = w.ctx.app.get(RunnerCommandService);
  });
  afterAll(async () => {
    await w.close();
    await fake.close();
  });

  beforeEach(async () => {
    await resetNotifications(w.ctx.prisma);
    await w.reset();
    fake.reset();
    viewerId = (
      await w.ctx.prisma.user.findUniqueOrThrow({
        where: { email: 'viewer@x.test' },
      })
    ).id;
    await w.ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', w.operatorId, { actor: SYSTEM_ACTOR });
    await w.ctx.prisma.telegramLink.createMany({
      data: [
        { userId: w.operatorId, chatId: BigInt(OPERATOR_CHAT) },
        { userId: viewerId, chatId: BigInt(VIEWER_CHAT) },
      ],
    });
    jest
      .spyOn(w.ctx.app.get(SessionMessageService), 'available')
      .mockResolvedValue(true);
    const original = runnerCommands.send.bind(runnerCommands);
    jest
      .spyOn(runnerCommands, 'send')
      .mockImplementation(async (runner, name, args, options) =>
        name === 'session.message'
          ? ({
              status: 'ok',
              output: { outcome: 'sent' },
              rttMs: 1,
            } as never)
          : original(runner, name, args, options),
      );
  });
  afterEach(async () => {
    jest.mocked(runnerCommands.send).mockRestore();
    jest.mocked(w.ctx.app.get(SessionMessageService).available).mockRestore();
    await w.work.settled();
  });

  const poll = async (...updates: { update_id: number }[]) => {
    fake.updates = updates;
    expect(await poller.pollOnce()).toEqual({
      status: 'polled',
      updates: updates.length,
    });
  };
  /** What the bot sent or edited in `chatId`, in order. */
  const outTo = (chatId: number): FakeCall[] =>
    fake.calls.filter(
      (c) =>
        (c.method === 'sendMessage' || c.method === 'editMessageText') &&
        c.body.chat_id === chatId,
    );
  const last = (chatId: number) => {
    const call = outTo(chatId).at(-1);
    if (!call) throw new Error(`nothing sent to ${chatId}`);
    return {
      method: call.method,
      text: call.body.text as string,
      messageId: call.body.message_id as number | undefined,
      markup: call.body.reply_markup as Markup | undefined,
    };
  };
  const buttons = (markup: Markup | undefined) =>
    markup?.inline_keyboard?.flat() ?? [];
  const button = (markup: Markup | undefined, text: string): string => {
    const found = buttons(markup).find((b) => b.text === text);
    if (!found) throw new Error(`no "${text}" button`);
    return found.callback_data;
  };
  const shortId = async (number: number) => (await w.card(number)).shortId;
  const detail = async (number: number) =>
    (await w.operator.get(`${w.path()}/board/cards/${number}`)).body as {
      column: string;
      rounds: { feedback: string | null }[];
    };
  const audits = async (result: string) =>
    (await w.audit('telegram.card')).filter((r) => r.result === result);

  /** C-1 run, then marked finished: its collect opened PR #77. */
  const finishedCard = async () => {
    await w.createCard();
    expect((await w.runCard(1)).status).toBe(200);
    expect(
      (await w.operator.send('post', `${w.path()}/board/cards/1/finish`, {}))
        .status,
    ).toBe(200);
    await w.work.settled();
    expect(await w.card(1)).toMatchObject({
      column: 'finished',
      prNumber: 77,
    });
  };

  /** A notification of `kind` for `userId` about event `data`, pending on Telegram. */
  const notify = async (
    userId: string,
    kind: string,
    type: string,
    data: object,
  ) => {
    const eventId = await insertEvent(w.ctx.prisma, w.runnerId, {
      type,
      source: 'api',
      slot: null,
      issue: null,
      root: ROOT_A,
      data,
    });
    await w.ctx.prisma.notification.create({
      data: {
        userId,
        kind,
        projectId: w.a,
        title: 'Card C-1 is finished',
        body: 'PR #77 is ready for review.',
        link: `/projects/${w.a}/board?card=1`,
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
  };

  const openCard = async (chatId: number, number: number) => {
    await poll(privateMessage(nextUpdate++, chatId, `/card ${number}`));
    return last(chatId);
  };

  it('Feedback: the Finished notification carries it; the reply sends the card back with the text', async () => {
    await finishedCard();
    const { id: cardId } = await w.card(1);
    for (const userId of [w.operatorId, viewerId]) {
      await notify(userId, 'card.finished', CARD_FINISHED_EVENT, {
        cardId,
        number: 1,
        title: 'Add login',
        round: 1,
        finishedBy: 'person',
        prNumber: 77,
        prUrl: 'https://github.com/acme/widget/pull/77',
      });
    }
    expect(await delivery.deliverOnce()).toMatchObject({ sent: 2 });
    const notification = last(OPERATOR_CHAT);
    expect(buttons(notification.markup).map((b) => b.text)).toEqual([
      'Accept',
      'Give feedback',
    ]);
    // A viewer gets no review buttons.
    expect(last(VIEWER_CHAT).markup).toBeUndefined();

    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(notification.markup, 'Give feedback'),
      ),
    );
    const prompt = last(OPERATOR_CHAT);
    expect(prompt.method).toBe('sendMessage');
    expect(prompt.markup).toMatchObject({ force_reply: true });
    expect(prompt.text).toContain('Reply to this message with your feedback');

    await poll(
      replyMessage(
        nextUpdate++,
        OPERATOR_CHAT,
        'Rename the button.',
        prompt.text,
      ),
    );
    expect(last(OPERATOR_CHAT).text).toContain(
      'Feedback sent. C-1 is back in progress.',
    );
    // The web app's card shows it.
    const card = await detail(1);
    expect(card.column).toBe('in_progress');
    expect(card.rounds.map((r) => r.feedback)).toContain('Rename the button.');
    expect(w.sent('card.run')).toHaveLength(2);
    const [audit] = await audits('ok');
    expect(audit).toMatchObject({ projectId: w.a });
    expect(audit?.after).toMatchObject({ number: 1, action: 'feedback' });
    expect(audit?.meta).toMatchObject({ via: 'telegram' });
  });

  it("Message session: a reply goes to the card's running round, and a fleet card's to its slot", async () => {
    await w.createCard();
    await w.runCard(1);
    const card = await openCard(OPERATOR_CHAT, 1);
    expect(card.text).toContain('C-1 · In progress');
    expect(buttons(card.markup).map((b) => b.text)).toEqual([
      'Message session',
      'Finish',
    ]);
    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(card.markup, 'Message session'),
      ),
    );
    const prompt = last(OPERATOR_CHAT);
    expect(prompt.markup).toMatchObject({ force_reply: true });
    await poll(
      replyMessage(
        nextUpdate++,
        OPERATOR_CHAT,
        'Also update the changelog',
        prompt.text,
      ),
    );
    expect(last(OPERATOR_CHAT).text).toContain('Sent.');

    // A fleet card at work: the runner appends it to the orchestrator's log.
    await w.ctx.prisma.boardCard.create({
      data: {
        projectId: w.a,
        number: 2,
        shortId: 'fl33tc4d',
        title: 'Fleet work',
        position: 2,
        issueOnRun: false,
        specOnRun: false,
        column: 'in_progress',
        source: 'fleet',
        fleetIssue: 41,
        fleetSlot: 'slot-2',
        movedAt: new Date(),
      },
    });
    const fleet = await openCard(OPERATOR_CHAT, 2);
    expect(buttons(fleet.markup).map((b) => b.text)).toEqual([
      'Message session',
    ]);
    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(fleet.markup, 'Message session'),
      ),
    );
    const fleetPrompt = last(OPERATOR_CHAT);
    expect(fleetPrompt.text).toContain('goes to slot-2');
    await poll(
      replyMessage(
        nextUpdate++,
        OPERATOR_CHAT,
        'Rebase first',
        fleetPrompt.text,
      ),
    );

    const sent = jest
      .mocked(runnerCommands.send)
      .mock.calls.filter(([, name]) => name === 'session.message')
      .map(([, , args]) => args as SessionMessageArgs);
    const { id: cardId, rounds } = await w.card(1);
    expect(sent).toEqual([
      {
        projectId: w.a,
        target: { kind: 'card_round', cardId, runId: rounds[0]?.runId },
        message: { kind: 'text', text: 'Also update the changelog' },
      },
      {
        projectId: w.a,
        target: { kind: 'fleet_slot', root: ROOT_A, slot: 'slot-2' },
        message: { kind: 'text', text: 'Rebase first' },
      },
    ]);
    const messages = await w.ctx.prisma.auditRecord.findMany({
      where: { action: { in: ['card.message', 'slot.session_message'] } },
      orderBy: { seq: 'asc' },
    });
    expect(messages.map((m) => m.action)).toEqual([
      'card.message',
      'slot.session_message',
    ]);
    for (const m of messages) {
      expect(m.after).toMatchObject({ via: 'telegram' });
    }
  });

  it('Accept asks first, merges at the head it showed, and the card is Completed', async () => {
    await finishedCard();
    const card = await openCard(OPERATOR_CHAT, 1);
    await poll(
      callbackPress(nextUpdate++, OPERATOR_CHAT, button(card.markup, 'Accept')),
    );
    const confirm = last(OPERATOR_CHAT);
    expect(confirm.text).toBe(
      'Accept C-1?\nThis merges PR #77 into develop and moves the card to Completed.',
    );
    // Nothing happens before the confirm tap.
    expect(w.sent('card.merge')).toEqual([]);
    expect((await detail(1)).column).toBe('finished');

    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(confirm.markup, 'Accept and merge'),
        42,
      ),
    );
    expect(w.sent('card.merge')).toEqual([
      expect.objectContaining({ pr: 77, headSha: HEAD_SHA }),
    ]);
    const result = last(OPERATOR_CHAT);
    expect(result).toMatchObject({ method: 'editMessageText', messageId: 42 });
    expect(result.text).toMatch(
      /^C-1 accepted · Completed\. PR #77 is merged\.\n\nwidget · C-1 · Completed/,
    );
    // The web Board shows it.
    const board = await w.operator.get(`${w.path()}/board`);
    const completed = (
      board.body as {
        columns: { column: string; cards: { number: number }[] }[];
      }
    ).columns.find((c) => c.column === 'completed');
    expect(completed?.cards.map((c) => c.number)).toEqual([1]);
  });

  it('Accept refuses a merge once the head moved, and the card stays in Finished', async () => {
    await finishedCard();
    const card = await openCard(OPERATOR_CHAT, 1);
    await poll(
      callbackPress(nextUpdate++, OPERATOR_CHAT, button(card.markup, 'Accept')),
    );
    const confirm = last(OPERATOR_CHAT);
    w.handlers['pr.inspect'] = () =>
      ok(prInspection({ headSha: 'b'.repeat(40) }));
    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(confirm.markup, 'Accept and merge'),
      ),
    );
    expect(last(OPERATOR_CHAT).text).toContain('new commits');
    expect(w.sent('card.merge')).toEqual([]);
    expect((await detail(1)).column).toBe('finished');
  });

  it('Finish asks first; Cancel changes nothing, the confirm tap moves the card to Finished', async () => {
    await w.createCard();
    await w.runCard(1);
    const card = await openCard(OPERATOR_CHAT, 1);
    const finish = button(card.markup, 'Finish');

    await poll(callbackPress(nextUpdate++, OPERATOR_CHAT, finish));
    const first = last(OPERATOR_CHAT);
    expect(first.text).toContain('Mark C-1 finished?');
    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(first.markup, 'Cancel'),
        50,
      ),
    );
    expect(last(OPERATOR_CHAT)).toMatchObject({
      method: 'editMessageText',
      messageId: 50,
      text: 'Cancelled. Nothing changed.',
    });
    expect((await detail(1)).column).toBe('in_progress');

    await poll(callbackPress(nextUpdate++, OPERATOR_CHAT, finish));
    const second = last(OPERATOR_CHAT);
    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(second.markup, 'Finish'),
        51,
      ),
    );
    const result = last(OPERATOR_CHAT);
    expect(result).toMatchObject({ method: 'editMessageText', messageId: 51 });
    expect(result.text).toMatch(/^C-1 marked finished · Finished\./);
    // Create pull request too, until the collect it started is done.
    expect(buttons(result.markup).map((b) => b.text)).toEqual(
      expect.arrayContaining(['Accept', 'Give feedback']),
    );
    expect((await detail(1)).column).toBe('finished');
  });

  it('an Inbox suggestion is accepted into To do or dismissed from its notification', async () => {
    const ids: string[] = [];
    for (const number of [1, 2]) {
      const card = await w.ctx.prisma.boardCard.create({
        data: {
          projectId: w.a,
          number,
          shortId: `inbox00${number}`,
          title: `Suggested ${number}`,
          position: number,
          issueOnRun: false,
          specOnRun: false,
          column: 'inbox',
          source: 'captured',
          movedAt: new Date(),
        },
      });
      ids.push(card.id);
    }
    await notify(w.operatorId, 'cards.suggested', CARDS_SUGGESTED_EVENT, {
      captureId: 'cap1',
      sessionId: 'ses1',
      count: 2,
      cardIds: ids,
    });
    expect(await delivery.deliverOnce()).toMatchObject({ sent: 1 });
    const notification = last(OPERATOR_CHAT);
    expect(buttons(notification.markup).map((b) => b.text)).toEqual([
      'Accept C-1',
      'Dismiss C-1',
      'Accept C-2',
      'Dismiss C-2',
    ]);

    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(notification.markup, 'Accept C-1'),
        60,
      ),
    );
    expect(last(OPERATOR_CHAT)).toMatchObject({
      method: 'editMessageText',
      messageId: 60,
    });
    expect(last(OPERATOR_CHAT).text).toMatch(/^C-1 accepted into To do\./);
    expect((await detail(1)).column).toBe('todo');

    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(notification.markup, 'Dismiss C-2'),
        60,
      ),
    );
    expect(last(OPERATOR_CHAT).text).toContain('C-2 dismissed.');
    expect(
      await w.ctx.prisma.boardCard.findUnique({ where: { id: ids[1] } }),
    ).toBeNull();
  });

  it("refuses, server-side and audited, an action the card's state does not allow and a viewer's press", async () => {
    await w.createCard();
    await w.runCard(1);
    const id = await shortId(1);

    // A forged Accept on a running card: not offered, and refused.
    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        CARD_ACTION_CALLBACK.encode({ card: id, action: 'accept' }),
      ),
    );
    expect(last(OPERATOR_CHAT).text).toContain(
      "The card's state does not allow that now",
    );

    // A viewer sees the card without buttons, and a forged press is refused.
    const viewerCard = await openCard(VIEWER_CHAT, 1);
    expect(viewerCard.text).toContain('C-1 · In progress');
    expect(viewerCard.markup).toBeUndefined();
    await poll(
      callbackPress(
        nextUpdate++,
        VIEWER_CHAT,
        CARD_ACTION_CALLBACK.encode({ card: id, action: 'finish' }),
      ),
    );
    expect(last(VIEWER_CHAT).text).toContain('Your role on this project');
    // An unlinked chat is refused too.
    await poll(
      callbackPress(
        nextUpdate++,
        9999,
        CARD_ACTION_CALLBACK.encode({ card: id, action: 'finish' }),
      ),
    );
    expect(last(9999).text).toContain('not linked');

    expect((await detail(1)).column).toBe('in_progress');
    expect(w.sent('card.stop')).toEqual([]);
    const denied = await audits('denied');
    expect(
      denied.map((r) => [r.actorUserId, (r.meta as { reason: string }).reason]),
    ).toEqual([
      [w.operatorId, 'not_allowed'],
      [viewerId, 'role'],
    ]);
  });
});
