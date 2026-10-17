import {
  AUTH_ERROR,
  CSRF_COOKIE,
  SESSION_COOKIE,
  type TelegramSignInResponse,
} from '@agentdock/shared';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { login, nextIp, Session, setCookies } from '../test/e2e-app';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { BOT_TOKEN } from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';
import { initDataHash } from './web-app-init-data';

const ADA_CHAT = 7101;
const VIC_CHAT = 7102;
const STRANGER = 7199;
const NOW_S = () => Math.floor(Date.now() / 1000);

/** `initData` as Telegram signs it for `userId`'s private chat with the bot. */
const initDataFor = (
  userId: number,
  { authDate = NOW_S(), token = BOT_TOKEN, startParam = '' } = {},
): string => {
  const fields: Record<string, string> = {
    auth_date: String(authDate),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: userId, first_name: 'Ada', username: 'ada' }),
    ...(startParam ? { start_param: startParam } : {}),
  };
  const params = new URLSearchParams(fields);
  params.set('hash', initDataHash(Object.entries(fields), token));
  return params.toString();
};

const cookieOf = (cookies: string[], name: string): string | undefined =>
  cookies
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    .slice(name.length + 1);

describe('Telegram Mini App sign-in and buttons (e2e, #580)', () => {
  let ctx: TelegramE2e;
  let widget: string;
  let gadget: string;
  let adaId: string;
  let vicId: string;

  const signIn = (initData: string) =>
    ctx
      .http()
      .post('/auth/telegram')
      .set('X-Forwarded-For', nextIp())
      .send({ initData });

  /** The web session a successful sign-in set, as the web app would hold it. */
  const sessionOf = (response: Awaited<ReturnType<typeof signIn>>) => {
    const cookies = setCookies(response);
    const token = cookieOf(cookies, SESSION_COOKIE);
    const csrf = cookieOf(cookies, CSRF_COOKIE);
    if (!token || !csrf) throw new Error('no session cookies');
    return new Session(ctx, token, csrf);
  };

  beforeAll(async () => {
    ctx = await createTelegramApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
    ctx.options.appUrl = 'https://dock.example.com';
    const root = await seedUser(ctx.prisma, 'root@example.com', 'admin');
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', root.id, { actor: SYSTEM_ACTOR });
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
    await ctx.prisma.telegramLink.createMany({
      data: [
        { userId: adaId, chatId: BigInt(ADA_CHAT), currentProjectId: gadget },
        { userId: vicId, chatId: BigInt(VIC_CHAT) },
      ],
    });
    const now = new Date();
    await ctx.prisma.boardCard.create({
      data: {
        projectId: widget,
        number: 1,
        shortId: 'card0001',
        title: 'Before',
        column: 'todo',
        position: 1,
        source: 'manual',
        issueOnRun: false,
        specOnRun: false,
        movedAt: now,
      },
    });
  });

  describe('POST /auth/telegram', () => {
    it('signs a linked user in with the web session, without a password', async () => {
      const response = await signIn(initDataFor(ADA_CHAT));
      expect(response.status).toBe(200);
      const body = response.body as TelegramSignInResponse;
      expect(body.user).toMatchObject({ id: adaId, email: 'ada@example.com' });
      // The chat's current project, chosen with /project.
      expect(body.projectId).toBe(gadget);

      const session = sessionOf(response);
      const me = await session.get('/auth/me');
      expect(me.status).toBe(200);
      expect((me.body as { id: string }).id).toBe(adaId);
      const audit = await ctx.prisma.auditRecord.findFirst({
        where: { action: 'auth.login', actorUserId: adaId, result: 'ok' },
      });
      expect(audit?.meta).toMatchObject({ via: 'telegram' });
    });

    it('answers no project when the chat has none it may still see', async () => {
      await ctx.prisma.projectMember.deleteMany({
        where: { projectId: gadget, userId: adaId },
      });
      const response = await signIn(initDataFor(VIC_CHAT));
      expect((response.body as TelegramSignInResponse).projectId).toBe(widget);
      const ada = await signIn(initDataFor(ADA_CHAT));
      // Gadget is gone; widget is then Ada's only project.
      expect((ada.body as TelegramSignInResponse).projectId).toBe(widget);
    });

    it('refuses tampered initData and sets no cookie', async () => {
      const forged = new URLSearchParams(initDataFor(STRANGER));
      forged.set(
        'user',
        JSON.stringify({ id: ADA_CHAT, first_name: 'Ada', username: 'ada' }),
      );
      for (const initData of [
        forged.toString(),
        initDataFor(ADA_CHAT, {
          token: '999999:ZYXwvuTSRqpoNMLkjiHGFedcba9876543210',
        }),
      ]) {
        const response = await signIn(initData);
        expect(response.status).toBe(401);
        expect(response.body).toMatchObject({
          error: AUTH_ERROR.telegramInvalid,
        });
        expect(setCookies(response)).toEqual([]);
      }
      expect(await ctx.prisma.userSession.count()).toBe(0);
    });

    it('refuses expired initData', async () => {
      const response = await signIn(
        initDataFor(ADA_CHAT, { authDate: NOW_S() - 3601 }),
      );
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({
        error: AUTH_ERROR.telegramExpired,
      });
      expect(await ctx.prisma.userSession.count()).toBe(0);
    });

    it('refuses an unlinked Telegram user, and a disabled linked one, with the link hint', async () => {
      await ctx.prisma.user.update({
        where: { id: vicId },
        data: { status: 'disabled' },
      });
      for (const chat of [STRANGER, VIC_CHAT]) {
        const response = await signIn(initDataFor(chat));
        expect(response.status).toBe(403);
        expect(response.body).toMatchObject({
          error: AUTH_ERROR.telegramNotLinked,
        });
        expect((response.body as { message: string }).message).toContain(
          'Account → Notifications',
        );
      }
      expect(await ctx.prisma.userSession.count()).toBe(0);
    });

    it('refuses everything while the bot is not configured', async () => {
      await ctx.app.get(BotTokenStore).clear({ actor: SYSTEM_ACTOR });
      const response = await signIn(initDataFor(ADA_CHAT));
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: AUTH_ERROR.telegramNotConfigured,
      });
    });

    it('rejects a body without initData', async () => {
      const response = await ctx
        .http()
        .post('/auth/telegram')
        .set('X-Forwarded-For', nextIp())
        .send({});
      expect(response.status).toBe(400);
    });

    it('keeps the web role checks: a viewer cannot edit, an operator can', async () => {
      const viewer = sessionOf(await signIn(initDataFor(VIC_CHAT)));
      const refused = await viewer.send(
        'patch',
        `/projects/${widget}/board/cards/1`,
        { title: 'Viewer edit' },
      );
      expect(refused.status).toBe(403);
      const card = await ctx.prisma.boardCard.findFirstOrThrow({
        where: { projectId: widget, number: 1 },
      });
      expect(card.title).toBe('Before');

      // A password session of the same operator and a Mini App one act alike.
      expect((await login(ctx, 'ada@example.com')).token).toBeTruthy();
      const operator = sessionOf(await signIn(initDataFor(ADA_CHAT)));
      const edited = await operator.send(
        'patch',
        `/projects/${widget}/board/cards/1`,
        { title: 'Operator edit' },
      );
      expect(edited.status).toBe(200);
    });
  });

  describe('the bot', () => {
    const configure = async () => {
      const root = await login(ctx, 'root@example.com');
      const response = await root.send('put', '/admin/integrations/telegram', {
        token: BOT_TOKEN,
      });
      expect(response.status).toBe(200);
      return ctx.fake.calls.filter((c) => c.method === 'setChatMenuButton');
    };

    it('sets the chat menu button to the Mini App', async () => {
      const [call] = await configure();
      expect(call.body.menu_button).toEqual({
        type: 'web_app',
        text: 'Board',
        web_app: { url: 'https://dock.example.com/tg' },
      });
    });

    it('keeps Telegram’s default menu button without an https APP_URL', async () => {
      ctx.options.appUrl = 'http://localhost:3517';
      const [call] = await configure();
      expect(call.body.menu_button).toEqual({ type: 'default' });
    });

    const cardNotification = () =>
      ctx.prisma.notification.create({
        data: {
          userId: adaId,
          kind: 'card.finished',
          projectId: widget,
          title: 'C-1 finished',
          body: 'Ready for review.',
          link: `/projects/${widget}/board?card=1`,
          firstAt: new Date(),
          lastAt: new Date(),
          deliveries: {
            create: {
              userId: adaId,
              channel: 'telegram',
              status: 'pending',
              nextAttemptAt: new Date(),
            },
          },
        },
      });

    it('puts an "Open in app" button on a card message, deep-linking to that card', async () => {
      await cardNotification();
      const pass = await ctx.app.get(TelegramDeliveryService).deliverOnce();
      expect(pass.sent).toBe(1);
      const [message] = ctx.fake.sent();
      expect(message.body.reply_markup).toEqual({
        inline_keyboard: [
          [
            {
              text: 'Open in app',
              web_app: {
                url: `https://dock.example.com/tg?start=${widget}_1`,
              },
            },
          ],
        ],
      });
    });

    it('sends a plain link instead, and does not fail, without an https APP_URL', async () => {
      ctx.options.appUrl = 'http://localhost:3517';
      await cardNotification();
      const pass = await ctx.app.get(TelegramDeliveryService).deliverOnce();
      expect(pass).toMatchObject({ sent: 1, failed: 0 });
      const [message] = ctx.fake.sent();
      expect(message.body.reply_markup).toBeUndefined();
      expect(message.body.text).toContain(
        `(http://localhost:3517/projects/${widget}/board?card=1)`,
      );
    });
  });
});
