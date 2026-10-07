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
import { batches, RunnerConnection } from './connection';
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

  const connect = (origin: string, clock = new FakeClock()) => {
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
        handlers: createHandlers({
          clock,
          runnerVersion: '0.1.0',
          host,
          detectCapabilities: async () => capabilities,
          exec: fakeExec({}),
          watchedProjects: () => [],
        }),
        disabledCommands: [],
        clock,
        log,
      }),
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
