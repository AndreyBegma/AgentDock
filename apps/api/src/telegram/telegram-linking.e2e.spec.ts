import type { Role, TelegramLinkCode } from '@agentdock/shared';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore } from '../notifications';
import { seedUser } from '../notifications/testing/notifications-e2e';
import { login, type Session } from '../test/e2e-app';
import { hashLinkCode, LINK_REPLIES } from './telegram-linking.service';
import { TelegramPoller } from './telegram-poller';
import {
  BOT_TOKEN,
  groupMessage,
  privateMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

describe('Telegram linking (e2e)', () => {
  let ctx: TelegramE2e;
  let poller: TelegramPoller;
  let store: BotTokenStore;
  let rootId: string;
  let nextUpdate = 100;

  const signIn = async (
    email: string,
    role: Role = 'operator',
  ): Promise<{ id: string; session: Session }> => {
    const user = await seedUser(ctx.prisma, email, role);
    return { id: user.id, session: await login(ctx, email) };
  };

  const newCode = async (session: Session): Promise<string> => {
    const response = await session.send('post', '/notifications/telegram/link');
    expect(response.status).toBe(201);
    const body = response.body as TelegramLinkCode;
    const code = new URL(body.url).searchParams.get('start');
    if (!code) throw new Error('no start parameter');
    return code;
  };

  /** Delivers one message update to the bot and returns its reply text. */
  const say = async (
    update: ReturnType<typeof privateMessage | typeof groupMessage>,
  ): Promise<string | undefined> => {
    const before = ctx.fake.sent().length;
    ctx.fake.updates.push(update);
    expect(await poller.pollOnce()).toEqual({ status: 'polled', updates: 1 });
    const replies = ctx.fake.sent().slice(before);
    return replies[0]?.body.text as string | undefined;
  };
  const fromChat = (chatId: number, text: string, username?: string) => {
    nextUpdate += 1;
    return privateMessage(nextUpdate, chatId, text, username);
  };

  beforeAll(async () => {
    ctx = await createTelegramApp();
    poller = ctx.app.get(TelegramPoller);
    store = ctx.app.get(BotTokenStore);
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
    rootId = (await seedUser(ctx.prisma, 'root@example.com', 'admin')).id;
    await store.set(BOT_TOKEN, 'agentdock_bot', rootId, {
      actor: SYSTEM_ACTOR,
    });
    await ctx.prisma.notificationMatcherState.create({
      data: { id: 1, eventsCursor: 0n },
    });
  });

  describe('GET /notifications/telegram/link', () => {
    it('reports not linked, then linked, for the caller only', async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      expect(
        (await ada.session.get('/notifications/telegram/link')).body,
      ).toEqual({
        linked: false,
        username: null,
        linkedAt: null,
        botConfigured: true,
      });

      const code = await newCode(ada.session);
      expect(await say(fromChat(555, `/start ${code}`))).toBe(
        LINK_REPLIES.linked,
      );

      const linked = await ada.session.get('/notifications/telegram/link');
      expect(linked.status).toBe(200);
      expect(linked.body).toMatchObject({
        linked: true,
        username: 'ada_tg',
        botConfigured: true,
      });
      expect(typeof linked.body.linkedAt).toBe('string');
      // Bob's own state, not Ada's.
      expect(
        (await bob.session.get('/notifications/telegram/link')).body,
      ).toEqual({
        linked: false,
        username: null,
        linkedAt: null,
        botConfigured: true,
      });
    });

    it('reports the bot as not configured', async () => {
      const ada = await signIn('ada@example.com');
      await store.clear({ actor: SYSTEM_ACTOR });
      const response = await ada.session.get('/notifications/telegram/link');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        linked: false,
        username: null,
        linkedAt: null,
        botConfigured: false,
      });
    });
  });

  describe('POST /notifications/telegram/link', () => {
    it('returns a one-time deep link and stores only the code hash', async () => {
      const ada = await signIn('ada@example.com');
      const started = Date.now();
      const response = await ada.session.send(
        'post',
        '/notifications/telegram/link',
      );
      expect(response.status).toBe(201);
      const body = response.body as TelegramLinkCode;
      expect(body.url).toMatch(
        /^https:\/\/t\.me\/agentdock_bot\?start=[A-Za-z0-9_-]{32}$/,
      );
      const expiresIn = new Date(body.expiresAt).getTime() - started;
      expect(expiresIn).toBeGreaterThan(9 * 60_000);
      expect(expiresIn).toBeLessThanOrEqual(10 * 60_000 + 5_000);

      const code = new URL(body.url).searchParams.get('start') ?? '';
      const rows = await ctx.prisma.telegramLinkCode.findMany({
        where: { userId: ada.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].codeHash).toBe(hashLinkCode(code));
      expect(JSON.stringify(rows)).not.toContain(code);
    });

    it('answers 409 telegram_not_configured without a bot', async () => {
      const ada = await signIn('ada@example.com');
      await store.clear({ actor: SYSTEM_ACTOR });
      const response = await ada.session.send(
        'post',
        '/notifications/telegram/link',
      );
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: 'telegram_not_configured' });
    });

    it('voids an older unused code when a new one is made', async () => {
      const ada = await signIn('ada@example.com');
      const first = await newCode(ada.session);
      const second = await newCode(ada.session);
      expect(await say(fromChat(555, `/start ${first}`))).toBe(
        LINK_REPLIES.invalidCode,
      );
      expect(await say(fromChat(555, `/start ${second}`))).toBe(
        LINK_REPLIES.linked,
      );
    });
  });

  describe('/start <code> (D9)', () => {
    it('binds the private chat, audits, and moves the update offset', async () => {
      const ada = await signIn('ada@example.com');
      const code = await newCode(ada.session);
      // The poller is one instance for the suite: ids keep growing across tests.
      nextUpdate += 1;
      const updateId = nextUpdate;
      ctx.fake.updates.push(privateMessage(updateId, 555, `/start ${code}`));
      expect(await poller.pollOnce()).toEqual({ status: 'polled', updates: 1 });

      const link = await ctx.prisma.telegramLink.findUniqueOrThrow({
        where: { userId: ada.id },
      });
      expect(link).toMatchObject({ chatId: 555n, username: 'ada_tg' });
      const reply = ctx.fake.sent()[0];
      expect(reply.body).toMatchObject({
        chat_id: 555,
        text: LINK_REPLIES.linked,
      });
      expect(reply.body.parse_mode).toBeUndefined();

      const state = await ctx.prisma.notificationMatcherState.findUniqueOrThrow(
        { where: { id: 1 } },
      );
      expect(state.telegramUpdateOffset).toBe(BigInt(updateId + 1));
      expect(state.eventsCursor).toBe(0n);

      // The next poll asks past it, and handles nothing twice.
      expect(await poller.pollOnce()).toEqual({ status: 'polled', updates: 0 });
      const polls = ctx.fake.calls.filter((c) => c.method === 'getUpdates');
      expect(polls.at(-1)?.body.offset).toBe(updateId + 1);
      expect(ctx.fake.sent()).toHaveLength(1);

      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'telegram.link', actorUserId: ada.id },
        select: { actorUserId: true, after: true, meta: true, result: true },
      });
      expect(audit).toMatchObject({
        actorUserId: ada.id,
        result: 'ok',
        meta: { via: 'telegram' },
        after: { linked: true, username: 'ada_tg' },
      });
      expect(JSON.stringify(audit)).not.toContain('555');
    });

    it('refuses a code that was already used', async () => {
      const ada = await signIn('ada@example.com');
      const code = await newCode(ada.session);
      expect(await say(fromChat(555, `/start ${code}`))).toBe(
        LINK_REPLIES.linked,
      );
      expect(await say(fromChat(555, '/stop'))).toBe(LINK_REPLIES.unlinked);
      expect(await say(fromChat(555, `/start ${code}`))).toBe(
        LINK_REPLIES.invalidCode,
      );
      expect(await ctx.prisma.telegramLink.count()).toBe(0);
    });

    it('refuses an expired code', async () => {
      const ada = await signIn('ada@example.com');
      const code = await newCode(ada.session);
      await ctx.prisma.telegramLinkCode.updateMany({
        where: { userId: ada.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });
      expect(await say(fromChat(555, `/start ${code}`))).toBe(
        LINK_REPLIES.invalidCode,
      );
      expect(await ctx.prisma.telegramLink.count()).toBe(0);
    });

    it('refuses an unknown or malformed code', async () => {
      expect(await say(fromChat(555, '/start nope'))).toBe(
        LINK_REPLIES.invalidCode,
      );
      expect(await say(fromChat(555, '/start ../../etc'))).toBe(
        LINK_REPLIES.invalidCode,
      );
      expect(await say(fromChat(555, '/start'))).toBe(LINK_REPLIES.noCode);
    });

    it('refuses a group chat and leaves the code unused', async () => {
      const ada = await signIn('ada@example.com');
      const code = await newCode(ada.session);
      nextUpdate += 1;
      expect(await say(groupMessage(nextUpdate, -1001, `/start ${code}`))).toBe(
        LINK_REPLIES.notPrivate,
      );
      expect(await ctx.prisma.telegramLink.count()).toBe(0);
      const row = await ctx.prisma.telegramLinkCode.findFirstOrThrow({
        where: { userId: ada.id },
      });
      expect(row.usedAt).toBeNull();
    });

    it('refuses a chat already linked to another user', async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      expect(
        await say(fromChat(555, `/start ${await newCode(ada.session)}`)),
      ).toBe(LINK_REPLIES.linked);
      expect(
        await say(fromChat(555, `/start ${await newCode(bob.session)}`)),
      ).toBe(LINK_REPLIES.chatTaken);
      const links = await ctx.prisma.telegramLink.findMany();
      expect(links.map((l) => l.userId)).toEqual([ada.id]);
    });

    it('moves a user to a new chat: one chat per user', async () => {
      const ada = await signIn('ada@example.com');
      await say(fromChat(555, `/start ${await newCode(ada.session)}`));
      await say(fromChat(777, `/start ${await newCode(ada.session)}`));
      const links = await ctx.prisma.telegramLink.findMany();
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ userId: ada.id, chatId: 777n });
    });

    it('refuses a code of a user disabled since', async () => {
      const ada = await signIn('ada@example.com');
      const code = await newCode(ada.session);
      await ctx.prisma.user.update({
        where: { id: ada.id },
        data: { status: 'disabled' },
      });
      expect(await say(fromChat(555, `/start ${code}`))).toBe(
        LINK_REPLIES.invalidCode,
      );
      expect(await ctx.prisma.telegramLink.count()).toBe(0);
    });

    it('ignores anything that is not /start or /stop', async () => {
      expect(await say(fromChat(555, 'hello'))).toBeUndefined();
      expect(await say(fromChat(555, '/help'))).toBeUndefined();
    });
  });

  describe('unlinking', () => {
    it('/stop in the chat unlinks and audits', async () => {
      const ada = await signIn('ada@example.com');
      await say(fromChat(555, `/start ${await newCode(ada.session)}`));
      expect(await say(fromChat(555, '/stop'))).toBe(LINK_REPLIES.unlinked);
      expect(await ctx.prisma.telegramLink.count()).toBe(0);
      expect(await say(fromChat(555, '/stop'))).toBe(LINK_REPLIES.notLinked);

      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'telegram.unlink', actorUserId: ada.id },
        select: { meta: true, result: true },
      });
      expect(audit).toEqual({ result: 'ok', meta: { via: 'telegram' } });
    });

    it('DELETE /notifications/telegram/link unlinks only the caller', async () => {
      const ada = await signIn('ada@example.com');
      const bob = await signIn('bob@example.com');
      await say(fromChat(555, `/start ${await newCode(ada.session)}`));
      await say(fromChat(666, `/start ${await newCode(bob.session)}`));

      const response = await ada.session.send(
        'delete',
        '/notifications/telegram/link',
      );
      expect(response.status).toBe(204);
      const links = await ctx.prisma.telegramLink.findMany();
      expect(links.map((l) => l.userId)).toEqual([bob.id]);
      // Idempotent.
      expect(
        (await ada.session.send('delete', '/notifications/telegram/link'))
          .status,
      ).toBe(204);
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'telegram.unlink', actorUserId: ada.id },
        }),
      ).toBe(1);
    });
  });
});
