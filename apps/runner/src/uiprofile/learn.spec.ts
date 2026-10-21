import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UIPROFILE_LEARN_RESULT_MAX_BYTES } from '@nautelle/shared';
import type { UiProfileLearnArgs } from '@nautelle/shared/protocol';
import type { CaptureProcess, CaptureSpawn } from '../capture/executor';
import { CAPTURE_CLAUDE_FLAGS } from '../capture/executor';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { UiProfileLearner } from './learn';

const SESSION = '22222222-2222-4222-8222-222222222222';

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

const setup = (script: Script = { stdout: resultLine('{"ok":1}') }) => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const root = join(dir, 'project');
  const learnDir = join(dir, 'state', 'uiprofile-learn');
  const clock = new FakeClock();
  const calls: Call[] = [];
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
      kill: () => finish(null),
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
  const learner = new UiProfileLearner({
    deps: {
      clock,
      profiles: () => profiles,
      watchedProjects: () => [{ id: 'prj_a', root }],
    },
    learnDir,
    env: { PATH: '/bin', HOME: '/home/person' },
    log: memoryLogger().log,
    spawn,
  });
  const args = (
    over: Partial<UiProfileLearnArgs> = {},
  ): UiProfileLearnArgs => ({
    runId: 'run_1',
    projectId: 'prj_a',
    sessionId: SESSION,
    prompt: 'PROMPT with a design',
    profileKey: 'claude-work',
    model: 'sonnet',
    timeoutSec: 180,
    ...over,
  });
  return { learner, calls, clock, args, learnDir, root };
};

describe('UiProfileLearner (#752 A2)', () => {
  it('runs headless claude with no tools in plan mode, prompt on stdin, hooks off, and returns the answer', async () => {
    const { learner, calls, args, learnDir } = setup();
    const result = await learner.learn(args());
    expect(result).toEqual({ resultText: '{"ok":1}', resultTruncated: false });
    const call = calls[0];
    expect(call?.command).toEqual([
      '/usr/bin/claude',
      '--strict-mcp-config',
      ...CAPTURE_CLAUDE_FLAGS,
      '--model',
      'sonnet',
      '--session-id',
      SESSION,
    ]);
    expect(call?.stdin).toBe('PROMPT with a design');
    expect(call?.cwd).toBe(join(learnDir, 'run_1'));
    expect(call?.dirExistedAtStart).toBe(true);
    expect(call?.env.NAUTELLE_HOOKS).toBe('off');
    expect(call?.env.CLAUDE_CONFIG_DIR).toBe('/profile');
    expect(call?.env.OTEL_RESOURCE_ATTRIBUTES).toContain('agentdock.run=run_1');
    // The prompt is a design's text: the directory goes with the run.
    expect(existsSync(join(learnDir, 'run_1'))).toBe(false);
  });

  it('cuts an oversized answer and says so', async () => {
    const { learner, args } = setup({
      stdout: resultLine('x'.repeat(UIPROFILE_LEARN_RESULT_MAX_BYTES + 10)),
    });
    const result = await learner.learn(args());
    expect(result.resultTruncated).toBe(true);
    expect(result.resultText.length).toBeLessThanOrEqual(
      UIPROFILE_LEARN_RESULT_MAX_BYTES,
    );
  });

  it('fails on an error result, a non-zero exit or no result', async () => {
    for (const script of [
      { stdout: resultLine('nope', true) },
      { code: 1, stderr: 'boom\n' },
      { stdout: '' },
    ]) {
      const { learner, args, learnDir } = setup(script);
      await expect(learner.learn(args())).rejects.toThrow();
      expect(existsSync(join(learnDir, 'run_1'))).toBe(false);
    }
  });

  it('kills a learn past its timeout', async () => {
    const { learner, args, clock } = setup({ hang: true });
    const pending = learner.learn(args({ timeoutSec: 30 }));
    await Promise.resolve();
    clock.advance(30_000);
    await expect(pending).rejects.toThrow('30 s timeout');
  });

  it('refuses a codex profile, an unwatched project and a learn dir inside a project', async () => {
    const { learner, args } = setup();
    await expect(
      learner.learn(args({ profileKey: 'codex-default' })),
    ).rejects.toBeInstanceOf(CommandFailure);
    await expect(
      learner.learn(args({ projectId: 'prj_other' })),
    ).rejects.toBeInstanceOf(CommandFailure);

    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const inside = new UiProfileLearner({
      deps: {
        clock: new FakeClock(),
        profiles: () => [
          {
            id: 'claude-work',
            runtime: 'claude',
            env: {},
            args: [],
          },
        ],
        watchedProjects: () => [{ id: 'prj_a', root: dir }],
      },
      learnDir: join(dir, 'learn'),
      env: {},
      log: memoryLogger().log,
    });
    await expect(inside.learn(args())).rejects.toBeInstanceOf(CommandFailure);
  });
});
