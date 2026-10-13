import { describe, expect, test } from 'bun:test';
import { diffLines, diffStat } from './diff';

const render = (before: string, after: string) =>
  diffLines(before, after).map(
    (line) =>
      `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`,
  );

describe('diffLines', () => {
  test('identical texts are all unchanged', () => {
    expect(render('a\nb', 'a\nb')).toEqual([' a', ' b']);
  });

  test('a changed line is one removal and one addition in place', () => {
    expect(render('a\nb\nc', 'a\nB\nc')).toEqual([' a', '-b', '+B', ' c']);
  });

  test('an inserted and a deleted line', () => {
    expect(render('a\nb\nc\nd', 'a\nc\nd\ne')).toEqual([
      ' a',
      '-b',
      ' c',
      ' d',
      '+e',
    ]);
  });

  test('from nothing is all added, to nothing all removed', () => {
    expect(render('', 'x\ny')).toEqual(['+x', '+y']);
    expect(render('x', '')).toEqual(['-x']);
  });

  test('CRLF and LF compare equal', () => {
    expect(diffStat(diffLines('a\r\nb', 'a\nb'))).toEqual({
      added: 0,
      removed: 0,
    });
  });

  test('the stat counts what changed', () => {
    expect(diffStat(diffLines('a\nb', 'a\nc\nd'))).toEqual({
      added: 2,
      removed: 1,
    });
  });

  test('a huge rewrite falls back to whole-text without hanging', () => {
    const before = Array.from({ length: 2500 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 2500 }, (_, i) => `b${i}`).join('\n');
    const stat = diffStat(diffLines(before, after));
    expect(stat).toEqual({ added: 2500, removed: 2500 });
  });
});
