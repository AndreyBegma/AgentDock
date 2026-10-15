import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CommandResultMessage,
  HelloMessage,
  RunnerEvent,
} from '@agentdock/shared/protocol';
import type { PairedConfig } from './config';
import type { RunnerConnection } from './connection';
import { runDaemon } from './daemon';
import type { Exec } from './detect/exec';
import { type HookDeps, runHook } from './hooks/run';
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

  const config = (
    otlp: PairedConfig['otlp'],
    disabledCommands: string[] = [],
  ): PairedConfig => ({
    server: server.origin,
    runnerId: 'rn_1',
    token: TOKEN,
    profiles: [],
    projects: [{ id: 'prj_fixture', root: ROOT }],
    disabledCommands,
    otlp,
    fleet: { pollSeconds: 15, prPollSeconds: 60, eventsPollSeconds: 5 },
    queue: { pollSeconds: 60 },
    sessions: { enabled: false },
    skills: { maxConcurrentRuns: 2, maxTimeoutSec: 21_600 },
  });

  const start = (
    otlp: PairedConfig['otlp'],
    disabledCommands?: string[],
    exec: Exec = machineWithoutCodex(),
  ) => {
    const controller = new AbortController();
    const { log, lines } = memoryLogger();
    let connection: RunnerConnection | null = null;
    const done = runDaemon({
      config: config(otlp, disabledCommands),
      configFile: join(dir, 'runner.json'),
      home: dir,
      spoolDir: join(dir, 'spool'),
      offsetsFile: join(dir, 'offsets.json'),
      host,
      exec,
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

  it('reports how git reaches GitHub in hello, and serves card.prClose (#329 D1, D8)', async () => {
    const machine = machineWithoutCodex();
    const loggedIn: Exec = async (binary, args, options) =>
      binary === 'gh' && args.join(' ') === 'auth status --hostname github.com'
        ? { code: 0, stdout: '', stderr: '' }
        : machine(binary, args, options);
    let hellos = 0;
    for (const [exec, github] of [
      [loggedIn, 'gh'],
      [machine, 'native'],
    ] as const) {
      hellos += 1;
      const { controller, done, live } = start(
        { enabled: false, grpc: null, http: 0 },
        [],
        exec,
      );
      const hello = (
        (await server.waitFor('hello', hellos)) as HelloMessage[]
      ).at(-1);
      expect(hello?.capabilities.gitAuth).toEqual({ github });
      expect(hello?.capabilities.commands).toContain('card.prClose');
      await live();
      controller.abort();
      await done;
    }
  });

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

  it('advertises the served commands and the disabled subset in hello (#233)', async () => {
    const { controller, done, live } = start(
      { enabled: false, grpc: null, http: 0 },
      ['terminal.attach', 'not.a.command'],
    );
    const [hello] = (await server.waitFor('hello')) as HelloMessage[];
    const commands = hello?.capabilities.commands;
    expect(commands).toEqual([...(commands ?? [])].sort());
    expect(commands).toEqual(
      expect.arrayContaining([
        'card.assess',
        'plan.turn',
        'terminal.attach',
        'worktree.status',
      ]),
    );
    expect(hello?.capabilities.disabledCommands).toEqual(['terminal.attach']);
    await live();
    controller.abort();
    await done;
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

  it('serves the plan.* commands (spec 172): a plan it never ran closes as nothing removed', async () => {
    const { controller, done, live } = start({
      enabled: false,
      grpc: null,
      http: 0,
    });
    await live();
    server.send({
      type: 'command',
      id: 'cmd_plan_close',
      name: 'plan.close',
      args: { planId: 'plan_1', projectId: 'prj_fixture' },
    });
    const [result] = (await server.waitFor(
      'command.result',
    )) as CommandResultMessage[];
    expect(result).toMatchObject({
      id: 'cmd_plan_close',
      ok: true,
      output: { removed: false },
    });
    controller.abort();
    await done;
  });

  it('serves the uiprofile.* commands (spec 223): a fingerprint of an unwatched root is refused', async () => {
    const { controller, done, live } = start({
      enabled: false,
      grpc: null,
      http: 0,
    });
    await live();
    server.send({
      type: 'command',
      id: 'cmd_uip_fp',
      name: 'uiprofile.fingerprint',
      args: {
        projectId: 'prj_fixture',
        root: '/not/watched',
        base: 'main',
        globs: ['src/**'],
      },
    });
    const [result] = (await server.waitFor(
      'command.result',
    )) as CommandResultMessage[];
    // Served (not `unknown_command` or `unsupported`) and confined to watched projects.
    expect(result).toMatchObject({
      id: 'cmd_uip_fp',
      ok: false,
      error: { code: 'path_not_allowed' },
    });
    controller.abort();
    await done;
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

describe('daemon — local socket (spec 201)', () => {
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
        projects: [{ id: 'prj_fixture', root: ROOT, shipContent: true }],
        pollIntervalsMs: {},
        awayMode: true,
      },
      ackedSeq: 0,
    });
  });
  afterEach(() => {
    server.stop();
    cleanup();
  });

  const start = () => {
    const controller = new AbortController();
    let connection: RunnerConnection | null = null;
    const done = runDaemon({
      config: {
        server: server.origin,
        runnerId: 'rn_1',
        token: TOKEN,
        profiles: [],
        projects: [],
        disabledCommands: [],
        otlp: { enabled: false, grpc: null, http: null },
        fleet: { pollSeconds: 15, prPollSeconds: 60, eventsPollSeconds: 5 },
        queue: { pollSeconds: 60 },
        sessions: { enabled: false },
        skills: { maxConcurrentRuns: 2, maxTimeoutSec: 21_600 },
      },
      configFile: join(dir, 'runner.json'),
      home: dir,
      spoolDir: join(dir, 'spool'),
      offsetsFile: join(dir, 'offsets.json'),
      host,
      exec: machineWithoutCodex(),
      clock: new FakeClock(),
      log: memoryLogger().log,
      signal: controller.signal,
      onStart: (c) => {
        connection = c;
      },
    });
    const live = () => until(() => connection?.isLive === true);
    return { controller, done, live };
  };

  const hookDeps = (stdin: unknown, stdout: string[]): HookDeps => ({
    env: {},
    os: 'linux',
    socketPath: join(dir, 'runner.sock'),
    cwd: ROOT,
    ppid: 999_999,
    stdin: () =>
      new Response(JSON.stringify(stdin)).body as ReadableStream<Uint8Array>,
    stdout: (t) => stdout.push(t),
    stderr: () => {},
    exec: async () => null,
    readFile: () => {
      throw new Error('ENOENT');
    },
  });

  const GHP = `ghp_${'c'.repeat(36)}`;

  it('spools hook events with source hook, redacted, and relays session-start context', async () => {
    const { controller, done, live } = start();
    await live();
    expect(statSync(join(dir, 'runner.sock')).mode & 0o777).toBe(0o600);

    const stdout: string[] = [];
    await runHook(
      ['user-prompt-submit'],
      hookDeps({ session_id: 's-1', cwd: ROOT, prompt: `use ${GHP}` }, stdout),
    );
    await until(() =>
      server
        .of('events')
        .some((m) => m.events.some((e) => e.type === 'hook.prompt_submitted')),
    );
    const event = server
      .of('events')
      .flatMap((m) => m.events)
      .find((e) => e.type === 'hook.prompt_submitted');
    expect(event).toMatchObject({
      source: 'hook',
      project: { repo: 'fixture', root: ROOT },
      session: { runtime: 'claude', id: 's-1' },
      data: { chars: GHP.length + 4, content: { truncated: false } },
    });
    expect(JSON.stringify(event)).not.toContain(GHP);

    const pending = runHook(
      ['session-start'],
      hookDeps({ session_id: 's-1', cwd: ROOT, source: 'startup' }, stdout),
    );
    const [request] = await server.waitFor('local.request');
    expect(request).toMatchObject({
      method: 'context.sessionStart',
      projectId: 'prj_fixture',
      session: { runtime: 'claude', id: 's-1' },
      via: 'hook',
    });
    server.send({
      type: 'local.response',
      id: request?.id ?? '',
      ok: true,
      data: { text: 'Project fixture.' },
    });
    expect(await pending).toBe(0);
    expect(JSON.parse(stdout.join(''))).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Project fixture.',
      },
    });

    controller.abort();
    await done;
    expect(existsSync(join(dir, 'runner.sock'))).toBe(false);
  });
});
