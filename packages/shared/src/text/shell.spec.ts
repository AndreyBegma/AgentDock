import { describe, expect, it } from 'bun:test';
import { shellWord } from './shell';

describe('shellWord', () => {
  it('leaves a plain word bare', () => {
    expect(shellWord('claude-work.2_x')).toBe('claude-work.2_x');
  });

  it('single-quotes anything the shell would expand or split', () => {
    expect(shellWord('a b')).toBe("'a b'");
    expect(shellWord('$(id)')).toBe("'$(id)'");
    expect(shellWord('')).toBe("''");
  });

  it('closes, escapes and reopens the quotes around a single quote', () => {
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });
});
