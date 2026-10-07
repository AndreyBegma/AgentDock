import { type ChildProcess, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AdminRunnerDetail } from '@agentdock/shared';
import { resetDatabase, type Session } from '../test/e2e-app';
import { API_ROOT } from '../test/test-database';
import {
  adminSession,
  CapturingLogger,
  createRunner,
  createRunnerE2eApp,
  eventually,
  type RunnerE2eContext,
} from './testing/runner-e2e';

/** The #5 daemon, run from source exactly as `agentdock-runner` would. */
const RUNNER_MAIN = resolve(API_ROOT, '../runner/src/main.ts');
const BUN = process.env.BUN_BIN ?? 'bun';
const STALE_AFTER_MS = 3_000;

interface Daemon {
  child: ChildProcess;
  exited: Promise<number | null>;
  output: () => string;
}

describe('the #5 runner daemon against the API (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let home: string;
  const logger = new CapturingLogger();
  const daemons: Daemon[] = [];

  const runnerCli = (args: string[]): Daemon => {
    const child = spawn(BUN, [RUNNER_MAIN, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_STATE_HOME: join(home, 'state'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number | null>((done) =>
      child.on('exit', (code) => done(code)),
    );
    const daemon = { child, exited, output: () => output };
    daemons.push(daemon);
    return daemon;
  };

  const exitCode = async (
    daemon: Daemon,
    ms = 20_000,
  ): Promise<number | null> => {
    const timeout = new Promise<'timeout'>((done) =>
      setTimeout(() => done('timeout'), ms).unref(),
    );
    const result = await Promise.race([daemon.exited, timeout]);
    if (result === 'timeout') {
      throw new Error(
        `runner did not exit within ${ms} ms:\n${daemon.output()}`,
      );
    }
    return result;
  };

  const detail = async (id: string) =>
    (await admin.get(`/admin/runners/${id}`)).body as AdminRunnerDetail;

  const statusIs = (
    id: string,
    status: AdminRunnerDetail['status'],
    ms?: number,
  ) =>
    eventually(
      `runner ${status}`,
      async () => {
        const shown = await detail(id);
        return shown.status === status ? shown : undefined;
      },
      ms,
    );

  beforeAll(async () => {
    ctx = await createRunnerE2eApp({ staleAfterMs: STALE_AFTER_MS }, logger);
  });
  afterAll(async () => {
    for (const { child } of daemons) {
      if (child.exitCode === null && child.pid) child.kill('SIGKILL');
    }
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    home = mkdtempSync(join(tmpdir(), 'agentdock-runner-e2e-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('pairs, connects, pings, goes stale and offline, and stops for good on revoke', async () => {
    const created = await createRunner(admin, 'e2e-machine');
    const runnerId = created.runner.id;

    // A profile in the runner's own config — the server only mirrors it.
    const configDir = join(home, 'config', 'agentdock');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'runner.json'),
      JSON.stringify({
        profiles: [
          {
            id: 'claude-e2e',
            runtime: 'claude',
            env: { CLAUDE_CONFIG_DIR: join(home, '.claude-e2e') },
            args: [],
          },
        ],
      }),
    );

    // Pair with the code exactly as the admin page shows it.
    const pairing = runnerCli([
      'pair',
      '--server',
      ctx.origin,
      '--code',
      created.pairingCode,
    ]);
    expect(await exitCode(pairing)).toBe(0);
    const config = JSON.parse(
      readFileSync(join(configDir, 'runner.json'), 'utf8'),
    ) as { runnerId: string; token: string };
    expect(config.runnerId).toBe(runnerId);
    const { token } = config;

    // Online with capabilities and profiles within 20 s.
    let daemon = runnerCli(['run']);
    const online = await statusIs(runnerId, 'online', 20_000);
    expect(online.capabilities).not.toBeNull();
    expect(online.capabilities?.profiles.map((p) => p.id)).toEqual([
      'claude-e2e',
    ]);
    expect(online.profiles).toEqual([
      expect.objectContaining({
        key: 'claude-e2e',
        runtime: 'claude',
        missing: false,
      }),
    ]);
    expect(online.hostname).toEqual(expect.any(String));

    // Ping round trip through the daemon's own dispatcher.
    const ping = await admin.send('post', `/admin/runners/${runnerId}/ping`);
    expect(ping.body).toEqual({
      status: 'ok',
      rttMs: expect.any(Number),
      ts: expect.any(String),
    });

    // No heartbeat within the (shortened) window → stale; socket still open.
    await statusIs(runnerId, 'stale', STALE_AFTER_MS + 5_000);

    // Stopping the daemon closes the socket → offline.
    daemon.child.kill('SIGTERM');
    expect(await exitCode(daemon)).toBe(0);
    await statusIs(runnerId, 'offline', 5_000);

    // Back online, then revoked: the daemon exits 78 and stays refused.
    daemon = runnerCli(['run']);
    await statusIs(runnerId, 'online', 20_000);
    await admin.send('post', `/admin/runners/${runnerId}/revoke`);
    expect(await exitCode(daemon)).toBe(78);
    const again = runnerCli(['run']);
    expect(await exitCode(again)).toBe(78);

    const row = await ctx.prisma.runner.findUnique({ where: { id: runnerId } });
    expect(row?.revokedAt).not.toBeNull();

    // Neither the token nor the pairing code ever reached the API's logs.
    const logs = logger.lines.join('\n');
    expect(logs).toContain(`runner ${runnerId} connected`);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(created.pairingCode);
  }, 90_000);
});
