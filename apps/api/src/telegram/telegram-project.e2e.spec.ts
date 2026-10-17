import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { TelegramAssistantService } from './telegram-assistant.service';
import type { InlineKeyboardButton } from './telegram-client';
import { BOT_COMMANDS, HELP_TEXT } from './telegram-commands';
import { TelegramGuard } from './telegram-guard.service';
import { LINK_REPLIES } from './telegram-linking.service';
import { TelegramPoller } from './telegram-poller';
import {
  PROJECT_REPLIES,
  TelegramProjectService,
} from './telegram-project.service';
import {
  BOT_TOKEN,
  callbackPress,
  FakeTelegram,
  groupMessage,
  privateMessage,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const CHAT = 7001;
const SOLO_CHAT = 7002;
const VIEWER_CHAT = 7003;
const UNLINKED_CHAT = 7999;

describe('Telegram /project and the guard (e2e, #500)', () => {
  let ctx: TelegramE2e;
  let fake: FakeTelegram;
  let nextUpdate = 1;
  /** Ada: operator on widget, viewer (override) on gadget; not on secret. */
  let adaId: string;
  /** Sol: operator, a member of widget only. */
  let solId: string;
  /** Vic: viewer, a member of widget. */
  let vicId: string;
  let widget: string;
  let gadget: string;
  let secret: string;

  const poller = () => ctx.app.get(TelegramPoller);

  /** Feeds `updates` through one poll; the messages the bot sent back. */
  const poll = async (...updates: { update_id: number }[]) => {
    const before = ctx.fake.sent().length;
    ctx.fake.updates = updates;
    expect(await poller().pollOnce()).toEqual({
      status: 'polled',
      updates: updates.length,
    });
    return ctx.fake.sent().slice(before);
  };
  const say = async (chatId: number, text: string) =>
    (await poll(privateMessage(nextUpdate++, chatId, text)))[0]?.body;
  const press = async (chatId: number, data: string) =>
    (await poll(callbackPress(nextUpdate++, chatId, data)))[0]?.body;

  const buttons = (body: Record<string, unknown> | undefined) =>
    (
      (body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] })
        ?.inline_keyboard ?? []
    ).flat();

  const currentOf = async (userId: string) =>
    (
      await ctx.prisma.telegramLink.findUniqueOrThrow({
        where: { userId },
        select: { currentProjectId: true },
      })
    ).currentProjectId;

  const setUp = async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
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
        repo: 'acme/Gadget',
      })
    ).projectId;
    secret = (
      await seedRunnerProject(ctx.prisma, {
        runnerId: first.runnerId,
        root: '/srv/dev/secret',
        repo: 'acme/secret',
      })
    ).projectId;
    adaId = (await seedUser(ctx.prisma, 'ada@example.com', 'operator', widget))
      .id;
    await ctx.prisma.projectMember.create({
      data: { projectId: gadget, userId: adaId, roleOverride: 'viewer' },
    });
    solId = (await seedUser(ctx.prisma, 'sol@example.com', 'operator', widget))
      .id;
    vicId = (await seedUser(ctx.prisma, 'vic@example.com', 'viewer', widget))
      .id;
    for (const [userId, chatId] of [
      [adaId, CHAT],
      [solId, SOLO_CHAT],
      [vicId, VIEWER_CHAT],
    ] as const) {
      await ctx.prisma.telegramLink.create({
        data: { userId, chatId: BigInt(chatId) },
      });
    }
  };

  /** A fresh API process on the same database and fake Telegram. */
  const restart = async () => {
    await ctx.close();
    ctx = await createTelegramApp(undefined, fake);
  };

  beforeAll(async () => {
    fake = await FakeTelegram.start();
    ctx = await createTelegramApp(undefined, fake);
  });
  afterAll(async () => {
    await ctx.close();
    await fake.close();
  });
  beforeEach(setUp);

  describe('/project', () => {
    it('lists only the projects the user is a member of, with their role', async () => {
      const body = await say(CHAT, '/project');
      expect(body?.text).toBe(PROJECT_REPLIES.choose);
      expect(buttons(body).map((b) => b.text)).toEqual([
        'gadget · viewer',
        'widget · operator',
      ]);
      expect(buttons(body).map((b) => b.callback_data)).toEqual([
        `pj:${gadget}`,
        `pj:${widget}`,
      ]);
      expect(JSON.stringify(body)).not.toContain(secret);
    });

    it('remembers a pressed project, across messages and an API restart', async () => {
      const body = await press(CHAT, `pj:${gadget}`);
      expect(body?.text).toMatch(/^gadget · now this chat's project/);
      expect(await currentOf(adaId)).toBe(gadget);
      expect(
        ctx.fake.calls.find((c) => c.method === 'answerCallbackQuery')?.body,
      ).toMatchObject({ text: body?.text });
      // Free text goes to the assistant (#620); its turn ends before the restart.
      expect(await say(CHAT, 'hello')).toBeUndefined();
      await ctx.app.get(TelegramAssistantService).idle();

      await restart();
      const after = await say(CHAT, '/project');
      expect(buttons(after).map((b) => b.text)).toEqual([
        'gadget · viewer ✓',
        'widget · operator',
      ]);
      const current = await ctx.app
        .get(TelegramProjectService)
        .current(CHAT, 'read');
      expect(current).toMatchObject({
        ok: true,
        project: { id: gadget, displayName: 'gadget', role: 'viewer' },
      });

      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'telegram.project', actorUserId: adaId },
        select: { projectId: true, after: true, meta: true, result: true },
      });
      expect(audit).toEqual({
        projectId: gadget,
        after: { projectId: gadget, selectedBy: 'button' },
        meta: { via: 'telegram' },
        result: 'ok',
      });
    });

    it('/project <name> switches by repository name, in any case', async () => {
      const body = await say(CHAT, '/project@agentdock_bot GADGET');
      expect(body?.text).toMatch(/^gadget · now this chat's project/);
      expect(await currentOf(adaId)).toBe(gadget);
      await say(CHAT, '/project acme/widget');
      expect(await currentOf(adaId)).toBe(widget);
    });

    it('refuses an unknown name and a project the user is not a member of', async () => {
      expect((await say(CHAT, '/project nope'))?.text).toBe(
        PROJECT_REPLIES.unknownName,
      );
      expect((await say(CHAT, '/project secret'))?.text).toBe(
        PROJECT_REPLIES.unknownName,
      );
      expect((await press(CHAT, `pj:${secret}`))?.text).toBe(
        'You are not a member of this project any more.',
      );
      expect(await currentOf(adaId)).toBeNull();
    });

    it('refuses a forged or malformed button', async () => {
      for (const data of ['pj:', 'pj:a:b', `pj:${'x'.repeat(40)}`, 'pj:a b']) {
        expect((await press(CHAT, data))?.text).toBe(
          PROJECT_REPLIES.invalidButton,
        );
      }
      expect(await currentOf(adaId)).toBeNull();
    });

    it('selects the only project without asking', async () => {
      const service = ctx.app.get(TelegramProjectService);
      expect(await service.current(SOLO_CHAT, 'write')).toMatchObject({
        ok: true,
        project: { id: widget, role: 'operator' },
      });
      expect(await currentOf(solId)).toBe(widget);

      await ctx.prisma.telegramLink.update({
        where: { userId: solId },
        data: { currentProjectId: null },
      });
      const body = await say(SOLO_CHAT, '/project');
      expect(body?.text).toBe(
        "widget · your only project, is this chat's project (you are operator).",
      );
      expect(buttons(body)).toEqual([]);
      expect(await currentOf(solId)).toBe(widget);
    });

    it('drops a chosen project the user left: asks, or takes the only one left', async () => {
      await press(CHAT, `pj:${gadget}`);
      await ctx.prisma.projectMember.create({
        data: { projectId: secret, userId: adaId },
      });
      await ctx.prisma.projectMember.deleteMany({
        where: { projectId: gadget, userId: adaId },
      });
      const service = ctx.app.get(TelegramProjectService);
      expect(await service.current(CHAT, 'read')).toEqual({
        ok: false,
        reason: 'choose',
      });
      await ctx.prisma.projectMember.deleteMany({
        where: { projectId: secret, userId: adaId },
      });
      expect(await service.current(CHAT, 'read')).toMatchObject({
        ok: true,
        project: { id: widget },
      });
      expect(await currentOf(adaId)).toBe(widget);
    });

    it('refuses a write on the current project to a member below operator', async () => {
      await press(CHAT, `pj:${gadget}`);
      expect(
        await ctx.app.get(TelegramProjectService).current(CHAT, 'write'),
      ).toMatchObject({ ok: false, reason: 'role', project: { id: gadget } });
    });

    it('answers a group chat and an unlinked chat with a refusal', async () => {
      const group = await poll(groupMessage(nextUpdate++, -100, '/project'));
      expect(group[0]?.body.text).toBe(LINK_REPLIES.notPrivate);
      expect((await say(UNLINKED_CHAT, '/project'))?.text).toBe(
        LINK_REPLIES.notLinked,
      );
    });
  });

  describe('TelegramGuard', () => {
    const guard = () => ctx.app.get(TelegramGuard);

    it('refuses an unlinked chat', async () => {
      expect(await guard().authorize(UNLINKED_CHAT, widget, 'read')).toEqual({
        ok: false,
        reason: 'not_linked',
        userId: null,
        projectId: widget,
      });
    });

    it('refuses a non-member, for reads and writes', async () => {
      for (const need of ['read', 'write'] as const) {
        expect(await guard().authorize(CHAT, secret, need)).toEqual({
          ok: false,
          reason: 'not_member',
          userId: adaId,
          projectId: secret,
        });
      }
    });

    it('refuses a member below operator a write, and lets them read', async () => {
      expect(await guard().authorize(VIEWER_CHAT, widget, 'write')).toEqual({
        ok: false,
        reason: 'role',
        role: 'viewer',
        userId: vicId,
        projectId: widget,
      });
      expect(await guard().authorize(CHAT, gadget, 'write')).toMatchObject({
        ok: false,
        reason: 'role',
        role: 'viewer',
      });
      expect(
        await guard().authorize(VIEWER_CHAT, widget, 'read'),
      ).toMatchObject({ ok: true, role: 'viewer', user: { id: vicId } });
    });

    it('lets an operator write', async () => {
      expect(await guard().authorize(CHAT, widget, 'write')).toMatchObject({
        ok: true,
        role: 'operator',
        projectId: widget,
        user: { id: adaId, email: 'ada@example.com' },
      });
    });

    it('refuses a user who is no longer active', async () => {
      await ctx.prisma.user.update({
        where: { id: adaId },
        data: { status: 'disabled' },
      });
      expect(await guard().authorize(CHAT, widget, 'read')).toEqual({
        ok: false,
        reason: 'inactive_user',
        userId: adaId,
        projectId: widget,
      });
    });
  });

  describe('/help and the command menu', () => {
    it('/help lists every command the menu registers', async () => {
      const body = await say(CHAT, '/help');
      expect(body?.text).toBe(HELP_TEXT);
      for (const { command } of BOT_COMMANDS) {
        expect(HELP_TEXT).toContain(`/${command} `);
      }
    });

    it('the poller sets the menu once for the bot it polls for', async () => {
      await restart();
      await say(CHAT, '/help');
      await say(CHAT, '/help');
      const menus = fake.calls.filter((c) => c.method === 'setMyCommands');
      expect(menus).toHaveLength(1);
      expect(menus[0].body).toEqual({
        commands: BOT_COMMANDS,
        scope: { type: 'all_private_chats' },
      });
    });
  });
});
