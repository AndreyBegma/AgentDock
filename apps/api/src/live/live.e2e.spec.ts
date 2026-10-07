import {
  LIVE_CLOSE_CODES,
  MAX_LIVE_CONNECTIONS_PER_SESSION,
  MAX_LIVE_MESSAGE_BYTES,
  MAX_LIVE_SUBSCRIPTIONS,
} from '@agentdock/shared';
import {
  createUser,
  login,
  resetDatabase,
  type Session,
} from '../test/e2e-app';
import { LiveService } from './live.service';
import { allowedLiveOrigin } from './live-options';
import {
  createLiveE2eApp,
  type LiveE2eContext,
  TestLiveSocket,
} from './testing/live-e2e';

const REVALIDATE_MS = 200;
const PING_INTERVAL_MS = 100;
const IDLE_TIMEOUT_MS = 600;

describe('/live gateway (e2e)', () => {
  let ctx: LiveE2eContext;
  let live: LiveService;
  const sockets: TestLiveSocket[] = [];

  const open = (
    token: string | undefined,
    origin: string | undefined = allowedLiveOrigin(),
  ) => {
    const socket = new TestLiveSocket(ctx.liveUrl, { token, origin });
    sockets.push(socket);
    return socket;
  };

  const signIn = async (
    email: string,
    role: 'admin' | 'operator' | 'viewer',
  ): Promise<{ id: string; session: Session }> => {
    const user = await createUser(ctx.prisma, email, role);
    return { id: user.id, session: await login(ctx, email) };
  };

  beforeAll(async () => {
    ctx = await createLiveE2eApp({
      revalidateMs: REVALIDATE_MS,
      pingIntervalMs: PING_INTERVAL_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    live = ctx.app.get(LiveService);
  });
  afterAll(() => ctx.app.close());
  beforeEach(() => resetDatabase(ctx.prisma));
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  describe('handshake', () => {
    it('closes 4401 without a session cookie or with an unknown one', async () => {
      expect((await open(undefined).closed).code).toBe(
        LIVE_CLOSE_CODES.unauthorized,
      );
      expect((await open('not-a-session').closed).code).toBe(
        LIVE_CLOSE_CODES.unauthorized,
      );
    });

    it('closes 4403 on a foreign or missing Origin, even with a valid session', async () => {
      const { session } = await signIn('ada@example.com', 'admin');
      for (const origin of ['http://evil.example', undefined]) {
        const socket = new TestLiveSocket(ctx.liveUrl, {
          token: session.token,
          origin,
        });
        sockets.push(socket);
        expect((await socket.closed).code).toBe(
          LIVE_CLOSE_CODES.forbiddenOrigin,
        );
      }
    });

    it('a refused socket gets no reply to what it sent', async () => {
      const socket = open('not-a-session');
      await socket.opened().catch(() => {});
      if (socket.socket.readyState === socket.socket.OPEN) {
        socket.send({ type: 'ping' });
      }
      expect((await socket.closed).code).toBe(LIVE_CLOSE_CODES.unauthorized);
      await expect(socket.next('pong', 200)).rejects.toThrow();
    });

    it(`refuses the ${MAX_LIVE_CONNECTIONS_PER_SESSION + 1}th socket of one session with 4429`, async () => {
      const { session } = await signIn('ada@example.com', 'viewer');
      const first = await Promise.all(
        Array.from({ length: MAX_LIVE_CONNECTIONS_PER_SESSION }, () =>
          open(session.token).ready(),
        ),
      );
      expect((await open(session.token).closed).code).toBe(
        LIVE_CLOSE_CODES.tooManyConnections,
      );
      // The earlier ones are untouched, and a slot frees up on close.
      await first[0].ready();
      first[0].socket.close();
      await first[0].closed;
      await open(session.token).ready();
    });
  });

  describe('subscriptions and publish', () => {
    it('delivers an event published on the own user topic', async () => {
      const { id, session } = await signIn('ada@example.com', 'viewer');
      const socket = await open(session.token).ready();
      expect(await socket.subscribe(`user:${id}`)).toEqual({
        type: 'subscribed',
        topic: `user:${id}`,
      });

      expect(live.publish(`user:${id}`, 'user.test', { n: 1 })).toBe(1);
      const event = await socket.next('event');
      expect(event).toMatchObject({
        topic: `user:${id}`,
        event: 'user.test',
        data: { n: 1 },
      });
      expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    });

    it('does not deliver to other topics, nor after unsubscribe', async () => {
      const ada = await signIn('ada@example.com', 'viewer');
      const bob = await signIn('bob@example.com', 'viewer');
      const adaSocket = await open(ada.session.token).ready();
      const bobSocket = await open(bob.session.token).ready();
      await adaSocket.subscribe(`user:${ada.id}`);
      await bobSocket.subscribe(`user:${bob.id}`);

      expect(live.publish(`user:${ada.id}`, 'user.test', {})).toBe(1);
      await expect(bobSocket.next('event', 300)).rejects.toThrow();
      await adaSocket.next('event');

      adaSocket.send({ type: 'unsubscribe', topic: `user:${ada.id}` });
      await adaSocket.ready(); // frames are handled in order
      expect(live.publish(`user:${ada.id}`, 'user.test', {})).toBe(0);
    });

    it('subscribing twice is idempotent', async () => {
      const { id, session } = await signIn('ada@example.com', 'viewer');
      const socket = await open(session.token).ready();
      await socket.subscribe(`user:${id}`);
      expect((await socket.subscribe(`user:${id}`)).type).toBe('subscribed');
      expect(live.publish(`user:${id}`, 'user.test', {})).toBe(1);
    });

    it('authorizes every topic by role and ownership', async () => {
      const viewer = await signIn('vic@example.com', 'viewer');
      const admin = await signIn('ada@example.com', 'admin');
      const viewerSocket = await open(viewer.session.token).ready();
      const adminSocket = await open(admin.session.token).ready();

      for (const topic of ['admin', 'runner:r1', `user:${admin.id}`]) {
        expect(await viewerSocket.subscribe(topic)).toEqual({
          type: 'error',
          topic,
          code: 'forbidden',
        });
      }
      // #10 registers `project:`: a project the viewer is no member of.
      expect(await viewerSocket.subscribe('project:p1')).toEqual({
        type: 'error',
        topic: 'project:p1',
        code: 'forbidden',
      });

      for (const topic of ['admin', 'runner:r1']) {
        expect((await adminSocket.subscribe(topic)).type).toBe('subscribed');
      }
      expect(await adminSocket.subscribe(`user:${viewer.id}`)).toMatchObject({
        type: 'error',
        code: 'forbidden',
      });
      // Admins see every project, but `p1` does not exist.
      expect(await adminSocket.subscribe('project:p1')).toMatchObject({
        type: 'error',
        code: 'forbidden',
      });

      // A forbidden subscription receives nothing.
      expect(live.publish('admin', 'admin.test', {})).toBe(1);
      await expect(viewerSocket.next('event', 300)).rejects.toThrow();
    });

    it(`refuses subscription ${MAX_LIVE_SUBSCRIPTIONS + 1} with too_many_subscriptions`, async () => {
      const { session } = await signIn('ada@example.com', 'admin');
      const socket = await open(session.token).ready();
      for (let i = 1; i <= MAX_LIVE_SUBSCRIPTIONS; i += 1) {
        expect((await socket.subscribe(`runner:r${i}`)).type).toBe(
          'subscribed',
        );
      }
      expect(
        await socket.subscribe(`runner:r${MAX_LIVE_SUBSCRIPTIONS + 1}`),
      ).toEqual({
        type: 'error',
        topic: `runner:r${MAX_LIVE_SUBSCRIPTIONS + 1}`,
        code: 'too_many_subscriptions',
      });
      // One already held is still confirmed; dropping one frees a place.
      expect((await socket.subscribe('runner:r1')).type).toBe('subscribed');
      socket.send({ type: 'unsubscribe', topic: 'runner:r1' });
      expect((await socket.subscribe('admin')).type).toBe('subscribed');
    });
  });

  describe('malformed input', () => {
    it('answers invalid_message and keeps the socket open', async () => {
      const { session } = await signIn('ada@example.com', 'viewer');
      const socket = await open(session.token).ready();
      for (const frame of [
        'not json',
        JSON.stringify({ type: 'nope' }),
        JSON.stringify({ type: 'subscribe', topic: 'user:' }),
        JSON.stringify({ type: 'subscribe', topic: 'session:1' }),
      ]) {
        socket.sendRaw(frame);
        expect(await socket.next('error')).toEqual({
          type: 'error',
          code: 'invalid_message',
        });
      }
      await socket.ready();
    });

    it(`closes 1009 on a frame over ${MAX_LIVE_MESSAGE_BYTES} bytes`, async () => {
      const { session } = await signIn('ada@example.com', 'viewer');
      const socket = await open(session.token).ready();
      socket.sendRaw('x'.repeat(MAX_LIVE_MESSAGE_BYTES + 1));
      expect((await socket.closed).code).toBe(1009);
    });

    it('publish refuses a malformed topic and an oversized event', () => {
      expect(() => live.publish('user:', 'x', {})).toThrow(/malformed/);
      expect(() =>
        live.publish('admin', 'x', 'y'.repeat(MAX_LIVE_MESSAGE_BYTES)),
      ).toThrow(/exceeds/);
    });
  });

  describe('session re-validation', () => {
    it('disabling a user closes their sockets 4401 within one interval', async () => {
      const admin = await signIn('ada@example.com', 'admin');
      const viewer = await signIn('vic@example.com', 'viewer');
      const socket = await open(viewer.session.token).ready();
      const adminSocket = await open(admin.session.token).ready();

      const response = await admin.session.send(
        'patch',
        `/admin/users/${viewer.id}`,
        { status: 'disabled' },
      );
      expect(response.status).toBe(200);
      const started = Date.now();
      expect((await socket.closed).code).toBe(LIVE_CLOSE_CODES.unauthorized);
      expect(Date.now() - started).toBeLessThan(REVALIDATE_MS * 10);
      // Nobody else is affected.
      await adminSocket.ready();
    });

    it('logging out closes the session’s sockets', async () => {
      const { session } = await signIn('ada@example.com', 'viewer');
      const socket = await open(session.token).ready();
      expect((await session.send('post', '/auth/logout')).status).toBe(204);
      expect((await socket.closed).code).toBe(LIVE_CLOSE_CODES.unauthorized);
    });

    it('drops a subscription the user may no longer read', async () => {
      const admin = await signIn('ada@example.com', 'admin');
      const socket = await open(admin.session.token).ready();
      await socket.subscribe('admin');
      // A role change outside the admin API, which would also end sessions.
      await ctx.prisma.user.update({
        where: { id: admin.id },
        data: { role: 'viewer' },
      });
      expect(await socket.next('error')).toEqual({
        type: 'error',
        topic: 'admin',
        code: 'forbidden',
      });
      expect(live.publish('admin', 'admin.test', {})).toBe(0);
      await socket.ready();
    });
  });

  describe('keepalive', () => {
    it('drops a socket that stops answering pings', async () => {
      const { session } = await signIn('ada@example.com', 'viewer');
      const socket = await open(session.token).ready();
      // Sends nothing more and, with autoPong off, never answers a ping.
      const silent = new TestLiveSocket(ctx.liveUrl, {
        token: session.token,
        origin: allowedLiveOrigin(),
        autoPong: false,
      });
      sockets.push(silent);
      await silent.ready();
      const started = Date.now();
      expect((await silent.closed).code).toBe(1006);
      expect(Date.now() - started).toBeGreaterThanOrEqual(
        IDLE_TIMEOUT_MS - PING_INTERVAL_MS * 2,
      );
      // A socket that answers pings stays.
      await socket.ready();
    });
  });
});
