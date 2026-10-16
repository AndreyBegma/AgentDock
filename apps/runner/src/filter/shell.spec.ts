import { describe, expect, it } from 'bun:test';
import { parseSimpleCommand, shellQuote } from './shell';

describe('parseSimpleCommand (#445 amendment 3)', () => {
  it('takes a single simple command apart', () => {
    expect(parseSimpleCommand('bun run test')).toEqual({
      assignments: '',
      command: 'bun run test',
      argv: ['bun', 'run', 'test'],
    });
  });

  it('keeps leading assignments in front, as written', () => {
    expect(parseSimpleCommand('AGENTDOCK_RAW=1 CI=true  bun test')).toEqual({
      assignments: 'AGENTDOCK_RAW=1 CI=true',
      command: 'bun test',
      argv: ['bun', 'test'],
    });
  });

  it('removes quotes from words but keeps the text as written', () => {
    expect(
      parseSimpleCommand(`git log --format='%h %s' -- "src/a b.ts"`),
    ).toEqual({
      assignments: '',
      command: `git log --format='%h %s' -- "src/a b.ts"`,
      argv: ['git', 'log', '--format=%h %s', '--', 'src/a b.ts'],
    });
  });

  it('allows quoted operators and plain variables', () => {
    expect(parseSimpleCommand(`grep -n 'a|b;c' "$FILE"`)?.argv).toEqual([
      'grep',
      '-n',
      'a|b;c',
      '$FILE',
    ]);
  });

  it.each([
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
    'bun test\nbun lint',
    'if true; then bun test; fi',
    'time bun test',
    '! bun test',
    'exec bun test',
    "echo 'unterminated",
    'echo "unterminated',
    'echo trailing\\',
    '',
    '   ',
    'FOO=1',
  ])('refuses %p', (command) => {
    expect(parseSimpleCommand(command)).toBeNull();
  });

  it('drops a trailing comment from the words', () => {
    expect(parseSimpleCommand('bun test # all of it')?.argv).toEqual([
      'bun',
      'test',
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
  });
});
