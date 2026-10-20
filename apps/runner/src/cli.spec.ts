import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type HelloMessage,
  runtimeProfileSchema,
} from '@agentdock/shared/protocol';
import { type CliDeps, runCli } from './cli';
import { type ConfigProfile, saveConfig } from './config';
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

  it('version prints the package version and the target', async () => {
    expect(await runCli(['version'], deps())).toBe(EXIT.ok);
    expect(stdout.join('')).toBe(`${RUNNER_VERSION} linux-x64\n`);
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
    ) as { version: string };
    expect(RUNNER_VERSION).toBe(pkg.version);
  });

  it('an unknown or missing command is a usage error', async () => {
    expect(await runCli(['frobnicate'], deps())).toBe(EXIT.usage);
    expect(await runCli([], deps())).toBe(EXIT.usage);
  });

  describe('policy', () => {
    it('show prints the effective policy; set changes it in runner.json', async () => {
      expect(await runCli(['policy', 'show'], deps())).toBe(EXIT.ok);
      expect(JSON.parse(stdout.join('')).maxPermissionMode).toBe('auto');
      expect(stderr.join('')).toContain('No root is allowed');
      expect(
        await runCli(['policy', 'set', 'terminal.write', 'true'], deps()),
      ).toBe(EXIT.ok);
      const config = JSON.parse(readFileSync(paths().configFile, 'utf8'));
      expect(config.policy.terminal).toEqual({ write: true });
    });

    it('prints its usage for an unknown verb', async () => {
      expect(await runCli(['policy', 'grant'], deps())).toBe(EXIT.usage);
      expect(stderr.join('')).toContain('Usage: agentdock-runner policy');
    });
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
          version: RUNNER_VERSION,
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

    describe('cleartext servers (F-20)', () => {
      const lan = (extra: string[]) =>
        runCli(
          [
            'pair',
            '--server',
            'http://dock.lan',
            '--code',
            'ABCD-EFGH',
            ...extra,
          ],
          deps({
            fetch: (async () =>
              Response.json({
                runnerId: 'rn_1',
                token: TOKEN,
              })) as unknown as typeof fetch,
          }),
        );

      it('refuses http://dock.lan without --insecure and writes nothing', async () => {
        expect(await lan([])).not.toBe(EXIT.ok);
        expect(() => statSync(paths().configFile)).toThrow();
      });

      it('pair --insecure persists insecureServer and warns; status and run warn too', async () => {
        expect(await lan(['--insecure'])).toBe(EXIT.ok);
        expect(stdout.join('')).toContain('WARNING');
        expect(
          JSON.parse(readFileSync(paths().configFile, 'utf8')),
        ).toMatchObject({ server: 'http://dock.lan', insecureServer: true });

        stdout.length = 0;
        await runCli(
          ['status'],
          deps({
            fetch: (async () => new Response('')) as unknown as typeof fetch,
          }),
        );
        expect(stdout.join('')).toContain('WARNING');

        stderr.length = 0;
        const controller = new AbortController();
        controller.abort();
        await runCli(
          ['run'],
          deps({
            signal: controller.signal,
            createSocket: () => {
              throw new Error('no network in tests');
            },
          }),
        );
        expect(stderr.join('')).toContain('WARNING');
      });

      it('run refuses a plain-http config that was not paired with --insecure', async () => {
        saveConfig(paths().configFile, {
          server: 'http://dock.lan',
          runnerId: 'rn_1',
          token: TOKEN,
        });
        expect(await runCli(['run'], deps())).toBe(EXIT.failure);
        expect(stderr.join('')).toContain('--insecure');
      });
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

    it('allows the --allow-root directories as real paths, and says so (ADR-0047)', async () => {
      server.pairing = () => Response.json({ runnerId: 'rn_1', token: TOKEN });
      const dev = join(home, 'dev');
      mkdirSync(dev, { recursive: true });
      const code = await runCli(
        [
          'pair',
          '--server',
          server.origin,
          '--code',
          'ABCD-EFGH',
          '--allow-root',
          dev,
        ],
        deps(),
      );
      expect(code).toBe(EXIT.ok);
      const config = JSON.parse(readFileSync(paths().configFile, 'utf8'));
      expect(config.policy.allowedRoots).toEqual([realpathSync(dev)]);
      expect(config.policy.maxPermissionMode).toBe('auto');
      expect(stdout.join('')).toContain('Projects may be watched under:');
    });

    it('refuses a missing --allow-root before pairing', async () => {
      const code = await runCli(
        [
          'pair',
          '--server',
          server.origin,
          '--code',
          'ABCD-EFGH',
          '--allow-root',
          join(home, 'missing'),
        ],
        deps(),
      );
      expect(code).toBe(EXIT.usage);
      expect(server.pairingBodies).toEqual([]);
    });

    describe('Cloudflare Access service token', () => {
      const SECRET = 'cf-secret-value-123';
      const ID = 'abc.access';
      const pairAccess = (
        extra: string[],
        env: Record<string, string> = {},
      ) => {
        server.pairing = () =>
          Response.json({ runnerId: 'rn_1', token: TOKEN });
        return runCli(
          ['pair', '--server', server.origin, '--code', 'ABCD-EFGH', ...extra],
          deps({
            env: { HOME: home, PATH: '', AGENTDOCK_LOG: 'debug', ...env },
          }),
        );
      };

      it('sends both headers on pairing, stores them 0600, and never prints the secret', async () => {
        const code = await pairAccess([
          '--access-client-id',
          ID,
          '--access-client-secret',
          SECRET,
        ]);
        expect(code).toBe(EXIT.ok);
        expect(server.pairingAccess).toEqual([{ id: ID, secret: SECRET }]);
        const file = paths().configFile;
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
          accessClientId: ID,
          accessClientSecret: SECRET,
        });
        expect(output()).not.toContain(SECRET);

        stdout.length = 0;
        stderr.length = 0;
        await runCli(['status'], deps());
        expect(stdout.join('')).toContain('access token: set');
        expect(output()).not.toContain(SECRET);
      });

      it('reads the secret from stdin or the environment', async () => {
        const stdin = () =>
          new Response(`${SECRET}\n`).body as ReadableStream<Uint8Array>;
        server.pairing = () =>
          Response.json({ runnerId: 'rn_1', token: TOKEN });
        await runCli(
          [
            'pair',
            '--server',
            server.origin,
            '--code',
            'ABCD-EFGH',
            '--access-client-id',
            ID,
            '--access-client-secret-stdin',
          ],
          deps({ stdin }),
        );
        expect(server.pairingAccess).toEqual([{ id: ID, secret: SECRET }]);

        await pairAccess(['--access-client-id', ID], {
          AGENTDOCK_ACCESS_CLIENT_SECRET: 'from-env',
        });
        expect(server.pairingAccess[1]).toEqual({ id: ID, secret: 'from-env' });
      });

      it('sends neither header without credentials, and rejects half a token', async () => {
        expect(await pairAccess([])).toBe(EXIT.ok);
        expect(server.pairingAccess).toEqual([{ id: null, secret: null }]);
        expect(await pairAccess(['--access-client-id', ID])).toBe(EXIT.usage);
      });
    });

    it('without --allow-root, says no project root is allowed yet', async () => {
      server.pairing = () => Response.json({ runnerId: 'rn_1', token: TOKEN });
      expect(await pairWith('ABCD-EFGH')).toBe(EXIT.ok);
      expect(stdout.join('')).toContain('No project root is allowed yet');
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

  it('install-service on macOS writes a launchd agent and prints how to load it', async () => {
    const mac = deps({
      host: { ...host, os: 'darwin', arch: 'arm64' },
      env: { HOME: home, PATH: '/opt/homebrew/bin:/usr/bin' },
    });
    expect(await runCli(['install-service'], mac)).toBe(EXIT.ok);
    const plist = readFileSync(paths().launchAgentFile, 'utf8');
    expect(paths().launchAgentFile).toBe(
      join(home, 'Library', 'LaunchAgents', 'com.agentdock.runner.plist'),
    );
    expect(plist).toContain(
      '<string>/opt/agentdock/agentdock-runner</string>\n    <string>run</string>',
    );
    expect(plist).toContain(`<string>${paths().launchAgentLog}</string>`);
    expect(stdout.join('')).toContain(
      `launchctl bootstrap gui/$UID ${paths().launchAgentFile}`,
    );
    expect(() => statSync(paths().serviceFile)).toThrow();
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
    const paired = (
      disabledCommands: string[] = [],
      profiles: ConfigProfile[] = [
        { id: 'claude-default', runtime: 'claude', env: {}, args: [] },
      ],
    ) =>
      saveConfig(paths().configFile, {
        server: server.origin,
        runnerId: 'rn_1',
        token: TOKEN,
        profiles,
        projects: [],
        disabledCommands,
        otlp: null,
        policy: { allowedRoots: ['/'] },
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

    describe('upgrading from before 0.13 (#691)', () => {
      /** A runner.json as 0.12 wrote it: no `policy` block, a cached list. */
      const pre013 = (root: string) => {
        mkdirSync(dirname(paths().configFile), { recursive: true });
        writeFileSync(
          paths().configFile,
          JSON.stringify({
            server: server.origin,
            runnerId: 'rn_1',
            token: TOKEN,
            profiles: [
              { id: 'claude-default', runtime: 'claude', env: {}, args: [] },
            ],
            projects: [
              { id: 'prj_a', root },
              { id: 'prj_b', root: '/srv/dev/with space' },
            ],
            otlp: null,
          }),
        );
      };

      it('prints and logs the upgrade notice with the cached roots, allows nothing, and reports every project refused', async () => {
        const root = join(home, 'dev', 'app');
        mkdirSync(root, { recursive: true });
        pre013(root);
        server.welcome = () => ({
          type: 'welcome',
          runnerId: 'rn_1',
          config: {
            projects: [
              { id: 'prj_a', root },
              { id: 'prj_b', root: '/srv/dev/with space' },
            ],
            pollIntervalsMs: {},
          },
          ackedSeq: 0,
        });
        const { controller, exit, live } = start();
        await live();
        const refused = () =>
          server
            .of('events')
            .flatMap((m) => m.events)
            .find((e) => e.type === 'runner.watch_refused');
        await until(() => refused() !== undefined);
        const event = refused();
        controller.abort();
        expect(await exit).toBe(EXIT.ok);

        const err = stderr.join('');
        expect(err).toContain('AgentDock runner 0.13 upgrade');
        expect(err).toContain(`  ${root} (prj_a)`);
        expect(err).toContain('agentdock-runner policy allow-root --watched');
        expect(err).toContain(
          `agentdock-runner policy allow-root ${root} '/srv/dev/with space'`,
        );
        const logged = err
          .split('\n')
          .filter((l) => l.startsWith('{'))
          .map((l) => JSON.parse(l) as { msg: string; roots?: string[] })
          .find((l) => l.msg.startsWith('runner 0.13 upgrade'));
        expect(logged?.roots).toEqual([root, '/srv/dev/with space']);

        // Nothing allowed by itself, and still no policy block on disk.
        const file = JSON.parse(readFileSync(paths().configFile, 'utf8'));
        expect(file.policy).toBeUndefined();
        expect(file.projects.map((p: { id: string }) => p.id)).toEqual([
          'prj_a',
          'prj_b',
        ]);
        const data = event?.data as {
          projects: { projectId: string; message: string }[];
        };
        expect(data.projects.map((p) => p.projectId)).toEqual([
          'prj_a',
          'prj_b',
        ]);
        expect(data.projects[0].message).toBe(
          "refused by this runner's policy (allowedRoots): this runner allows no project root yet. On the runner's machine: `agentdock-runner policy allow-root " +
            `${root}\``,
        );
      });

      it('says nothing on a config with a policy block', async () => {
        paired();
        const { controller, exit, live } = start();
        await live();
        controller.abort();
        expect(await exit).toBe(EXIT.ok);
        expect(stderr.join('')).not.toContain('0.13 upgrade');
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
        runnerVersion: RUNNER_VERSION,
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

    it('C-123: sends a profile env secret in hello as set, never its value', async () => {
      paired(
        [],
        [
          {
            id: 'claude-work',
            runtime: 'claude',
            env: {
              ANTHROPIC_API_KEY: 'sk-ant-x',
              CLAUDE_CONFIG_DIR: '/home/dev/.claude-profiles/work',
            },
            args: [],
          },
        ],
      );
      const { controller, exit } = start();
      const [hello] = (await server.waitFor('hello')) as HelloMessage[];
      expect(hello.capabilities.profiles[0]?.env).toEqual({
        ANTHROPIC_API_KEY: { set: true },
        CLAUDE_CONFIG_DIR: '/home/dev/.claude-profiles/work',
      });
      expect(JSON.stringify(hello)).not.toContain('sk-ant-x');
      controller.abort();
      expect(await exit).toBe(EXIT.ok);
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
        policy: { allowedRoots: ['/'] },
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

    it('a replaced connection (4409) leaves the status `status` prints, then exits 78 (C-108)', async () => {
      paired();
      const { exit, live } = start();
      await live();
      server.close(4409, 'replaced by a newer connection');
      expect(await exit).toBe(EXIT.terminalClose);
      const expected =
        'replaced by another connection at 2026-10-07T18:00:00.000Z, re-pair if this was not you';
      expect(stderr.join('')).toContain(`stopped: ${expected}`);

      stdout = [];
      expect(await runCli(['status'], deps())).toBe(EXIT.ok);
      expect(stdout.join('')).toContain(`stopped:  ${expected}\n`);
    });

    it('a new run clears the last stop from `status`', async () => {
      paired();
      const first = start();
      await first.live();
      server.close(4409, 'replaced');
      expect(await first.exit).toBe(EXIT.terminalClose);

      const second = start();
      await second.live();
      stdout = [];
      await runCli(['status'], deps());
      expect(stdout.join('')).not.toContain('stopped:');
      second.controller.abort();
      expect(await second.exit).toBe(EXIT.ok);
    });
  });

  describe('Claude Code integration subcommands (spec 201)', () => {
    it('hook exits 0 for an unknown hook and when the daemon is down', async () => {
      expect(
        await runCli(
          ['hook', 'pre-compact'],
          deps({
            stdin: () => new Response('{}').body as ReadableStream<Uint8Array>,
          }),
        ),
      ).toBe(EXIT.ok);
      const started = Date.now();
      expect(
        await runCli(
          ['hook', 'stop'],
          deps({
            stdin: () =>
              new Response('{"session_id":"s","cwd":"/x"}')
                .body as ReadableStream<Uint8Array>,
          }),
        ),
      ).toBe(EXIT.ok);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(stdout).toEqual([]);
    });

    it('away needs on or off, and fails when the daemon is down', async () => {
      expect(await runCli(['away', 'maybe'], deps())).toBe(EXIT.usage);
      expect(await runCli(['away', 'on'], deps())).toBe(EXIT.failure);
      expect(stderr.join('')).toContain('daemon_unavailable');
    });

    it('setup needs the claude target and accepts its flags', async () => {
      expect(await runCli(['setup'], deps())).toBe(EXIT.usage);
      expect(await runCli(['setup', 'codex'], deps())).toBe(EXIT.usage);
      expect(await runCli(['setup', 'claude', 'extra'], deps())).toBe(
        EXIT.usage,
      );
      saveConfig(paths().configFile, {
        profiles: [
          {
            id: 'claude-main',
            runtime: 'claude',
            env: { CLAUDE_CONFIG_DIR: '~/.claude-main' },
            args: [],
          },
        ],
      });
      expect(
        await runCli(
          ['setup', 'claude', '--dry-run', '--profile', 'claude-main'],
          deps(),
        ),
      ).toBe(EXIT.ok);
      expect(stdout.join('')).toContain(
        'claude plugin install agentdock@agentdock --scope user',
      );
      expect(stdout.join('')).toContain('Dry run');
    });

    it('lists the new commands in the usage', async () => {
      await runCli(['help'], deps());
      const text = stdout.join('');
      for (const command of [
        'setup claude',
        'away on|off',
        'hook <name>',
        'mcp',
        'claude [-- <args>]',
      ]) {
        expect(text).toContain(command);
      }
    });
  });

  describe('Token saver subcommands (#445 D3)', () => {
    it('filter runs the command after `--` and returns its exit code', async () => {
      const code = await runCli(
        ['filter', '--', 'sh', '-c', 'echo hi; echo oops >&2; exit 3'],
        deps({ env: { HOME: home, PATH: process.env.PATH } }),
      );
      expect(code).toBe(3);
      expect(stdout.join('')).toBe('hi\n');
      expect(stderr.join('')).toBe('oops\n');
    });

    it('filter-hook fails open: no decision, exit 0', async () => {
      for (const input of ['', 'not json', '{"tool_name":"Bash"}']) {
        expect(
          await runCli(
            ['filter-hook'],
            deps({
              stdin: () =>
                new Response(input).body as ReadableStream<Uint8Array>,
            }),
          ),
        ).toBe(EXIT.ok);
      }
      expect(stdout).toEqual([]);
    });

    it('read-hook fails open: no decision, exit 0 (#616)', async () => {
      for (const input of ['', 'not json', '{"tool_name":"Read"}']) {
        expect(
          await runCli(
            ['read-hook'],
            deps({
              stdin: () =>
                new Response(input).body as ReadableStream<Uint8Array>,
            }),
          ),
        ).toBe(EXIT.ok);
      }
      expect(stdout).toEqual([]);
    });

    it('lists all three in the usage', async () => {
      await runCli(['help'], deps());
      expect(stdout.join('')).toContain('filter -- <command>');
      expect(stdout.join('')).toContain('filter-hook');
      expect(stdout.join('')).toContain('read-hook');
    });
  });
});
