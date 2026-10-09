import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProjectDetail } from '@agentdock/shared';
import {
  adminSession,
  createRunner,
  createRunnerE2eApp,
  eventually,
  type RunnerE2eContext,
} from '../runners/testing/runner-e2e';
import { resetDatabase, type Session } from '../test/e2e-app';
import { API_ROOT } from '../test/test-database';

const RUNNER_MAIN = resolve(API_ROOT, '../runner/src/main.ts');
const BUN = process.env.BUN_BIN ?? 'bun';

/** Every path under `dir` with its size and mtime: what "disk unchanged" means. */
const snapshot = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      out.push(`${path} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'ignore' });

/**
 * The real #5/#10 runner: connect inspects a repository on disk, the watch
 * list reaches the daemon and its config cache, and nothing on disk changes.
 */
describe('projects against the runner daemon (e2e)', () => {
  let ctx: RunnerE2eContext;
  let admin: Session;
  let home: string;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    ctx = await createRunnerE2eApp();
  });
  afterAll(async () => {
    if (child?.exitCode === null) child.kill('SIGKILL');
    await ctx.app.close();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    admin = await adminSession(ctx);
    home = mkdtempSync(join(tmpdir(), 'agentdock-projects-e2e-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('connects a repository, lists it in the watch list, and deletes it without touching the disk', async () => {
    // A GitHub main checkout whose specDir points in-repo, so detection
    // stops at rule 1 and never calls `gh`.
    const root = join(home, 'dev', 'widget');
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    mkdirSync(join(root, 'docs', 'adr'));
    writeFileSync(join(root, 'docs', 'specs', 'one.md'), '# one\n');
    writeFileSync(
      join(root, '.code-analyzer-config.json'),
      JSON.stringify({
        orchestrator: { base: 'develop', specDir: 'docs/specs' },
      }),
    );
    git(root, 'init', '-q', '-b', 'develop');
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git');

    const created = await createRunner(admin, 'e2e-machine');
    const runnerId = created.runner.id;
    const configFile = join(home, 'config', 'agentdock', 'runner.json');
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_STATE_HOME: join(home, 'state'),
    };
    // Async: the API answering the pairing runs in this very process.
    const pairing = spawn(
      BUN,
      [
        RUNNER_MAIN,
        'pair',
        '--server',
        ctx.origin,
        '--code',
        created.pairingCode,
      ],
      { env, stdio: 'ignore' },
    );
    expect(
      await new Promise((done) => pairing.on('exit', (code) => done(code))),
    ).toBe(0);
    child = spawn(BUN, [RUNNER_MAIN, 'run'], { env, stdio: 'ignore' });
    await eventually(
      'runner online',
      async () =>
        (await admin.get(`/admin/runners/${runnerId}`)).body.status === 'online'
          ? true
          : undefined,
      20_000,
    );
    const cached = () =>
      (
        JSON.parse(readFileSync(configFile, 'utf8')) as {
          projects: { id: string; root: string }[];
        }
      ).projects;

    const before = snapshot(root);
    const connected = await admin.send('post', '/admin/projects', {
      runnerId,
      path: root,
    });
    expect(connected.status).toBe(201);
    const project = connected.body as ProjectDetail;
    expect(project).toMatchObject({
      repo: 'acme/widget',
      rootPath: root,
      baseBranch: 'develop',
      baseSource: 'config',
      docsSource: {
        kind: 'in_repo',
        localPath: join(root, 'docs'),
        detectedBy: 'spec_dir',
      },
    });

    await eventually('watch list cached', async () =>
      cached().some((p) => p.id === project.id) ? true : undefined,
    );
    expect(cached()).toEqual([{ id: project.id, root }]);
    // The runner refreshes only what its watch list holds: this proves it does.
    const refreshed = await admin.send(
      'post',
      `/projects/${project.id}/refresh`,
    );
    expect(refreshed.status).toBe(200);

    expect(
      (await admin.send('delete', `/admin/projects/${project.id}`)).status,
    ).toBe(204);
    await eventually('watch list emptied', async () =>
      cached().length === 0 ? true : undefined,
    );
    expect(snapshot(root)).toEqual(before);

    child.kill('SIGTERM');
  }, 90_000);
});
