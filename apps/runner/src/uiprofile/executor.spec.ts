import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  UiProfileBuildArgs,
  UiProfileBuildFinishedData,
  UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { SharedRunSlots } from '../planner/slots';
import { skillsWorkspace } from '../skills/testing';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../testing/projects';
import { UiProfileBuildExecutor } from './executor';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * `uiprofile.build` against real git, a private tmux server (`tmux -L <name>`,
 * never the user's own) and the real `exec-run`. The profile binary is a fake
 * `claude` that records its argv, stdin and cwd.
 */
const tmuxInstalled = Bun.which('tmux') !== null;
const MAIN = join(import.meta.dir, '..', 'main.ts');

let teardown: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of teardown.reverse()) await fn();
  teardown = [];
});

const FAKE_CLAUDE = `#!/bin/sh
n=$(ls "$RECORD_DIR" | wc -l | tr -d ' ')
d="$RECORD_DIR/$n"
mkdir -p "$d"
printf '%s\\n' "$@" > "$d/argv"
cat > "$d/stdin"
pwd > "$d/cwd"
git rev-parse HEAD > "$d/head"
echo '{"type":"system","subtype":"init","session_id":"11111111-1111-4111-8111-111111111111"}'
case "$FAKE_MODE" in
  sleep) sleep 60 ;;
  fail) echo 'Error: boom' >&2; exit 2 ;;
esac
echo '{"type":"result","subtype":"success","is_error":false,"result":"Profiled.\\n\`\`\`agentdock-design\\n{}\\n\`\`\`"}'
`;

const setup = async () => {
  const f = await skillsWorkspace();
  const server = `agentdock-uiprofile-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmuxServer = ['-L', server];
  teardown.push(async () => {
    await f.git('tmux', [...tmuxServer, 'kill-server']);
    f.cleanup();
  });

  const binary = join(f.ws, 'fake-claude');
  await Bun.write(binary, FAKE_CLAUDE);
  chmodSync(binary, 0o755);
  const recordDir = join(f.ws, 'calls');
  await Bun.write(join(recordDir, '.keep'), '');
  const profile = (id: string, mode: string): ConfigProfile => ({
    id,
    runtime: 'claude',
    binary,
    env: {
      CLAUDE_CONFIG_DIR: f.profileDir,
      RECORD_DIR: recordDir,
      FAKE_MODE: mode,
    },
    args: ['--strict-mcp-config'],
  });
  const profiles: ConfigProfile[] = [
    profile('claude-work', 'quick'),
    profile('claude-slow', 'sleep'),
    profile('claude-fail', 'fail'),
    { id: 'codex-default', runtime: 'codex', env: {}, args: [] },
  ];

  const clock = new FakeClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const events: UnsequencedEvent[] = [];
  let next = 0;
  const deps = f.deps(f.git, {
    clock,
    profiles: () => profiles,
    shortId: () => `uip${String(next++).padStart(5, '0')}`,
  });
  // `fleet/project` asks for the origin URL: the project is acme/widget.
  const exec: typeof f.git = async (binary, args, options) =>
    binary === 'git' && args.join(' ') === `-C ${f.root} remote get-url origin`
      ? { code: 0, stdout: 'git@github.com:acme/widget.git\n', stderr: '' }
      : f.git(binary, args, options);
  const slots = new SharedRunSlots(2);
  const never = 365 * 24 * 60 * 60_000;
  const executor = new UiProfileBuildExecutor({
    deps: { ...deps, exec },
    buildsDir: join(f.ws, 'state', 'uiprofile'),
    selfCommand: [process.execPath, MAIN],
    tmuxServer,
    slots,
    emit: (event) => events.push(event),
    log: memoryLogger().log,
    tickMs: never,
  });
  await executor.start();
  teardown.push(() => executor.stop());

  const args = (
    overrides: Partial<UiProfileBuildArgs> = {},
  ): UiProfileBuildArgs => ({
    projectId: f.project.id,
    root: f.root,
    base: 'main',
    runId: 'run_b1',
    prompt: '# Build the profile\n\n$(rm -rf ~) `x`\n',
    profileKey: 'claude-work',
    model: 'opus',
    timeoutSec: 600,
    ...overrides,
  });
  const finished = (runId: string) =>
    events.find(
      (e) =>
        e.type === 'uiprofile_build.finished' &&
        (e.data as UiProfileBuildFinishedData).runId === runId,
    )?.data as UiProfileBuildFinishedData | undefined;
  const until = async (runId: string) => {
    for (let i = 0; i < 600; i++) {
      const done = finished(runId);
      if (done) return done;
      await executor.tick();
      await Bun.sleep(25);
    }
    throw new Error(`${runId} never finished`);
  };
  const phases = (runId: string) =>
    events
      .filter(
        (e) =>
          e.type === 'uiprofile_build.phase_changed' &&
          (e.data as { runId: string }).runId === runId,
      )
      .map((e) => (e.data as { phase: string }).phase);
  const call = (n: number) => {
    const read = (name: string) =>
      readFileSync(join(recordDir, String(n), name), 'utf8');
    return {
      argv: read('argv').split('\n').filter(Boolean),
      stdin: read('stdin'),
      cwd: read('cwd').trim(),
      head: read('head').trim(),
    };
  };
  const worktree = join(f.ws, '.wt-widget-uiprofile-uip00000');
  return {
    f,
    clock,
    events,
    executor,
    args,
    finished,
    until,
    phases,
    call,
    worktree,
    recordDir,
  };
};

const codeOf = async (work: Promise<unknown>) => {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CommandFailure);
  return (error as CommandFailure).code;
};

describe.skipIf(!tmuxInstalled)(
  'uiprofile.build (real tmux, fake claude)',
  () => {
    it('runs plan mode in a detached worktree at origin/<base>, prompt on stdin, and removes the worktree', async () => {
      const t = await setup();
      const prompt = t.args().prompt;
      expect(await t.executor.run(t.args())).toEqual({ phase: 'running' });
      const done = await t.until('run_b1');

      const first = t.call(0);
      expect(first.argv).toEqual([
        '--strict-mcp-config',
        '-p',
        '--model',
        'opus',
        '--permission-mode',
        'plan',
        '--output-format',
        'stream-json',
        '--verbose',
      ]);
      expect(first.stdin).toBe(prompt);
      expect(first.argv.some((a) => a.includes('Build the profile'))).toBe(
        false,
      );
      expect(first.cwd).toBe(t.worktree);
      expect(first.head).toBe(
        await t.f.run(t.f.root, 'rev-parse', 'origin/main'),
      );

      expect(t.phases('run_b1')).toEqual(['queued', 'running', 'succeeded']);
      expect(done).toMatchObject({
        runId: 'run_b1',
        projectId: 'prj_widget',
        phase: 'succeeded',
        exitCode: 0,
        resultText: 'Profiled.\n```agentdock-design\n{}\n```',
        resultTruncated: false,
      });
      expect(done).not.toHaveProperty('sessionId');
      expect(
        t.events.find((e) => e.type === 'uiprofile_build.finished'),
      ).toMatchObject({
        source: 'runner',
        project: { repo: 'acme/widget', root: t.f.root },
      });
      // Removed when the run ends: no worktree on disk, none registered with git.
      expect(existsSync(t.worktree)).toBe(false);
      expect(
        await t.f.run(t.f.root, 'worktree', 'list', '--porcelain'),
      ).not.toContain('uiprofile');
    });

    it('fails a build whose binary exits non-zero, with the last stderr line, and still removes the worktree', async () => {
      const t = await setup();
      await t.executor.run(t.args({ profileKey: 'claude-fail' }));
      const done = await t.until('run_b1');
      expect(done).toMatchObject({
        phase: 'failed',
        exitCode: 2,
        error: 'Error: boom',
      });
      expect(existsSync(t.worktree)).toBe(false);
    });

    it('kills a build over its timeout', async () => {
      const t = await setup();
      await t.executor.run(
        t.args({ profileKey: 'claude-slow', timeoutSec: 60 }),
      );
      for (let i = 0; i < 200 && !existsSync(join(t.recordDir, '0')); i++) {
        await Bun.sleep(25);
      }
      t.clock.advance(61_000);
      const done = await t.until('run_b1');
      expect(done.phase).toBe('failed');
      expect(done.error).toContain('60 s timeout');
      expect(existsSync(t.worktree)).toBe(false);
    });

    it('refuses a second build in the same project, a reused run id and a codex profile', async () => {
      const t = await setup();
      await t.executor.run(t.args({ profileKey: 'claude-slow' }));
      expect(await codeOf(t.executor.run(t.args({ runId: 'run_b2' })))).toBe(
        'busy',
      );
      expect(await codeOf(t.executor.run(t.args()))).toBe('already_exists');
      expect(
        await codeOf(
          t.executor.run(
            t.args({ runId: 'run_b3', profileKey: 'codex-default' }),
          ),
        ),
      ).toBe('unsupported_runtime');
      expect(
        await codeOf(
          t.executor.run(t.args({ runId: 'run_b4', root: '/elsewhere' })),
        ),
      ).toBe('path_not_allowed');
      expect(readdirSync(join(t.f.ws, 'state', 'uiprofile'))).toEqual([
        'run_b1',
      ]);
    });

    it('fails a build whose base origin does not have, without leaving a worktree', async () => {
      const t = await setup();
      await t.executor.run(t.args({ base: 'nope' }));
      const done = await t.until('run_b1');
      expect(done).toMatchObject({
        phase: 'failed',
        error: 'origin/nope does not exist',
      });
      expect(existsSync(t.worktree)).toBe(false);
    });

    it('answers the run log of a build it knows and nothing for another', async () => {
      const t = await setup();
      await t.executor.run(t.args());
      await t.until('run_b1');
      expect(t.executor.record('run_b1')).toMatchObject({
        projectId: 'prj_widget',
        phase: 'succeeded',
      });
      expect(t.executor.streamFile('run_b1')).toEndWith('stream.jsonl');
      expect(t.executor.record('run_zzz')).toBeNull();
      expect(t.executor.streamFile('run_zzz')).toBe('');
    });
  },
);
