import { createHash } from 'node:crypto';
import {
  CARD_DEMO_EVENT,
  type CardDemoView,
  TELEGRAM_BOT_UPLOAD_MAX_BYTES,
} from '@nautelle/shared';
import {
  FILES,
  useTempAttachmentsDir,
} from '../attachments/testing/attachments-e2e';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BoardWorld, HEAD_SHA } from '../board/testing/board-e2e';
import { BotTokenStore } from '../notifications';
import { NotificationMatcher } from '../notifications/notification-matcher';
import { resetNotifications } from '../notifications/testing/notifications-e2e';
import {
  generateRunnerToken,
  hashRunnerToken,
  tokenPrefix,
} from '../runners/credentials';
import { CARD_ACTION_CALLBACK } from './card-actions';
import type { InlineButton } from './telegram-client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  callbackPress,
  type FakeCall,
  FakeTelegram,
  replyMessage,
} from './testing/fake-telegram';
import { createTelegramApp } from './testing/telegram-e2e';

useTempAttachmentsDir();

const OPERATOR_CHAT = 7101;
const VIEWER_CHAT = 7102;
const ADMIN_CHAT = 7103;

type Markup = { inline_keyboard?: InlineButton[][]; force_reply?: boolean };

const sha256 = (body: Buffer): string =>
  createHash('sha256').update(body).digest('hex');

/**
 * C-372 (ADR-0095): a card's demo video sent to Telegram, on the fake Bot API,
 * from the runner's upload through the notification matcher to the delivery
 * pass, and its Merge and Feedback buttons through #578's card actions.
 */
describe('Telegram: a card demo with Merge and Feedback (C-372, e2e)', () => {
  const w = new BoardWorld();
  let fake: FakeTelegram;
  let poller: TelegramPoller;
  let delivery: TelegramDeliveryService;
  let matcher: NotificationMatcher;
  let viewerId: string;
  let adminId: string;
  let nextUpdate = 1;

  beforeAll(async () => {
    fake = await FakeTelegram.start();
    await w.init(() => createTelegramApp(undefined, fake));
    poller = w.ctx.app.get(TelegramPoller);
    delivery = w.ctx.app.get(TelegramDeliveryService);
    matcher = w.ctx.app.get(NotificationMatcher);
  });
  afterAll(async () => {
    await w.close();
    await fake.close();
  });

  beforeEach(async () => {
    await resetNotifications(w.ctx.prisma);
    await w.reset();
    fake.reset();
    const id = async (email: string) =>
      (await w.ctx.prisma.user.findUniqueOrThrow({ where: { email } })).id;
    viewerId = await id('viewer@x.test');
    adminId = await id('admin@x.test');
    await w.ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', w.operatorId, { actor: SYSTEM_ACTOR });
    // The first pass only places the matcher's cursor.
    await matcher.tick();
  });
  afterEach(() => w.work.settled());

  const link = (...links: [string, number][]) =>
    w.ctx.prisma.telegramLink.createMany({
      data: links.map(([userId, chatId]) => ({
        userId,
        chatId: BigInt(chatId),
      })),
    });
  const settings = (body: object) =>
    w.admin.send('patch', `${w.path()}/demos/settings`, body);

  /** C-1 run and marked finished (PR #77), with demo videos on. */
  const finishedCard = async () => {
    expect((await settings({ enabled: true })).status).toBe(200);
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
    // The CI watcher saw the checks pass.
    await w.ctx.prisma.boardCard.updateMany({
      where: { projectId: w.a, number: 1 },
      data: { ciState: 'green' },
    });
  };
  const requested = async (): Promise<CardDemoView> => {
    const response = await w.operator.send(
      'post',
      `${w.path()}/board/cards/1/demos`,
    );
    expect(response.status).toBe(201);
    return response.body as CardDemoView;
  };
  /** The runner uploads demo `demoId`'s video, which makes it ready. */
  const uploaded = async (demoId: string): Promise<CardDemoView> => {
    const token = generateRunnerToken();
    await w.ctx.prisma.runner.update({
      where: { id: w.runnerId },
      data: {
        tokenPrefix: tokenPrefix(token),
        tokenHash: await hashRunnerToken(token),
      },
    });
    const response = await w.ctx
      .http()
      .post(`/runner/cards/1/demos/${demoId}/video`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'video/mp4')
      .set('x-demo-sha256', sha256(FILES.mp4))
      .set('x-demo-duration-ms', '4200')
      .send(FILES.mp4);
    expect(response.status).toBe(201);
    return response.body as CardDemoView;
  };
  /** The matcher's passes until it has nothing left, then one delivery pass. */
  const deliver = async () => {
    for (let i = 0; i < 20; i += 1) {
      if ((await matcher.tick()) === 0) break;
    }
    return delivery.deliverOnce();
  };
  const poll = async (...updates: { update_id: number }[]) => {
    fake.updates = updates;
    expect(await poller.pollOnce()).toEqual({
      status: 'polled',
      updates: updates.length,
    });
  };
  /** What the bot sent to `chatId`, in order. */
  const outTo = (chatId: number): FakeCall[] =>
    fake.calls.filter(
      (c) =>
        ['sendMessage', 'sendVideo', 'editMessageText'].includes(c.method) &&
        c.body.chat_id === chatId,
    );
  const last = (chatId: number) => {
    const call = outTo(chatId).at(-1);
    if (!call) throw new Error(`nothing sent to ${chatId}`);
    return {
      method: call.method,
      text: (call.body.text ?? call.body.caption) as string,
      video: call.body.video,
      markup: call.body.reply_markup as Markup | undefined,
    };
  };
  /** The demo's message to `chatId`, among the card's other notifications. */
  const demoTo = (chatId: number) => {
    const calls = outTo(chatId).filter((c) =>
      String(c.body.text ?? c.body.caption).startsWith('C-1 demo'),
    );
    expect(calls).toHaveLength(1);
    const [call] = calls as [FakeCall];
    return {
      method: call.method,
      text: (call.body.text ?? call.body.caption) as string,
      video: call.body.video,
      markup: call.body.reply_markup as Markup | undefined,
    };
  };
  const noDemoTo = (chatId: number) =>
    expect(
      outTo(chatId).filter((c) =>
        String(c.body.text ?? c.body.caption).startsWith('C-1 demo'),
      ),
    ).toEqual([]);
  const buttons = (markup: Markup | undefined) =>
    markup?.inline_keyboard?.flat() ?? [];
  const button = (markup: Markup | undefined, text: string): string => {
    const found = buttons(markup).find((b) => b.text === text);
    if (!found || !('callback_data' in found)) {
      throw new Error(`no "${text}" button`);
    }
    return found.callback_data;
  };
  const demoNotifications = () =>
    w.ctx.prisma.notification.findMany({ where: { kind: 'card.demo' } });

  it('sends a ready demo as the video with the PR, CI and Merge / Feedback / Open card, once uploaded per pass', async () => {
    await link(
      [w.operatorId, OPERATOR_CHAT],
      [viewerId, VIEWER_CHAT],
      [adminId, ADMIN_CHAT],
    );
    await finishedCard();
    const demo = await uploaded((await requested()).id);
    const [event] = await w.ctx.prisma.event.findMany({
      where: { type: CARD_DEMO_EVENT },
    });
    expect(event?.data).toMatchObject({
      number: 1,
      demoId: demo.id,
      status: 'ready',
      size: FILES.mp4.length,
    });

    expect(await deliver()).toMatchObject({ failed: 0 });
    const sent = demoTo(OPERATOR_CHAT);
    expect(sent.method).toBe('sendVideo');
    expect(sent.text).toBe('C-1 demo: Add login\nPR #77 · CI green\nwidget');
    expect(buttons(sent.markup).map((b) => b.text)).toEqual([
      'Merge',
      'Feedback',
      'Open card',
    ]);
    expect(demoTo(ADMIN_CHAT).method).toBe('sendVideo');
    // Uploaded once; the second copy goes by the file_id Telegram gave it.
    const [first, second] = fake.videos();
    expect(first?.body.video).toEqual({
      name: expect.any(String),
      type: 'video/mp4',
      size: FILES.mp4.length,
    });
    expect(second?.body.video).toMatch(/^video-\d+$/);
    // Only people who can act on the project: a viewer gets nothing.
    noDemoTo(VIEWER_CHAT);
    // Telegram only: no delivery in the app.
    const rows = await w.ctx.prisma.notificationDelivery.findMany({
      where: { notification: { kind: 'card.demo' } },
      select: { channel: true },
    });
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(['telegram']));
  });

  it('sends a video over 50 MB as a message that points to the card', async () => {
    await link([w.operatorId, OPERATOR_CHAT]);
    await finishedCard();
    const demo = await uploaded((await requested()).id);
    // A stored video just over Telegram's limit for a bot.
    await w.ctx.prisma.attachment.update({
      where: { id: demo.attachmentId as string },
      data: { size: TELEGRAM_BOT_UPLOAD_MAX_BYTES + 1 },
    });

    await deliver();
    expect(fake.videos()).toEqual([]);
    const sent = demoTo(OPERATOR_CHAT);
    expect(sent.method).toBe('sendMessage');
    expect(sent.text).toContain('C-1 demo: Add login\nPR #77 · CI green');
    expect(sent.text).toContain(
      "The video is 50.0 MB, over Telegram's 50.0 MB limit for a bot: watch it on the card.",
    );
    expect(buttons(sent.markup).map((b) => b.text)).toEqual([
      'Merge',
      'Feedback',
      'Open card',
    ]);
  });

  it('Merge asks first and merges with the web checks; a viewer and an unlinked chat are refused', async () => {
    await link([w.operatorId, OPERATOR_CHAT], [viewerId, VIEWER_CHAT]);
    await finishedCard();
    await uploaded((await requested()).id);
    await deliver();
    const merge = button(demoTo(OPERATOR_CHAT).markup, 'Merge');

    // A forged Merge from a viewer's chat, and from a chat nobody linked.
    await poll(callbackPress(nextUpdate++, VIEWER_CHAT, merge));
    expect(last(VIEWER_CHAT).text).toContain('Your role on this project');
    await poll(callbackPress(nextUpdate++, 9999, merge));
    expect(outTo(9999).at(-1)?.body.text).toContain('not linked');
    expect(w.sent('card.merge')).toEqual([]);

    await poll(callbackPress(nextUpdate++, OPERATOR_CHAT, merge));
    const confirm = last(OPERATOR_CHAT);
    expect(confirm.text).toBe(
      'Accept C-1?\nThis merges PR #77 into develop and moves the card to Completed.',
    );
    expect(w.sent('card.merge')).toEqual([]);
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
    expect(await w.card(1)).toMatchObject({ column: 'completed' });
    const denied = (await w.audit('telegram.card')).filter(
      (r) => r.result === 'denied',
    );
    expect(
      denied.map((r) => [r.actorUserId, (r.meta as { reason: string }).reason]),
    ).toEqual([[viewerId, 'role']]);
  });

  it("Feedback's reply becomes the card's next round", async () => {
    await link([w.operatorId, OPERATOR_CHAT]);
    await finishedCard();
    await uploaded((await requested()).id);
    await deliver();
    const roundsBefore = (await w.card(1)).rounds.length;

    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        button(demoTo(OPERATOR_CHAT).markup, 'Feedback'),
      ),
    );
    const prompt = last(OPERATOR_CHAT);
    expect(prompt.markup).toMatchObject({ force_reply: true });
    await poll(
      replyMessage(
        nextUpdate++,
        OPERATOR_CHAT,
        'The empty state needs a hint.',
        prompt.text,
      ),
    );
    expect(last(OPERATOR_CHAT).text).toContain(
      'Feedback sent. C-1 is back in progress.',
    );
    const card = await w.card(1);
    expect(card.column).toBe('in_progress');
    expect(card.rounds).toHaveLength(roundsBefore + 1);
    expect(card.rounds.at(-1)).toMatchObject({
      feedback: 'The empty state needs a hint.',
    });
  });

  it('sends a failed demo as one line with its reason, no video', async () => {
    await link([w.operatorId, OPERATOR_CHAT]);
    await finishedCard();
    const demo = await requested();
    await w.deliver('demo.status', {
      cardId: (await w.card(1)).id,
      projectId: w.a,
      demoId: demo.id,
      status: 'failed',
      at: new Date().toISOString(),
      reason: 'readyUrl never answered',
    });

    await deliver();
    expect(fake.videos()).toEqual([]);
    expect(demoTo(OPERATOR_CHAT)).toMatchObject({
      method: 'sendMessage',
      text: 'C-1 demo failed: readyUrl never answered',
      markup: undefined,
    });
  });

  it('sends nothing when the project turned the Telegram switch off', async () => {
    await link([w.operatorId, OPERATOR_CHAT]);
    await finishedCard();
    expect((await settings({ telegram: false })).status).toBe(200);
    const demo = await requested();
    await uploaded(demo.id);
    await w.deliver('demo.status', {
      cardId: (await w.card(1)).id,
      projectId: w.a,
      demoId: (await requested()).id,
      status: 'failed',
      at: new Date().toISOString(),
      reason: 'readyUrl never answered',
    });

    await deliver();
    noDemoTo(OPERATOR_CHAT);
    expect(
      await w.ctx.prisma.event.count({ where: { type: CARD_DEMO_EVENT } }),
    ).toBe(0);
    expect(await demoNotifications()).toEqual([]);
  });

  it('sends no message to an operator who never linked Telegram, and keeps no row for them', async () => {
    await finishedCard();
    await uploaded((await requested()).id);
    expect(await deliver()).toMatchObject({ sent: 0 });
    expect(await demoNotifications()).toEqual([]);
  });

  it('keeps the Merge button off a card whose state does not allow Accept', async () => {
    await link([w.operatorId, OPERATOR_CHAT]);
    await finishedCard();
    const demo = await requested();
    // The card went back to work before the video arrived.
    await w.ctx.prisma.boardCard.updateMany({
      where: { projectId: w.a, number: 1 },
      data: { column: 'in_progress' },
    });
    await uploaded(demo.id);
    await deliver();
    const labels = buttons(demoTo(OPERATOR_CHAT).markup).map((b) => b.text);
    expect(labels).not.toContain('Merge');
    expect(labels).toContain('Open card');
    // A forged Merge changes nothing.
    await poll(
      callbackPress(
        nextUpdate++,
        OPERATOR_CHAT,
        CARD_ACTION_CALLBACK.encode({
          card: (await w.card(1)).shortId,
          action: 'accept',
        }),
      ),
    );
    expect(last(OPERATOR_CHAT).text).toContain(
      "The card's state does not allow that now",
    );
    expect(w.sent('card.merge')).toEqual([]);
  });
});
