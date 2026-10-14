import { describe, expect, test } from 'bun:test';
import { parseRetention, retentionError } from './session-content';

describe('parseRetention', () => {
  test('accepts whole days from 1 to 365', () => {
    expect(parseRetention('1')).toBe(1);
    expect(parseRetention(' 30 ')).toBe(30);
    expect(parseRetention('365')).toBe(365);
  });
  test('refuses zero, over the limit, fractions, signs and empty', () => {
    for (const text of ['0', '366', '1.5', '-3', '', 'abc', '1e2']) {
      expect(parseRetention(text)).toBeNull();
    }
  });
});

describe('retentionError', () => {
  test('names the range only for a bad value', () => {
    expect(retentionError('30')).toBeUndefined();
    expect(retentionError('400')).toMatch(/1 to 365/);
  });
});
