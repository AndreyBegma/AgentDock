import type { BoardView } from '@agentdock/shared';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { BoardService } from '../board/board.service';
import { BoardCommands } from '../board/board-commands';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { BOARD_REPLIES, CARD_CALLBACK } from './board-actions';
import { CALLBACK_DATA_MAX } from './callback-data';
import type { InlineKeyboard } from './telegram-client';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  callbackPress,
  groupMessage,
  privateMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const CHAT = 8001;
const VIEWER_CHAT = 8002;
const UNLINKED_CHAT = 8999;
const MESSAGE_ID = 55;

type Body = Record<string, unknown> | undefined;

describe('Telegram Board commands (e2e, #576)', () => {
  let ctx: TelegramE2e;
  let nextUpdate = 1;
  let widget: string;
  let gadget: string;
  let adaId: string;
  let vicId: string;
  /** Every `callback_data` the bot has put on a button so far. */
  const seen = new Set<string>();

  const commands = () => ctx.app.get(BoardCommands);
  const sentCommands = (name: string) =>
    jest
      .mocked(commands().send)
      .mock.calls.filter(([, n]) => n === name)
      .map(([, , args]) => args as Record<string, unknown>);

  /** One poll; the messages the bot sent or rewrote, oldest first. */
  const poll = async (...updates: { update_id: number }[]) => {
    const before = ctx.fake.calls.length;
    ctx.fake.updates = updates;
    await ctx.app.get(TelegramPoller).pollOnce();
    const bodies = ctx.fake.calls
      .slice(before)
      .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method));
    for (const body of bodies.map((c) => c.body)) {
      for (const b of keyboardOf(body).flat()) {
        if ('callback_data' in b) seen.add(b.callback_data);
      }
    }
    return bodies;
  };
  const say = async (chatId: number, text: string) =>
    (await poll(privateMessage(nextUpdate++, chatId, text))).at(-1)?.body;
  const press = async (chatId: number, data: string) =>
    (await poll(callbackPress(nextUpdate++, chatId, data, MESSAGE_ID))).at(-1);

  const keyboardOf = (body: Body): InlineKeyboard =>
    (body?.reply_markup as { inline_keyboard: InlineKeyboard } | undefined)
      ?.inline_keyboard ?? [];
  const buttons = (body: Body) => keyboardOf(body).flat();
  const labels = (body: Body) => buttons(body).map((b) => b.text);
  const dataOf = (body: Body, label: string): string => {
    const found = buttons(body).find((b) => b.text === label);
    if (!found || !('callback_data' in found)) {
      throw new Error(
        `no "${label}" button in ${JSON.stringify(labels(body))}`,
      );
    }
    return found.callback_data;
  };

  const operator = () => ({
    userId: adaId,
    role: 'operator' as const,
    ctx: { actor: userActor(adaId) },
  });
  const makeCard = (title: string, body = 'Users sign in.') =>
    ctx.app.get(BoardService).create(widget, { title, body }, operator());
  const cardRow = (number: number) =>
    ctx.prisma.boardCard.findUniqueOrThrow({
      where: { projectId_number: { projectId: widget, number } },
      include: { rounds: true },
    });

  const setUp = async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
    seen.clear();
    jest.mocked(commands().send).mockClear();
    const root = await seedUser(ctx.prisma, 'root@example.com', 'admin');
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', root.id, { actor: SYSTEM_ACTOR });
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
    const profile = await ctx.prisma.runtimeProfile.create({
      data: {
        runnerId: first.runnerId,
        key: 'claude-main',
        runtime: 'claude',
        label: 'Claude',
        env: {},
        args: [],
        authenticated: true,
      },
    });
    await ctx.prisma.project.updateMany({
      data: { defaultProfileId: profile.id },
    });
    adaId = (await seedUser(ctx.prisma, 'ada@example.com', 'operator', widget))
      .id;
    vicId = (await seedUser(ctx.prisma, 'vic@example.com', 'viewer', widget))
      .id;
    for (const [userId, chatId] of [
      [adaId, CHAT],
      [vicId, VIEWER_CHAT],
    ] as const) {
      await ctx.prisma.telegramLink.create({
        data: { userId, chatId: BigInt(chatId) },
      });
    }
  };

  beforeAll(async () => {
    ctx = await createTelegramApp();
    // Runner commands never leave the process.
    jest.spyOn(commands(), 'assertReady').mockImplementation(() => undefined);
    jest
      .spyOn(commands(), 'send')
      .mockImplementation(async (_runner, name, args) => ({
        status: 'ok',
        output:
          name === 'card.run'
            ? {
                phase: 'starting',
                tmuxSession: `agentdock-card-${String((args as { shortId: string }).shortId)}`,
              }
            : { stopped: true },
      }));
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(setUp);

  describe('/board', () => {
    it('shows the columns with the same counts as the Board', async () => {
      await makeCard('First');
      await makeCard('Second');
      const body = await say(CHAT, '/board');
      expect(body?.text).toMatch(/^widget · /);
      const view: BoardView = await ctx.app
        .get(BoardService)
        .board(widget, undefined, 'operator');
      expect(labels(body)).toEqual(
        view.columns.map(
          (c) =>
            `${{ inbox: 'Inbox', todo: 'To Do', in_progress: 'In progress', finished: 'Finished', completed: 'Completed' }[c.column]} · ${c.cards.length}`,
        ),
      );
      expect(labels(body)).toContain('To Do · 2');
    });

    it('hides the Inbox from a viewer', async () => {
      const body = await say(VIEWER_CHAT, '/board');
      expect(labels(body).join()).not.toMatch(/Inbox/);
      expect(labels(body)).toContain('To Do · 0');
      expect((await say(VIEWER_CHAT, '/board inbox'))?.text).toBe(
        `widget · ${BOARD_REPLIES.noColumn}`,
      );
    });

    it('pages a column of more than 10 cards, 10 at a time', async () => {
      for (let i = 1; i <= 23; i++) await makeCard(`Card ${i}`);
      const first = (
        await poll(privateMessage(nextUpdate++, CHAT, '/board todo'))
      )[0].body;
      expect(first.text).toContain('To Do · 23 cards · page 1 of 3');
      const rows = (b: Body) =>
        buttons(b).filter((x) => /^C-\d+ /.test(x.text));
      expect(rows(first)).toHaveLength(10);
      // The newest card is on top, as on the Board.
      expect(String(first.text)).toContain('C-23 Card 23 · To Do');
      expect(labels(first)).toContain('Next ›');
      expect(labels(first)).not.toContain('‹ Prev');

      const second = await press(CHAT, dataOf(first, 'Next ›'));
      expect(second?.method).toBe('editMessageText');
      expect(second?.body.message_id).toBe(MESSAGE_ID);
      expect(second?.body.text).toContain('page 2 of 3');
      expect(second?.body.text).toContain('C-13 Card 13');
      expect(labels(second?.body)).toEqual(
        expect.arrayContaining(['‹ Prev', 'Next ›']),
      );

      const third = await press(CHAT, dataOf(second?.body, 'Next ›'));
      expect(rows(third?.body)).toHaveLength(3);
      expect(labels(third?.body)).not.toContain('Next ›');

      const back = await press(CHAT, dataOf(third?.body, '‹ Prev'));
      expect(back?.body.text).toContain('page 2 of 3');
    });

    it('jumps to a column by key or title, and refuses an unknown one', async () => {
      await makeCard('Only');
      for (const arg of ['todo', 'To Do', 'TODO']) {
        expect((await say(CHAT, `/board ${arg}`))?.text).toContain(
          'To Do · 1 cards',
        );
      }
      expect((await say(CHAT, '/board in progress'))?.text).toContain(
        'In progress · 0 cards',
      );
      expect((await say(CHAT, '/board nowhere'))?.text).toBe(
        `widget · ${BOARD_REPLIES.noColumn}`,
      );
    });

    it('refuses a group chat and an unlinked chat', async () => {
      const group = await poll(groupMessage(nextUpdate++, -100, '/board'));
      expect(group[0].body.text).toMatch(/private chat/);
      expect((await say(UNLINKED_CHAT, '/board'))?.text).toMatch(/not linked/i);
    });
  });

  describe('/card', () => {
    it('shows the detail of a card, and tapping it in a list does too', async () => {
      const card = await makeCard('Add login', 'Users sign in.\n\nWith email.');
      const body = await say(CHAT, `/card ${card.number}`);
      const text = String(body?.text);
      expect(text).toContain('widget · ');
      expect(text).toContain(`C-${card.number} Add login`);
      expect(text).toContain('Kind: feature · Column: To Do');
      expect(text).toContain('Agent: not started');
      expect(text).toContain('Users sign in. With email.');
      // #580: an https APP_URL opens the card in the Mini App.
      expect(buttons(body)).toContainEqual({
        text: 'Open in app',
        web_app: {
          url: `https://dock.example.com/tg?start=${widget}_${card.number}`,
        },
      });
      expect(labels(body)).toEqual(
        expect.arrayContaining(['Move', 'Run', '‹ To Do']),
      );
      expect(labels(body)).not.toContain('Stop');

      const list = await say(CHAT, '/board todo');
      const tapped = await press(
        CHAT,
        dataOf(list, `C-${card.number} Add login`),
      );
      expect(tapped?.method).toBe('editMessageText');
      expect(tapped?.body.text).toBe(text);
    });

    it('accepts C-n and #n, trims a long body, and answers an unknown number clearly', async () => {
      const card = await makeCard('Long', 'word '.repeat(500));
      const body = await say(CHAT, `/card C-${card.number}`);
      expect(String(body?.text).length).toBeLessThan(700);
      expect(String(body?.text)).toContain('…');
      expect((await say(CHAT, `/card #${card.number}`))?.text).toBe(body?.text);
      expect((await say(CHAT, '/card 999'))?.text).toBe(
        'widget · This project has no card C-999.',
      );
      expect((await say(CHAT, '/card'))?.text).toBe(
        `widget · ${BOARD_REPLIES.cardUsage}`,
      );
      expect((await say(CHAT, '/card abc'))?.text).toBe(
        `widget · ${BOARD_REPLIES.cardUsage}`,
      );
    });

    it('never shows a card of another project', async () => {
      const other = await ctx.app.get(BoardService).create(
        gadget,
        { title: 'Secret' },
        {
          ...operator(),
          role: 'admin',
        },
      );
      expect(other.number).toBe(1);
      await makeCard('Mine');
      const forged = await press(
        CHAT,
        CARD_CALLBACK.encode({ project: gadget, number: 1 }),
      );
      expect(forged?.body.text).toBe(
        'You are not a member of this project any more.',
      );
    });
  });

  describe('Move', () => {
    it('opens a column picker, moves the card and rewrites the message', async () => {
      const card = await makeCard('Move me');
      const detail = await say(CHAT, `/card ${card.number}`);
      const picker = await press(CHAT, dataOf(detail, 'Move'));
      expect(picker?.method).toBe('editMessageText');
      expect(labels(picker?.body)).toEqual([
        'In progress',
        'Finished',
        'Completed',
        'Cancel',
      ]);

      const done = await press(CHAT, dataOf(picker?.body, 'Finished'));
      expect(done?.method).toBe('editMessageText');
      expect(done?.body.message_id).toBe(MESSAGE_ID);
      expect(done?.body.text).toContain('✓ Moved to Finished.');
      expect(done?.body.text).toContain('Column: Finished');
      expect((await cardRow(card.number)).column).toBe('finished');
      const view = await ctx.app
        .get(BoardService)
        .board(widget, undefined, 'operator');
      expect(
        view.columns
          .find((c) => c.column === 'finished')
          ?.cards.map((c) => c.number),
      ).toEqual([card.number]);

      const moved = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'card.moved', actorUserId: adaId },
      });
      expect(moved.after).toMatchObject({ column: 'finished' });
      const via = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'telegram.board', actorUserId: adaId },
      });
      expect(via).toMatchObject({
        result: 'ok',
        projectId: widget,
        meta: { via: 'telegram' },
        after: { action: 'move', number: card.number, column: 'finished' },
      });
    });

    it('shows the board’s own reason when it refuses a move', async () => {
      const card = await makeCard('Busy');
      await press(CHAT, `br:${widget}:${card.number}`);
      const detail = await say(CHAT, `/card ${card.number}`);
      const picker = await press(CHAT, dataOf(detail, 'Move'));
      const refused = await press(CHAT, dataOf(picker?.body, 'To Do'));
      expect(refused?.body.text).toContain(
        'Nothing changed: A worker is running on this card. Stop it or mark it finished first.',
      );
      expect((await cardRow(card.number)).column).toBe('in_progress');

      // Into the Inbox is never offered, and a forged button is refused too.
      const forged = await press(CHAT, `bt:${widget}:${card.number}:inbox`);
      expect(forged?.body.text).toContain('Nothing changed:');
    });
  });

  describe('Run and Stop', () => {
    it('offers Run in To Do, runs the card and then offers Stop', async () => {
      const card = await makeCard('Ship it');
      const detail = await say(CHAT, `/card ${card.number}`);
      expect(labels(detail)).toContain('Run');
      expect(labels(detail)).not.toContain('Stop');

      const running = await press(CHAT, dataOf(detail, 'Run'));
      expect(running?.method).toBe('editMessageText');
      expect(running?.body.text).toContain('✓ Run started.');
      expect(running?.body.text).toContain('Column: In progress');
      expect(running?.body.text).toContain('Agent: Starting (round 1)');
      expect(labels(running?.body)).toContain('Stop');
      expect(labels(running?.body)).not.toContain('Run');
      expect(sentCommands('card.run')).toHaveLength(1);
      expect((await cardRow(card.number)).column).toBe('in_progress');
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'card.run_started', actorUserId: adaId },
        }),
      ).toBe(1);

      // A second press of the old Run button changes nothing.
      const again = await press(CHAT, dataOf(detail, 'Run'));
      expect(again?.body.text).toContain('Run is not available in this state.');
      expect(sentCommands('card.run')).toHaveLength(1);
    });

    it('asks to confirm before it stops, and cancel leaves the worker alone', async () => {
      const card = await makeCard('Stop me');
      const running = await press(CHAT, `br:${widget}:${card.number}`);
      const ask = await press(CHAT, dataOf(running?.body, 'Stop'));
      expect(ask?.body.text).toContain('Stop the worker on');
      expect(labels(ask?.body)).toEqual(['Stop worker', 'Cancel']);
      expect(sentCommands('card.stop')).toHaveLength(0);

      const cancelled = await press(CHAT, dataOf(ask?.body, 'Cancel'));
      expect(cancelled?.body.text).toContain('Agent: Starting');
      expect(sentCommands('card.stop')).toHaveLength(0);

      const ask2 = await press(CHAT, dataOf(cancelled?.body, 'Stop'));
      const stopped = await press(CHAT, dataOf(ask2?.body, 'Stop worker'));
      expect(stopped?.method).toBe('editMessageText');
      expect(stopped?.body.text).toContain('✓ Worker stopped.');
      expect(sentCommands('card.stop')).toHaveLength(1);
      const row = await cardRow(card.number);
      expect(row.rounds[0].phase).toBe('cancelled');
      expect(labels(stopped?.body)).not.toContain('Stop');
      expect(labels(stopped?.body)).toContain('Retry');
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'card.stopped', actorUserId: adaId },
        }),
      ).toBe(1);
    });

    it('does not offer Stop where no worker runs, and refuses a forged one', async () => {
      const card = await makeCard('Idle');
      const detail = await say(CHAT, `/card ${card.number}`);
      expect(labels(detail)).not.toContain('Stop');
      const forged = await press(CHAT, `bk:${widget}:${card.number}`);
      expect(forged?.body.text).toContain('Nothing to stop');
      expect(sentCommands('card.stop')).toHaveLength(0);
    });
  });

  describe('roles', () => {
    it('gives a viewer the cards but no write buttons', async () => {
      const card = await makeCard('Read only');
      const body = await say(VIEWER_CHAT, `/card ${card.number}`);
      expect(String(body?.text)).toContain('Read only');
      expect(labels(body)).toEqual(['Open in app', '‹ To Do']);
      const list = await say(VIEWER_CHAT, '/board todo');
      expect(labels(list)).toContain(`C-${card.number} Read only`);
    });

    it('refuses a forged write button from a viewer, server-side, and audits it', async () => {
      const card = await makeCard('Not yours');
      for (const data of [
        `bm:${widget}:${card.number}`,
        `bt:${widget}:${card.number}:finished`,
        `br:${widget}:${card.number}`,
        `bs:${widget}:${card.number}`,
        `bk:${widget}:${card.number}`,
      ]) {
        const refused = await press(VIEWER_CHAT, data);
        expect(refused?.method).toBe('sendMessage');
        expect(refused?.body.text).toBe(BOARD_REPLIES.roleDenied);
      }
      const row = await cardRow(card.number);
      expect(row.column).toBe('todo');
      expect(row.rounds).toHaveLength(0);
      expect(sentCommands('card.run')).toHaveLength(0);
      expect(sentCommands('card.stop')).toHaveLength(0);
      const denied = await ctx.prisma.auditRecord.findMany({
        where: { action: 'telegram.board', result: 'denied' },
        orderBy: { seq: 'asc' },
      });
      expect(denied).toHaveLength(5);
      expect(denied[0]).toMatchObject({
        actorUserId: vicId,
        projectId: widget,
        meta: { via: 'telegram' },
      });
    });

    it('refuses a button of a project the user is not in, and a malformed one', async () => {
      const refused = await press(CHAT, `br:${gadget}:1`);
      expect(refused?.body.text).toBe(
        'You are not a member of this project any more.',
      );
      expect(sentCommands('card.run')).toHaveLength(0);
      for (const data of [
        'br:',
        'br:x:y',
        `br:${widget}:0`,
        `bt:${widget}:1:nope`,
      ]) {
        expect((await press(CHAT, data))?.body.text).toBe(
          BOARD_REPLIES.invalidButton,
        );
      }
    });
  });

  it('keeps every callback payload within 64 bytes', async () => {
    for (let i = 1; i <= 12; i++) await makeCard(`Card ${i}`);
    const detail = await say(CHAT, '/card 1');
    await press(CHAT, dataOf(detail, 'Move'));
    await press(CHAT, `br:${widget}:1`);
    await press(CHAT, `bs:${widget}:1`);
    const list = await say(CHAT, '/board todo');
    await press(CHAT, dataOf(list, 'Next ›'));
    await say(CHAT, '/board');
    expect(seen.size).toBeGreaterThan(10);
    for (const data of seen) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX);
    }
  });
});
