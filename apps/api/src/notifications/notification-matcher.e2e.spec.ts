import { NOTIFICATION_NEW_EVENT } from '@agentdock/shared';
import { LiveService } from '../live/live.service';
import { NotificationMatcher } from './notification-matcher';
import {
  createNotificationsApp,
  insertEvent,
  type NotificationsE2e,
  panePrompt,
  REPO,
  reserveEventIds,
  resetNotifications,
  seedRunnerProject,
  seedUser,
} from './testing/notifications-e2e';

const T0 = new Date('2026-10-08T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe('notification matcher (e2e)', () => {
  let ctx: NotificationsE2e;
  let matcher: NotificationMatcher;
  let runnerId: string;
  let projectId: string;

  const rowsOf = (userId: string) =>
    ctx.prisma.notification.findMany({
      where: { userId },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    ctx = await createNotificationsApp();
    matcher = ctx.app.get(NotificationMatcher);
  });
  afterAll(() => ctx.app.close());

  beforeEach(async () => {
    await resetNotifications(ctx.prisma);
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    // The first pass only places the cursor after what is already stored.
    expect(await matcher.tick()).toBe(0);
  });

  it('does not notify about events stored before the matcher first ran', async () => {
    await resetNotifications(ctx.prisma);
    ({ runnerId, projectId } = await seedRunnerProject(ctx.prisma));
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    await insertEvent(ctx.prisma, runnerId, panePrompt());
    expect(await matcher.tick()).toBe(0);
    expect(await rowsOf(admin.id)).toHaveLength(0);
  });

  it('notifies every member of the project and every admin, nobody else (D2)', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const operator = await seedUser(
      ctx.prisma,
      'op@example.com',
      'operator',
      projectId,
    );
    const viewer = await seedUser(
      ctx.prisma,
      'vi@example.com',
      'viewer',
      projectId,
    );
    const outsider = await seedUser(ctx.prisma, 'out@example.com', 'operator');
    const disabled = await seedUser(
      ctx.prisma,
      'dis@example.com',
      'operator',
      projectId,
    );
    await ctx.prisma.user.update({
      where: { id: disabled.id },
      data: { status: 'disabled' },
    });

    const eventId = await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ ts: T0 }),
    );
    expect(await matcher.tick()).toBe(1);

    for (const user of [admin, operator, viewer]) {
      const rows = await rowsOf(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'pane.prompt',
        projectId,
        runnerId,
        slot: 'i42-api',
        issue: 42,
        eventId,
        count: 1,
        muted: false,
        readAt: null,
        link: `/projects/${projectId}/fleet`,
      });
    }
    expect(await rowsOf(outsider.id)).toHaveLength(0);
    expect(await rowsOf(disabled.id)).toHaveLength(0);
  });

  it('produces nothing new when an event is matched again', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const eventId = await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ ts: T0 }),
    );
    await matcher.tick();
    // Replay: move the cursor back over the event.
    await ctx.prisma.notificationMatcherState.update({
      where: { id: 1 },
      data: { eventsCursor: eventId - 1n },
    });
    expect(await matcher.tick()).toBe(1);
    const rows = await rowsOf(admin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  it('folds five prompts of one slot within 15 minutes into count 5 (D6)', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const ids: bigint[] = [];
    for (const minute of [0, 3, 6, 9, 14]) {
      ids.push(
        await insertEvent(ctx.prisma, runnerId, panePrompt({ ts: at(minute) })),
      );
    }
    expect(await matcher.tick()).toBe(5);
    const rows = await rowsOf(admin.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 5, firstAt: at(0), lastAt: at(14) });

    // Replaying the folded events changes nothing.
    await ctx.prisma.notificationMatcherState.update({
      where: { id: 1 },
      data: { eventsCursor: ids[1] },
    });
    expect(await matcher.tick()).toBe(3);
    expect((await rowsOf(admin.id))[0].count).toBe(5);

    // Past the window, and another slot: new notifications.
    await insertEvent(ctx.prisma, runnerId, panePrompt({ ts: at(16) }));
    await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ ts: at(16), slot: 'i43-web' }),
    );
    await matcher.tick();
    expect((await rowsOf(admin.id)).map((r) => r.count)).toEqual([5, 1, 1]);
  });

  it('marks a muted project muted, uncounted, and skips Telegram (D3)', async () => {
    const operator = await seedUser(
      ctx.prisma,
      'op@example.com',
      'operator',
      projectId,
    );
    await ctx.prisma.telegramLink.create({
      data: { userId: operator.id, chatId: 1001n },
    });
    await ctx.prisma.notificationMute.create({
      data: { userId: operator.id, projectId, until: at(60) },
    });

    await insertEvent(ctx.prisma, runnerId, panePrompt({ ts: at(1) }));
    await matcher.tick();
    const [row] = await rowsOf(operator.id);
    expect(row.muted).toBe(true);
    expect(
      await ctx.prisma.notification.count({
        where: { userId: operator.id, readAt: null, muted: false },
      }),
    ).toBe(0);
    expect(
      await ctx.prisma.notificationDelivery.findMany({
        where: { notificationId: row.id },
      }),
    ).toEqual([
      expect.objectContaining({ status: 'skipped', lastError: 'muted' }),
    ]);

    // After `until` the mute no longer applies.
    await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ ts: at(61), slot: 'i43-web' }),
    );
    await matcher.tick();
    const later = (await rowsOf(operator.id))[1];
    expect(later.muted).toBe(false);
    expect(
      await ctx.prisma.notificationDelivery.findFirst({
        where: { notificationId: later.id },
      }),
    ).toMatchObject({ status: 'pending' });
  });

  it('keeps in-app when Telegram is turned off for a kind', async () => {
    const quiet = await seedUser(
      ctx.prisma,
      'q@example.com',
      'operator',
      projectId,
    );
    const loud = await seedUser(
      ctx.prisma,
      'l@example.com',
      'operator',
      projectId,
    );
    for (const [user, chatId] of [
      [quiet, 1n],
      [loud, 2n],
    ] as const) {
      await ctx.prisma.telegramLink.create({
        data: { userId: user.id, chatId },
      });
    }
    await ctx.prisma.notificationRule.create({
      data: {
        userId: quiet.id,
        kind: 'quota.hit',
        inApp: true,
        telegram: false,
      },
    });

    await insertEvent(ctx.prisma, runnerId, {
      type: 'pane.quota_hit',
      data: { target: 'slot' },
      ts: T0,
    });
    await matcher.tick();
    const delivery = async (userId: string) =>
      ctx.prisma.notificationDelivery.findFirst({ where: { userId } });
    expect(await rowsOf(quiet.id)).toHaveLength(1);
    expect(await delivery(quiet.id)).toMatchObject({
      status: 'skipped',
      lastError: 'rule_off',
    });
    expect(await delivery(loud.id)).toMatchObject({ status: 'pending' });
  });

  it('writes no delivery for a user with no linked chat', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    await insertEvent(ctx.prisma, runnerId, panePrompt());
    await matcher.tick();
    expect(
      await ctx.prisma.notificationDelivery.count({
        where: { userId: admin.id },
      }),
    ).toBe(0);
  });

  it('ignores plugin echoes and bookkeeping rows', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ source: 'code-sentinel' }),
    );
    await insertEvent(ctx.prisma, runnerId, {
      type: 'events.duplicate',
      source: 'runner',
      data: { pluginEventId: 'e1', type: 'person.needed' },
    });
    expect(await matcher.tick()).toBe(2);
    expect(await rowsOf(admin.id)).toHaveLength(0);
  });

  it('waits at a hole in event ids and picks up the late commit', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const [first, second] = await reserveEventIds(ctx.prisma, 2);
    await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ id: second, slot: 'b' }),
    );
    const now = Date.now();
    expect(await matcher.tick(now)).toBe(0);

    // The earlier insert commits within the wait: both are matched, in order.
    await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ id: first, slot: 'a' }),
    );
    expect(await matcher.tick(now + 100)).toBe(2);
    expect((await rowsOf(admin.id)).map((r) => r.slot).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('takes a hole that never fills as a rolled-back insert', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const [, second] = await reserveEventIds(ctx.prisma, 2);
    await insertEvent(ctx.prisma, runnerId, panePrompt({ id: second }));
    const now = Date.now();
    expect(await matcher.tick(now)).toBe(0);
    expect(await matcher.tick(now + ctx.options.holeWaitMs - 1)).toBe(0);
    expect(await matcher.tick(now + ctx.options.holeWaitMs)).toBe(1);
    expect(await rowsOf(admin.id)).toHaveLength(1);
    expect(
      (
        await ctx.prisma.notificationMatcherState.findUniqueOrThrow({
          where: { id: 1 },
        })
      ).eventsCursor,
    ).toBe(second);
  });

  it('resolves the project by root first, by a unique repo second', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    await insertEvent(ctx.prisma, runnerId, panePrompt({ root: null }));
    await matcher.tick();
    expect((await rowsOf(admin.id))[0]?.projectId).toBe(projectId);

    // A second checkout of the same repo on the runner: the repo is ambiguous.
    await seedRunnerProject(ctx.prisma, {
      runnerId,
      root: '/srv/dev/widget-2',
    });
    await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ root: null, slot: 'x' }),
    );
    await insertEvent(
      ctx.prisma,
      runnerId,
      panePrompt({ root: '/elsewhere', repo: 'acme/other', slot: 'y' }),
    );
    await matcher.tick();
    expect(await rowsOf(admin.id)).toHaveLength(1);
    expect(REPO).toBe('acme/widget');
  });

  it('flags a dry queue at most once per project per 6 hours, and not while a slot runs', async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const dry = (ts: Date) =>
      insertEvent(ctx.prisma, runnerId, {
        type: 'round.decided',
        slot: null,
        issue: null,
        source: 'code-sentinel',
        data: {
          rows: [],
          decisions: {
            dispatching: [],
            heldForLead: [],
            notDispatching: [],
            inFlight: [],
          },
        },
        ts,
      });
    await dry(at(0));
    await dry(at(60));
    await matcher.tick();
    const rows = await rowsOf(admin.id);
    expect(rows.map((r) => r.kind)).toEqual(['queue.dry']);
    expect(rows[0].link).toBe(`/projects/${projectId}`);

    await ctx.prisma.slot.create({
      data: {
        projectId,
        name: 'i42-api',
        worktree: '/srv/dev/.wt-widget-i42-api',
        owns: [],
        never: [],
        status: 'running',
        lastSeq: 1n,
        startedAt: at(0),
        updatedAt: at(0),
      },
    });
    await dry(at(7 * 60));
    await matcher.tick();
    expect(await rowsOf(admin.id)).toHaveLength(1);
  });

  it("publishes notification.new on the recipient's user topic", async () => {
    const admin = await seedUser(ctx.prisma, 'ada@example.com', 'admin');
    const publish = jest.spyOn(ctx.app.get(LiveService), 'publish');
    try {
      await insertEvent(ctx.prisma, runnerId, panePrompt());
      await matcher.tick();
      expect(publish).toHaveBeenCalledWith(
        `user:${admin.id}`,
        NOTIFICATION_NEW_EVENT,
        expect.objectContaining({
          unreadCount: 1,
          notification: expect.objectContaining({
            kind: 'pane.prompt',
            projectName: 'widget',
          }),
        }),
      );
    } finally {
      publish.mockRestore();
    }
  });
});
