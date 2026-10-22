import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDeps } from '../cli';
import { runCli } from '../cli';
import { FILTER_OFF_ENV, filterEnv } from './env';
import { type HookDeps, runFilterHook } from './hook';
import { runFilterCommand } from './main';
import type { StatsLine } from './stats';
import { demoFilter } from './testing';

const input = (command: string, mode = 'default') =>
  JSON.stringify({
    cwd: '/repo',
    permission_mode: mode,
    tool_name: 'Bash',
    tool_input: { command },
  });

describe('Bash read refusal (#663 D8)', () => {
  let dir: string;
  let deps: HookDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'read-refusal-'));
    deps = {
      env: filterEnv({
        runDir: dir,
        projectId: 'p1',
        runId: 'r1',
        runKind: 'card',
      }),
      filters: [demoFilter],
      selfCommand: ['/opt/agentdock/nautelle-runner'],
      home: '/home/u',
      os: 'linux',
      now: () => Date.parse('2026-10-19T12:00:00.000Z'),
      random: () => 0.5,
      rules: () => ({ allow: [], deny: [], ask: [] }),
      managedPolicy: () => false,
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const refused = (command: string, mode?: string): boolean => {
    const out = runFilterHook(input(command, mode), deps);
    if (!out) return false;
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: {
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain(
      'Read with offset/limit',
    );
    return true;
  };

  it.each([
    'cat file.ts',
    'cat src/a/b.ts',
    'head -50 file.ts',
    'head -n 50 file.ts',
    'tail -20 file.ts',
    'tail -n 20 file.ts',
    'sed -n 1,80p file.ts',
    "sed -n '1,80p' file.ts",
    'sed -n 5p file.ts',
  ])('refuses `%s`', (command) => {
    expect(refused(command)).toBe(true);
  });

  it('refuses in every permission mode', () => {
    for (const mode of ['default', 'bypassPermissions', 'auto', 'plan']) {
      expect(refused('cat file.ts', mode)).toBe(true);
    }
  });

  it.each([
    'cat a | grep x',
    'cat file.ts | head -5',
    'wc -l file.ts',
    'jq . file.json',
    'cat a b',
    'cat *.ts',
    'cat',
    'cat -',
    'tail -f app.log',
    'tail -F app.log',
    'head -c 100 file.bin',
    'sed -i s/a/b/ file.ts',
    "sed -n '/x/p' file.ts",
    'cat /dev/null',
    'cat a && cat b',
    'FOO=1 cat a',
    'cat a > b',
    'cat "unterminated',
    'ls src',
  ])('lets `%s` pass', (command) => {
    expect(refused(command)).toBe(false);
  });

  it('fails open on input it cannot parse', () => {
    for (const bad of ['', 'not json', '{"tool_name":"Bash"}', '[]']) {
      expect(runFilterHook(bad, deps)).toBe('');
    }
  });

  it('does nothing without the launch env', () => {
    expect(runFilterHook(input('cat file.ts'), { ...deps, env: {} })).toBe('');
  });

  it('writes a row naming the filter and the program', () => {
    refused('cat file.ts');
    const rows = readFileSync(join(dir, 'filter-stats.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as StatsLine);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.row).toMatchObject({
      filter: 'tool/read-refused',
      program: 'cat',
      passedThrough: false,
      bypassed: false,
    });
  });

  it('is switched off by the `tool` family (#663 D9)', () => {
    deps = { ...deps, env: { ...deps.env, [FILTER_OFF_ENV]: 'js,tool' } };
    expect(refused('cat file.ts')).toBe(false);
  });
});

describe('filter family switch (#663 D9)', () => {
  const run = async (off: string | undefined): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'family-off-'));
    try {
      const out: string[] = [];
      await runFilterCommand(
        ['filter-hook'],
        {
          env: {
            ...filterEnv({
              runDir: dir,
              projectId: 'p1',
              runId: 'r1',
              runKind: 'card',
            }),
            ...(off === undefined ? {} : { [FILTER_OFF_ENV]: off }),
          },
          stdout: (bytes) => out.push(String(bytes)),
          stderr: () => {},
          stdin: async () => input('demo-test --all', 'bypassPermissions'),
          flush: async () => {},
        },
        [demoFilter],
      );
      return out.join('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('wraps a command of an enabled family', async () => {
    expect(await run(undefined)).toContain('filter -- demo-test');
    expect(await run('js,ops')).toContain('filter -- demo-test');
  });

  it('leaves a command of a switched-off family alone', async () => {
    expect(await run('fixture')).toBe('');
    expect(await run('js, fixture')).toBe('');
  });
});

describe('nautelle-runner register (#663 D3)', () => {
  it('prints the shared register', async () => {
    const stdout: string[] = [];
    const deps = {
      env: {},
      stdout: (text: string) => stdout.push(text),
      stderr: () => {},
    } as unknown as CliDeps;
    expect(await runCli(['register'], deps)).toBe(0);
    const { TERSE_REGISTER } = await import('@nautelle/shared');
    expect(stdout.join('')).toBe(`${TERSE_REGISTER}\n`);
  });
});
