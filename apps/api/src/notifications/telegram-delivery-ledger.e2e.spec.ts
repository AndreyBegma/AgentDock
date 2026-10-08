import { TelegramDeliveryLedger } from './telegram-delivery-ledger';
import {
  createNotificationsApp,
  type NotificationsE2e,
  resetNotifications,
  seedRunnerProject,
  seedUser,
} from './testing/notifications-e2e';

const NOW = new Date('2026-10-08T12:00:00Z');
const plus = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('Telegram delivery ledger (e2e)', () => {
  let ctx: NotificationsE2e;
  let ledger: TelegramDeliveryLedger;
  let userId: string;
  let projectId: string;

  /** `n` notifications for the user, each with a pending Telegram delivery. */
  const pending = async (n: number, at = NOW) => {
    for (let i = 0; i < n; i += 1) {
      await ctx.prisma.notification.create({
        data: {
          userId,
          kind: 'pane.prompt',
          projectId,
          slot: `s${i}`,
          title: `t${i}`,
          body: 'b',
          firstAt: at,
          lastAt: at,
          deliveries: {
            create: {
              userId,
              channel: 'telegram',
              status: 'pending',
              nextAttemptAt: at,
              createdAt: new Date(at.getTime() + i),
            },
          },
        },
      });
    }
  };

  beforeAll(async () => {
    ctx = await createNotificationsApp();
    ledger = ctx.app.get(TelegramDeliveryLedger);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetNotifications(ctx.prisma);
    ({ projectId } = await seedRunnerProject(ctx.prisma));
    userId = (await seedUser(ctx.prisma, 'ada@example.com', 'admin')).id;
    await ctx.prisma.telegramLink.create({ data: { userId, chatId: 4242n } });
  });

  it('sends 20 of 30 in ten minutes and digests the other 10 at the window end', async () => {
    await pending(30);
    const first = await ledger.claim(NOW);
    expect(first.messages).toHaveLength(20);
    expect(first.messages[0]).toMatchObject({
      userId,
      chatId: 4242n,
      content: { kind: 'pane.prompt', title: 't0', projectName: 'widget' },
    });
    expect(first.digests).toEqual([]);
    for (const message of first.messages)
      await ledger.markSent(message.id, NOW);

    // Nothing more inside the window.
    expect(await ledger.claim(plus(60))).toEqual({ messages: [], digests: [] });

    const atEnd = await ledger.claim(plus(600));
    expect(atEnd.messages).toEqual([]);
    expect(atEnd.digests).toHaveLength(1);
    expect(atEnd.digests[0].items.map((i) => i.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `t${i + 20}`),
    );
    await ledger.markDigestSent(atEnd.digests[0].digestId, plus(600));

    expect(await ledger.claim(plus(700))).toEqual({
      messages: [],
      digests: [],
    });
    const statuses = await ctx.prisma.notificationDelivery.groupBy({
      by: ['status'],
      _count: true,
      orderBy: { status: 'asc' },
    });
    expect(statuses.map((s) => [s.status, s._count])).toEqual([
      ['sent', 20],
      ['digested', 10],
    ]);
  });

  it('honours retry_after on a 429', async () => {
    await pending(1);
    const [message] = (await ledger.claim(NOW)).messages;
    await ledger.markFailed(
      message.id,
      '429 Too Many Requests',
      { retryAfterS: 30 },
      NOW,
    );
    expect((await ledger.claim(plus(29))).messages).toEqual([]);
    const retry = (await ledger.claim(plus(30))).messages;
    expect(retry.map((m) => m.id)).toEqual([message.id]);
    expect(retry[0].attempts).toBe(1);
    await ledger.markSent(message.id, plus(31));
    expect(
      await ctx.prisma.notificationDelivery.findUniqueOrThrow({
        where: { id: message.id },
      }),
    ).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
  });

  it('gives up after a permanent failure', async () => {
    await pending(1);
    const [message] = (await ledger.claim(NOW)).messages;
    await ledger.markFailed(
      message.id,
      '403 bot was blocked',
      { permanent: true },
      NOW,
    );
    expect(
      await ctx.prisma.notificationDelivery.findUniqueOrThrow({
        where: { id: message.id },
      }),
    ).toMatchObject({ status: 'failed', lastError: '403 bot was blocked' });
    expect((await ledger.claim(plus(3600))).messages).toEqual([]);
  });

  it('does not hand out a claimed delivery twice within the lease', async () => {
    await pending(2);
    expect((await ledger.claim(NOW)).messages).toHaveLength(2);
    expect((await ledger.claim(plus(1))).messages).toEqual([]);
    // An unreported claim comes back after the lease.
    expect((await ledger.claim(plus(61))).messages).toHaveLength(2);
  });

  it('skips the deliveries of a user who unlinked', async () => {
    await pending(2);
    await ctx.prisma.telegramLink.delete({ where: { userId } });
    expect(await ledger.claim(NOW)).toEqual({ messages: [], digests: [] });
    expect(
      await ctx.prisma.notificationDelivery.findMany({
        select: { status: true, lastError: true },
      }),
    ).toEqual([
      { status: 'skipped', lastError: 'unlinked' },
      { status: 'skipped', lastError: 'unlinked' },
    ]);
  });
});
