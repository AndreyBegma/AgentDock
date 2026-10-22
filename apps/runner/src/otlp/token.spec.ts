import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/fixtures';
import {
  isOtlpHeaders,
  loadOtlpToken,
  otlpHeaders,
  otlpTokenPath,
  tokenMatches,
} from './token';

describe('otlp receiver token (L-30)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('is created 0600 once and read back on the next boot', () => {
    const path = otlpTokenPath(join(dir, 'state'));
    const token = loadOtlpToken(path);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOtlpToken(path)).toBe(token);
  });

  it('replaces a file that does not hold a token', () => {
    const path = otlpTokenPath(dir);
    writeFileSync(path, 'short');
    expect(loadOtlpToken(path)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('formats and recognises the exporter headers', () => {
    const token = 'a'.repeat(64);
    expect(otlpHeaders(token)).toBe(`x-nautelle-otlp-token=${token}`);
    expect(isOtlpHeaders(otlpHeaders(token))).toBe(true);
    expect(isOtlpHeaders('x-nautelle-otlp-token=short')).toBe(false);
    expect(isOtlpHeaders('authorization=Bearer x')).toBe(false);
    expect(isOtlpHeaders(undefined)).toBe(false);
  });

  it('compares tokens of any length without throwing', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(null, 'abc')).toBe(false);
  });
});
