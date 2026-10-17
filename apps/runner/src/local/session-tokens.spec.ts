import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../testing/fixtures';
import {
  cwdWithin,
  loadSessionTokenSecret,
  SessionTokens,
} from './session-tokens';

describe('SessionTokens (#113)', () => {
  const tokens = new SessionTokens(Buffer.alloc(32, 1));
  const binding = { sessionId: 's-1', cwd: '/home/person/dev/app' };

  it('verifies a token it minted back to its binding', () => {
    expect(tokens.verify(tokens.mint(binding))).toEqual(binding);
  });

  it('refuses a token signed with another secret, tampered or malformed', () => {
    const token = tokens.mint(binding);
    expect(new SessionTokens(Buffer.alloc(32, 2)).verify(token)).toBeNull();
    const [prefix, , mac] = token.split('.');
    const other = Buffer.from(
      JSON.stringify({ s: 's-1', c: '/home/person/dev/other' }),
    ).toString('base64url');
    expect(tokens.verify(`${prefix}.${other}.${mac}`)).toBeNull();
    expect(tokens.verify('')).toBeNull();
    expect(tokens.verify('adst1.x')).toBeNull();
    expect(tokens.verify(`${token}.extra`)).toBeNull();
  });
});

describe('cwdWithin (#113)', () => {
  it('is the root or below it, never a sibling or a parent', () => {
    expect(cwdWithin('/a/app', '/a/app')).toBe(true);
    expect(cwdWithin('/a/app/src', '/a/app')).toBe(true);
    expect(cwdWithin('/a/app-other', '/a/app')).toBe(false);
    expect(cwdWithin('/a', '/a/app')).toBe(false);
    expect(cwdWithin('/a/app/../other', '/a/app')).toBe(false);
  });
});

describe('loadSessionTokenSecret (#113)', () => {
  let dir = '';
  let cleanup = () => {};
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  it('creates a 0600 secret once and keeps it, so tokens outlive a restart', () => {
    const path = join(dir, 'state', 'session-token.key');
    const first = loadSessionTokenSecret(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadSessionTokenSecret(path).equals(first)).toBe(true);
    const token = new SessionTokens(first).mint({ sessionId: 's', cwd: '/w' });
    expect(
      new SessionTokens(loadSessionTokenSecret(path)).verify(token),
    ).toEqual({ sessionId: 's', cwd: '/w' });
  });
});
