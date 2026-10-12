import type { Role } from '@agentdock/shared';
import { SYSTEM_ACTOR } from '../audit/audit.types';
import { SecretCipher } from '../common/crypto';
import {
  BotTokenStore,
  TELEGRAM_BOT_TOKEN_SETTING_KEY,
} from '../notifications';
import {
  seedUser,
  TEST_ENCRYPTION_KEY,
} from '../notifications/testing/notifications-e2e';
import { login, type Session } from '../test/e2e-app';
import { BOT_TOKEN, serverError } from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const OTHER_TOKEN = '7099999999:AAF-another-secret-bot-token-value-abc';
const ROUTE = '/admin/integrations/telegram';

/** Every byte the process writes while `run` runs. */
const captureOutput = async (run: () => Promise<void>): Promise<string> => {
  const output: string[] = [];
  const capture = (chunk: unknown) => {
    output.push(String(chunk));
    return true;
  };
  const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
  const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    await run();
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return output.join('');
};

describe('Telegram admin integration (e2e)', () => {
  let ctx: TelegramE2e;

  const signIn = async (
    email: string,
    role: Role,
  ): Promise<{ id: string; session: Session }> => {
    const user = await seedUser(ctx.prisma, email, role);
    return { id: user.id, session: await login(ctx, email) };
  };

  beforeAll(async () => {
    ctx = await createTelegramApp();
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
  });

  it('answers 403 to operators and viewers on every route', async () => {
    for (const [email, role] of [
      ['op@example.com', 'operator'],
      ['vic@example.com', 'viewer'],
    ] as const) {
      const { session } = await signIn(email, role);
      expect((await session.get(ROUTE)).status).toBe(403);
      expect(
        (await session.send('put', ROUTE, { token: BOT_TOKEN })).status,
      ).toBe(403);
      expect((await session.send('delete', ROUTE)).status).toBe(403);
      expect((await session.send('post', `${ROUTE}/test`)).status).toBe(403);
    }
    expect(ctx.fake.calls).toEqual([]);
    expect(await ctx.prisma.setting.count()).toBe(0);
  });

  it('verifies the token with getMe, stores v1 ciphertext, and never echoes it', async () => {
    const ada = await signIn('ada@example.com', 'admin');
    expect((await ada.session.get(ROUTE)).body).toEqual({
      configured: false,
      botUsername: null,
      encryptionAvailable: true,
      polling: false,
      lastError: null,
      lastPollAt: null,
      linkedUsers: 0,
    });

    let text = '';
    const logs = await captureOutput(async () => {
      const response = await ada.session.send('put', ROUTE, {
        token: BOT_TOKEN,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        configured: true,
        botUsername: 'agentdock_bot',
        unlinkedUsers: 0,
      });
      text = response.text;
      text += (await ada.session.get(ROUTE)).text;
    });
    expect(ctx.fake.calls.map((c) => [c.method, c.token])).toEqual([
      ['getMe', BOT_TOKEN],
    ]);
    expect(text).not.toContain(BOT_TOKEN);
    expect(logs).not.toContain(BOT_TOKEN);

    const row = await ctx.prisma.setting.findUniqueOrThrow({
      where: { key: TELEGRAM_BOT_TOKEN_SETTING_KEY },
    });
    const sealed = (row.value as { ciphertext: string }).ciphertext;
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(SecretCipher.fromKeyText(TEST_ENCRYPTION_KEY).decrypt(sealed)).toBe(
      BOT_TOKEN,
    );
    expect(JSON.stringify(row.value)).not.toContain(BOT_TOKEN);

    const audits = await ctx.prisma.auditRecord.findMany({
      where: { actorUserId: ada.id },
      select: { before: true, after: true, meta: true },
    });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(BOT_TOKEN);
  });

  it('refuses a token Telegram rejects, and stores nothing', async () => {
    const ada = await signIn('ada@example.com', 'admin');
    const response = await ada.session.send('put', ROUTE, {
      token: OTHER_TOKEN,
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'telegram_token_invalid' });
    expect(response.text).not.toContain(OTHER_TOKEN);
    expect(await ctx.prisma.setting.count()).toBe(0);
  });

  it('refuses a malformed token before calling Telegram, without quoting it', async () => {
    const ada = await signIn('ada@example.com', 'admin');
    const response = await ada.session.send('put', ROUTE, {
      token: 'not-a-token-secret-value',
    });
    expect(response.status).toBe(400);
    expect(response.text).not.toContain('not-a-token-secret-value');
    expect(ctx.fake.calls).toEqual([]);
  });

  it('answers 502 when Telegram fails, with the token redacted', async () => {
    const ada = await signIn('ada@example.com', 'admin');
    ctx.fake.script('getMe', {
      status: 500,
      body: {
        ok: false,
        error_code: 500,
        description: `Internal error for bot${BOT_TOKEN}`,
      },
    });
    const response = await ada.session.send('put', ROUTE, {
      token: BOT_TOKEN,
    });
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ error: 'telegram_unavailable' });
    expect(response.text).not.toContain(BOT_TOKEN);
    expect(response.text).toContain('<redacted>');
    expect(await ctx.prisma.setting.count()).toBe(0);

    ctx.fake.script('getMe', serverError());
    expect(
      (await ada.session.send('put', ROUTE, { token: BOT_TOKEN })).status,
    ).toBe(502);
  });

  it('answers 409 encryption_key_missing without a key, before calling Telegram', async () => {
    const keyless = await createTelegramApp(
      SecretCipher.fromKeyText(undefined),
      ctx.fake,
    );
    try {
      await seedUser(keyless.prisma, 'ada@example.com', 'admin');
      const session = await login(keyless, 'ada@example.com');
      const response = await session.send('put', ROUTE, { token: BOT_TOKEN });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: 'encryption_key_missing' });
      expect(response.text).not.toContain(BOT_TOKEN);
      expect(ctx.fake.calls).toEqual([]);
      expect(await keyless.prisma.setting.count()).toBe(0);
      expect((await session.get(ROUTE)).body).toMatchObject({
        configured: false,
        encryptionAvailable: false,
      });
    } finally {
      await keyless.close();
    }
  });

  describe('a token of another bot', () => {
    const linkUser = async (email: string, chatId: bigint) => {
      const user = await seedUser(ctx.prisma, email, 'operator');
      await ctx.prisma.telegramLink.create({
        data: { userId: user.id, chatId },
      });
      return user;
    };

    beforeEach(() => {
      ctx.fake.tokens.add(OTHER_TOKEN);
    });

    it('unlinks everyone, voids open codes, resets the offset and audits counts', async () => {
      const ada = await signIn('ada@example.com', 'admin');
      expect(
        (await ada.session.send('put', ROUTE, { token: BOT_TOKEN })).status,
      ).toBe(200);
      const bob = await linkUser('bob@example.com', 555n);
      await linkUser('cy@example.com', 666n);
      await ctx.prisma.telegramLinkCode.createMany({
        data: [
          {
            userId: bob.id,
            codeHash: 'open',
            expiresAt: new Date(Date.now() + 60_000),
          },
          {
            userId: bob.id,
            codeHash: 'used',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: new Date(),
          },
        ],
      });
      await ctx.prisma.notificationMatcherState.create({
        data: { id: 1, eventsCursor: 7n, telegramUpdateOffset: 900n },
      });

      ctx.fake.bot = { id: 7099999999, is_bot: true, username: 'other_bot' };
      const response = await ada.session.send('put', ROUTE, {
        token: OTHER_TOKEN,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        botUsername: 'other_bot',
        unlinkedUsers: 2,
        linkedUsers: 0,
      });
      expect(await ctx.prisma.telegramLink.count()).toBe(0);
      expect(
        (await ctx.prisma.telegramLinkCode.findMany()).map((c) => c.codeHash),
      ).toEqual(['used']);
      expect(
        await ctx.prisma.notificationMatcherState.findUniqueOrThrow({
          where: { id: 1 },
        }),
      ).toMatchObject({ eventsCursor: 7n, telegramUpdateOffset: 0n });

      const audit = await ctx.prisma.auditRecord.findFirstOrThrow({
        where: { action: 'telegram.unlink', actorUserId: ada.id },
        select: { after: true, meta: true },
      });
      expect(audit.after).toEqual({
        botUsername: 'other_bot',
        previousBotUsername: 'agentdock_bot',
        unlinkedUsers: 2,
      });
      expect(audit.meta).toMatchObject({ reason: 'bot_changed' });
      expect(JSON.stringify(audit)).not.toContain(OTHER_TOKEN);
    });

    it('keeps the links on a rotation of the same bot', async () => {
      const ada = await signIn('ada@example.com', 'admin');
      await ada.session.send('put', ROUTE, { token: BOT_TOKEN });
      await linkUser('bob@example.com', 555n);
      const response = await ada.session.send('put', ROUTE, {
        token: OTHER_TOKEN,
      });
      expect(response.body).toMatchObject({
        botUsername: 'agentdock_bot',
        unlinkedUsers: 0,
        linkedUsers: 1,
      });
    });

    it('still finds the old bot after the token was cleared', async () => {
      const ada = await signIn('ada@example.com', 'admin');
      await ada.session.send('put', ROUTE, { token: BOT_TOKEN });
      await linkUser('bob@example.com', 555n);
      const cleared = await ada.session.send('delete', ROUTE);
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ configured: false, linkedUsers: 1 });

      ctx.fake.bot = { id: 7099999999, is_bot: true, username: 'other_bot' };
      const response = await ada.session.send('put', ROUTE, {
        token: OTHER_TOKEN,
      });
      expect(response.body).toMatchObject({ unlinkedUsers: 1, linkedUsers: 0 });
    });
  });

  it('DELETE clears the token and audits it', async () => {
    const ada = await signIn('ada@example.com', 'admin');
    await ada.session.send('put', ROUTE, { token: BOT_TOKEN });
    const response = await ada.session.send('delete', ROUTE);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      configured: false,
      botUsername: null,
    });
    expect(
      await ctx.prisma.auditRecord.count({
        where: { action: 'telegram.clear', actorUserId: ada.id },
      }),
    ).toBe(1);
  });

  describe('POST /admin/integrations/telegram/test', () => {
    it('sends only to the calling admin’s own chat', async () => {
      const ada = await signIn('ada@example.com', 'admin');
      const eve = await seedUser(ctx.prisma, 'eve@example.com', 'admin');
      await ctx.app
        .get(BotTokenStore)
        .set(BOT_TOKEN, 'agentdock_bot', ada.id, { actor: SYSTEM_ACTOR });
      await ctx.prisma.telegramLink.create({
        data: { userId: eve.id, chatId: 999n },
      });

      const unlinked = await ada.session.send('post', `${ROUTE}/test`);
      expect(unlinked.status).toBe(409);
      expect(unlinked.body).toMatchObject({ error: 'telegram_not_linked' });
      expect(ctx.fake.sent()).toEqual([]);

      await ctx.prisma.telegramLink.create({
        data: { userId: ada.id, chatId: 555n },
      });
      const response = await ada.session.send('post', `${ROUTE}/test`);
      expect(response.status).toBe(204);
      expect(ctx.fake.sent().map((c) => c.body.chat_id)).toEqual([555]);
      expect(ctx.fake.sent()[0].body).toMatchObject({
        parse_mode: 'MarkdownV2',
      });
    });

    it('answers 409 telegram_not_configured without a bot', async () => {
      const ada = await signIn('ada@example.com', 'admin');
      await ctx.prisma.telegramLink.create({
        data: { userId: ada.id, chatId: 555n },
      });
      const response = await ada.session.send('post', `${ROUTE}/test`);
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: 'telegram_not_configured',
      });
    });
  });
});
