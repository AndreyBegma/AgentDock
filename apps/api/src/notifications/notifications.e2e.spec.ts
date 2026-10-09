import type {
  NotificationPage,
  NotificationRulesView,
} from '@agentdock/shared';
import { HttpException } from '@nestjs/common';
import { AuditService } from '../audit';
import { SYSTEM_ACTOR, userActor } from '../audit/audit.types';
import { SecretCipher } from '../common/crypto';
import { SettingsService } from '../settings/settings.service';
import { login, type Session } from '../test/e2e-app';
import {
  BotTokenStore,
  TELEGRAM_BOT_TOKEN_SETTING_KEY,
} from './bot-token.store';
import { NotificationMatcher } from './notification-matcher';
import {
  createNotificationsApp,
  insertEvent,
  type NotificationsE2e,
  panePrompt,
  resetNotifications,
  seedRunnerProject,
  seedUser,
  TEST_ENCRYPTION_KEY,
} from './testing/notifications-e2e';

const BOT_TOKEN = '7012345678:AAE-very-secret-bot-token-value';

describe('notifications API (e2e)', () => {
  let ctx: NotificationsE2e;
  let matcher: NotificationMatcher;
  let runnerId: string;
  let projectId: string;
  let otherProjectId: string;

  const signIn = async (
    email: string,
    role: 'admin' | 'operator' | 'viewer',
    member: string | null = projectId,
  ): Promise<{ id: string; session: Session }> => {
    const user = await seedUser(ctx.prisma, email, role, member ?? undefined);
    return { id: user.id, session: await login(ctx, email) };
  };

  /** One pane prompt per slot, matched for every member. */
  const prompts = async (...slots: string[]) => {
    for (const slot of slots) {
      await insertEvent(ctx.prisma, runnerId, panePrompt({ slot }));
    }
    await matcher.tick();
  };

  beforeAll(async () => {
    ctx = await createNotificationsApp();
    matcher = ctx.app.get(NotificationMatcher);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetNotifications(ctx.prisma);
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    ({ projectId: otherProjectId } = await seedRunnerProject(ctx.prisma, {
      runnerId,
      root: '/srv/dev/gadget',
      repo: 'acme/gadget',
    }));
    await matcher.tick();
  });

  describe('list and read', () => {
    it('needs a session', async () => {
      await ctx.http().get('/notifications').expect(401);
    });

    it("returns only the caller's rows, newest first, with the unread count", async () => {
      const ada = await signIn('ada@example.com', 'operator');
      const bob = await signIn('bob@example.com', 'operator');
      await prompts('a', 'b', 'c');

      const page = (await ada.session.get('/notifications').expect(200))
        .body as NotificationPage;
      expect(page.items.map((n) => n.slot)).toEqual(['c', 'b', 'a']);
      expect(page.unreadCount).toBe(3);
      expect(page.nextCursor).toBeNull();
      expect(page.items[0]).toMatchObject({
        kind: 'pane.prompt',
        projectId,
        projectName: 'widget',
        count: 1,
        readAt: null,
        muted: false,
      });
      const bobIds = (
        await ctx.prisma.notification.findMany({ where: { userId: bob.id } })
      ).map((n) => n.id.toString());
      expect(page.items.some((n) => bobIds.includes(n.id))).toBe(false);
    });

    it('pages with a cursor and refuses a malformed one', async () => {
      const ada = await signIn('ada@example.com', 'operator');
      await prompts('a', 'b', 'c');
      const first = (
        await ada.session.get('/notifications?limit=2').expect(200)
      ).body as NotificationPage;
      expect(first.items.map((n) => n.slot)).toEqual(['c', 'b']);
      expect(first.nextCursor).not.toBeNull();
      const second = (
        await ada.session
          .get(`/notifications?limit=2&cursor=${first.nextCursor}`)
          .expect(200)
      ).body as NotificationPage;
      expect(second.items.map((n) => n.slot)).toEqual(['a']);
      expect(second.nextCursor).toBeNull();

      const bad = await ada.session
        .get('/notifications?cursor=nope')
        .expect(400);
      expect(bad.body.error).toBe('invalid_cursor');
      await ada.session.get('/notifications?unread=maybe').expect(400);
      await ada.session.get('/notifications?limit=1000').expect(400);
    });

    it("marks one read, and answers 404 for another user's id", async () => {
      const ada = await signIn('ada@example.com', 'operator');
      const bob = await signIn('bob@example.com', 'operator');
      await prompts('a', 'b');
      const [mine] = await ctx.prisma.notification.findMany({
        where: { userId: ada.id },
      });
      const [theirs] = await ctx.prisma.notification.findMany({
        where: { userId: bob.id },
      });

      const read = await ada.session
        .send('post', `/notifications/${mine.id}/read`)
        .expect(200);
      expect(read.body).toEqual({ unreadCount: 1 });

      const refused = await ada.session
        .send('post', `/notifications/${theirs.id}/read`)
        .expect(404);
      expect(refused.body.error).toBe('notification_not_found');
      await ada.session
        .send('post', '/notifications/999999999/read')
        .expect(404);
      await ada.session.send('post', '/notifications/abc/read').expect(404);
      expect(
        (
          await ctx.prisma.notification.findUniqueOrThrow({
            where: { id: theirs.id },
          })
        ).readAt,
      ).toBeNull();

      const unread = (
        await ada.session.get('/notifications?unread=true').expect(200)
      ).body as NotificationPage;
      expect(unread.items).toHaveLength(1);
    });

    it("marks all of the caller's rows read, nobody else's", async () => {
      const ada = await signIn('ada@example.com', 'operator');
      const bob = await signIn('bob@example.com', 'operator');
      await prompts('a', 'b');
      expect(
        (await ada.session.send('post', '/notifications/read-all').expect(200))
          .body,
      ).toEqual({ unreadCount: 0 });
      expect(
        await ctx.prisma.notification.count({
          where: { userId: bob.id, readAt: null },
        }),
      ).toBe(2);
    });

    it('does not count muted rows as unread', async () => {
      const ada = await signIn('ada@example.com', 'operator');
      await ada.session
        .send('put', `/notifications/mutes/${projectId}`, {})
        .expect(200);
      await prompts('a');
      const page = (await ada.session.get('/notifications').expect(200))
        .body as NotificationPage;
      expect(page.items).toHaveLength(1);
      expect(page.items[0].muted).toBe(true);
      expect(page.unreadCount).toBe(0);
    });
  });

  describe('rules', () => {
    it("fills in the D1 defaults for the caller's role", async () => {
      const vic = await signIn('vic@example.com', 'viewer');
      const ada = await signIn('ada@example.com', 'admin', null);
      const viewer = (await vic.session.get('/notifications/rules').expect(200))
        .body as NotificationRulesView;
      const kinds = viewer.rules.map((r) => r.kind);
      expect(kinds).not.toContain('runner.offline');
      expect(kinds).not.toContain('budget.exceeded');
      expect(
        viewer.rules.find((r) => r.kind === 'pr.awaiting_approval'),
      ).toMatchObject({
        inApp: true,
        telegram: false,
        isDefault: true,
      });
      expect(viewer.rules.find((r) => r.kind === 'queue.dry')).toMatchObject({
        inApp: true,
        telegram: false,
      });

      const admin = (await ada.session.get('/notifications/rules').expect(200))
        .body as NotificationRulesView;
      expect(admin.rules.find((r) => r.kind === 'runner.online')).toMatchObject(
        {
          telegram: false,
          channels: ['inApp'],
        },
      );
    });

    it("stores the caller's rules and audits the change", async () => {
      const ada = await signIn('ada@example.com', 'operator');
      const response = await ada.session
        .send('put', '/notifications/rules', {
          rules: [{ kind: 'quota.hit', inApp: true, telegram: false }],
        })
        .expect(200);
      expect(
        (response.body as NotificationRulesView).rules.find(
          (r) => r.kind === 'quota.hit',
        ),
      ).toMatchObject({ telegram: false, isDefault: false });
      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        // Audit records are append-only and outlive the reset: scope to this user.
        where: { action: 'notification.rules', actorUserId: ada.id },
      });
      expect(audit).toMatchObject({
        actorUserId: ada.id,
        before: { 'quota.hit': { inApp: true, telegram: true } },
        after: { 'quota.hit': { inApp: true, telegram: false } },
      });
    });

    it('refuses kinds the caller cannot receive or channels a kind lacks', async () => {
      const op = await signIn('op@example.com', 'operator');
      const ada = await signIn('ada@example.com', 'admin', null);
      const put = (session: Session, rule: object) =>
        session.send('put', '/notifications/rules', { rules: [rule] });
      expect(
        (
          await put(op.session, {
            kind: 'runner.offline',
            inApp: true,
            telegram: true,
          }).expect(400)
        ).body.error,
      ).toBe('invalid_rule');
      await put(ada.session, {
        kind: 'runner.online',
        inApp: true,
        telegram: true,
      }).expect(400);
      await put(ada.session, {
        kind: 'nonsense',
        inApp: true,
        telegram: true,
      }).expect(400);
      await put(ada.session, {
        kind: 'pane.prompt',
        inApp: 'yes',
        telegram: true,
      }).expect(400);
    });
  });

  describe('mutes', () => {
    it('mutes, lists and unmutes a project the caller is a member of', async () => {
      const ada = await signIn('ada@example.com', 'operator');
      const until = new Date(Date.now() + 3_600_000).toISOString();
      const put = await ada.session
        .send('put', `/notifications/mutes/${projectId}`, { until })
        .expect(200);
      expect(put.body).toMatchObject({
        projectId,
        projectName: 'widget',
        until,
      });

      expect(
        (await ada.session.get('/notifications/mutes').expect(200)).body,
      ).toHaveLength(1);
      expect(
        (await ada.session.get(`/notifications/mutes/${projectId}`).expect(200))
          .body,
      ).toMatchObject({ projectId, mute: { until } });

      await ada.session
        .send('delete', `/notifications/mutes/${projectId}`)
        .expect(204);
      expect(
        (await ada.session.get(`/notifications/mutes/${projectId}`).expect(200))
          .body,
      ).toEqual({ projectId, mute: null });
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'notification.mute', actorUserId: ada.id },
        }),
      ).toBe(2);
    });

    it('answers 404 for a project the caller is not a member of', async () => {
      const ada = await signIn('ada@example.com', 'operator');
      for (const [method, path] of [
        ['put', `/notifications/mutes/${otherProjectId}`],
        ['delete', `/notifications/mutes/${otherProjectId}`],
        ['put', '/notifications/mutes/no-such-project'],
      ] as const) {
        const response = await ada.session.send(method, path, {}).expect(404);
        expect(response.body.error).toBe('project_not_found');
      }
      await ada.session
        .get(`/notifications/mutes/${otherProjectId}`)
        .expect(404);
      expect(await ctx.prisma.notificationMute.count()).toBe(0);
    });

    it('lets an admin mute any project and refuses a past until', async () => {
      const ada = await signIn('ada@example.com', 'admin', null);
      await ada.session
        .send('put', `/notifications/mutes/${otherProjectId}`, {})
        .expect(200);
      await ada.session
        .send('put', `/notifications/mutes/${projectId}`, {
          until: '2020-01-01T00:00:00.000Z',
        })
        .expect(400);
      await ada.session
        .send('put', `/notifications/mutes/${projectId}`, { until: 'tomorrow' })
        .expect(400);
    });
  });

  describe('bot token storage (D8)', () => {
    it('stores v1 ciphertext that opens with the key, and leaks the token nowhere', async () => {
      const ada = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
      const store = ctx.app.get(BotTokenStore);
      const output: string[] = [];
      const capture = (chunk: unknown) => {
        output.push(String(chunk));
        return true;
      };
      const out = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(capture);
      const err = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(capture);
      try {
        const status = await store.set(BOT_TOKEN, 'agentdock_bot', ada.id, {
          actor: userActor(ada.id),
        });
        expect(status).toEqual({
          configured: true,
          botUsername: 'agentdock_bot',
          encryptionAvailable: true,
        });
        expect(await store.read()).toEqual({
          ok: true,
          token: BOT_TOKEN,
          botUsername: 'agentdock_bot',
        });
        await store.clear({ actor: userActor(ada.id) });
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      expect(output.join('')).not.toContain(BOT_TOKEN);

      const audits = await ctx.prisma.auditRecord.findMany({
        where: {
          action: { in: ['telegram.configure', 'telegram.clear'] },
          actorUserId: ada.id,
        },
        orderBy: { seq: 'asc' },
        select: { action: true, before: true, after: true, meta: true },
      });
      expect(audits.map((a) => a.action)).toEqual([
        'telegram.configure',
        'telegram.clear',
      ]);
      expect(audits[0].after).toEqual({
        configured: true,
        botUsername: 'agentdock_bot',
      });
      expect(JSON.stringify(audits)).not.toContain(BOT_TOKEN);
      expect(await store.read()).toEqual({
        ok: false,
        reason: 'not_configured',
      });
    });

    it('writes the sealed form to settings', async () => {
      const ada = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
      await ctx.app
        .get(BotTokenStore)
        .set(BOT_TOKEN, 'agentdock_bot', ada.id, { actor: SYSTEM_ACTOR });
      const row = await ctx.prisma.setting.findUniqueOrThrow({
        where: { key: TELEGRAM_BOT_TOKEN_SETTING_KEY },
      });
      const value = row.value as { ciphertext: string; botUsername: string };
      expect(value.ciphertext.startsWith('v1:')).toBe(true);
      expect(JSON.stringify(row.value)).not.toContain(BOT_TOKEN);
      expect(
        SecretCipher.fromKeyText(TEST_ENCRYPTION_KEY).decrypt(value.ciphertext),
      ).toBe(BOT_TOKEN);
    });

    it('refuses to store a token without APP_ENCRYPTION_KEY (409)', async () => {
      const ada = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
      const keyless = new BotTokenStore(
        ctx.prisma,
        ctx.app.get(SettingsService),
        SecretCipher.fromKeyText(undefined),
        ctx.app.get(AuditService),
      );
      const error = await keyless
        .set(BOT_TOKEN, 'agentdock_bot', ada.id, { actor: userActor(ada.id) })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: 'encryption_key_missing',
      });
      expect(
        JSON.stringify((error as HttpException).getResponse()),
      ).not.toContain(BOT_TOKEN);
      expect(await ctx.prisma.setting.count()).toBe(0);
      expect(await keyless.status()).toMatchObject({
        encryptionAvailable: false,
      });
    });

    it('reports a token sealed with another key as undecryptable', async () => {
      const ada = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
      await ctx.app
        .get(BotTokenStore)
        .set(BOT_TOKEN, 'agentdock_bot', ada.id, { actor: SYSTEM_ACTOR });
      const rotated = new BotTokenStore(
        ctx.prisma,
        ctx.app.get(SettingsService),
        SecretCipher.fromKeyText(Buffer.alloc(32, 7).toString('base64')),
        ctx.app.get(AuditService),
      );
      expect(await rotated.read()).toEqual({
        ok: false,
        reason: 'undecryptable',
      });
    });
  });
});
