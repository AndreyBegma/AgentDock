import { describe, expect, it } from 'bun:test';
import { capLines, diffLines, splitCapture } from './frame';

describe('diffLines', () => {
  it('is null when nothing changed', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toBeNull();
    expect(diffLines([], [])).toBeNull();
  });

  it('starts at the first differing line', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual({
      from: 1,
      lines: ['x', 'c'],
    });
  });

  it('appends: from is the old length', () => {
    expect(diffLines(['a'], ['a', 'b', 'c'])).toEqual({
      from: 1,
      lines: ['b', 'c'],
    });
  });

  it('shrinks: an empty patch truncates the client', () => {
    expect(diffLines(['a', 'b', 'c'], ['a'])).toEqual({ from: 1, lines: [] });
  });
});

describe('capLines', () => {
  it('keeps everything that fits', () => {
    expect(capLines(['a', 'b'], 10_000)).toEqual(['a', 'b']);
  });

  it('drops lines from the top', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`.padEnd(50));
    const capped = capLines(lines, 2000);
    expect(capped.length).toBeLessThan(100);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.at(-1)).toBe(lines.at(-1));
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(2000);
  });
});

describe('splitCapture', () => {
  it('drops the empty piece after the final newline only', () => {
    expect(splitCapture('a\n\nb\n')).toEqual(['a', '', 'b']);
    expect(splitCapture('')).toEqual([]);
  });
});
