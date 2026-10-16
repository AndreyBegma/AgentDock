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

  describe('by permission mode (amendments 9 and 10)', () => {
    const wrapped = (command: string) => ({
      command: `/opt/agentdock/agentdock-runner filter -- ${command}`,
      description: 'Run the tests',
      timeout: 120000,
    });
    /** Bypass: the rewrite, approved by the hook — unchanged since amendment 9. */
    const allowed = (command: string) =>
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason:
            'AgentDock token saver: the output is filtered; AGENTDOCK_RAW=1 runs it unfiltered',
          updatedInput: wrapped(command),
        },
      });
    /** Auto: the rewrite alone, no decision — the classifier judges it. */
    const undecided = (command: string) =>
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: wrapped(command),
        },
      });
    // Allow rules everywhere: they never widen what the hook does.
    const modeRules: PermissionRules = {
      allow: ['Bash', 'Bash(bun run test:*)', 'Bash(bun test:*)'],
      deny: ['Bash(bun test:*)'],
      ask: ['Bash(bun run test --ci:*)'],
    };
    const covered = 'bun run test';
    const denied = 'bun test';
    const asked = 'bun run test --ci';
    const compound = 'bun run test && echo ok';

    // biome-ignore format: one row per line reads as the table it is
    const table: [string | undefined, string, string | null][] = [
      ['bypassPermissions', covered, allowed(covered)],
      ['bypassPermissions', denied, null],
      ['bypassPermissions', asked, null],
      ['bypassPermissions', compound, null],
      ['auto', covered, undecided(covered)],
      ['auto', denied, null],
      ['auto', asked, null],
      ['auto', compound, null],
      ['default', covered, null],
      ['default', denied, null],
      ['default', compound, null],
      ['acceptEdits', covered, null],
      ['acceptEdits', denied, null],
      ['acceptEdits', compound, null],
      ['plan', covered, null],
      ['plan', denied, null],
      ['plan', compound, null],
      ['dontAsk', covered, null],
      ['some-later-mode', covered, null],
      ['Auto', covered, null],
      [undefined, covered, null],
    ];

    it.each(table)('%s · %p → %s', (mode, command, expected) => {
      const input = preToolUse(command);
      if (mode === undefined) {
        delete (input as { permission_mode?: string }).permission_mode;
      } else {
        input.permission_mode = mode;
      }
      const out = runFilterHook(JSON.stringify(input), {
        ...deps,
        rules: () => modeRules,
      });
      if (expected === null) {
        expect(out).toBe('');
        expect(stats()).toHaveLength(1);
        expect(stats()[0]?.row.passedThrough).toBe(true);
      } else {
        // Exact bytes: in auto there is no `permissionDecision` key at all.
        expect(out).toBe(expected);
        expect(stats()).toEqual([]);
      }
    });

    it('never puts a decision on an auto-mode rewrite', () => {
      const out = runFilterHook(
        JSON.stringify(preToolUse('bun run test', {}, 'auto')),
        deps,
      );
      const parsed = JSON.parse(out) as HookOutput;
      expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual([
        'hookEventName',
        'updatedInput',
      ]);
    });
  });

  it('builds the rewrite from the words, never from the text (DR-01)', () => {
    const out = runFilterHook(
      JSON.stringify(preToolUse(`FOO='a b'  bun   test "x y" \\;`)),
      deps,
    );
    expect(
      (JSON.parse(out) as HookOutput).hookSpecificOutput.updatedInput.command,
    ).toBe(
      `FOO='a b' /opt/agentdock/agentdock-runner filter -- bun test 'x y' ';'`,
    );
  });

  it.each([
    `bun test $'\\'; touch /tmp/pwned; \\''`,
    'bun test # x\ntouch /tmp/pwned',
    'bun test\ntouch /tmp/pwned',
  ])('leaves %p alone (DR-01, DR-09)', (command) => {
    expect(runFilterHook(JSON.stringify(preToolUse(command)), deps)).toBe('');
    expect(stats()[0]?.row).toMatchObject({
      filter: 'none',
      passedThrough: true,
    });
  });

  it('gives no rewrite for `git  push` against `Bash(git push:*)` (DR-04)', () => {
    const git: Filter = {
      id: 'ops/git',
      matches: (argv) => argv[0] === 'git',
      apply: () => null,
    };
    const out = runFilterHook(JSON.stringify(preToolUse('git  push')), {
      ...deps,
      filters: [git],
      rules: () => ({ ...NO_RULES, deny: ['Bash(git push:*)'] }),
    });
    expect(out).toBe('');
    expect(stats()[0]?.row.filter).toBe('ops/git');
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
