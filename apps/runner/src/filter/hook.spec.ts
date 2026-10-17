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
    ['a pipe into a file', 'bun test | tail -5 > out.log', {}, 'none:compound'],
    ['a background list', 'bun test && echo ok &', {}, 'none:compound'],
    ['a redirect', 'bun test > out.log', {}, 'none:compound'],
    ['a substitution', 'bun test $(git diff --name-only)', {}, 'none:compound'],
    [
      'a background call',
      'bun test',
      { run_in_background: true },
      'js/bun-test',
    ],
    ['a watch mode', 'bun test --watch', {}, 'js/bun-test'],
    ['a family long-running mode', 'demo-test --forever', {}, 'fixture/demo'],
    ['an uncovered command', 'cd apps/runner', {}, 'none:uncovered'],
    ['an uncovered command after cd', 'cd apps && ls', {}, 'none:uncovered'],
    [
      'a covered command later in a pipe',
      'ls | bun test',
      {},
      'none:uncovered',
    ],
    [
      'a background pipeline',
      'bun test | tail -5',
      { run_in_background: true },
      'js/bun-test',
    ],
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
    // The filter that matched a simple command, else why none did.
    expect(rows[0]?.row.filter).toBe(filter);
  });

  describe('the reason no filter ran (amendment 12)', () => {
    const filterOf = (command: string, mode?: string) => {
      runFilterHook(JSON.stringify(preToolUse(command, {}, mode)), deps);
      return stats().at(-1)?.row.filter;
    };

    it('is the mode in a mode that never rewrites, whatever the command', () => {
      for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk']) {
        expect(filterOf('bun test > out.log', mode)).toBe('none:mode');
        expect(filterOf('ls', mode)).toBe('none:mode');
      }
    });

    it('is compound or uncovered in bypass and auto', () => {
      for (const mode of ['bypassPermissions', 'auto']) {
        expect(filterOf('bun test > out; ls', mode)).toBe('none:compound');
        expect(filterOf('ls -la', mode)).toBe('none:uncovered');
      }
    });

    it('keeps a matched filter’s id in any mode', () => {
      expect(filterOf('bun test', 'default')).toBe('js/bun-test');
      expect(filterOf('bun test --watch', 'auto')).toBe('js/bun-test');
    });
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
    const compound = 'bun run test > out.log';
    const chain = 'bun run test 2>&1 | tail -50 && echo ok';

    // biome-ignore format: one row per line reads as the table it is
    const table: [string | undefined, string, string | null][] = [
      ['bypassPermissions', covered, allowed(covered)],
      ['bypassPermissions', denied, null],
      ['bypassPermissions', asked, null],
      ['bypassPermissions', compound, null],
      ['bypassPermissions', chain, allowed(chain)],
      ['auto', covered, undecided(covered)],
      ['auto', chain, undecided(chain)],
      ['auto', denied, null],
      ['auto', asked, null],
      ['auto', compound, null],
      ['default', covered, null],
      ['default', denied, null],
      ['default', compound, null],
      ['default', chain, null],
      ['acceptEdits', covered, null],
      ['acceptEdits', denied, null],
      ['acceptEdits', compound, null],
      ['plan', covered, null],
      ['plan', denied, null],
      ['plan', compound, null],
      ['plan', chain, null],
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

  describe('`cd <path> &&` and a trailing `2>&1` (amendment 11)', () => {
    const rewritten = (command: string, mode = 'bypassPermissions') =>
      (
        JSON.parse(
          runFilterHook(JSON.stringify(preToolUse(command, {}, mode)), deps),
        ) as HookOutput
      ).hookSpecificOutput.updatedInput.command;

    it.each([
      [
        'cd apps/runner && bun test',
        'cd apps/runner && /opt/agentdock/agentdock-runner filter -- bun test',
      ],
      [
        `cd  "/repo/a b"   &&  CI=1 bun run test 'x y'`,
        `cd '/repo/a b' && CI=1 /opt/agentdock/agentdock-runner filter -- bun run test 'x y'`,
      ],
      [
        'bun test 2>&1',
        '/opt/agentdock/agentdock-runner filter -- bun test 2>&1',
      ],
      [
        `cd 'it'\\''s' && bun test\t2>&1  `,
        `cd 'it'\\''s' && /opt/agentdock/agentdock-runner filter -- bun test 2>&1`,
      ],
    ])('rewrites %p from its words', (command, expected) => {
      expect(rewritten(command)).toBe(expected);
      expect(rewritten(command, 'auto')).toBe(expected);
    });

    it.each([
      ['cd $HOME && bun test', 'none:compound'],
      ['bun test 2>&1 > out.log', 'none:compound'],
      ['bun test 2>&3', 'none:compound'],
      ['bun test &> out.log', 'none:compound'],
      ['bun test 1>&2', 'none:compound'],
      ['cd x && bun test 2>&1\ntouch /tmp/pwned', 'none:compound'],
      ['cd x && cd y', 'none:uncovered'],
      ['cd x && bun test --watch 2>&1', 'js/bun-test'],
    ])('leaves %p alone', (command, filter) => {
      expect(runFilterHook(JSON.stringify(preToolUse(command)), deps)).toBe('');
      expect(stats()[0]?.row).toMatchObject({ filter, passedThrough: true });
    });

    it('matches deny and ask rules on the inner command', () => {
      for (const rule of [
        { deny: ['Bash(bun test:*)'] },
        { ask: ['Bash(bun test)'] },
        { deny: ['Bash(cd:*)'] },
      ]) {
        const out = runFilterHook(
          JSON.stringify(preToolUse('cd apps/api && bun test 2>&1')),
          { ...deps, rules: () => ({ ...NO_RULES, ...rule }) },
        );
        expect(out).toBe('');
      }
    });
  });

  describe('pipelines and lists (#610)', () => {
    const git: Filter = {
      id: 'ops/git',
      matches: (argv) => argv[0] === 'git',
      apply: () => null,
    };
    const bunLint: Filter = {
      id: 'js/biome',
      matches: (argv) => argv.join(' ') === 'bun run lint',
      apply: () => null,
    };
    const self = '/opt/agentdock/agentdock-runner filter --';
    const rewritten = (command: string, mode = 'auto') => {
      const out = runFilterHook(JSON.stringify(preToolUse(command, {}, mode)), {
        ...deps,
        filters: [bunTest, bunLint, git, demoFilter],
      });
      return out === ''
        ? null
        : (JSON.parse(out) as HookOutput).hookSpecificOutput.updatedInput
            .command;
    };

    it.each([
      // the first stage of a pipe runs through the filter; the rest reads its output
      ['bun run test 2>&1 | tail -50', `${self} bun run test 2>&1 | tail -50`],
      ['git log --oneline | head -20', `${self} git log --oneline | head -20`],
      [
        'git diff | grep -n foo | wc -l',
        `${self} git diff | grep -n foo | wc -l`,
      ],
      // every covered command of a list on its own; the rest as written
      [
        'cd apps/api && bun run lint && git status',
        `cd apps/api && ${self} bun run lint && ${self} git status`,
      ],
      [
        'bun test; ls -la || git status | sort',
        `${self} bun test ; ls -la || ${self} git status | sort`,
      ],
      // only first stages: a covered command later in a pipe runs as written
      ['ls | bun test && git status', `ls | bun test && ${self} git status`],
      // a dev/watch mode is left as written, the rest still wrapped
      [
        'bun test --watch; demo-test --forever && bun test',
        `bun test --watch ; demo-test --forever && ${self} bun test`,
      ],
      [
        `CI=1  bun   run test 'a b'&&git  "status"`,
        `CI=1 ${self} bun run test 'a b' && ${self} git status`,
      ],
    ])('rewrites %p', (command, expected) => {
      expect(rewritten(command)).toBe(expected);
      expect(rewritten(command, 'bypassPermissions')).toBe(expected);
      expect(rewritten(command, 'default')).toBeNull();
      expect(stats().every((s) => s.row.filter !== 'none:compound')).toBe(true);
    });

    it.each([
      'bun test <<EOF\nx\nEOF',
      'bun test <<< x | tail',
      '(bun test) | tail -5',
      'bun test | (tail -5)',
      '{ bun test; } | tail -5',
      'bun test $(git diff --name-only) | tail',
      'git status && bun test `ls`',
      'bun test <(ls) && git status',
      'bun test & git status',
      'bun test | tail -5 &',
      'bun test && git status &',
      'bun test > out.log; git status',
      'git status 2>/dev/null | head',
      'bun test |& tail',
      'bun test | xargs echo',
    ])('leaves %p alone', (command) => {
      expect(rewritten(command)).toBeNull();
      expect(stats().at(-1)?.row).toMatchObject({
        filter: 'none:compound',
        passedThrough: true,
      });
    });

    it('leaves a whole background call alone', () => {
      const out = runFilterHook(
        JSON.stringify(
          preToolUse('bun test | tail && git status', {
            run_in_background: true,
          }),
        ),
        { ...deps, filters: [bunTest, git] },
      );
      expect(out).toBe('');
      expect(stats()[0]?.row.filter).toBe('js/bun-test');
    });

    it('counts a line with no covered first stage under the first filter it meets', () => {
      expect(rewritten('bun test --watch | tail; ls')).toBeNull();
      expect(stats()[0]?.row.filter).toBe('js/bun-test');
      expect(rewritten('ls | bun test; cd x')).toBeNull();
      expect(stats()[1]?.row.filter).toBe('none:uncovered');
    });

    it('leaves the line alone when a rule matches any of its commands', () => {
      for (const rule of [
        { deny: ['Bash(git push:*)'] },
        { ask: ['Bash(tail:*)'] },
        { deny: ['Bash(cd:*)'] },
        { ask: ['Bash(bun test)'] },
      ]) {
        const out = runFilterHook(
          JSON.stringify(
            preToolUse('cd x && bun test 2>&1 | tail -5; git push', {}, 'auto'),
          ),
          {
            ...deps,
            filters: [bunTest, git],
            rules: () => ({ ...NO_RULES, ...rule }),
          },
        );
        expect(out).toBe('');
      }
    });
  });

  it.each([
    `bun test $'\\'; touch /tmp/pwned; \\''`,
    'bun test # x\ntouch /tmp/pwned',
    'bun test\ntouch /tmp/pwned',
  ])('leaves %p alone (DR-01, DR-09)', (command) => {
    expect(runFilterHook(JSON.stringify(preToolUse(command)), deps)).toBe('');
    expect(stats()[0]?.row).toMatchObject({
      filter: 'none:compound',
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
