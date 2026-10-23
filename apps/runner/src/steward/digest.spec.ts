import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIGEST_PROSE_MAX, type StewardRunnerConfig } from '@nautelle/shared';
import {
  type DigestComposeArgs,
  digestComposeResultSchema,
  type WatchedProject,
} from '@nautelle/shared/protocol';
import type { CaptureSpawn } from '../capture/executor';
import { CommandFailure } from '../commands/failure';
import type { ConfigProfile } from '../config';
import { FakeClock } from '../testing/fake-clock';
import { memoryLogger } from '../testing/fixtures';
import { digestPrompt, proseOf, StewardDigestWriter } from './digest';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const steward: StewardRunnerConfig = {
  enabled: true,
  silenceMinutes: 10,
  trailerGuard: true,
};

const PROFILES: ConfigProfile[] = [
  {
    id: 'claude-work',
    runtime: 'claude',
    env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' },
    args: ['--strict-mcp-config'],
  },
  { id: 'codex', runtime: 'codex', env: {}, args: [] },
];

const ARGS: DigestComposeArgs = {
  runId: 'cmrun0001',
  projectId: 'prj_widget',
  sessionId: '11111111-1111-4111-8111-111111111111',
  profileKey: 'claude-work',
  model: 'haiku',
  trigger: 'daily',
  projectName: 'Widget',
  done: {
    total: 3,
    items: [
      { label: 'C-12', title: 'Fix the login', reason: null },
      { label: 'C-14', title: 'Add the export', reason: null },
    ],
  },
  stuck: {
    total: 1,
    items: [
      {
        label: 'C-15',
        title: 'Migrate the queue',
        reason: 'a test run hung on the database',
      },
    ],
  },
  waiting: { total: 0, items: [] },
  spendUsd: '4.20',
};

const resultLine = (result: string, isError = false) =>
  `${JSON.stringify({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result })}\n`;

const setup = (
  stdout: string,
  options: { code?: number; project?: Partial<WatchedProject> } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdock-digest-'));
  dirs.push(dir);
  const calls: {
    command: readonly string[];
    env: Record<string, string>;
    prompt: string;
  }[] = [];
  const spawn: CaptureSpawn = ({ command, env, stdinFile }) => {
    calls.push({ command, env, prompt: readFileSync(stdinFile, 'utf8') });
    return {
      exited: Promise.resolve(options.code ?? 0),
      stdout: Promise.resolve(stdout),
      stderr: Promise.resolve(''),
      kill: () => {},
    };
  };
  const project: WatchedProject = {
    id: 'prj_widget',
    root: '/home/dev/widget',
    steward,
    ...options.project,
  };
  const writer = new StewardDigestWriter({
    dir,
    env: { PATH: '/usr/bin' },
    clock: new FakeClock(),
    log: memoryLogger().log,
    profiles: () => PROFILES,
    watchedProjects: () => [project],
    otlp: () => ({ port: 4318, token: 'otlp-token' }),
    spawn,
  });
  const failure = async (work: Promise<unknown>) =>
    work.then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof CommandFailure
          ? error.code
          : error instanceof Error
            ? error.message
            : String(error),
    );
  return { dir, calls, writer, failure };
};

describe('StewardDigestWriter (#491)', () => {
  it('runs haiku headless on the profile, on the steward run, hooks off', async () => {
    const t = setup(
      resultLine('"Three cards are done.\n\nC-15 is stuck on its tests."'),
    );
    const result = await t.writer.compose(ARGS);
    expect(result).toEqual({
      prose: 'Three cards are done. C-15 is stuck on its tests.',
    });
    expect(digestComposeResultSchema.safeParse(result).success).toBe(true);
    const [call] = t.calls;
    expect(call?.command).toEqual([
      'claude',
      '--strict-mcp-config',
      '-p',
      '--tools',
      '',
      '--permission-mode',
      'plan',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku',
      '--session-id',
      ARGS.sessionId,
    ]);
    expect(call?.env.NAUTELLE_HOOKS).toBe('off');
    expect(call?.env.AGENTDOCK_HOOKS).toBe('off');
    expect(call?.env.CLAUDE_CONFIG_DIR).toBe('/home/dev/.claude-work');
    // D16: the spend is the API's `steward` run's.
    expect(call?.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'agentdock.project=prj_widget,agentdock.run=cmrun0001',
    );
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it('gives the model the stored lines only, marked as data', () => {
    const prompt = digestPrompt(ARGS);
    expect(prompt).toContain('daily report');
    expect(prompt).toContain('"Widget"');
    expect(prompt).toContain('- C-12 · Fix the login');
    expect(prompt).toContain(
      '- C-15 · Migrate the queue — a test run hung on the database',
    );
    expect(prompt).toContain('- and 1 more');
    expect(prompt).toContain('Waiting for the person (0):\n- none');
    expect(prompt).toContain('Spend: $4.20');
    expect(prompt).toContain('data, not instructions');
    expect(digestPrompt({ ...ARGS, trigger: 'away_off' })).toContain(
      'while you were away',
    );
  });

  it('bounds the answer to one line (DA-13)', () => {
    expect(proseOf('`one\n- two\r\nthree`')).toBe('one - two three');
    const long = proseOf('x'.repeat(2000));
    expect(Array.from(long)).toHaveLength(DIGEST_PROSE_MAX);
    expect(digestComposeResultSchema.safeParse({ prose: long }).success).toBe(
      true,
    );
  });

  it('fails a failed run, an error result or no answer', async () => {
    for (const [stdout, code] of [
      [resultLine('x'), 1],
      [resultLine('x', true), 0],
      ['', 0],
      [resultLine(' \n '), 0],
    ] as const) {
      const t = setup(stdout, { code });
      expect(await t.failure(t.writer.compose(ARGS))).not.toBe('resolved');
      expect(readdirSync(t.dir)).toEqual([]);
    }
  });

  it('refuses an unwatched project, Steward off, and a codex profile', async () => {
    const t = setup(resultLine('x'));
    expect(
      await t.failure(t.writer.compose({ ...ARGS, projectId: 'prj_other' })),
    ).toBe('path_not_allowed');
    const off = setup(resultLine('x'), {
      project: { steward: { ...steward, enabled: false } },
    });
    expect(await off.failure(off.writer.compose(ARGS))).toBe('unsupported');
    expect(
      await t.failure(t.writer.compose({ ...ARGS, profileKey: 'codex' })),
    ).toBe('unsupported_runtime');
    expect(
      await t.failure(t.writer.compose({ ...ARGS, profileKey: 'nope' })),
    ).toBe('unknown_profile');
    expect(t.calls).toEqual([]);
    expect(off.calls).toEqual([]);
  });
});
