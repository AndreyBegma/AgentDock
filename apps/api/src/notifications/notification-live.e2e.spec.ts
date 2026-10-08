import {
  NOTIFICATION_NEW_EVENT,
  NOTIFICATION_READ_EVENT,
  type NotificationNewLive,
} from '@agentdock/shared';
import { allowedLiveOrigin } from '../live/live-options';
import {
  createLiveE2eApp,
  type LiveE2eContext,
  TestLiveSocket,
} from '../live/testing/live-e2e';
import { login } from '../test/e2e-app';
import { NotificationMatcher } from './notification-matcher';
import {
  insertEvent,
  panePrompt,
  resetNotifications,
  seedRunnerProject,
  seedUser,
} from './testing/notifications-e2e';

describe('notification live push (e2e)', () => {
  let ctx: LiveE2eContext;
  const sockets: TestLiveSocket[] = [];

  beforeAll(async () => {
    // Notification timers are off under APP_ENV=test; the test drives the matcher.
    ctx = await createLiveE2eApp();
  });
  afterAll(async () => {
    for (const socket of sockets) socket.socket.close();
    await ctx.app.close();
  });

  it("pushes notification.new and notification.read to the owner's open socket", async () => {
    await resetNotifications(ctx.prisma);
    const { runnerId, projectId } = await seedRunnerProject(ctx.prisma);
    const matcher = ctx.app.get(NotificationMatcher);
    await matcher.tick();
    const ada = await seedUser(
      ctx.prisma,
      'ada@example.com',
      'operator',
      projectId,
    );
    const session = await login(ctx, 'ada@example.com');
    const socket = new TestLiveSocket(ctx.liveUrl, {
      token: session.token,
      origin: allowedLiveOrigin(),
    });
    sockets.push(socket);
    await socket.ready();
    expect((await socket.subscribe(`user:${ada.id}`)).type).toBe('subscribed');

    await insertEvent(ctx.prisma, runnerId, panePrompt());
    const started = Date.now();
    await matcher.tick();
    const pushed = await socket.next('event');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(pushed).toMatchObject({
      topic: `user:${ada.id}`,
      event: NOTIFICATION_NEW_EVENT,
    });
    const data = pushed.data as NotificationNewLive;
    expect(data.unreadCount).toBe(1);
    expect(data.notification).toMatchObject({ kind: 'pane.prompt', projectId });

    await session.send('post', '/notifications/read-all').expect(200);
    expect(await socket.next('event')).toMatchObject({
      event: NOTIFICATION_READ_EVENT,
      data: { ids: null, unreadCount: 0 },
    });
  });
});
