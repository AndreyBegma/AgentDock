import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { HelloMessage, RunnerEvent } from '@agentdock/shared/protocol';
import type { PairedConfig } from './config';
import type { RunnerConnection } from './connection';
import { runDaemon } from './daemon';
import { FORBIDDEN, fixtureProtobuf, PROTOBUF_SESSION } from './otlp/testing';
import { FakeClock } from './testing/fake-clock';
import {
  machineWithoutCodex,
  memoryLogger,
  TOKEN,
  tempDir,
} from './testing/fixtures';
import { MockServer, until } from './testing/mock-server';

const host = { hostname: 'test-host', os: 'linux', arch: 'x64' };
const ROOT = '/home/person/dev/fixture';

describe('daemon — OTLP receiver (spec 13)', () => {
  let dir = '';
  let cleanup = () => {};
  let server: MockServer;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    server = new MockServer().start();
    server.welcome = () => ({
      type: 'welcome',
      runnerId: 'rn_1',
      config: {
        projects: [{ id: 'prj_fixture', root: ROOT }],
        pollIntervalsMs: {},
      },
      ackedSeq: 0,
    });
  });
  afterEach(() => {
    server.stop();
    cleanup();
  });

  const config = (otlp: PairedConfig['otlp']): PairedConfig => ({
    server: server.origin,
    runnerId: 'rn_1',
    token: TOKEN,
    profiles: [],
    projects: [{ id: 'prj_fixture', root: ROOT }],
    disabledCommands: [],
    otlp,
    fleet: { pollSeconds: 15, prPollSeconds: 60 },
    sessions: { enabled: false },
  });

  const start = (otlp: PairedConfig['otlp']) => {
    const controller = new AbortController();
    const { log, lines } = memoryLogger();
    let connection: RunnerConnection | null = null;
    const done = runDaemon({
      config: config(otlp),
      configFile: join(dir, 'runner.json'),
      home: dir,
      spoolDir: join(dir, 'spool'),
      offsetsFile: join(dir, 'offsets.json'),
      host,
      exec: machineWithoutCodex(),
      clock: new FakeClock(),
      log,
      signal: controller.signal,
      onStart: (c) => {
        connection = c;
      },
    });
    const live = () => until(() => connection?.isLive === true);
    return { controller, done, live, lines };
  };

  it('reports the bound port in hello and spools an export as llm.request events', async () => {
    // Port 0 picks a free one; the config schema would refuse it, the daemon does not care.
    const { controller, done, live, lines } = start({ grpc: null, http: 0 });
    const [hello] = (await server.waitFor('hello')) as HelloMessage[];
    const port = hello?.capabilities.otlp?.http;
    expect(port).toBeGreaterThan(0);
    expect(hello?.capabilities.otlp?.grpc).toBeNull();
    await live();

    const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      body: fixtureProtobuf(),
      headers: { 'content-type': 'application/x-protobuf' },
    });
    expect(response.status).toBe(200);

    await until(() =>
      server
        .of('events')
        .some((m) => m.events.some((e) => e.type === 'llm.request')),
    );
    const sent: RunnerEvent[] = server
      .of('events')
      .flatMap((m) => m.events)
      .filter((e) => e.type === 'llm.request');
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      source: 'otel',
      slot: 'i42-api',
      issue: 42,
      // No git remote in the fake machine: the root's basename, as fleet events.
      project: { repo: 'fixture', root: ROOT },
      session: { runtime: 'claude', id: PROTOBUF_SESSION },
    });
    const wire = JSON.stringify(server.received);
    for (const value of FORBIDDEN) expect(wire).not.toContain(value);
    expect(lines.join('\n')).toContain('otlp: receiver listening');

    controller.abort();
    await done;
    // Stopped with the daemon: the port no longer answers.
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/logs`, { method: 'POST' }),
    ).rejects.toThrow();
  });

  it('starts no receiver when otlp.enabled is false', async () => {
    const { controller, done, live, lines } = start({
      enabled: false,
      grpc: null,
      http: 0,
    });
    const [hello] = (await server.waitFor('hello')) as HelloMessage[];
    expect(hello?.capabilities.otlp).toBeNull();
    await live();
    controller.abort();
    await done;
    expect(lines.join('\n')).not.toContain('otlp: receiver listening');
  });

  it('runs without the receiver when its port is taken', async () => {
    const taken = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('mine'),
    });
    try {
      const { controller, done, live, lines } = start({
        grpc: null,
        http: taken.port ?? 0,
      });
      const [hello] = (await server.waitFor('hello')) as HelloMessage[];
      expect(hello?.capabilities.otlp).toBeNull();
      await live();
      expect(lines.join('\n')).toContain('otlp: cannot start the receiver');
      controller.abort();
      await done;
    } finally {
      await taken.stop(true);
    }
  });
});
