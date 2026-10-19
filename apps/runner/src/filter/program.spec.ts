import { describe, expect, it } from 'bun:test';
import { programOf, programOfLine } from './program';
import { parseHookCommand } from './shell';

describe('programOf (#648)', () => {
  it('names the program and the subcommand of a tool that has them', () => {
    expect(programOf(['git', 'log', '--oneline', '-5'])).toBe('git log');
    expect(programOf(['bun', 'run', 'test'])).toBe('bun run');
    expect(programOf(['/usr/bin/git', 'status'])).toBe('git status');
  });

  it('never keeps an argument', () => {
    expect(programOf(['ls', 'src'])).toBe('ls');
    expect(programOf(['cat', '/etc/passwd'])).toBe('cat');
    expect(programOf(['git', '-C', 'repo', 'log'])).toBe('git');
    expect(programOf(['git', 'Secret Value'])).toBe('git');
    expect(programOf(['node', 'script.js'])).toBe('node');
  });

  it('is undefined for nothing, or a name the row schema would refuse', () => {
    expect(programOf([])).toBeUndefined();
    expect(programOf(['wéird'])).toBeUndefined();
    expect(programOf([`x${'a'.repeat(64)}`])).toBeUndefined();
  });

  it('drops a subcommand that would make the name too long', () => {
    expect(programOf([`g${'i'.repeat(55)}`, 'log'])).toBe(`g${'i'.repeat(55)}`);
    expect(programOf(['git', 'l'.repeat(70)])).toBe('git');
  });
});

describe('programOfLine (#648)', () => {
  const of = (line: string) => programOfLine(line, parseHookCommand(line));

  it('takes the first pipeline head past a cd', () => {
    expect(of('cd apps/api && git diff --stat | head')).toBe('git diff');
    expect(of('ls -la')).toBe('ls');
    expect(of('cd /tmp')).toBe('cd');
  });

  it('takes the first plain word of a line that does not parse', () => {
    expect(of('FOO=1 git log > out.txt; ls')).toBe('git log');
    expect(of('for f in *; do echo $f; done')).toBe('for');
    expect(of('$(whoami)')).toBeUndefined();
  });
});
