import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PREFIX_FILE_MAX_BYTES } from '@nautelle/shared';
import {
  PREFIX_PROPOSE_INSTRUCTION,
  PREFIX_RESULT_MAX_BYTES,
  type PrefixProposeArgs,
  type RulesCompressArgs,
} from '@nautelle/shared/protocol';
import type { CaptureProcess, CaptureSpawn } from '../capture/executor';
import { CAPTURE_CLAUDE_FLAGS } from '../capture/executor';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { defaultPolicy, type PolicyConfig } from '../policy/schema';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger, tempDir } from '../testing/fixtures';
import { PrefixCalls } from './calls';
import { sha256Hex } from './measure';

const SESSION = '33333333-3333-4333-8333-333333333333';

const resultLine = (result: string): string =>
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION })}\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result })}\n`;

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups = [];
});

const write = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const setup = (answer = 'SHORT', policy: PolicyConfig = defaultPolicy()) => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const root = join(dir, 'project');
  const callsDir = join(dir, 'state', 'prefix-calls');
  const spawned: {
    command: readonly string[];
    cwd: string;
    stdin: string;
    env: Record<string, string>;
  }[] = [];
  const spawn: CaptureSpawn = (spec) => {
    spawned.push({
      command: spec.command,
      cwd: spec.cwd,
      stdin: readFileSync(spec.stdinFile, 'utf8'),
      env: spec.env,
    });
    const exited = Promise.resolve(0);
    const proc: CaptureProcess = {
      exited,
      stdout: exited.then(() => resultLine(answer)),
      stderr: exited.then(() => ''),
      kill: () => {},
    };
    return proc;
  };
  const profiles: ConfigProfile[] = [
    {
      id: 'claude-work',
      runtime: 'claude',
      binary: '/usr/bin/claude',
      env: {},
      args: [],
    },
  ];
  const calls = new PrefixCalls({
    deps: {
      clock: new FakeClock(),
      profiles: () => profiles,
      watchedProjects: () => [{ id: 'prj_a', root }],
    },
    policy: () => policy,
    dir: callsDir,
    env: { PATH: '/bin' },
    log: memoryLogger().log,
    spawn,
  });
  const compressArgs: RulesCompressArgs = {
    runId: 'run_1',
    projectId: 'prj_a',
    sessionId: SESSION,
    prompt: 'Compress these rules',
    profileKey: 'claude-work',
    model: 'haiku',
    timeoutSec: 60,
  };
  const proposeArgs = (
    over: Partial<PrefixProposeArgs> = {},
  ): PrefixProposeArgs => ({
    runId: 'run_2',
    projectId: 'prj_a',
    root,
    part: 'claude_md',
    sessionId: SESSION,
    profileKey: 'claude-work',
    model: 'sonnet',
    timeoutSec: 120,
    ...over,
  });
  return { calls, spawned, root, callsDir, compressArgs, proposeArgs };
};

const failureOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof CommandFailure ? error.code : 'internal';
  }
  return 'ok';
};

describe('rules.compress (#751 B6)', () => {
  it('runs headless haiku with no tools on the API prompt and returns its text', async () => {
    const { calls, spawned, callsDir, compressArgs } = setup('{"rules":[]}');
    expect(await calls.compress(compressArgs)).toEqual({
      resultText: '{"rules":[]}',
      resultTruncated: false,
    });
    expect(spawned[0]?.command).toEqual([
      '/usr/bin/claude',
      ...CAPTURE_CLAUDE_FLAGS,
      '--model',
      'haiku',
      '--session-id',
      SESSION,
    ]);
    expect(spawned[0]?.stdin).toBe('Compress these rules');
    expect(spawned[0]?.env.NAUTELLE_HOOKS).toBe('off');
    expect(spawned[0]?.cwd).toBe(join(callsDir, 'run_1'));
    expect(existsSync(join(callsDir, 'run_1'))).toBe(false);
  });

  it('cuts an oversized answer and says so', async () => {
    const { calls, compressArgs } = setup(
      'x'.repeat(PREFIX_RESULT_MAX_BYTES + 5),
    );
    const result = await calls.compress(compressArgs);
    expect(result.resultTruncated).toBe(true);
    expect(result.resultText.length).toBe(PREFIX_RESULT_MAX_BYTES);
  });

  it('refuses a project the runner does not watch', async () => {
    const { calls, compressArgs } = setup();
    expect(
      await failureOf(calls.compress({ ...compressArgs, projectId: 'prj_b' })),
    ).toBe('path_not_allowed');
  });
});

describe('prefix.propose (#751 B8)', () => {
  it('reads CLAUDE.md and returns it with its hash and the proposal', async () => {
    const { calls, spawned, root, proposeArgs } = setup('# Short\n');
    const original = '# Project\n\nA long text.\n';
    write(join(root, 'CLAUDE.md'), original);
    expect(await calls.propose(proposeArgs())).toEqual({
      path: 'CLAUDE.md',
      originalSha256: sha256Hex(original),
      originalText: original,
      proposedText: '# Short\n',
    });
    expect(spawned[0]?.stdin.startsWith(PREFIX_PROPOSE_INSTRUCTION)).toBe(true);
    expect(spawned[0]?.stdin).toContain(original);
    expect(spawned[0]?.command).toContain('sonnet');
  });

  it('reads a project skill, and .claude/CLAUDE.md without a root one', async () => {
    const { calls, root, proposeArgs } = setup();
    write(join(root, '.claude', 'CLAUDE.md'), 'a');
    write(join(root, '.claude', 'skills', 'release', 'SKILL.md'), 'b');
    expect((await calls.propose(proposeArgs())).path).toBe('.claude/CLAUDE.md');
    expect(
      (
        await calls.propose(
          proposeArgs({ runId: 'run_3', part: 'skill:release' }),
        )
      ).path,
    ).toBe('.claude/skills/release/SKILL.md');
  });

  it('refuses a code.deny path and a file over 64 KiB with policy_refused', async () => {
    const policy: PolicyConfig = {
      ...defaultPolicy(),
      code: { deny: ['.claude/skills/internal'] },
    };
    const { calls, spawned, root, proposeArgs } = setup('x', policy);
    write(join(root, '.claude', 'skills', 'internal', 'SKILL.md'), 'secret');
    write(join(root, 'CLAUDE.md'), 'x'.repeat(PREFIX_FILE_MAX_BYTES + 1));
    expect(
      await failureOf(calls.propose(proposeArgs({ part: 'skill:internal' }))),
    ).toBe('policy_refused');
    expect(await failureOf(calls.propose(proposeArgs()))).toBe(
      'policy_refused',
    );
    expect(spawned).toEqual([]);
  });

  it('refuses a root that is not the watched project’s, and a missing file', async () => {
    const { calls, proposeArgs } = setup();
    expect(await failureOf(calls.propose(proposeArgs({ root: '/etc' })))).toBe(
      'path_not_allowed',
    );
    expect(await failureOf(calls.propose(proposeArgs()))).toBe('not_found');
  });
});
