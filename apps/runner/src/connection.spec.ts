import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  MAX_EVENTS_PER_BATCH,
  RUNNER_CLOSE_CODES,
  type RunnerEvent,
  type ServerMessage,
} from '@agentdock/shared/protocol';
import { Backoff } from './backoff';
import { createDispatcher } from './commands/dispatcher';
import { createHandlers } from './commands/handlers';
import {
  batches,
  type PaneHandler,
  type RunLogHandler,
  RunnerConnection,
  type TerminalHandler,
} from './connection';
import { permissivePolicy, sameRealpath } from './policy/testing';
import { Spool } from './spool';
import { FakeClock } from './testing/fake-clock';
import {
  fakeExec,
  memoryLogger,
  TOKEN,
  tempDir,
  testEvent,
} from './testing/fixtures';
import { MockServer, until } from './testing/mock-server';

const host = { hostname: 'test-host', os: 'linux', arch: 'x64' };
const capabilities = {
  tmux: null,
  git: null,
  gh: null,
  runtimes: { claude: null, codex: null },
  profiles: [],
  codeSentinel: null,
  otlp: null,
};

const welcome = (ackedSeq: number): ServerMessage => ({
  type: 'welcome',
  runnerId: 'rn_1',
  config: { projects: [], pollIntervalsMs: {} },
  ackedSeq,
});

const eventSeqs = (server: MockServer): number[] =>
  server.of('events').flatMap((m) => m.events.map((e) => e.seq));

describe('RunnerConnection', () => {
  let dir = '';
  let cleanup = () => {};
  let servers: MockServer[] = [];
  let connection: RunnerConnection | null = null;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    servers = [];
  });
  afterEach(() => {
    connection?.stop();
    for (const s of servers) s.stop();
    cleanup();
  });

  const server = (port = 0, ackedSeq = 0) => {
    const s = new MockServer(port);
    s.welcome = () => welcome(ackedSeq);
    servers.push(s.start());
    return s;
  };

  const connect = (
    origin: string,
    clock = new FakeClock(),
    pane?: PaneHandler,
    terminal?: TerminalHandler,
    runLog?: RunLogHandler,
  ) => {
    const { log, lines } = memoryLogger();
    const spool = Spool.open({ dir, log });
    connection = new RunnerConnection({
      server: origin,
      token: TOKEN,
      spool,
      clock,
      backoff: new Backoff({ random: () => 0.5 }),
      log,
      hello: async () => ({
        runnerVersion: '0.1.0',
        protocolVersion: 1,
        ...host,
        capabilities,
      }),
      heartbeat: async () => ({
        load: [0, 0, 0],
        tmuxSessions: 0,
        collectors: {},
      }),
      dispatch: createDispatcher({
        policy: permissivePolicy,
        realpath: sameRealpath,
        handlers: createHandlers({
          policy: permissivePolicy,
          clock,
          runnerVersion: '0.1.0',
          host,
          detectCapabilities: async () => capabilities,
          exec: fakeExec({}),
          watchedProjects: () => [],
          profiles: () => [],
        }),
        disabledCommands: [],
        clock,
        log,
      }),
      pane,
      terminal,
      runLog,
    });
    connection.start();
    return { clock, spool, lines, connection };
  };

  it('dials /runner with the bearer token and goes live after welcome', async () => {
    const s = server();
    const { connection } = connect(s.origin);
    const [hello] = await s.waitFor('hello');
    expect(hello.lastAckedSeq).toBe(0);
    expect(s.authorizations).toEqual([`Bearer ${TOKEN}`]);
    await until(() => connection.isLive);
  });

  it('reconnects with backoff and resends exactly the events above welcome.ackedSeq', async () => {
    const first = server();
    const { clock, connection, spool } = connect(first.origin);
    await until(() => connection.isLive);

    for (let n = 1; n <= 3; n++) connection.emit(testEvent(n));
    await until(() => eventSeqs(first).length === 3);
    first.send({ type: 'ack', seq: 2 });
    await until(() => spool.ackedSeq === 2);
    connection.emit(testEvent(4));
    connection.emit(testEvent(5));
    await until(() => eventSeqs(first).length === 5);
    expect(eventSeqs(first)).toEqual([1, 2, 3, 4, 5]);

    // The server dies; events keep being spooled.
    const port = Number(new URL(first.origin).port);
    first.stop();
    await until(() => !connection.isLive && clock.pending().length === 1);
    expect(clock.pending()).toEqual([1_000]);
    connection.emit(testEvent(6));
    connection.emit(testEvent(7));

    // A retry while it is still down backs off further.
    clock.advance(1_000);
    await until(() => clock.pending().length === 1);
    expect(clock.pending()).toEqual([2_000]);

    // It comes back having persisted up to 3.
    const second = server(port, 3);
    clock.advance(2_000);
    const [hello] = await second.waitFor('hello');
    expect(hello.lastAckedSeq).toBe(2);
    await until(() => eventSeqs(second).length >= 4);
    await Bun.sleep(50);
    expect(eventSeqs(second)).toEqual([4, 5, 6, 7]);

    // Live events continue the sequence on the new connection.
    connection.emit(testEvent(8));
    await until(() => eventSeqs(second).length === 5);
    expect(eventSeqs(second)).toEqual([4, 5, 6, 7, 8]);
    expect(spool.ackedSeq).toBe(3);
  });

  it('resets the backoff after a connection that lasted 60 s', async () => {
    const s = server();
    const { clock, connection } = connect(s.origin);
    await until(() => connection.isLive);
    s.close(1011, 'restart');
    await until(() => clock.pending().length === 1);
    clock.advance(1_000);
    await until(() => connection.isLive);
    clock.advance(60_000);
    s.close(1011, 'restart');
    await until(
      () => !connection.isLive && clock.pending().some((d) => d === 1_000),
    );
    expect(clock.pending()).toContain(1_000);
  });

  it.each(
    Object.entries(RUNNER_CLOSE_CODES),
  )('stops for good on close code %s (%d)', async (_name, code) => {
    const s = server();
    const { clock, connection } = connect(s.origin);
    await until(() => connection.isLive);
    s.close(code, 'no');
    expect(await connection.done).toEqual({
      kind: 'terminal',
      code,
      reason: 'no',
    });
    expect(clock.pending()).toEqual([]);
  });

  it('ignores an invalid server message and keeps answering commands', async () => {
    const s = server();
    const { connection } = connect(s.origin);
    await until(() => connection.isLive);
    s.send({ type: 'bogus' });
    s.send({ type: 'command', id: 'c1', name: 'nope', args: {} });
    s.send({ type: 'command', id: 'c2', name: 'runner.ping', args: {} });
    const results = await s.waitFor('command.result', 2);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId.c1.error?.code).toBe('unknown_command');
    expect(byId.c2.ok).toBe(true);
    expect(connection.isLive).toBe(true);
    expect(s.invalid).toEqual([]);
  });

  it('hands pane subscribe / unsubscribe to the handler, sends its frames, and resets it on close', async () => {
    const s = server();
    const calls: string[] = [];
    const pane: PaneHandler = {
      subscribe: async (m) => {
        calls.push(`subscribe ${m.id} ${m.slot}`);
      },
      unsubscribe: (id) => {
        calls.push(`unsubscribe ${id}`);
      },
      reset: () => {
        calls.push('reset');
      },
    };
    const { connection } = connect(s.origin, new FakeClock(), pane);
    await until(() => connection.isLive);
    s.send({
      type: 'subscribe',
      id: 'p1',
      kind: 'pane',
      projectId: 'prj_1',
      root: '/srv/widget',
      slot: 'i42',
    });
    s.send({ type: 'unsubscribe', id: 'p1' });
    await until(() => calls.length === 2);
    expect(calls).toEqual(['subscribe p1 i42', 'unsubscribe p1']);

    expect(
      connection.sendMessage({
        type: 'pane',
        id: 'p1',
        frame: { type: 'ended' },
      }),
    ).toBe(true);
    await s.waitFor('pane');

    s.close(1006);
    await until(() => calls.includes('reset'));
  });

  it('routes subscribe by kind: run_log to the run log, pane to the pane, unsubscribe and reset to both', async () => {
    const s = server();
    const calls: string[] = [];
    const pane: PaneHandler = {
      subscribe: async (m) => {
        calls.push(`pane subscribe ${m.id}`);
      },
      unsubscribe: (id) => {
        calls.push(`pane unsubscribe ${id}`);
      },
      reset: () => {
        calls.push('pane reset');
      },
    };
    const runLog: RunLogHandler = {
      subscribe: (m) => {
        calls.push(`run_log subscribe ${m.id} ${m.projectId} ${m.runId}`);
      },
      unsubscribe: (id) => {
        calls.push(`run_log unsubscribe ${id}`);
      },
      reset: () => {
        calls.push('run_log reset');
      },
    };
    const { connection } = connect(
      s.origin,
      new FakeClock(),
      pane,
      undefined,
      runLog,
    );
    await until(() => connection.isLive);
    s.send({
      type: 'subscribe',
      id: 'r1',
      kind: 'run_log',
      projectId: 'prj_1',
      runId: 'run_1',
    });
    s.send({ type: 'unsubscribe', id: 'r1' });
    await until(() => calls.length === 3);
    expect(calls).toEqual([
      'run_log subscribe r1 prj_1 run_1',
      'pane unsubscribe r1',
      'run_log unsubscribe r1',
    ]);

    expect(
      connection.sendMessage({
        type: 'run_log',
        id: 'r1',
        frame: { type: 'ended', phase: 'succeeded' },
      }),
    ).toBe(true);
    await s.waitFor('run_log');

    s.close(1006);
    await until(() => calls.includes('run_log reset'));
    expect(calls).toContain('pane reset');
  });

  it('hands terminal.* to the handler, drops a frame with an extra field, sends its bytes, and resets it on close', async () => {
    const s = server();
    const calls: string[] = [];
    const terminal: TerminalHandler = {
      data: (m) => {
        calls.push(`data ${m.id} ${m.b64}`);
      },
      resize: (m) => {
        calls.push(`resize ${m.id} ${m.cols}x${m.rows}`);
      },
      close: (m) => {
        calls.push(`close ${m.id} ${m.reason}`);
      },
      history: async (m) => {
        calls.push(`history ${m.id}`);
      },
      reset: () => {
        calls.push('reset');
      },
    };
    const { connection } = connect(
      s.origin,
      new FakeClock(),
      undefined,
      terminal,
    );
    await until(() => connection.isLive);
    // Strict: nothing may ride along with bytes headed for a PTY.
    s.send({ type: 'terminal.data', id: 't1', b64: 'bHM=', session: 'x' });
    s.send({ type: 'terminal.data', id: 't1', b64: 'bHM=' });
    s.send({ type: 'terminal.resize', id: 't1', cols: 120, rows: 40 });
    s.send({ type: 'terminal.history.request', id: 't1', session: 'cs-i7' });
    s.send({ type: 'terminal.history.request', id: 't1' });
    s.send({ type: 'terminal.close', id: 't1', reason: 'client' });
    await until(() => calls.length === 4);
    expect(calls).toEqual([
      'data t1 bHM=',
      'resize t1 120x40',
      'history t1',
      'close t1 client',
    ]);

    expect(
      connection.sendMessage({ type: 'terminal.data', id: 't1', b64: 'b2s=' }),
    ).toBe(true);
    await s.waitFor('terminal.data');
    expect(s.invalid).toEqual([]);

    s.close(1006);
    await until(() => calls.includes('reset'));
  });

  describe('local.request relay (spec 201 D6)', () => {
    const relay = {
      method: 'queue.list',
      args: { limit: 5 },
      projectId: 'prj_1',
      session: { runtime: 'claude', id: 's-1' },
      via: 'mcp' as const,
    };

    it('answers runner_offline at once when the socket is not live, sending nothing', async () => {
      const s = server();
      s.welcome = () => null;
      const { connection } = connect(s.origin);
      await s.waitFor('hello');
      const result = await connection.request(relay);
      expect(result).toEqual({
        ok: false,
        error: { code: 'runner_offline', message: expect.any(String) },
      });
      expect(s.of('local.request')).toEqual([]);
    });

    describe('an idempotent method (card.finish, #434)', () => {
      const finish = {
        method: 'card.finish',
        args: { summary: 'done' },
        projectId: 'prj_1',
        session: { runtime: 'claude', id: 's-1' },
        via: 'mcp' as const,
      };

      /** Lets the retry loop re-arm its timer between two clock steps. */
      const step = async (clock: FakeClock, ms: number): Promise<void> => {
        clock.advance(ms);
        await Bun.sleep(0);
      };

      it('waits for the connection and succeeds once it is back, without a second call', async () => {
        const s = server();
        s.welcome = () => null;
        const { connection, clock } = connect(s.origin);
        await s.waitFor('hello');
        const pending = connection.request(finish);
        await Bun.sleep(0);
        await step(clock, 1_000);
        await step(clock, 2_000);
        expect(s.of('local.request')).toEqual([]);

        s.send(welcome(0));
        await until(() => connection.isLive);
        await step(clock, 4_000);
        const [sent] = await s.waitFor('local.request');
        expect(sent).toMatchObject({ method: 'card.finish' });
        s.send({
          type: 'local.response',
          id: sent.id,
          ok: true,
          data: { number: 75, finished: true },
        });
        expect(await pending).toEqual({
          ok: true,
          data: { number: 75, finished: true },
        });
        expect(s.of('local.request')).toHaveLength(1);
      });

      it('tells the worker to call again when the connection stays down, sending nothing', async () => {
        const s = server();
        s.welcome = () => null;
        const { connection, clock } = connect(s.origin);
        await s.waitFor('hello');
        const pending = connection.request(finish);
        await Bun.sleep(0);
        for (let i = 0; i < 130; i++) await step(clock, 1_000);
        const result = await pending;
        expect(result).toEqual({
          ok: false,
          error: {
            code: 'runner_offline',
            message: expect.stringContaining(
              'call this tool again in a minute',
            ),
          },
        });
        expect(s.of('local.request')).toEqual([]);
      });

      it('stops waiting when the connection is stopped', async () => {
        const s = server();
        s.welcome = () => null;
        const { connection, clock } = connect(s.origin);
        await s.waitFor('hello');
        const pending = connection.request(finish);
        await Bun.sleep(0);
        connection.stop();
        await step(clock, 1_000);
        expect(await pending).toMatchObject({
          ok: false,
          error: { code: 'runner_offline' },
        });
      });
    });

    it('sends local.request and settles it with the matching local.response', async () => {
      const s = server();
      const { connection } = connect(s.origin);
      await until(() => connection.isLive);
      const pending = connection.request(relay);
      const [sent] = await s.waitFor('local.request');
      expect(sent).toMatchObject({ type: 'local.request', ...relay });
      // A response nobody waits for is ignored.
      s.send({ type: 'local.response', id: 'lr_other', ok: true, data: 1 });
      s.send({
        type: 'local.response',
        id: sent.id,
        ok: false,
        error: { code: 'forbidden', message: 'viewer' },
      });
      expect(await pending).toEqual({
        ok: false,
        error: { code: 'forbidden', message: 'viewer' },
      });
    });

    it('gives up with timeout after LOCAL_REQUEST_TIMEOUT_MS', async () => {
      const s = server();
      const { connection, clock } = connect(s.origin);
      await until(() => connection.isLive);
      const pending = connection.request(relay);
      const [sent] = await s.waitFor('local.request');
      clock.advance(15_000);
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: 'timeout' },
      });
      // A late answer changes nothing.
      s.send({ type: 'local.response', id: sent.id, ok: true, data: {} });
    });

    it('answers runner_offline for what is in flight when the socket drops', async () => {
      const s = server();
      const { connection } = connect(s.origin);
      await until(() => connection.isLive);
      const pending = connection.request(relay);
      await s.waitFor('local.request');
      s.stop();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: 'runner_offline' },
      });
    });
  });
});

describe('batches', () => {
  const event = (seq: number, size = 10): RunnerEvent => ({
    ...testEvent(seq),
    seq,
    data: 'x'.repeat(size),
  });

  it('caps a batch at the protocol event count', () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) =>
      event(i + 1),
    );
    expect([...batches(events)].map((b) => b.length)).toEqual([
      MAX_EVENTS_PER_BATCH,
      1,
    ]);
  });

  it('caps a batch at the protocol byte size', () => {
    const events = Array.from({ length: 3 }, (_, i) => event(i + 1, 100_000));
    expect([...batches(events)].map((b) => b.length)).toEqual([2, 1]);
  });
});
