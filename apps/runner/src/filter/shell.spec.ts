import { describe, expect, it } from 'bun:test';
import { wrappedCommand } from './hook';
import { parseSimpleCommand, quoteAssignment, shellQuote } from './shell';

/** The words bash itself makes of `text`, through a function that prints its args. */
const bashWords = (text: string): string[] => {
  const result = Bun.spawnSync(
    ['bash', '--noprofile', '--norc', '-c', `a() { printf '%s\\0' "$@"; }; a ${text}`],
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
    expect(
      parseSimpleCommand(`AGENTDOCK_RAW=1 CI='a b'  bun test`),
    ).toEqual({
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
    expect(bashWords(wrappedCommand(parsed, self))).toEqual([
      ...parsed.assignments.map((a) => `${a.name}=${a.value}`),
      ...self,
      'filter',
      '--',
      ...parsed.argv,
    ]);
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
