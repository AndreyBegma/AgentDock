import { SYSTEM_ACTOR } from '../audit/audit.types';
import { BotTokenStore, TELEGRAM_MAX_ATTEMPTS } from '../notifications';
import {
  seedRunnerProject,
  seedUser,
} from '../notifications/testing/notifications-e2e';
import { TelegramDeliveryService } from './telegram-delivery.service';
import {
  BOT_TOKEN,
  forbidden,
  serverError,
  tooManyRequests,
} from './testing/fake-telegram';
import {
  createTelegramApp,
  resetTelegram,
  type TelegramE2e,
} from './testing/telegram-e2e';

const NOW = new Date('2026-10-08T12:00:00Z');
const plus = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('Telegram delivery (e2e, D6 + D10)', () => {
  let ctx: TelegramE2e;
  let delivery: TelegramDeliveryService;
  let userId: string;
  let projectId: string;

  /** `n` notifications for the user, each with a pending Telegram delivery. */
  const pending = async (
    n: number,
    overrides: { title?: string; body?: string } = {},
  ) => {
    for (let i = 0; i < n; i += 1) {
      await ctx.prisma.notification.create({
        data: {
          userId,
          kind: 'pane.prompt',
          projectId,
          slot: `s${i}`,
          issue: 42,
          title: overrides.title ?? `t${i}`,
          body: overrides.body ?? 'A dialog waits for a person.',
          link: `/projects/${projectId}/fleet`,
          firstAt: NOW,
          lastAt: NOW,
          deliveries: {
            create: {
              userId,
              channel: 'telegram',
              status: 'pending',
              nextAttemptAt: NOW,
              createdAt: new Date(NOW.getTime() + i),
            },
          },
        },
      });
    }
  };

  const deliveries = () =>
    ctx.prisma.notificationDelivery.findMany({ orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ctx = await createTelegramApp();
    delivery = ctx.app.get(TelegramDeliveryService);
  });
  afterAll(() => ctx.close());

  beforeEach(async () => {
    await resetTelegram(ctx.prisma);
    ctx.fake.reset();
    ({ projectId } = await seedRunnerProject(ctx.prisma));
    userId = (await seedUser(ctx.prisma, 'ada@example.com', 'admin')).id;
    await ctx.app
      .get(BotTokenStore)
      .set(BOT_TOKEN, 'agentdock_bot', userId, { actor: SYSTEM_ACTOR });
    await ctx.prisma.telegramLink.create({ data: { userId, chatId: 4242n } });
  });

  it('sends 20 of 30 in ten minutes, then one digest message for the rest', async () => {
    await pending(30);
    expect(await delivery.deliverOnce(NOW)).toEqual({
      sent: 20,
      failed: 0,
      digests: 0,
      stopped: null,
    });
    expect(ctx.fake.sent()).toHaveLength(20);
    expect(await delivery.deliverOnce(plus(60))).toMatchObject({
      sent: 0,
      digests: 0,
    });

    expect(await delivery.deliverOnce(plus(600))).toMatchObject({
      sent: 0,
      digests: 1,
    });
    const sent = ctx.fake.sent();
    expect(sent).toHaveLength(21);
    expect(sent.every((c) => c.body.chat_id === 4242)).toBe(true);
    expect(sent.every((c) => c.token === BOT_TOKEN)).toBe(true);
    const digest = sent[20].body.text as string;
    expect(digest).toContain('*10 more notifications*');
    expect(digest).toContain('t29');
    expect(digest).toContain(
      '[Open notifications](https://dock.example.com/account/notifications)',
    );
    const rows = await deliveries();
    expect(rows.filter((r) => r.status === 'sent')).toHaveLength(20);
    expect(
      rows.filter((r) => r.status === 'digested' && r.sentAt !== null),
    ).toHaveLength(10);
  });

  it('formats a message as escaped MarkdownV2 with an APP_URL link', async () => {
    await pending(1, { title: 'Fix_it (now)!', body: 'a.b-c' });
    await delivery.deliverOnce(NOW);
    const [call] = ctx.fake.sent();
    expect(call.body.parse_mode).toBe('MarkdownV2');
    expect(call.body.text).toBe(
      [
        '*Fix\\_it \\(now\\)\\!*',
        'a\\.b\\-c',
        '_widget · s0 · \\#42_',
        `[Open in AgentDock](https://dock.example.com/projects/${projectId}/fleet)`,
      ].join('\n'),
    );
  });

  it('retries a 429 exactly after retry_after, and stops the pass', async () => {
    await pending(3);
    ctx.fake.script('sendMessage', tooManyRequests(7));
    expect(await delivery.deliverOnce(NOW)).toEqual({
      sent: 0,
      failed: 1,
      digests: 0,
      stopped: 'rate_limited',
    });
    // The pass stopped at the 429: one request, not three.
    expect(ctx.fake.sent()).toHaveLength(1);
    const [first] = await deliveries();
    expect(first).toMatchObject({ status: 'pending', attempts: 1 });
    expect(first.nextAttemptAt).toEqual(plus(7));
    expect(first.lastError).toContain('Too Many Requests');

    // The other two are leased (60 s); the first is due at +7 s, not before.
    expect(await delivery.deliverOnce(plus(6))).toMatchObject({ sent: 0 });
    expect(ctx.fake.sent()).toHaveLength(1);
    expect(await delivery.deliverOnce(plus(7))).toMatchObject({ sent: 1 });
    expect((await deliveries())[0]).toMatchObject({ status: 'sent' });
  });

  it(`gives up after ${TELEGRAM_MAX_ATTEMPTS} failed attempts`, async () => {
    await pending(1);
    ctx.fake.script(
      'sendMessage',
      ...Array.from({ length: TELEGRAM_MAX_ATTEMPTS }, serverError),
    );
    for (let i = 0; i < TELEGRAM_MAX_ATTEMPTS; i += 1) {
      expect(await delivery.deliverOnce(plus(i * 3600))).toMatchObject({
        failed: 1,
      });
    }
    const [row] = await deliveries();
    expect(row).toMatchObject({
      status: 'failed',
      attempts: TELEGRAM_MAX_ATTEMPTS,
    });
    await delivery.deliverOnce(plus(TELEGRAM_MAX_ATTEMPTS * 3600));
    expect(ctx.fake.sent()).toHaveLength(TELEGRAM_MAX_ATTEMPTS);
  });

  it('fails for good when the user blocked the bot', async () => {
    await pending(1);
    ctx.fake.script('sendMessage', forbidden());
    await delivery.deliverOnce(NOW);
    expect((await deliveries())[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
  });

  it('leaves the rows alone when Telegram refuses the token', async () => {
    await pending(2);
    ctx.fake.tokens.clear();
    expect(await delivery.deliverOnce(NOW)).toMatchObject({
      sent: 0,
      failed: 0,
      stopped: 'token_rejected',
    });
    expect(ctx.fake.sent()).toHaveLength(1);
    const rows = await deliveries();
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(
      true,
    );
  });

  it('never stores or logs the token in an error', async () => {
    await pending(1);
    ctx.fake.script('sendMessage', {
      status: 500,
      body: {
        ok: false,
        error_code: 500,
        description: `boom at /bot${BOT_TOKEN}/sendMessage`,
      },
    });
    const output: string[] = [];
    const capture = (chunk: unknown) => {
      output.push(String(chunk));
      return true;
    };
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(capture);
    try {
      await delivery.deliverOnce(NOW);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const [row] = await deliveries();
    expect(row.lastError).toContain('<redacted>');
    expect(row.lastError).not.toContain(BOT_TOKEN);
    expect(output.join('')).not.toContain(BOT_TOKEN);
  });

  it('sends nothing while the bot is not configured', async () => {
    await pending(1);
    await ctx.app.get(BotTokenStore).clear({ actor: SYSTEM_ACTOR });
    expect(await delivery.deliverOnce(NOW)).toMatchObject({ sent: 0 });
    expect(ctx.fake.calls).toEqual([]);
    expect((await deliveries())[0]).toMatchObject({ status: 'pending' });
  });
});
