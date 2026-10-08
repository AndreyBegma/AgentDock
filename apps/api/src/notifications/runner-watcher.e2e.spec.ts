import { RunnerPresence } from '../runners/runner-presence';
import { RunnerWatcher } from './runner-watcher';
import {
  createNotificationsApp,
  type NotificationsE2e,
  resetNotifications,
  seedUser,
} from './testing/notifications-e2e';

const NOW = new Date('2026-10-08T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const later = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe('runner watcher (e2e)', () => {
  let ctx: NotificationsE2e;
  let watcher: RunnerWatcher;
  let presence: RunnerPresence;
  let online: Set<string>;

  const runner = (data: {
    name?: string;
    lastSeenAt?: Date | null;
    pairedAt?: Date | null;
    revokedAt?: Date | null;
  }) =>
    ctx.prisma.runner.create({
      data: {
        name: data.name ?? 'desk',
        pairedAt: data.pairedAt === undefined ? minutesAgo(600) : data.pairedAt,
        lastSeenAt: data.lastSeenAt ?? null,
        revokedAt: data.revokedAt ?? null,
      },
    });

  const kindsOf = async (userId: string) =>
    (
      await ctx.prisma.notification.findMany({
        where: { userId },
        orderBy: { id: 'asc' },
      })
    ).map((n) => n.kind);

  beforeAll(async () => {
    ctx = await createNotificationsApp();
    watcher = ctx.app.get(RunnerWatcher);
    presence = ctx.app.get(RunnerPresence);
    // No runner has a socket in this suite: status comes from `online`.
    jest
      .spyOn(presence, 'status')
      .mockImplementation((r) =>
        r.revokedAt ? 'revoked' : online.has(r.id) ? 'online' : 'offline',
      );
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    online = new Set();
    await resetNotifications(ctx.prisma);
  });

  it('opens one incident per runner, notifies each admin once, and resolves in-app only', async () => {
    const ada = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const bob = await seedUser(ctx.prisma, 'bob@example.com', 'admin');
    const op = await seedUser(ctx.prisma, 'op@example.com', 'operator');
    await ctx.prisma.telegramLink.create({
      data: { userId: ada.id, chatId: 1n },
    });
    const desk = await runner({ lastSeenAt: minutesAgo(6) });

    expect(await watcher.tick(NOW)).toBe(true);
    expect(await watcher.tick(later(1))).toBe(true);
    expect(await watcher.tick(later(2))).toBe(true);

    expect(await kindsOf(ada.id)).toEqual(['runner.offline']);
    expect(await kindsOf(bob.id)).toEqual(['runner.offline']);
    expect(await kindsOf(op.id)).toEqual([]);
    expect(
      await ctx.prisma.runnerIncident.findMany({
        where: { runnerId: desk.id },
      }),
    ).toEqual([expect.objectContaining({ openedAt: NOW, resolvedAt: null })]);
    const offline = await ctx.prisma.notification.findFirstOrThrow({
      where: { userId: ada.id },
    });
    expect(offline).toMatchObject({
      runnerId: desk.id,
      projectId: null,
      link: '/admin/runners',
    });
    expect(
      await ctx.prisma.notificationDelivery.findMany({
        where: { userId: ada.id },
      }),
    ).toEqual([
      expect.objectContaining({
        notificationId: offline.id,
        status: 'pending',
      }),
    ]);

    online.add(desk.id);
    await watcher.tick(later(3));
    await watcher.tick(later(4));
    expect(await kindsOf(ada.id)).toEqual(['runner.offline', 'runner.online']);
    expect(await kindsOf(bob.id)).toEqual(['runner.offline', 'runner.online']);
    // No second Telegram message: still only the offline delivery.
    expect(
      await ctx.prisma.notificationDelivery.count({
        where: { userId: ada.id },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.runnerIncident.findFirstOrThrow({
        where: { runnerId: desk.id },
      }),
    ).toMatchObject({ resolvedAt: later(3) });

    // Gone again: a new incident.
    online.delete(desk.id);
    await ctx.prisma.runner.update({
      where: { id: desk.id },
      data: { lastSeenAt: later(4) },
    });
    await watcher.tick(later(10));
    expect(await kindsOf(ada.id)).toEqual([
      'runner.offline',
      'runner.online',
      'runner.offline',
    ]);
  });

  it('waits five minutes before alarming', async () => {
    const ada = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    await runner({ lastSeenAt: minutesAgo(4) });
    await watcher.tick(NOW);
    expect(await kindsOf(ada.id)).toEqual([]);
    await watcher.tick(later(1));
    expect(await kindsOf(ada.id)).toEqual(['runner.offline']);
  });

  it('ignores revoked and never-paired runners, and a runner that is online', async () => {
    const ada = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    await runner({
      name: 'revoked',
      lastSeenAt: minutesAgo(60),
      revokedAt: minutesAgo(30),
    });
    await runner({ name: 'unpaired', pairedAt: null });
    const live = await runner({ name: 'live', lastSeenAt: minutesAgo(60) });
    online.add(live.id);
    await watcher.tick(NOW);
    expect(await kindsOf(ada.id)).toEqual([]);
    expect(await ctx.prisma.runnerIncident.count()).toBe(0);
  });
});
