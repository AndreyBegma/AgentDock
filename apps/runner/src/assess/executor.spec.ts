import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_ASSESS_RESULT_MAX_BYTES } from '@agentdock/shared';
import type {
  CardAssessArgs,
  CardAssessFinishedData,
  UnsequencedEvent,
} from '@agentdock/shared/protocol';
import type { CaptureProcess, CaptureSpawn } from '../capture/executor';
import { CAPTURE_CLAUDE_FLAGS } from '../capture/executor';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { FakeClock } from '../testing/fake-clock';
import { fakeExec, memoryLogger, tempDir } from '../testing/fixtures';
import { AssessExecutor } from './executor';

const SESSION = '11111111-1111-4111-8111-111111111111';

const resultLine = (result: string, isError = false): string =>
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION })}\n${JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result })}\n`;

interface Call {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  dirExistedAtStart: boolean;
}

interface Script {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  /** Never exits until killed. */
  hang?: boolean;
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

const setup = (script: Script = { stdout: resultLine('ok') }) => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const root = join(dir, 'project');
  const assessDir = join(dir, 'state', 'assess');
  const clock = new FakeClock();
  const calls: Call[] = [];
  const events: UnsequencedEvent[] = [];
  const killed: string[] = [];
  const spawn: CaptureSpawn = (spec) => {
    calls.push({
      command: spec.command,
      cwd: spec.cwd,
      env: spec.env,
      stdin: readFileSync(spec.stdinFile, 'utf8'),
      dirExistedAtStart: existsSync(spec.cwd),
    });
    let finish: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      finish = resolve;
    });
    if (!script.hang) finish(script.code ?? 0);
    const proc: CaptureProcess = {
      exited,
      stdout: exited.then(() => script.stdout ?? ''),
      stderr: exited.then(() => script.stderr ?? ''),
      kill: () => {
        killed.push(spec.cwd);
        finish(null);
      },
    };
    return proc;
  };
  const profiles: ConfigProfile[] = [
    {
      id: 'claude-work',
      runtime: 'claude',
      binary: '/usr/bin/claude',
      env: { CLAUDE_CONFIG_DIR: '/profile', AGENTDOCK_HOOKS: 'on' },
      args: ['--strict-mcp-config'],
    },
    { id: 'codex-default', runtime: 'codex', env: {}, args: [] },
  ];
  const executor = new AssessExecutor({
    deps: {
      exec: fakeExec({ git: { code: 1, stdout: '', stderr: '' } }),
      clock,
      profiles: () => profiles,
      watchedProjects: () => [{ id: 'prj_a', root }],
    },
    assessDir,
    env: { PATH: '/bin', HOME: '/home/person' },
    emit: (event) => events.push(event),
    log: memoryLogger().log,
    spawn,
  });
  const args = (over: Partial<CardAssessArgs> = {}): CardAssessArgs => ({
    runId: 'run_1',
    projectId: 'prj_a',
    sessionId: SESSION,
    prompt: 'PROMPT with a card',
    profileKey: 'claude-work',
    model: 'haiku',
    timeoutSec: 120,
    ...over,
  });
  const finished = async (): Promise<CardAssessFinishedData> => {
    for (let i = 0; i < 100 && events.length === 0; i++) await Bun.sleep(5);
    const event = events.at(-1);
    expect(event?.type).toBe('card_assess.finished');
    return event?.data as CardAssessFinishedData;
  };
  return {
    executor,
    args,
    calls,
    events,
    killed,
    clock,
    assessDir,
    root,
    finished,
  };
};

const codeOf = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (e: unknown) => (e instanceof CommandFailure ? e.code : String(e)),
  );

describe('AssessExecutor (#322 D5)', () => {
  it('runs claude -p with haiku, no tools, plan mode, the prompt on stdin, cwd outside every root and hooks off', async () => {
    const t = setup();
    expect(await t.executor.run(t.args())).toEqual({ phase: 'running' });
    await t.finished();

    const call = t.calls[0] as Call;
    expect(call.command).toEqual([
      '/usr/bin/claude',
      '--strict-mcp-config',
      ...CAPTURE_CLAUDE_FLAGS,
      '--model',
      'haiku',
      '--session-id',
      SESSION,
    ]);
    const tools = call.command.indexOf('--tools');
    expect(call.command[tools + 1]).toBe('');
    const mode = call.command.indexOf('--permission-mode');
    expect(call.command[mode + 1]).toBe('plan');
    expect(call.stdin).toBe('PROMPT with a card');
    expect(call.cwd).toBe(join(t.assessDir, 'run_1'));
    expect(call.cwd.startsWith(`${t.root}/`)).toBe(false);
    // The profile's own AGENTDOCK_HOOKS=on cannot win.
    expect(call.env.AGENTDOCK_HOOKS).toBe('off');
    expect(call.env.CLAUDE_CONFIG_DIR).toBe('/profile');
    expect(call.env.OTEL_RESOURCE_ATTRIBUTES).toContain('agentdock.run=run_1');
  });

  it('reports the result once as card_assess.finished, then deletes the prompt and the run directory', async () => {
    const result = '{"work":{"model":"sonnet","reason":"clear"}}';
    const t = setup({ stdout: resultLine(result) });
    await t.executor.run(t.args());
    const data = await t.finished();
    expect(data).toMatchObject({
      runId: 'run_1',
      projectId: 'prj_a',
      ok: true,
      exitCode: 0,
      result,
      resultTruncated: false,
    });
    expect(t.events).toHaveLength(1);
    expect(t.events[0]?.source).toBe('runner');
    expect(t.calls[0]?.dirExistedAtStart).toBe(true);
    expect(existsSync(join(t.assessDir, 'run_1'))).toBe(false);
  });

  it('cuts an oversized result and says so', async () => {
    const t = setup({ stdout: resultLine('é'.repeat(20 * 1024)) });
    await t.executor.run(t.args());
    const data = await t.finished();
    expect(data.ok).toBe(true);
    expect(data.resultTruncated).toBe(true);
    expect(
      new TextEncoder().encode(data.result ?? '').length,
    ).toBeLessThanOrEqual(CARD_ASSESS_RESULT_MAX_BYTES);
  });

  it('reports a non-zero exit with the last stderr line', async () => {
    const t = setup({ code: 2, stderr: 'warming up\nError: not logged in\n' });
    await t.executor.run(t.args());
    expect(await t.finished()).toMatchObject({
      ok: false,
      exitCode: 2,
      error: 'Error: not logged in',
    });
  });

  it('fails when there is no result message or an error result', async () => {
    const none = setup({ stdout: '' });
    await none.executor.run(none.args());
    expect((await none.finished()).error).toContain('no result message');

    const bad = setup({ stdout: resultLine('boom', true) });
    await bad.executor.run(bad.args());
    const data = await bad.finished();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('error result');
  });

  it('kills the process at its timeout and reports it', async () => {
    const t = setup({ hang: true });
    await t.executor.run(t.args({ timeoutSec: 30 }));
    t.clock.advance(29_000);
    expect(t.killed).toEqual([]);
    t.clock.advance(1_000);
    const data = await t.finished();
    expect(t.killed).toEqual([join(t.assessDir, 'run_1')]);
    expect(data).toMatchObject({
      ok: false,
      error: 'the assessment exceeded its 30 s timeout',
    });
    expect(existsSync(join(t.assessDir, 'run_1'))).toBe(false);
  });

  it('refuses a repeated run id and runs different ids side by side', async () => {
    const t = setup({ hang: true });
    await t.executor.run(t.args());
    expect(await codeOf(t.executor.run(t.args()))).toBe('already_exists');
    expect((await t.executor.run(t.args({ runId: 'run_2' }))).phase).toBe(
      'running',
    );
    t.executor.stop();
    await t.finished();
  });

  it('refuses a codex profile, an unknown profile and an unwatched project', async () => {
    const t = setup();
    expect(
      await codeOf(t.executor.run(t.args({ profileKey: 'codex-default' }))),
    ).toBe('unsupported_runtime');
    expect(await codeOf(t.executor.run(t.args({ profileKey: 'nope' })))).toBe(
      'unknown_profile',
    );
    expect(await codeOf(t.executor.run(t.args({ projectId: 'prj_x' })))).toBe(
      'path_not_allowed',
    );
    expect(t.calls).toEqual([]);
  });

  it('refuses an assessment directory inside a watched project', async () => {
    const t = setup();
    const inside = new AssessExecutor({
      deps: {
        exec: fakeExec({}),
        clock: t.clock,
        profiles: () => [
          { id: 'claude-work', runtime: 'claude', env: {}, args: [] },
        ],
        watchedProjects: () => [{ id: 'prj_a', root: t.assessDir }],
      },
      assessDir: join(t.assessDir, 'nested'),
      env: {},
      emit: () => {},
      log: memoryLogger().log,
      spawn: () => {
        throw new Error('must not start');
      },
    });
    expect(await codeOf(inside.run(t.args()))).toBe('path_not_allowed');
  });
});
