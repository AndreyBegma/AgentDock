import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type SkillRunArgs,
  type SkillRunFinishedData,
  type SkillRunPhase,
  skillPhaseToRunStatus,
  type UnsequencedEvent,
} from '@agentdock/shared/protocol';
import { CommandFailure } from '../../commands/failure';
import type { ConfigProfile } from '../../config';
import type { Exec } from '../../detect/exec';
import { FakeClock } from '../../testing/fake-clock';
import { memoryLogger } from '../../testing/fixtures';
import { REAL_PROCESS_TIMEOUT_MS } from '../../testing/projects';
import { skillsWorkspace, withFakeGh } from '../testing';
import { SkillRunExecutor } from './executor';

setDefaultTimeout(REAL_PROCESS_TIMEOUT_MS * 2);

/**
 * Spec 24's run criteria against real git, a real tmux and the real
 * `exec-run`. The tmux server is private (`tmux -L <name>`): the user's own
 * server — where live fleets run — is never listed, let alone touched. The
 * profile binary is a script that writes `stream-json` and edits files.
 */
const tmuxInstalled = Bun.which('tmux') !== null;
const MAIN = join(import.meta.dir, '..', '..', 'main.ts');

let teardown: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.reverse()) await fn();
  teardown = [];
});

const FAKE_CLAUDE = `#!/bin/sh
printf '%s\\n' "$@" > "$RECORD_ARGV"
echo '{"type":"system","subtype":"init","model":"claude-opus-5-5"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Editing the app."},{"type":"tool_use","name":"Edit","input":{"file_path":"src/app.txt"}}]}}'
echo 'v2' > src/app.txt
echo 'new' > notes.md
echo 'progress' >&2
if [ "$FAKE_MODE" = sleep ]; then sleep 60; fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"Changed the app to v2."}'
`;

const setup = async (options: { maxConcurrentRuns?: number } = {}) => {
  const f = await skillsWorkspace();
  const server = `agentdock-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const tmuxServer = ['-L', server];
  teardown.push(async () => {
    await f.git('tmux', [...tmuxServer, 'kill-server']);
    f.cleanup();
  });

  const binary = join(f.ws, 'fake-claude');
  await Bun.write(binary, FAKE_CLAUDE);
  chmodSync(binary, 0o755);
  const recordArgv = join(f.ws, 'argv.txt');
  const profile = (id: string, mode: string): ConfigProfile => ({
    id,
    runtime: 'claude',
    binary,
    env: {
      CLAUDE_CONFIG_DIR: f.profileDir,
      RECORD_ARGV: recordArgv,
      FAKE_MODE: mode,
    },
    args: ['--strict-mcp-config'],
  });
  const profiles: ConfigProfile[] = [
    profile('claude-work', 'quick'),
    profile('claude-slow', 'sleep'),
    { id: 'codex-default', runtime: 'codex', env: {}, args: [] },
  ];
  // The skill the runs invoke, installed on the profiles' config dir.
  f.write(f.profileDir, {
    'skills/estimate/SKILL.md': '---\nname: estimate\n---\nEstimate.\n',
  });

  const gh = withFakeGh(f.git, f.root);
  const tmuxCalls: string[][] = [];
  const exec: Exec = (bin, args, opts) => {
    if (bin === 'tmux') tmuxCalls.push([...args]);
    return gh.exec(bin, args, opts);
  };
  const clock = new FakeClock(Date.parse('2026-10-09T12:00:00.000Z'));
  const events: UnsequencedEvent[] = [];
  let next = 0;
  const executor = new SkillRunExecutor({
    deps: f.deps(exec, {
      clock,
      profiles: () => profiles,
      shortId: () => `run${String(next++).padStart(5, '0')}`,
    }),
    runsDir: join(f.ws, 'state', 'runs'),
    selfCommand: [process.execPath, MAIN],
    tmuxServer,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
    maxTimeoutSec: 21_600,
    emit: (event) => events.push(event),
    log: memoryLogger().log,
  });
  await executor.start();
  teardown.push(async () => executor.stop());

  const args = (overrides: Partial<SkillRunArgs> = {}): SkillRunArgs => ({
    runId: 'run_1',
    projectId: f.project.id,
    root: f.root,
    base: 'main',
    skill: 'estimate',
    args: '#42 quickly',
    profileKey: 'claude-work',
    model: 'opus',
    permissionMode: 'auto',
    output: 'report',
    timeoutSec: 600,
    ...overrides,
  });

  /** Ticks the executor until the run is in one of `phases`. */
  const until = async (runId: string, phases: SkillRunPhase[]) => {
    for (let i = 0; i < 600; i++) {
      const phase = executor.record(runId)?.phase;
      if (phase && phases.includes(phase)) return phase;
      await executor.tick();
      await Bun.sleep(25);
    }
    throw new Error(`${runId} stayed ${executor.record(runId)?.phase}`);
  };

  const finished = (runId: string) =>
    events.find(
      (e) =>
        e.type === 'skill_run.finished' &&
        (e.data as SkillRunFinishedData).runId === runId,
    )?.data as SkillRunFinishedData | undefined;
  const phases = (runId: string) =>
    events
      .filter(
        (e) =>
          e.type === 'skill_run.phase_changed' &&
          (e.data as { runId: string }).runId === runId,
      )
      .map((e) => (e.data as { phase: string }).phase);
  const sessions = async () =>
    (
      (
        await f.git('tmux', [
          ...tmuxServer,
          'list-sessions',
          '-F',
          '#{session_name}',
        ])
      )?.stdout ?? ''
    )
      .split('\n')
      .filter(Boolean);

  return {
    f,
    gh,
    exec,
    clock,
    events,
    executor,
    args,
    until,
    finished,
    phases,
    sessions,
    tmuxCalls,
    recordArgv,
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

describe.skipIf(!tmuxInstalled)('skill runs (real tmux)', () => {
  it('runs a report run to succeeded, stores the report fields and removes the worktree and branch', async () => {
    const t = await setup();
    const headBefore = await t.f.run(t.f.root, 'rev-parse', 'HEAD');
    expect(await t.executor.run(t.args())).toEqual({ phase: 'preparing' });
    expect(await t.until('run_1', ['succeeded', 'failed'])).toBe('succeeded');
    expect(skillPhaseToRunStatus('succeeded')).toBe('succeeded');

    expect(t.phases('run_1')).toEqual([
      'queued',
      'preparing',
      'running',
      'collecting',
      'succeeded',
    ]);
    const data = t.finished('run_1');
    expect(data).toMatchObject({
      runId: 'run_1',
      projectId: 'prj_widget',
      phase: 'succeeded',
      exitCode: 0,
      reportText: 'Changed the app to v2.',
      reportTruncated: false,
      changedFiles: [
        { status: ' M', path: 'src/app.txt' },
        { status: '??', path: 'notes.md' },
      ],
      changedFilesTotal: 2,
      patchTruncated: false,
    });
    expect(data?.patch).toContain('+v2');
    expect(data?.patch).toContain('notes.md');
    expect(data?.prUrl).toBeUndefined();

    // The worktree and the branch are gone; the main checkout never moved.
    const record = t.executor.record('run_1');
    expect(record?.session).toBe('agentdock-run-run00000');
    expect(existsSync(record?.worktree ?? '')).toBe(false);
    expect(await t.f.run(t.f.root, 'branch', '--list', 'run/*')).toBe('');
    expect(await t.f.run(t.f.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(await t.f.run(t.f.root, 'status', '--porcelain')).toBe('');
    // The full patch stays in the run directory.
    expect(
      readFileSync(join(t.executor.store.dir('run_1'), 'patch.diff'), 'utf8'),
    ).toBe(data?.patch ?? '<no patch>');

    // The session was agentdock-run-*, and launched `exec-run` as an argv, not `sh -c`.
    const created = t.tmuxCalls.find((c) => c.includes('new-session'));
    expect(created).toBeDefined();
    const at = created!.indexOf('-s');
    expect(created![at + 1]).toMatch(/^agentdock-run-[a-z0-9]{6,16}$/);
    const argv = created!.slice(created!.indexOf(record!.worktree) + 1);
    expect(argv).toEqual([
      process.execPath,
      MAIN,
      'exec-run',
      t.executor.store.dir('run_1'),
    ]);
    // tmux's own `-c <cwd>` precedes the command; no shell is in it.
    expect(created!.filter((a) => /(^|\/)(ba|da|z)?sh$/.test(a))).toEqual([]);
    expect(argv).not.toContain('-c');

    // The profile binary got D7's argv.
    expect(
      readFileSync(t.recordArgv, 'utf8').split('\n').filter(Boolean),
    ).toEqual([
      '--strict-mcp-config',
      '-p',
      '/estimate #42 quickly',
      '--model',
      'opus',
      '--permission-mode',
      'auto',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    // The OTEL resource attributes of D9 reached the session.
    const launch = JSON.parse(
      readFileSync(join(t.executor.store.dir('run_1'), 'run.json'), 'utf8'),
    );
    expect(launch.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'agentdock.project=prj_widget,agentdock.run=run_1',
    );
  });

  it('turns a pr run into a commit, a push and a PR, and keeps the worktree until the PR closes', async () => {
    const t = await setup();
    await t.executor.run(t.args({ output: 'pr' }));
    expect(await t.until('run_1', ['succeeded', 'failed'])).toBe('succeeded');
    const data = t.finished('run_1');
    expect(data).toMatchObject({
      phase: 'succeeded',
      prNumber: 7,
      prUrl: 'https://github.com/acme/widget/pull/7',
      reportText: 'Changed the app to v2.',
    });

    const record = t.executor.record('run_1')!;
    expect(record.branch).toBe('run/run00000-estimate');
    // Pushed to origin, one commit on the base, no trailer.
    const message = await t.f.run(
      t.f.origin,
      'log',
      '-1',
      '--format=%B',
      record.branch,
    );
    expect(message).toBe('chore(skill): estimate run run00000');
    expect(
      await t.f.run(t.f.origin, 'show', `${record.branch}:src/app.txt`),
    ).toBe('v2');
    expect(await t.f.run(t.f.origin, 'rev-parse', `${record.branch}~1`)).toBe(
      await t.f.run(t.f.root, 'rev-parse', 'origin/main'),
    );
    const create = t.gh.calls.find((c) => c.args[1] === 'create');
    expect(create?.args).toContain('--base');
    expect(create?.args[create.args.indexOf('--base') + 1]).toBe('main');
    expect(create?.args[create.args.indexOf('--head') + 1]).toBe(record.branch);
    expect(create?.body).toContain('Changed the app to v2.');

    // Open: the worktree stays.
    await t.executor.cleanup();
    expect(existsSync(record.worktree)).toBe(true);
    // Closed: the cleanup job removes it.
    t.gh.prState.value = 'CLOSED';
    await t.executor.cleanup();
    expect(existsSync(record.worktree)).toBe(false);
    expect(await t.f.run(t.f.root, 'branch', '--list', 'run/*')).toBe('');
    expect(t.executor.record('run_1')?.cleanedUp).toBe(true);
  });

  it('cancels a running run → cancelled → abandoned', async () => {
    const t = await setup();
    await t.executor.run(t.args({ profileKey: 'claude-slow' }));
    await t.until('run_1', ['running']);
    expect(await t.sessions()).toEqual(['agentdock-run-run00000']);
    expect(
      await t.executor.cancel({ runId: 'run_1', projectId: t.f.project.id }),
    ).toEqual({
      cancelled: true,
    });
    expect(await t.until('run_1', ['cancelled', 'failed', 'succeeded'])).toBe(
      'cancelled',
    );
    expect(skillPhaseToRunStatus('cancelled')).toBe('abandoned');
    expect(await t.sessions()).toEqual([]);
    expect(t.finished('run_1')).toMatchObject({
      phase: 'cancelled',
      exitCode: null,
    });
    expect(existsSync(t.executor.record('run_1')!.worktree)).toBe(false);
    // Over: a second cancel cancels nothing.
    expect(
      await t.executor.cancel({ runId: 'run_1', projectId: t.f.project.id }),
    ).toEqual({
      cancelled: false,
    });
  });

  it('ends a run over its timeout as timed_out → failed', async () => {
    const t = await setup();
    await t.executor.run(t.args({ profileKey: 'claude-slow', timeoutSec: 60 }));
    await t.until('run_1', ['running']);
    t.clock.advance(60_000);
    expect(await t.until('run_1', ['timed_out', 'failed', 'succeeded'])).toBe(
      'timed_out',
    );
    expect(skillPhaseToRunStatus('timed_out')).toBe('failed');
    expect(await t.sessions()).toEqual([]);
    expect(t.finished('run_1')?.error).toContain('60 s timeout');
  });

  it('keeps a second run queued until the first finishes with maxConcurrentRuns 1', async () => {
    const t = await setup({ maxConcurrentRuns: 1 });
    expect(await t.executor.run(t.args({ profileKey: 'claude-slow' }))).toEqual(
      { phase: 'preparing' },
    );
    expect(await t.executor.run(t.args({ runId: 'run_2' }))).toEqual({
      phase: 'queued',
    });
    await t.until('run_1', ['running']);
    await t.executor.tick();
    expect(t.executor.record('run_2')?.phase).toBe('queued');
    await t.executor.cancel({ runId: 'run_1', projectId: t.f.project.id });
    expect(await t.until('run_2', ['succeeded', 'failed'])).toBe('succeeded');
    expect(t.phases('run_2')[0]).toBe('queued');
  });

  it('resumes a running run after a runner restart', async () => {
    const t = await setup();
    await t.executor.run(t.args({ profileKey: 'claude-slow' }));
    await t.until('run_1', ['running']);
    t.executor.stop();

    const events: UnsequencedEvent[] = [];
    const again = new SkillRunExecutor({
      deps: t.f.deps(t.exec, { clock: t.clock, profiles: () => [] }),
      runsDir: join(t.f.ws, 'state', 'runs'),
      selfCommand: [process.execPath, MAIN],
      tmuxServer: (t.tmuxCalls[0] ?? []).slice(0, 2),
      maxConcurrentRuns: 2,
      maxTimeoutSec: 21_600,
      emit: (event) => events.push(event),
      log: memoryLogger().log,
    });
    await again.start();
    teardown.push(async () => again.stop());
    expect(again.record('run_1')?.phase).toBe('running');
    expect(
      await again.cancel({ runId: 'run_1', projectId: t.f.project.id }),
    ).toEqual({ cancelled: true });
    for (
      let i = 0;
      i < 400 && again.record('run_1')?.phase !== 'cancelled';
      i++
    )
      await Bun.sleep(25);
    expect(again.record('run_1')?.phase).toBe('cancelled');
    expect(events.map((e) => e.type)).toContain('skill_run.finished');
  });
});

describe('skill.run refusals', () => {
  it('refuses the orchestrator, a codex profile, an unknown skill, another project and a reused run id', async () => {
    const t = await setup();
    expect(
      await codeOf(
        t.executor.run(t.args({ skill: 'code-sentinel:orchestrator' })),
      ),
    ).toBe('not_runnable');
    expect(
      await codeOf(t.executor.run(t.args({ profileKey: 'codex-default' }))),
    ).toBe('unsupported_runtime');
    expect(await codeOf(t.executor.run(t.args({ profileKey: 'nope' })))).toBe(
      'unknown_profile',
    );
    expect(
      await codeOf(t.executor.run(t.args({ skill: 'not-installed' }))),
    ).toBe('not_found');
    expect(
      await codeOf(t.executor.run(t.args({ projectId: 'prj_other' }))),
    ).toBe('path_not_allowed');
    expect(t.events).toEqual([]);
  });

  it('answers not_found for a cancel through another project', async () => {
    const t = await setup({ maxConcurrentRuns: 1 });
    await t.executor.run(t.args({ profileKey: 'claude-slow' }));
    await t.executor.run(t.args({ runId: 'run_2' }));
    expect(
      await codeOf(
        t.executor.cancel({ runId: 'run_2', projectId: 'prj_other' }),
      ),
    ).toBe('not_found');
    expect(
      await codeOf(
        t.executor.cancel({ runId: 'nope', projectId: t.f.project.id }),
      ),
    ).toBe('not_found');
    // A queued run is cancelled without ever starting.
    expect(
      await t.executor.cancel({ runId: 'run_2', projectId: t.f.project.id }),
    ).toEqual({
      cancelled: true,
    });
    expect(t.phases('run_2')).toEqual(['queued', 'cancelled']);
    expect(await codeOf(t.executor.run(t.args({ runId: 'run_2' })))).toBe(
      'already_exists',
    );
    await t.executor.cancel({ runId: 'run_1', projectId: t.f.project.id });
    await t.until('run_1', ['cancelled', 'failed', 'succeeded']);
  });
});
