import { describe, expect, it } from 'bun:test';
import {
  checkSafePattern,
  compileMatchPattern,
  hasNestedQuantifier,
  SAFE_MATCH_INPUT_MAX_CHARS,
  SAFE_PATTERN_MAX_CHARS,
  testBounded,
} from './safe-pattern';

describe('hasNestedQuantifier', () => {
  it.each([
    '^(a+)+$',
    '^(a*)*$',
    '^(a|a)*$',
    '^(a|aa)+$',
    '(x+x+)+y',
    '^(?:a{1,9})*$',
    '^((a+)b)+$',
    '^(a+)\\1$',
    '^(\\w+\\s?)*$',
  ])('refuses %s', (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(true);
  });

  it.each([
    '^[\\w.:/#@+-]{1,100}$',
    '^claude-sonnet-4-5(-20250929)?$',
    '^(claude|gpt)-[0-9]+$',
    '^(-latest|-preview)?$',
    '^(\\.[0-9]+)*$',
    '^[a-z]+(-[a-z0-9]+)*$',
    '.*',
    '^[^\\n]*$',
  ])('accepts %s', (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(false);
  });
});

describe('checkSafePattern', () => {
  it('refuses a pattern over the length limit', () => {
    const result = checkSafePattern(
      'a'.repeat(SAFE_PATTERN_MAX_CHARS + 1),
      'u',
    );
    expect(result).toEqual({ ok: false, reason: 'too_long' });
  });

  it('refuses an invalid regex', () => {
    expect(checkSafePattern('([', 'u')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses ^(a+)+$', () => {
    expect(checkSafePattern('^(a+)+$', 'u')).toEqual({
      ok: false,
      reason: 'nested_quantifier',
    });
    expect(checkSafePattern('^(a+)+$', 'i')).toEqual({
      ok: false,
      reason: 'nested_quantifier',
    });
  });

  it('judges a pattern without its leading (?i)', () => {
    expect(checkSafePattern('(?i)^(a+)+$', 'i').ok).toBe(false);
    expect(checkSafePattern('(?i)^gpt-5$', 'i').ok).toBe(true);
  });
});

describe('testBounded', () => {
  it('does not match input over the cap', () => {
    const input = 'a'.repeat(SAFE_MATCH_INPUT_MAX_CHARS + 1);
    expect(testBounded(/a/, input)).toBe(false);
    expect(testBounded(/a/, input.slice(1))).toBe(true);
  });

  it('matches a 100 KB input with an accepted pattern in under 50 ms', () => {
    const pattern = compileMatchPattern('^(claude|gpt)-[a-z0-9-]+$');
    const input = `claude-${'a'.repeat(100 * 1024)}!`;
    const start = performance.now();
    expect(testBounded(pattern, input)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('matches a capped input with a pathological-looking safe pattern quickly', () => {
    const pattern = compileMatchPattern('^[a-z]+(-[a-z0-9]+)*$');
    const input = `${'a-'.repeat(SAFE_MATCH_INPUT_MAX_CHARS / 2 - 1)}!`;
    const start = performance.now();
    expect(testBounded(pattern, input)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
