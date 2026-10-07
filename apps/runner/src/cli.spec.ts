import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type HelloMessage,
  runtimeProfileSchema,
} from '@agentdock/shared/protocol';
import { type CliDeps, runCli } from './cli';
import { saveConfig } from './config';
import type { RunnerConnection } from './connection';
import type { Exec } from './detect/exec';
import { resolvePaths } from './env';
import { EXIT } from './service';
import { FakeClock } from './testing/fake-clock';
import { machineWithoutCodex, TOKEN, tempDir } from './testing/fixtures';
import { MockServer, until } from './testing/mock-server';
import { workspace } from './testing/projects';
import { RUNNER_VERSION } from './version';

const host = { hostname: 'test-host', os: 'linux', arch: 'x64' };

describe('agentdock-runner CLI', () => {
  let home = '';
  let cleanup = () => {};
  let server: MockServer;
  let stdout: string[] = [];
  let stderr: string[] = [];

  beforeEach(() => {
    ({ dir: home, cleanup } = tempDir());
    server = new MockServer().start();
    stdout = [];
    stderr = [];
  });
  afterEach(() => {
    server.stop();
    cleanup();
  });

  const deps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
    env: { HOME: home, PATH: '', AGENTDOCK_LOG: 'debug' },
    host,
    clock: new FakeClock(),
    fetch,
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    execStart: ['/opt/agentdock/agentdock-runner', 'run'],
    ...overrides,
  });
  const paths = () => resolvePaths({ HOME: home });
  const output = () => stdout.join('') + stderr.join('');

  it('version prints the package version', async () => {
    expect(await runCli(['version'], deps())).toBe(EXIT.ok);
    expect(stdout.join('')).toBe(`${RUNNER_VERSION}\n`);
    expect(RUNNER_VERSION).toBe('0.1.0');
  });

  it('an unknown or missing command is a usage error', async () => {
    expect(await runCli(['frobnicate'], deps())).toBe(EXIT.usage);
    expect(await runCli([], deps())).toBe(EXIT.usage);
  });

  describe('pair', () => {
    const pairWith = (code: string) =>
      runCli(['pair', '--server', server.origin, '--code', code], deps());

    it('stores runnerId and token in a 0600 config and never prints the token', async () => {
      server.pairing = () => Response.json({ runnerId: 'rn_1', token: TOKEN });
      const code = await runCli(
        ['pair', '--server', `${server.origin}/`, '--code', ' abcd-efgh '],
        deps(),
      );
      expect(code).toBe(EXIT.ok);

      expect(server.pairingBodies).toEqual([
        {
          code: 'ABCD-EFGH',
          hostname: 'test-host',
          version: '0.1.0',
          protocolVersion: 1,
        },
      ]);
      const file = paths().configFile;
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
        server: server.origin,
        runnerId: 'rn_1',
        token: TOKEN,
      });

      expect(stdout.join('')).toContain('Paired as rn_1');
      expect(stderr.join('')).toContain('"msg":"paired"');
      expect(output()).not.toContain(TOKEN);
    });

    it('keeps profiles and disabled commands, and logs the replaced runner id', async () => {
      saveConfig(paths().configFile, {
        server: server.origin,
        runnerId: 'rn_old',
        token: TOKEN,
        profiles: [{ id: 'claude-x', runtime: 'claude', env: {}, args: [] }],
        projects: [],
        disabledCommands: ['runner.describe'],
        otlp: null,
      });
      const fresh = TOKEN.replace('SECRET', 'SECOND');
      server.pairing = () =>
        Response.json({ runnerId: 'rn_new', token: fresh });
      expect(await pairWith('ABCD-EFGH')).toBe(EXIT.ok);
      const config = JSON.parse(readFileSync(paths().configFile, 'utf8'));
      expect(config).toMatchObject({
        runnerId: 'rn_new',
        token: fresh,
        disabledCommands: ['runner.describe'],
      });
      expect(config.profiles).toHaveLength(1);
      expect(stderr.join('')).toContain('"previousRunnerId":"rn_old"');
      expect(output()).not.toContain(fresh);
    });

    describe('profile detection', () => {
      beforeEach(() => {
        for (const name of ['a', 'b']) {
          mkdirSync(join(home, '.claude-profiles', name), { recursive: true });
        }
        server.pairing = () =>
          Response.json({ runnerId: 'rn_1', token: TOKEN });
      });

      it('writes and prints detected profiles when the config has none', async () => {
        expect(await pairWith('ABCD-EFGH')).toBe(EXIT.ok);
        const config = JSON.parse(readFileSync(paths().configFile, 'utf8'));
        expect(
          config.profiles.filter(
            (p: { runtime: string }) => p.runtime === 'claude',
          ),
        ).toHaveLength(3);
        expect(config.profiles).toHaveLength(4);
        expect(stdout.join('')).toContain('claude-a');
        expect(stdout.join('')).toContain('claude-b');
        expect(stdout.join('')).toContain('claude-default');
        expect(output()).not.toContain(TOKEN);
      });

      it('leaves existing profiles byte-identical', async () => {
        const base = {
          server: server.origin,
          runnerId: 'rn_old',
          token: TOKEN,
          profiles: [
            { id: 'mine', runtime: 'claude' as const, env: {}, args: [] },
          ],
          projects: [],
          disabledCommands: [],
          otlp: null,
        };
        saveConfig(paths().configFile, base);
        const before = JSON.stringify(
          JSON.parse(readFileSync(paths().configFile, 'utf8')).profiles,
        );
        expect(await pairWith('ABCD-EFGH')).toBe(EXIT.ok);
        const after = JSON.stringify(
          JSON.parse(readFileSync(paths().configFile, 'utf8')).profiles,
        );
        expect(after).toBe(before);
        expect(stdout.join('')).not.toContain('Detected');
      });

      it('--no-detect writes no profiles', async () => {
        const code = await runCli(
          [
            'pair',
            '--server',
            server.origin,
            '--code',
            'ABCD-EFGH',
            '--no-detect',
          ],
          deps(),
        );
        expect(code).toBe(EXIT.ok);
        const config = JSON.parse(readFileSync(paths().configFile, 'utf8'));
        expect(config.profiles).toEqual([]);
        expect(stdout.join('')).not.toContain('Detected');
      });
    });

    it('rejects a malformed code without calling the server', async () => {
      expect(await pairWith('O0O0-1111')).toBe(EXIT.failure);
      expect(server.pairingBodies).toEqual([]);
      expect(stderr.join('')).toContain('XXXX-XXXX');
    });

    it('reports an invalid, expired or used code', async () => {
      expect(await pairWith('ABCD-EFGH')).toBe(EXIT.failure);
      expect(stderr.join('')).toContain('invalid, expired or already used');
    });

    it('needs both --server and --code', async () => {
      expect(await runCli(['pair', '--server', server.origin], deps())).toBe(
        EXIT.usage,
      );
    });
  });

  describe('profiles', () => {
    beforeEach(() => {
      for (const name of ['a', 'b']) {
        mkdirSync(join(home, '.claude-profiles', name), { recursive: true });
      }
      writeFileSync(
        join(home, '.claude-profiles', 'a', '.credentials.json'),
        '{"k":1}',
      );
    });

    it('--detect proposes three claude profiles with the right dirs and auth flags', async () => {
      expect(await runCli(['profiles', '--detect'], deps())).toBe(EXIT.ok);
      const proposed = runtimeProfileSchema
        .array()
        .parse(JSON.parse(stdout.join('')));
      const claude = proposed.filter((p) => p.runtime === 'claude');
      expect(
        claude.map((p) => ({
          id: p.id,
          dir: 'CLAUDE_CONFIG_DIR' in p.env ? p.env.CLAUDE_CONFIG_DIR : null,
          authenticated: p.authenticated,
        })),
      ).toEqual([
        { id: 'claude-default', dir: null, authenticated: false },
        {
          id: 'claude-a',
          dir: join(home, '.claude-profiles', 'a'),
          authenticated: true,
        },
        {
          id: 'claude-b',
          dir: join(home, '.claude-profiles', 'b'),
          authenticated: false,
        },
      ]);
      // Proposing writes nothing.
      expect(() => statSync(paths().configFile)).toThrow();
    });

    it('--detect --write stores them, without the authenticated flag', async () => {
      expect(await runCli(['profiles', '--detect', '--write'], deps())).toBe(
        EXIT.ok,
      );
      const config = JSON.parse(readFileSync(paths().configFile, 'utf8'));
      expect(config.profiles).toHaveLength(4);
      expect(config.profiles[0]).not.toHaveProperty('authenticated');

      stdout = [];
      expect(await runCli(['profiles'], deps())).toBe(EXIT.ok);
      expect(JSON.parse(stdout.join(''))).toHaveLength(4);
    });

    it('--write alone is a usage error', async () => {
      expect(await runCli(['profiles', '--write'], deps())).toBe(EXIT.usage);
    });
  });

  it('install-service writes a unit that systemd will not restart after a terminal close', async () => {
    expect(await runCli(['install-service'], deps())).toBe(EXIT.ok);
    const unit = readFileSync(paths().serviceFile, 'utf8');
    expect(unit).toContain('ExecStart=/opt/agentdock/agentdock-runner run\n');
    expect(unit).toContain('Restart=on-failure\n');
    expect(unit).toContain(`RestartPreventExitStatus=${EXIT.terminalClose}\n`);
    expect(unit).toContain('WantedBy=default.target');
    expect(stdout.join('')).toContain(
      'systemctl --user enable --now agentdock-runner',
    );
  });

  it('status reports the config, spool and reachability without the token', async () => {
    saveConfig(paths().configFile, {
      server: server.origin,
      runnerId: 'rn_1',
      token: TOKEN,
      profiles: [],
      projects: [],
      disabledCommands: [],
      otlp: null,
    });
    expect(await runCli(['status'], deps())).toBe(EXIT.ok);
    expect(stdout.join('')).toContain('yes, as rn_1');
    expect(stdout.join('')).toContain('reachable (HTTP 404)');
    expect(output()).not.toContain(TOKEN);
  });

  describe('run', () => {
    const paired = (disabledCommands: string[] = []) =>
      saveConfig(paths().configFile, {
        server: server.origin,
        runnerId: 'rn_1',
        token: TOKEN,
        profiles: [
          { id: 'claude-default', runtime: 'claude', env: {}, args: [] },
        ],
        projects: [],
        disabledCommands,
        otlp: null,
      });

    const start = (exec: Exec = machineWithoutCodex()) => {
      const clock = new FakeClock();
      const controller = new AbortController();
      let connection: RunnerConnection | null = null;
      const exit = runCli(
        ['run'],
        deps({
          clock,
          exec,
          signal: controller.signal,
          onStart: (c) => {
            connection = c;
          },
        }),
      );
      const live = () => until(() => connection?.isLive === true);
      return { clock, controller, exit, live };
    };

    beforeEach(() => {
      server.welcome = () => ({
        type: 'welcome',
        runnerId: 'rn_1',
        config: { projects: [], pollIntervalsMs: {} },
        ackedSeq: 0,
      });
    });

    it('refuses to run unpaired', async () => {
      expect(await runCli(['run'], deps())).toBe(EXIT.failure);
      expect(stderr.join('')).toContain('Not paired');
    });

    it('sends hello with version, capabilities and profiles, then a heartbeat every 15 s', async () => {
      paired();
      const { clock, controller, exit, live } = start();
      const [hello] = (await server.waitFor('hello')) as HelloMessage[];
      expect(hello).toMatchObject({
        runnerVersion: '0.1.0',
        protocolVersion: 1,
        hostname: 'test-host',
        os: 'linux',
        arch: 'x64',
        lastAckedSeq: 0,
      });
      expect(hello.capabilities.runtimes).toEqual({
        claude: { version: '2.3.1' },
        codex: null,
      });
      expect(hello.capabilities.profiles.map((p) => p.id)).toEqual([
        'claude-default',
      ]);
      expect(server.authorizations).toEqual([`Bearer ${TOKEN}`]);

      await live();
      clock.advance(14_999);
      await Bun.sleep(30);
      expect(server.of('heartbeat')).toHaveLength(0);
      clock.advance(1);
      const [beat] = await server.waitFor('heartbeat', 1);
      expect(beat.ts).toBe('2026-10-07T18:00:15.000Z');
      expect(beat.tmuxSessions).toBe(2);
      clock.advance(15_000);
      const beats = await server.waitFor('heartbeat', 2);
      expect(beats[1].ts).toBe('2026-10-07T18:00:30.000Z');

      controller.abort();
      expect(await exit).toBe(EXIT.ok);
      expect(output()).not.toContain(TOKEN);
      expect(server.invalid).toEqual([]);
    });

    it('answers ping, unknown, disabled and invalid commands without crashing', async () => {
      paired(['runner.describe']);
      const { controller, exit, live } = start();
      await live();
      const command = (id: string, name: string, args: unknown = {}) =>
        server.send({ type: 'command', id, name, args });
      command('c1', 'runner.ping');
      command('c2', 'shell.exec', { cmd: 'id' });
      command('c3', 'runner.describe');
      command('c4', 'runner.ping', { x: 1 });
      const results = await server.waitFor('command.result', 4);
      const byId = Object.fromEntries(results.map((r) => [r.id, r]));
      expect(byId.c1.ok).toBe(true);
      expect(byId.c2.error?.code).toBe('unknown_command');
      expect(byId.c3.error?.code).toBe('disabled');
      expect(byId.c4.error?.code).toBe('invalid_args');

      command('c5', 'runner.ping');
      await server.waitFor('command.result', 5);
      expect(server.connected).toBe(true);
      controller.abort();
      expect(await exit).toBe(EXIT.ok);
    });

    it('watches the projects of welcome and config, caches them, and refreshes only those roots', async () => {
      paired();
      const project = workspace();
      try {
        const root = await project.repo('x', 'git@github.com:acme/x.git');
        project.files({ 'x/docs/': '' });
        const before = await project.run(root, 'status', '--porcelain');
        server.welcome = () => ({
          type: 'welcome',
          runnerId: 'rn_1',
          config: { projects: [{ id: 'prj_x', root }], pollIntervalsMs: {} },
          ackedSeq: 0,
        });
        const machine = machineWithoutCodex();
        const { controller, exit, live } = start((binary, args) =>
          binary === 'git' && args[0] === '-C'
            ? project.git(binary, args)
            : machine(binary, args),
        );
        await live();
        const cached = () =>
          JSON.parse(readFileSync(paths().configFile, 'utf8')).projects;
        await until(() => cached().length === 1);
        expect(cached()).toEqual([{ id: 'prj_x', root }]);

        server.send({
          type: 'command',
          id: 'r1',
          name: 'project.refresh',
          args: { projectId: 'prj_x', root },
        });
        const [refreshed] = await server.waitFor('command.result', 1);
        expect(refreshed.ok).toBe(true);
        expect(refreshed.output).toMatchObject({
          root,
          remote: { repo: 'acme/x' },
          docs: { kind: 'in_repo' },
        });

        // The project is deleted on the server: the list empties, refresh is refused.
        server.send({
          type: 'config',
          config: { projects: [], pollIntervalsMs: {} },
        });
        await until(() => cached().length === 0);
        server.send({
          type: 'command',
          id: 'r2',
          name: 'project.refresh',
          args: { projectId: 'prj_x', root },
        });
        const results = await server.waitFor('command.result', 2);
        expect(results[1].error?.code).toBe('path_not_allowed');

        // Neither the watch list nor inspection touched the repository.
        expect(await project.run(root, 'status', '--porcelain')).toBe(before);
        controller.abort();
        expect(await exit).toBe(EXIT.ok);
        expect(server.invalid).toEqual([]);
      } finally {
        project.cleanup();
      }
    });

    it('connects with no tools installed at all: codex null, still live', async () => {
      paired();
      const { controller, exit, live } = start(async () => null);
      const [hello] = await server.waitFor('hello');
      expect(hello.capabilities.runtimes.codex).toBeNull();
      await live();
      controller.abort();
      expect(await exit).toBe(EXIT.ok);
    });

    it('warns once at start when the profile list is empty', async () => {
      saveConfig(paths().configFile, {
        server: server.origin,
        runnerId: 'rn_1',
        token: TOKEN,
        profiles: [],
        projects: [],
        disabledCommands: [],
        otlp: null,
      });
      const { controller, exit, live } = start();
      await live();
      controller.abort();
      expect(await exit).toBe(EXIT.ok);
      const warnings = stderr
        .join('')
        .split('\n')
        .filter((l) => l.includes('"level":"warn"'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('profiles --detect --write');
    });

    it('does not warn when profiles exist', async () => {
      paired();
      const { controller, exit, live } = start();
      await live();
      controller.abort();
      await exit;
      expect(stderr.join('')).not.toContain('"level":"warn"');
    });

    it('exits with the terminal-close code when the token is revoked', async () => {
      paired();
      const { exit, live } = start();
      await live();
      server.close(4401, 'revoked');
      expect(await exit).toBe(EXIT.terminalClose);
    });
  });
});
