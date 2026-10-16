import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterEnv } from './env';
import {
  decideHook,
  type HookDeps,
  type HookOutput,
  runFilterHook,
} from './hook';
import type { PermissionRules } from './permissions';
import type { StatsLine } from './stats';
import { demoFilter } from './testing';
import type { Filter } from './types';

/** Stands in for a family that covers `bun run test` / `bun test`. */
const bunTest: Filter = {
  id: 'js/bun-test',
  matches: (argv) =>
    argv[0] === 'bun' &&
    (argv[1] === 'test' || (argv[1] === 'run' && argv[2] === 'test')),
  apply: () => null,
};

const NO_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

/** Claude Code's PreToolUse input for a Bash call. */
const preToolUse = (
  command: string,
  extra: Record<string, unknown> = {},
  mode = 'bypassPermissions',
) => ({
  session_id: 's1',
  transcript_path: '/t.jsonl',
  cwd: '/repo',
  permission_mode: mode,
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: {
    command,
    description: 'Run the tests',
    timeout: 120000,
    ...extra,
  },
  tool_use_id: 'toolu_1',
});

describe('filter-hook (#445 D3, amendment 3)', () => {
  let dir: string;
  let deps: HookDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hook-'));
    deps = {
      env: filterEnv({
        runDir: dir,
        projectId: 'p1',
        runId: 'r1',
        runKind: 'card',
      }),
      filters: [bunTest, demoFilter],
      selfCommand: ['/opt/agentdock/agentdock-runner'],
      home: '/home/u',
      os: 'linux',
      now: () => Date.parse('2026-10-16T12:00:00.000Z'),
      random: () => 0.5,
      rules: () => NO_RULES,
    };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const stats = (): StatsLine[] => {
    try {
      return readFileSync(join(dir, 'filter-stats.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as StatsLine);
    } catch {
      return [];
    }
  };

  it('runs `bun run test` as `agentdock-runner filter -- bun run test`', () => {
    const out = runFilterHook(JSON.stringify(preToolUse('bun run test')), deps);
    const parsed = JSON.parse(out) as HookOutput;
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    // The whole input comes back, only the command changed.
    expect(parsed.hookSpecificOutput.updatedInput).toEqual({
      command: '/opt/agentdock/agentdock-runner filter -- bun run test',
      description: 'Run the tests',
      timeout: 120000,
    });
    expect(stats()).toEqual([]);
  });

  it('runs a dev checkout as bun with the entry script, quoted', () => {
    const out = runFilterHook(JSON.stringify(preToolUse('bun test')), {
      ...deps,
      selfCommand: ['/home/a b/.bun/bin/bun', '/repo/apps/runner/src/main.ts'],
    });
    expect(
      (JSON.parse(out) as HookOutput).hookSpecificOutput.updatedInput.command,
    ).toBe(
      `'/home/a b/.bun/bin/bun' /repo/apps/runner/src/main.ts filter -- bun test`,
    );
  });

  it('keeps assignments in front, so the bypass reaches the filter', () => {
    const out = runFilterHook(
      JSON.stringify(preToolUse('AGENTDOCK_RAW=1 bun test')),
      deps,
    );
    expect(
      (JSON.parse(out) as HookOutput).hookSpecificOutput.updatedInput.command,
    ).toBe(
      'AGENTDOCK_RAW=1 /opt/agentdock/agentdock-runner filter -- bun test',
    );
  });

  it('rewrites nothing with Token saver off — the launch sets no filter env', () => {
    expect(
      runFilterHook(JSON.stringify(preToolUse('bun run test')), {
        ...deps,
        env: {},
      }),
    ).toBe('');
    expect(stats()).toEqual([]);
  });

  it.each([
    ['a pipe', 'bun test | tail -5', {}, 'none'],
    ['a list', 'bun test && echo ok', {}, 'none'],
    ['a redirect', 'bun test > out.log', {}, 'none'],
    ['a substitution', 'bun test $(git diff --name-only)', {}, 'none'],
    [
      'a background call',
      'bun test',
      { run_in_background: true },
      'js/bun-test',
    ],
    ['a watch mode', 'bun test --watch', {}, 'js/bun-test'],
    ['a family long-running mode', 'demo-test --forever', {}, 'fixture/demo'],
    ['an uncovered command', 'cd apps/runner', {}, 'none'],
  ])('leaves %s alone and counts it passedThrough', (_, command, extra, filter) => {
    const input = JSON.stringify(preToolUse(command, extra));
    expect(runFilterHook(input, deps)).toBe('');
    const rows = stats();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectId).toBe('p1');
    expect(rows[0]?.row).toMatchObject({
      runId: 'r1',
      runKind: 'card',
      rawBytes: 0,
      keptBytes: 0,
      bypassed: false,
      passedThrough: true,
      at: '2026-10-16T12:00:00.000Z',
    });
    // The filter that matched a simple command, else `none`.
    expect(rows[0]?.row.filter).toBe(filter);
  });

  it('leaves the command alone when a deny rule matches it, even in bypass mode', () => {
    expect(
      runFilterHook(JSON.stringify(preToolUse('bun run test')), {
        ...deps,
        rules: () => ({ ...NO_RULES, deny: ['Bash(bun run:*)'] }),
      }),
    ).toBe('');
    expect(stats()[0]?.row.passedThrough).toBe(true);
  });

  it('rewrites outside bypass mode only when an allow rule covers the original', () => {
    const input = JSON.stringify(preToolUse('bun run test', {}, 'default'));
    expect(runFilterHook(input, deps)).toBe('');
    const allowed = runFilterHook(input, {
      ...deps,
      rules: () => ({ ...NO_RULES, allow: ['Bash(bun run test:*)'] }),
    });
    expect(allowed).toContain('filter -- bun run test');
  });

  it('leaves the command alone when the settings cannot be read', () => {
    expect(
      runFilterHook(JSON.stringify(preToolUse('bun run test')), {
        ...deps,
        rules: () => null,
      }),
    ).toBe('');
  });

  it('fails open on anything it does not expect', () => {
    const odd = ['', 'not json', '[]', 'null', '{"tool_name":"Read"}'];
    for (const stdin of odd) {
      expect(runFilterHook(stdin, deps)).toBe('');
    }
    expect(
      runFilterHook(JSON.stringify(preToolUse('bun test')), {
        ...deps,
        rules: () => {
          throw new Error('boom');
        },
      }),
    ).toBe('');
    const notText = { tool_name: 'Bash', tool_input: { command: 3 } };
    expect(decideHook(notText, deps)).toBeNull();
  });
});
