import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
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
    expect(parseSimpleCommand(`NAUTELLE_RAW=1 CI='a b'  bun test`)).toEqual({
      assignments: [
        { name: 'NAUTELLE_RAW', value: '1' },
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
    const self = ['/opt/a b/nautelle-runner'];
    const rewrite = wrappedCommand(
      { pipelines: [[{ command: parsed, mergeStderr: false }]], operators: [] },
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

/** A stage of `parseHookCommand`'s result, for short expectations. */
const stage = (
  argv: string[],
  mergeStderr = false,
  assignments: Record<string, string> = {},
) => ({
  command: {
    assignments: Object.entries(assignments).map(([name, value]) => ({
      name,
      value,
    })),
    argv,
  },
  mergeStderr,
});

describe('parseHookCommand (#445 amendment 11, #610)', () => {
  it('takes `cd <path> && <command> 2>&1` apart', () => {
    expect(parseHookCommand(`cd "a b" && CI=1 bun test 2>&1`)).toEqual({
      pipelines: [
        [stage(['cd', 'a b'])],
        [stage(['bun', 'test'], true, { CI: '1' })],
      ],
      operators: ['&&'],
    });
    expect(parseHookCommand('bun test')).toEqual({
      pipelines: [[stage(['bun', 'test'])]],
      operators: [],
    });
  });

  it('takes pipelines and lists apart', () => {
    expect(parseHookCommand('bun run test 2>&1 | tail -50')).toEqual({
      pipelines: [
        [stage(['bun', 'run', 'test'], true), stage(['tail', '-50'])],
      ],
      operators: [],
    });
    expect(
      parseHookCommand('cd apps/api&&bun run lint ;git status||a|b 2>&1|c'),
    ).toEqual({
      pipelines: [
        [stage(['cd', 'apps/api'])],
        [stage(['bun', 'run', 'lint'])],
        [stage(['git', 'status'])],
        [stage(['a']), stage(['b'], true), stage(['c'])],
      ],
      operators: ['&&', ';', '||'],
    });
  });

  it('leaves operators and `2>&1` inside quotes to the command', () => {
    expect(
      parseHookCommand(`cd 'a && b' && grep '&&' "2>&1" '|' \\; "||"`),
    ).toEqual({
      pipelines: [
        [stage(['cd', 'a && b'])],
        [stage(['grep', '&&', '2>&1', '|', ';', '||'])],
      ],
      operators: ['&&'],
    });
  });

  it.each([
    // a stage that is not a simple command
    'cd $HOME && x',
    'cd "$HOME" && x',
    'cd ~ && x',
    'cd ~/x && y',
    'cd *.d && y',
    'cd a{b,c} && y',
    'cd `pwd` && y',
    'cd x && (y)',
    'cd x && FOO=1',
    'cd x && exec y',
    'cd x && env y',
    'a | xargs b',
    'a && time b',
    'a | { b; }',
    'a; if b; then c; fi',
    '"cd" x && y',
    "c'd' x && y",
    'a | b $(c)',
    'a && b `c`',
    'a | b <(c)',
    'a | b > f',
    'a > f | b',
    'a < f && b',
    'a | cat <<EOF\nx\nEOF',
    'a <<<x | b',
    // an empty stage: a leading, trailing or doubled operator
    '&& y',
    'cd x &&',
    'cd x && ',
    'a |',
    '| a',
    'a ;',
    'a;',
    '; a',
    'a ||',
    'a && && b',
    'a | | b',
    'a ; ; b',
    // an operator this parser does not know
    'a & b',
    'a &',
    'a && b &',
    'cd x &&& y',
    'a |& b',
    'a ||| b',
    'a ;; b',
    'a ;& b',
    // an injected newline, anywhere
    'cd x\n&& y',
    'cd x &&\ny',
    'cd x && y\nz',
    'cd x\ny && z',
    'cd x && y 2>&1\nz',
    'a | b\nc',
    'y 2>&1\n',
    // the near misses of `2>&1`
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
    'y 2>&1 z',
    'y 2>&1 | 2>&1 z',
    'y | 2>&1',
    'y \\ 2>&1',
    "y '2>&1",
    'y "a 2>&1',
    'cd x && 2>&1',
    '2>&1',
    ' 2>&1',
    '2>&1 y',
    'FOO=1 2>&1',
    '',
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
     * Runs `text` in `root` and reports its stdout, its stderr, `$?` and
     * `PIPESTATUS`. `a` prints its working directory, `$FOO` and its args to
     * stdout, then `E` to stderr. `f N` prints `fN`, then `eN` to stderr, and
     * returns N. `w`, the stand-in for the runner, logs its args to fd 3 and
     * runs what follows `filter --`, returning its status — as the filter
     * does.
     */
    const run = (text: string) => {
      const log = join(root, 'wrapped.log');
      rmSync(log, { force: true });
      const result = Bun.spawnSync(
        [
          'bash',
          '--noprofile',
          '--norc',
          '-c',
          [
            `exec 3>>'${log}'`,
            `a() { printf '%s\\0' "$PWD" "\${FOO-unset}" "$@"; printf E >&2; }`,
            // A reader that exits without reading (`f 3 | f 0`) races its
            // writer: if the writer is still going it dies of SIGPIPE (141) and
            // never prints its `eN`. Ignoring SIGPIPE and silencing the failed
            // write makes the writer finish whichever side wins; what the test
            // compares — data, stderr, statuses — is unchanged.
            `trap '' PIPE`,
            `f() { printf 'f%s\\0' "$1" 2>/dev/null; printf 'e%s\\n' "$1" >&2; return "$1"; }`,
            `w() { printf '%s\\0' "$@" >&3; shift 2; "$@"; }`,
            `${text}; printf 'status %s %s' "$?" "\${PIPESTATUS[*]}" >&2`,
          ].join('\n'),
        ],
        {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: process.env.PATH },
        },
      );
      let wrapped: string[] = [];
      try {
        const text = readFileSync(log, 'utf8');
        wrapped = text === '' ? [] : text.slice(0, -1).split('\0');
      } catch {}
      return {
        out: result.stdout.toString(),
        err: result.stderr.toString(),
        wrapped,
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
      // #610: lists keep their short-circuits and their status
      'f 1 && f 2',
      'f 0 && f 2 || f 0',
      'f 1 || f 2 && f 0',
      'f 1; f 0',
      'f 0; f 3',
      'cd sub && a x; a y && f 4',
      // …and pipelines their data flow and their status
      'f 3 | f 0',
      'f 0 | f 4',
      'f 2 2>&1 | cat',
      'f 2 | cat 2>&1',
      'a x 2>&1 | tr E e',
      'f 5 | f 6 | cat; f 7 | cat',
      'cd sub && FOO=x a "y z" | tr / : && f 1 | cat || f 0',
    ])('on %p and its rewrite', (command) => {
      const parsed = parseHookCommand(command);
      if (!parsed) throw new Error(`expected ${command} to be rewritable`);
      const original = run(command);
      const rewrite = run(wrappedCommand(parsed, ['w']));
      // Same output, same stderr, same `$?` and `PIPESTATUS`…
      expect(rewrite.out).toBe(original.out);
      if (command.includes('|')) {
        // Pipeline stages write stderr at once, so bash orders it by chance:
        // compare it as a multiset of lines, and the status line exactly.
        const split = (err: string) => {
          const at = err.lastIndexOf('status ');
          return {
            lines: err.slice(0, at).split('\n').sort(),
            status: err.slice(at),
          };
        };
        expect(split(rewrite.err)).toEqual(split(original.err));
      } else {
        expect(rewrite.err).toBe(original.err);
      }
      expect(original.wrapped).toEqual([]);
      // …and every first stage that ran went through `w filter --`.
      expect(rewrite.wrapped.length).toBeGreaterThan(0);
      expect(rewrite.wrapped.slice(0, 2)).toEqual(['filter', '--']);
    });

    it('wraps only the first stage of each pipeline, and only those asked for', () => {
      const parsed = parseHookCommand('f 0 | f 1 && f 2 | f 3; f 4');
      if (!parsed) throw new Error('expected a rewritable line');
      const skip = parsed.pipelines[1]?.[0];
      const rewrite = wrappedCommand(parsed, ['w'], (s) => s !== skip);
      expect(rewrite).toBe(
        'w filter -- f 0 | f 1 && f 2 | f 3 ; w filter -- f 4',
      );
      expect(run(rewrite).wrapped).toEqual([
        'filter',
        '--',
        'f',
        '0',
        'filter',
        '--',
        'f',
        '4',
      ]);
    });
  });
});

describe('shellQuote', () => {
  it('leaves a plain word alone and quotes the rest', () => {
    expect(shellQuote('/usr/bin/nautelle-runner')).toBe(
      '/usr/bin/nautelle-runner',
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
