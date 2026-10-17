import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/fixtures';
import { filterEnv } from './env';
import { decideHook, type HookDeps } from './hook';
import { demoFilter } from './testing';

/**
 * #610 end to end: the hook rewrites a pipeline or a list, and bash runs the
 * rewrite through the real `filter` entry (`main.ts`, with the demo filter).
 * The line's output past the filter, its `$?` and its `PIPESTATUS` are the
 * original's — and a `| head` that closes the pipe early leaves the filter as
 * quiet as it leaves the command.
 */
describe('Token saver on pipelines and lists (#610)', () => {
  let dir = '';
  let cleanup = () => {};
  let env: Record<string, string | undefined> = {};
  let deps: HookDeps;

  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
    // `demo.sh N` prints 50 passing lines, a failing one unless N is 0, a
    // summary, and exits N; `demo.sh big` prints 3 million numbers.
    const demo = join(dir, 'demo.sh');
    writeFileSync(
      demo,
      [
        '#!/bin/sh',
        '[ "$1" = big ] && exec seq 1 3000000',
        'i=1; while [ $i -le 50 ]; do echo "ok $i - passes"; i=$((i+1)); done',
        '[ "$1" = 0 ] || echo "not ok 51 - fails"',
        'echo summary',
        'exit "$1"',
      ].join('\n'),
    );
    chmodSync(demo, 0o755);
    const self = join(dir, 'self.ts');
    writeFileSync(
      self,
      [
        `import { processIo, runFilterCommand } from '${join(import.meta.dir, 'main.ts')}';`,
        `import { demoFilter } from '${join(import.meta.dir, 'testing.ts')}';`,
        'process.exit(await runFilterCommand(process.argv.slice(2), processIo(), [demoFilter]));',
      ].join('\n'),
    );
    env = {
      PATH: process.env.PATH,
      ...filterEnv({
        runDir: dir,
        projectId: 'p1',
        runId: 'r1',
        runKind: 'card',
      }),
    };
    deps = {
      env,
      filters: [demoFilter],
      selfCommand: [process.execPath, self],
      home: dir,
      os: 'linux',
      now: Date.now,
      rules: () => ({ allow: [], deny: [], ask: [] }),
    };
  });
  afterEach(() => cleanup());

  const rewrite = (command: string): string => {
    const decision = decideHook(
      {
        tool_name: 'Bash',
        permission_mode: 'auto',
        cwd: dir,
        tool_input: { command },
      },
      deps,
    );
    if (!decision || !('rewrite' in decision)) {
      throw new Error(`expected ${command} to be rewritten`);
    }
    return decision.rewrite.hookSpecificOutput.updatedInput.command as string;
  };

  /** stdout, stderr, and `$?` with `PIPESTATUS` after the line. */
  const run = (line: string) => {
    const result = Bun.spawnSync(
      [
        'bash',
        '--noprofile',
        '--norc',
        '-c',
        `${line}; printf 'status %s %s' "$?" "\${PIPESTATUS[*]}"`,
      ],
      { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' },
    );
    const out = result.stdout.toString();
    const at = out.lastIndexOf('status ');
    return {
      out: out.slice(0, at),
      status: out.slice(at),
      err: result.stderr.toString(),
    };
  };

  it('pipes the filtered output into `| tail`, with the original status', () => {
    const command = './demo.sh 1 2>&1 | tail -3';
    const line = rewrite(command);
    expect(line).toBe(
      `${deps.selfCommand.join(' ')} filter -- ./demo.sh 1 2>&1 | tail -3`,
    );
    const original = run(command);
    const filtered = run(line);
    expect(original.out).toContain('ok 50 - passes');
    // tail reads what the filter printed: the passing lines are gone.
    expect(filtered.out).not.toContain('ok 50 - passes');
    expect(filtered.out).toContain('not ok 51 - fails');
    expect(filtered.out).toContain('[agentdock filter:');
    // A failing first stage: `$?` is tail's, PIPESTATUS keeps the 1.
    expect(original.status).toBe('status 0 1 0');
    expect(filtered.status).toBe(original.status);
  });

  it.each([
    './demo.sh 3 && echo after',
    './demo.sh 0 && ./demo.sh 2 || echo rescued',
    './demo.sh 2; ./demo.sh 0 && echo both',
    './demo.sh 4 | wc -l',
    'cd . && ./demo.sh 0 | grep -c summary && ./demo.sh 5',
  ])('keeps the status and short-circuits of %p', (command) => {
    const original = run(command);
    const filtered = run(rewrite(command));
    expect(filtered.status).toBe(original.status);
    for (const word of ['after', 'rescued', 'both']) {
      expect(filtered.out.includes(word)).toBe(original.out.includes(word));
    }
  });

  it('stays quiet when `| head` closes the pipe, as the command does', () => {
    const command = 'AGENTDOCK_RAW=1 ./demo.sh big | head -2';
    const original = run(command);
    const filtered = run(rewrite(command));
    expect(original).toEqual({
      out: '1\n2\n',
      status: 'status 0 141 0',
      err: '',
    });
    expect(filtered).toEqual(original);
  }, 20_000);
});
