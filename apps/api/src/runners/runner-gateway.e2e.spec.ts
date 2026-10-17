import type { AdminRunnerDetail } from '@agentdock/shared';
import {
  RUNNER_CLOSE_CODES,
  type RunnerEvent,
  SPOOL_TRUNCATED_EVENT,
} from '@agentdock/shared/protocol';
import { resetDatabase, type Session } from '../test/e2e-app';
import { generateRunnerToken } from './credentials';
import { RunnerConnectHooks } from './runner-connect-hooks';
import { RunnerConnections } from './runner-connections';
import { RunnerIngestService } from './runner-ingest.service';
import { RunnerPresence } from './runner-presence';
import {
  adminSession,
  capabilities,
  createRunnerE2eApp,
  eventually,
  hello,
  pairedRunner,
  type RunnerE2eContext,
  repairRunner,
  TestRunnerSocket,
} from './testing/runner-e2e';

const PING_TIMEOUT_MS = 1_500;
const STALE_AFTER_MS = 1_000;

const event = (
  seq: number,
  overrides: Partial<RunnerEvent> = {},
): RunnerEvent => ({
  v: 1,
  seq,
  ts: '2026-10-07T18:36:02.335Z',
  type: 'slot.checkpoint',
  source: 'code-sentinel',
  project: { repo: 'AndreyBegma/AgentDock', root: '/home/archi/dev/AgentDock' },
  slot: 'i6-api',
  issue: 6,
  session: { runtime: 'claude', id: '8f0c2a', name: 'cs-i6-api' },
  data: { checkpoint: 'plan_ready', n: seq },
  ...overrides,
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => event(from + i));

describe('/runner gateway (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  const sockets: TestRunnerSocket[] = [];

  const open = (token: string | null, headers?: Record<string, string>) => {
    const socket = new TestRunnerSocket(ctx.origin, token, headers);
    sockets.push(socket);
    return socket;
  };

  const detail = async (id: string) =>
    (await admin.get(`/admin/runners/${id}`)).body as AdminRunnerDetail;

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({
      pingTimeoutMs: PING_TIMEOUT_MS,
      staleAfterMs: STALE_AFTER_MS,
    });
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  describe('authentication', () => {
    it('closes 4401 with no token, a wrong token, or a revoked token', async () => {
      expect((await open(null).closed).code).toBe(
        RUNNER_CLOSE_CODES.unauthorized,
      );
      expect((await open(generateRunnerToken()).closed).code).toBe(
        RUNNER_CLOSE_CODES.unauthorized,
      );

      const { runnerId, token } = await pairedRunner(ctx, admin);
      // Same prefix, wrong rest: found by prefix, refused by argon2.
      const forged = `${token.slice(0, 8)}${generateRunnerToken().slice(8)}`;
      expect((await open(forged).closed).code).toBe(
        RUNNER_CLOSE_CODES.unauthorized,
      );

      await admin.send('post', `/admin/runners/${runnerId}/revoke`);
      expect((await open(token).closed).code).toBe(
        RUNNER_CLOSE_CODES.unauthorized,
      );
    });

    it('a refused socket gets no reply to anything it sent', async () => {
      const socket = open(generateRunnerToken());
      await socket.opened().catch(() => {});
      if (socket.socket.readyState === socket.socket.OPEN) socket.send(hello());
      expect((await socket.closed).code).toBe(RUNNER_CLOSE_CODES.unauthorized);
      await expect(socket.next('welcome', 200)).rejects.toThrow();
    });

    it('closes 4400 naming the supported version on a wrong protocol version', async () => {
      const { token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.opened();
      socket.send({ ...hello(), protocolVersion: 2, somethingNew: true });
      expect(await socket.closed).toEqual({
        code: RUNNER_CLOSE_CODES.protocolMismatch,
        reason: 'supported protocol version: 1',
      });
    });

    it('closes 1008 when the first frame is not hello', async () => {
      const { token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.opened();
      socket.send({ type: 'events', events: [event(1)] });
      expect((await socket.closed).code).toBe(1008);
      expect(await ctx.prisma.event.count()).toBe(0);
    });

    it('revoking closes the live socket 4401 and keeps the row and events', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();
      socket.send({ type: 'events', events: range(1, 3) });
      await socket.next('ack');

      await admin.send('post', `/admin/runners/${runnerId}/revoke`);
      expect((await socket.closed).code).toBe(RUNNER_CLOSE_CODES.unauthorized);
      expect((await open(token).closed).code).toBe(
        RUNNER_CLOSE_CODES.unauthorized,
      );
      expect(await ctx.prisma.runner.count({ where: { id: runnerId } })).toBe(
        1,
      );
      expect(await ctx.prisma.event.count({ where: { runnerId } })).toBe(3);
    });

    it('a newer connection replaces the old one with 4409', async () => {
      const { token } = await pairedRunner(ctx, admin);
      const first = open(token);
      await first.connect();
      const second = open(token);
      await second.connect();
      expect((await first.closed).code).toBe(RUNNER_CLOSE_CODES.replaced);
      expect(second.socket.readyState).toBe(second.socket.OPEN);
    });

    it('C-108: replacing a live socket is audited with both peers and told to admins', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const first = open(token, { 'User-Agent': 'agentdock-runner/1 (real)' });
      await first.connect();
      const second = open(token, { 'User-Agent': 'impostor/0.1' });
      await second.connect();
      expect((await first.closed).code).toBe(RUNNER_CLOSE_CODES.replaced);

      const record = await eventually('the audit row', () =>
        ctx.prisma.auditRecord
          .findFirst({
            // Audit rows outlive the reset: append-only.
            where: { action: 'runner.connection_replaced', targetId: runnerId },
          })
          .then((r) => r ?? undefined),
      );
      expect(record).toMatchObject({
        actorType: 'runner',
        actorRunnerId: runnerId,
        targetType: 'runner',
        targetId: runnerId,
        result: 'ok',
        meta: {
          ip: '127.0.0.1',
          userAgent: 'impostor/0.1',
          previousIp: '127.0.0.1',
          previousUserAgent: 'agentdock-runner/1 (real)',
        },
      });
      const notification = await eventually('the admin notification', () =>
        ctx.prisma.notification
          .findFirst({
            where: { kind: 'runner.connection_replaced' },
            include: { user: { select: { role: true } } },
          })
          .then((n) => n ?? undefined),
      );
      expect(notification).toMatchObject({
        runnerId,
        projectId: null,
        user: { role: 'admin' },
      });
      expect(notification?.body).toContain('127.0.0.1');
    });

    describe('C-118: pre-hello sockets', () => {
      /** Opens a socket and waits until the server has authenticated it. */
      const openSilent = async (token: string) => {
        const admit = jest.spyOn(ctx.app.get(RunnerConnections), 'admit');
        try {
          const socket = open(token);
          await socket.opened();
          await eventually('the socket authenticated', async () =>
            admit.mock.calls.length > 0 ? true : undefined,
          );
          return socket;
        } finally {
          admit.mockRestore();
        }
      };

      const row = (id: string) =>
        ctx.prisma.runner.findUniqueOrThrow({
          where: { id },
          select: { hostname: true, capabilities: true, lastSeenAt: true },
        });

      it('re-pairing closes a socket that upgraded with the old token; its hello changes nothing', async () => {
        const { runnerId, token: t1 } = await pairedRunner(ctx, admin);
        const stale = await openSilent(t1);

        const t2 = await repairRunner(ctx, admin, runnerId);
        const before = await row(runnerId);
        if (stale.socket.readyState === stale.socket.OPEN) {
          stale.send(hello({ hostname: 'stale-host' }));
        }
        expect((await stale.closed).code).toBe(RUNNER_CLOSE_CODES.unauthorized);
        await expect(stale.next('welcome', 200)).rejects.toThrow();
        expect(await row(runnerId)).toEqual(before);

        const fresh = open(t2);
        await fresh.connect();
        await new Promise((r) => setTimeout(r, 200));
        expect(fresh.socket.readyState).toBe(fresh.socket.OPEN);
        expect(ctx.app.get(RunnerPresence).isConnected(runnerId)).toBe(true);
      });

      it('a hello verified against a rotated token hash updates no row', async () => {
        const { runnerId, token: t1 } = await pairedRunner(ctx, admin);
        const { tokenHash: oldHash } =
          await ctx.prisma.runner.findUniqueOrThrow({
            where: { id: runnerId },
            select: { tokenHash: true },
          });
        await repairRunner(ctx, admin, runnerId);
        const before = await row(runnerId);

        // The race eviction cannot cover: authenticated with T1 just before
        // the re-pair committed, admitted just after it closed the sockets.
        const ingest = ctx.app.get(RunnerIngestService);
        expect(
          await ingest.hello(
            runnerId,
            oldHash as string,
            hello({ hostname: 'stale-host' }),
          ),
        ).toBeNull();
        expect(await row(runnerId)).toEqual(before);
        expect((await open(t1).closed).code).toBe(
          RUNNER_CLOSE_CODES.unauthorized,
        );
      });

      it('revoking closes a socket that has not sent hello', async () => {
        const { runnerId, token } = await pairedRunner(ctx, admin);
        const stale = await openSilent(token);

        await admin.send('post', `/admin/runners/${runnerId}/revoke`);
        expect((await stale.closed).code).toBe(RUNNER_CLOSE_CODES.unauthorized);
      });
    });

    it('C-108: a reconnect after the old socket closed on its own is not reported', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const first = open(token);
      await first.connect();
      first.socket.close(1000);
      await first.closed;
      // The server has let go of it before the runner dials again.
      await eventually('the old socket detached', async () =>
        ctx.app.get(RunnerPresence).isConnected(runnerId) ? undefined : true,
      );
      await open(token).connect();
      // Give a wrongly fired report the time it would take.
      await new Promise((r) => setTimeout(r, 300));
      expect(
        await ctx.prisma.auditRecord.count({
          where: { action: 'runner.connection_replaced', targetId: runnerId },
        }),
      ).toBe(0);
      expect(
        await ctx.prisma.notification.count({
          where: { kind: 'runner.connection_replaced' },
        }),
      ).toBe(0);
    });
  });

  describe('hello', () => {
    it('#329 D4: runs the connect hooks once the runner is welcomed', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      // Whether the runner could take a command when its hook ran.
      const connected: { id: string; live: boolean }[] = [];
      ctx.app.get(RunnerConnectHooks).register({
        name: 'test',
        connected: async (id) => {
          connected.push({
            id,
            live: ctx.app.get(RunnerPresence).isConnected(id),
          });
        },
      });
      await open(token).connect();
      const seen = await eventually('the connect hook', async () =>
        connected.find((c) => c.id === runnerId),
      );
      expect(seen).toEqual({ id: runnerId, live: true });
    });

    it('welcomes with the cursor and mirrors capabilities and profiles', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      const welcome = await socket.connect();
      expect(welcome).toEqual({
        type: 'welcome',
        runnerId,
        config: { projects: [], pollIntervalsMs: {} },
        ackedSeq: 0,
      });

      const shown = await detail(runnerId);
      expect(shown).toMatchObject({
        status: 'online',
        hostname: 'test-host',
        os: 'linux',
        arch: 'x64',
        capabilities,
        profilesCount: 1,
      });
      expect(shown.profiles).toEqual([
        expect.objectContaining({
          key: 'claude-main',
          label: 'claude-main',
          runtime: 'claude',
          binary: null,
          env: { CLAUDE_CONFIG_DIR: '~/.claude-profiles/main' },
          authenticated: true,
          missing: false,
        }),
      ]);
      expect(shown.lastSeenAt).not.toBeNull();
    });

    it('marks a profile absent from the latest hello missing, never deletes it', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const first = open(token);
      await first.connect();
      await first.close();

      const second = open(token);
      await second.connect(
        hello({
          capabilities: {
            ...capabilities,
            profiles: [
              {
                id: 'codex-main',
                runtime: 'codex',
                binary: '/opt/codex',
                env: {},
                args: ['--x'],
                authenticated: false,
              },
            ],
          },
        }),
      );
      const shown = await detail(runnerId);
      expect(shown.profilesCount).toBe(1);
      expect(shown.profiles.map((p) => [p.key, p.missing, p.binary])).toEqual([
        ['claude-main', true, null],
        ['codex-main', false, '/opt/codex'],
      ]);
    });
  });

  describe('status', () => {
    it('online, stale without heartbeats, online again on a heartbeat, offline on close', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();
      expect((await detail(runnerId)).status).toBe('online');

      await eventually('stale', async () =>
        (await detail(runnerId)).status === 'stale' ? true : undefined,
      );

      socket.send({
        type: 'heartbeat',
        ts: new Date().toISOString(),
        load: [0.1, 0.2, 0.3],
        tmuxSessions: 2,
        collectors: { tmux: { ok: true } },
      });
      const live = await eventually('heartbeat', async () => {
        const shown = await detail(runnerId);
        return shown.heartbeat ? shown : undefined;
      });
      expect(live.status).toBe('online');
      expect(live.heartbeat).toMatchObject({
        load: [0.1, 0.2, 0.3],
        tmuxSessions: 2,
        collectors: { tmux: { ok: true } },
      });

      await socket.close();
      await eventually('offline', async () =>
        (await detail(runnerId)).status === 'offline' ? true : undefined,
      );
    });
  });

  describe('heartbeat profiles (#348)', () => {
    const beat = (extra: Record<string, unknown> = {}) => ({
      type: 'heartbeat' as const,
      ts: new Date().toISOString(),
      load: [0.1, 0.2, 0.3] as [number, number, number],
      tmuxSessions: 0,
      collectors: {},
      ...extra,
    });

    const storedAgentdock = async (runnerId: string) => {
      const row = await ctx.prisma.runner.findUniqueOrThrow({
        where: { id: runnerId },
        select: { capabilities: true },
      });
      const profiles = (
        row.capabilities as { profiles: { id: string; agentdock?: unknown }[] }
      ).profiles;
      return profiles.map((p) => [p.id, p.agentdock]);
    };

    let seq = 0;
    const settled = async (socket: TestRunnerSocket) => {
      // The gateway handles messages in order: the ack of a following event
      // means the beat before it is stored.
      seq += 1;
      socket.send({ type: 'events', events: [event(seq)] });
      await socket.next('ack');
    };

    it('merges reported agentdock into the stored profile, ignores unknown ids, and leaves capabilities alone without profiles', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect(
        hello({
          capabilities: {
            ...capabilities,
            profiles: [
              {
                ...capabilities.profiles[0],
                agentdock: { plugin: null, telemetry: false },
              },
            ],
          },
        }),
      );

      socket.send(
        beat({
          profiles: {
            'claude-main': { plugin: '0.4.2', telemetry: true },
            'claude-ghost': { plugin: '9.9.9', telemetry: true },
          },
        }),
      );
      await settled(socket);
      expect(await storedAgentdock(runnerId)).toEqual([
        ['claude-main', { plugin: '0.4.2', telemetry: true }],
      ]);

      socket.send(beat());
      await settled(socket);
      expect(await storedAgentdock(runnerId)).toEqual([
        ['claude-main', { plugin: '0.4.2', telemetry: true }],
      ]);

      socket.send(
        beat({
          profiles: { 'claude-main': { plugin: null, telemetry: false } },
        }),
      );
      await settled(socket);
      expect(await storedAgentdock(runnerId)).toEqual([
        ['claude-main', { plugin: null, telemetry: false }],
      ]);
    });
  });

  describe('events and ack', () => {
    it('stores each event once across a resend after reconnect; ack is the highest contiguous seq', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const first = open(token);
      await first.connect();
      first.send({ type: 'events', events: range(1, 3) });
      expect(await first.next('ack')).toEqual({ type: 'ack', seq: 3 });

      // 4 is lost in flight; 5 and 6 arrive: the cursor holds at 3.
      first.send({ type: 'events', events: range(5, 6) });
      expect(await first.next('ack')).toEqual({ type: 'ack', seq: 3 });
      first.socket.terminate();
      await first.closed;

      // The runner reconnects and resends everything above the cursor.
      const second = open(token);
      const welcome = await second.connect(hello({ lastAckedSeq: 3 }));
      expect(welcome.ackedSeq).toBe(3);
      second.send({ type: 'events', events: range(1, 6) });
      expect(await second.next('ack')).toEqual({ type: 'ack', seq: 6 });

      const stored = await ctx.prisma.event.findMany({
        where: { runnerId },
        orderBy: { seq: 'asc' },
      });
      expect(stored.map((e) => Number(e.seq))).toEqual([1, 2, 3, 4, 5, 6]);
      expect(stored[0]).toMatchObject({
        type: 'slot.checkpoint',
        source: 'code-sentinel',
        projectRepo: 'AndreyBegma/AgentDock',
        projectRoot: '/home/archi/dev/AgentDock',
        slot: 'i6-api',
        issue: 6,
        session: { runtime: 'claude', id: '8f0c2a', name: 'cs-i6-api' },
        data: { checkpoint: 'plan_ready', n: 1 },
      });

      const shown = await detail(runnerId);
      expect(shown.ackedSeq).toBe(6);
      expect(shown.events.map((e) => e.seq)).toEqual([6, 5, 4, 3, 2, 1]);
    });

    it('treats a persisted spool_truncated range as filled', async () => {
      const { token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();
      // 1..100 were dropped from the spool; 101..103 survive; 104 reports the loss.
      socket.send({ type: 'events', events: range(101, 103) });
      expect(await socket.next('ack')).toEqual({ type: 'ack', seq: 0 });
      socket.send({
        type: 'events',
        events: [
          event(104, {
            type: SPOOL_TRUNCATED_EVENT,
            source: 'runner',
            project: undefined,
            slot: undefined,
            issue: undefined,
            session: undefined,
            data: { fromSeq: 1, toSeq: 100, bytes: 10_485_760 },
          }),
        ],
      });
      expect(await socket.next('ack')).toEqual({ type: 'ack', seq: 104 });
    });

    it('drops an invalid message and keeps the socket', async () => {
      const { token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();
      socket.send({ type: 'events', events: [] });
      socket.send({ type: 'shell.exec', cmd: 'rm -rf /' });
      socket.send({ type: 'events', events: range(1, 1) });
      expect(await socket.next('ack')).toEqual({ type: 'ack', seq: 1 });
    });
  });

  describe('commands', () => {
    it('ping returns the round-trip time', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();

      // `.then` starts the request; the command arrives while it is in flight.
      const sent = admin
        .send('post', `/admin/runners/${runnerId}/ping`)
        .then((r) => r);
      const command = await socket.next('command');
      expect(command).toMatchObject({ name: 'runner.ping', args: {} });
      const ts = new Date().toISOString();
      socket.send({
        type: 'command.result',
        id: command.id,
        ok: true,
        output: { pong: true, ts },
      });
      const response = await sent;
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        rttMs: expect.any(Number),
        ts,
      });
    });

    it('relays a command error', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();
      const pinging = admin
        .send('post', `/admin/runners/${runnerId}/ping`)
        .then((r) => r);
      const command = await socket.next('command');
      socket.send({
        type: 'command.result',
        id: command.id,
        ok: false,
        error: { code: 'disabled', message: 'disabled on this machine' },
      });
      expect((await pinging).body).toEqual({
        status: 'error',
        error: { code: 'disabled', message: 'disabled on this machine' },
      });
    });

    it('a runner that never answers is unknown at the timeout, not later', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();
      const started = Date.now();
      const response = await admin.send(
        'post',
        `/admin/runners/${runnerId}/ping`,
      );
      const elapsed = Date.now() - started;
      expect(response.body).toEqual({ status: 'unknown' });
      expect(elapsed).toBeGreaterThanOrEqual(PING_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(PING_TIMEOUT_MS + 1_000);
    });

    it('a socket that closes mid-command makes it unknown at once', async () => {
      const { runnerId, token } = await pairedRunner(ctx, admin);
      const socket = open(token);
      await socket.connect();
      const started = Date.now();
      const pinging = admin
        .send('post', `/admin/runners/${runnerId}/ping`)
        .then((r) => r);
      await socket.next('command');
      socket.socket.terminate();
      expect((await pinging).body).toEqual({ status: 'unknown' });
      expect(Date.now() - started).toBeLessThan(PING_TIMEOUT_MS);
    });
  });
});
