import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrappedCommand } from './hook';
import {
  parseHookCommand,
  parseSimpleCommand,
  quoteAssignment,
  shellQuote,
} from './shell';

/** The words bash itself makes of `text`, through a function that prints its args. */
const bashWords = (text: string): string[] => {
  const result = Bun.spawnSync(
    [
      'bash',
      '--noprofile',
      '--norc',
      '-c',
      `a() { printf '%s\\0' "$@"; }; a ${text}`,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH } },
  );
  if (result.exitCode !== 0) {
    throw new Error(`bash failed on ${text}: ${result.stderr.toString()}`);
  }
  const out = result.stdout.toString();
  return out === '' ? [] : out.slice(0, -1).split('\0');
};

describe('parseSimpleCommand (#445 amendment 3)', () => {
  it('takes a single simple command apart', () => {
    expect(parseSimpleCommand('bun run test')).toEqual({
      assignments: [],
      argv: ['bun', 'run', 'test'],
    });
  });

  it('takes leading assignments apart, unquoted', () => {
    expect(parseSimpleCommand(`AGENTDOCK_RAW=1 CI='a b'  bun test`)).toEqual({
      assignments: [
        { name: 'AGENTDOCK_RAW', value: '1' },
        { name: 'CI', value: 'a b' },
      ],
      argv: ['bun', 'test'],
    });
  });

  it('removes quotes from words', () => {
    expect(
      parseSimpleCommand(`git log --format='%h %s' -- "src/a b.ts"`)?.argv,
    ).toEqual(['git', 'log', '--format=%h %s', '--', 'src/a b.ts']);
  });

  it('allows quoted operators and globs', () => {
    expect(parseSimpleCommand(`grep -n 'a|b;c*' "x{y}"`)?.argv).toEqual([
      'grep',
      '-n',
      'a|b;c*',
      'x{y}',
    ]);
  });

  it.each([
    // lists, pipes, redirects, subshells, substitutions
    'bun test | head',
    'bun test && echo ok',
    'bun test || true',
    'bun test; echo done',
    'bun test &',
    'bun test > out.log',
    'bun test 2>&1',
    'cat < input',
    'cat <<EOF\nx\nEOF',
    '(cd a && bun test)',
    'echo $(date)',
    'echo "$(date)"',
    'echo `date`',
    'echo "`date`"',
    'diff <(ls a) <(ls b)',
    'echo $((1+2))',
    // DR-01: ANSI-C and locale quoting, and every other `$`
    `git log $'\\'; touch /tmp/x; \\''`,
    `git log $'a'`,
    `git log $"a"`,
    'git log "$HOME"',
    'git log $FILE',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell text, not a template
    'git log ${X}',
    // DR-09 / DR-11: a newline or a comment anywhere
    'bun test\nbun lint',
    'bun test # all of it',
    'bun test # x\nrm -rf /',
    'git log --format=#%h',
    "git log '#'",
    'git status \\\nrm -rf /',
    'bun test\r',
    // keywords and command runners
    'if true; then bun test; fi',
    'time bun test',
    '! bun test',
    'exec bun test',
    'eval bun test',
    'command git push',
    'builtin echo x',
    'env git push',
    'sudo git push',
    'source x.sh',
    '. x.sh',
    // history, brace, glob and tilde expansion
    'git log !1',
    "git commit -m 'a!'",
    'echo a{1..3}',
    'git add {a,b}.ts',
    'ls *.ts',
    'cat ?',
    'ls [ab]',
    'ls ~',
    'git -C ~/repo status',
    // unicode lookalikes and controls
    'git log ；rm x',
    'git push',
    'git log ‘x’',
    'git log \x07',
    // a quoted program or a quoted assignment is not what it looks like
    '"git" push',
    "g'it' push",
    "'FOO=1' git status",
    // unterminated
    "echo 'unterminated",
    'echo "unterminated',
    'echo trailing\\',
    '',
    '   ',
    'FOO=1',
  ])('refuses %p', (command) => {
    expect(parseSimpleCommand(command)).toBeNull();
  });

  // Each of these is simple, and bash makes exactly the parser's words of
  // it — and of the rewrite built from them.
  it.each([
    'bun run test',
    'git\tstatus',
    'git  log   --oneline',
    'git status \\; echo',
    'git log -- a.ts',
    'git "log" --format="%h \\"x\\""',
    `git log "a\\b" 'c\\d' e\\f`,
    `git commit -m 'it'\\''s'`,
    `FOO=1 BAR='a b' git log`,
    `FOO= git log`,
    `jest --testNamePattern='a b|c'`,
    `./node_modules/.bin/jest src/a.spec.ts`,
    `git log --author=a@b.c --since=2.days`,
  ])('agrees with bash on %p', (command) => {
    const parsed = parseSimpleCommand(command);
    if (!parsed) throw new Error(`expected ${command} to be simple`);
    const words = [
      ...parsed.assignments.map((a) => `${a.name}=${a.value}`),
      ...parsed.argv,
    ];
    expect(bashWords(command)).toEqual(words);
    const self = ['/opt/a b/agentdock-runner'];
    const rewrite = wrappedCommand(
      { cd: null, command: parsed, mergeStderr: false },
      self,
    );
    expect(bashWords(rewrite)).toEqual([
      ...parsed.assignments.map((a) => `${a.name}=${a.value}`),
      ...self,
      'filter',
      '--',
      ...parsed.argv,
    ]);
  });
});

describe('parseHookCommand (#445 amendment 11)', () => {
  it('takes `cd <path> && <command> 2>&1` apart', () => {
    expect(parseHookCommand(`cd "a b" && CI=1 bun test 2>&1`)).toEqual({
      cd: 'a b',
      command: {
        assignments: [{ name: 'CI', value: '1' }],
        argv: ['bun', 'test'],
      },
      mergeStderr: true,
    });
    expect(parseHookCommand('bun test')).toEqual({
      cd: null,
      command: { assignments: [], argv: ['bun', 'test'] },
      mergeStderr: false,
    });
  });

  it('leaves `&&` and `2>&1` inside quotes to the command', () => {
    expect(parseHookCommand(`cd 'a && b' && grep '&&' "2>&1"`)).toEqual({
      cd: 'a && b',
      command: { assignments: [], argv: ['grep', '&&', '2>&1'] },
      mergeStderr: false,
    });
  });

  it.each([
    // the near misses of `cd <literal path> &&`
    'cd a b && x',
    'cd -- x && y',
    'cd - && y',
    'cd -P x && y',
    'cd $HOME && x',
    'cd "$HOME" && x',
    'cd ~ && x',
    'cd ~/x && y',
    'cd *.d && y',
    'cd a{b,c} && y',
    'cd `pwd` && y',
    "cd '' && y",
    'cd && y',
    'cd x &&',
    'cd x && ',
    '&& y',
    'cd x && y && z',
    'cd x; y',
    'cd x && y; z',
    'cd x && y | z',
    'cd x || y',
    'cd x & y',
    'cd x &&& y',
    'cd x && (y)',
    'cd x && FOO=1',
    'cd x && exec y',
    'cd x && env y',
    '"cd" x && y',
    "c'd' x && y",
    'FOO=1 cd x && y',
    'y && cd x',
    'x && y',
    // an injected newline, anywhere
    'cd x\n&& y',
    'cd x &&\ny',
    'cd x && y\nz',
    'cd x\ny && z',
    'cd x && y 2>&1\nz',
    'y 2>&1\n',
    // the near misses of a trailing `2>&1`
    'y 2>&1 >f',
    'y >f 2>&1',
    'y 2>&3',
    'y &>f',
    'y &> f',
    'y 1>&2',
    'y >&2',
    'y 2>& 1',
    'y 2 >&1',
    'y2>&1',
    'y 12>&1',
    'y 2>&1x',
    'y 2>&1;',
    'y 2>&1 &',
    'y 2>&1 2>&1',
    'y 2>&1 | z',
    'y \\ 2>&1',
    "y '2>&1",
    'y "a 2>&1',
    'cd x 2>&1 && y',
    'cd x && 2>&1',
    '2>&1',
    ' 2>&1',
    'FOO=1 2>&1',
  ])('refuses %p', (command) => {
    expect(parseHookCommand(command)).toBeNull();
  });

  describe('agrees with bash', () => {
    let root: string;
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-cd-')));
      for (const dir of ['sub/deeper', 'd i r', `it's`, '2>&1']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
    });
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    /**
     * Runs `text` in `root`, with `a` a function that prints its working
     * directory, `$FOO` and its args to stdout, then `E` to stderr.
     */
    const run = (text: string) => {
      const result = Bun.spawnSync(
        [
          'bash',
          '--noprofile',
          '--norc',
          '-c',
          `a() { printf '%s\\0' "$PWD" "\${FOO-unset}" "$@"; printf E >&2; }; ${text}`,
        ],
        {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: process.env.PATH },
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(`bash failed on ${text}: ${result.stderr.toString()}`);
      }
      return { out: result.stdout.toString(), err: result.stderr.toString() };
    };

    /** The printed words, and where `E` went. */
    const observed = (text: string) => {
      const { out, err } = run(text);
      const merged = out.endsWith('E');
      const body = merged ? out.slice(0, -1) : out;
      return {
        words: body.slice(0, -1).split('\0'),
        stderrInStdout: merged,
        stderr: err,
      };
    };

    it.each([
      'cd sub && a x',
      'cd sub/deeper&&a x',
      `cd "d i r" && FOO='v w' a 'x y' z 2>&1`,
      `cd 'it'\\''s' && a q`,
      `cd it\\'s && a q\t2>&1\t`,
      `cd '2>&1' && a "2>&1"`,
      `cd ./sub && a 'x 2>&1'`,
      `cd sub && a '&&' 2>&1`,
      'a x 2>&1',
      'FOO=1 a x 2>&1  ',
      'a x',
    ])('on %p and its rewrite', (command) => {
      const parsed = parseHookCommand(command);
      if (!parsed) throw new Error(`expected ${command} to be rewritable`);
      const foo =
        parsed.command.assignments.find((a) => a.name === 'FOO')?.value ??
        'unset';
      const cwd = parsed.cd === null ? root : join(root, parsed.cd);

      // bash runs the command the parser saw…
      const original = observed(command);
      expect(original.words).toEqual([
        cwd,
        foo,
        ...parsed.command.argv.slice(1),
      ]);
      expect(original.stderrInStdout).toBe(parsed.mergeStderr);

      // …and the rewrite runs it the same way, behind `filter --`.
      const rewrite = observed(wrappedCommand(parsed, ['a']));
      expect(rewrite.words).toEqual([
        cwd,
        foo,
        'filter',
        '--',
        ...parsed.command.argv,
      ]);
      expect(rewrite.stderrInStdout).toBe(original.stderrInStdout);
      expect(rewrite.stderr).toBe(original.stderr);
    });
  });
});

describe('shellQuote', () => {
  it('leaves a plain word alone and quotes the rest', () => {
    expect(shellQuote('/usr/bin/agentdock-runner')).toBe(
      '/usr/bin/agentdock-runner',
    );
    expect(shellQuote('/home/a b/bun')).toBe(`'/home/a b/bun'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(shellQuote('')).toBe(`''`);
    expect(shellQuote('$HOME;x')).toBe(`'$HOME;x'`);
  });

  it('keeps an assignment an assignment', () => {
    expect(quoteAssignment({ name: 'A', value: 'x y' })).toBe(`A='x y'`);
    expect(quoteAssignment({ name: 'A', value: '' })).toBe('A=');
  });
});
