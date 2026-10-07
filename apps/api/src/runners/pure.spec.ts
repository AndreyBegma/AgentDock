import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_PATTERN,
} from '@agentdock/shared/protocol';
import { advanceCursor } from './ack-cursor';
import {
  bearerToken,
  generatePairingCode,
  generateRunnerToken,
  hashPairingCode,
  hashRunnerToken,
  normalizePairingCode,
  tokenPrefix,
  verifyRunnerToken,
} from './credentials';
import { deriveStatus } from './status';

const r = (from: number, to = from) => [BigInt(from), BigInt(to)] as const;

describe('advanceCursor', () => {
  it('stays at 0 with nothing stored', () => {
    expect(advanceCursor(0n, [])).toBe(0n);
  });

  it('advances over a contiguous run', () => {
    expect(advanceCursor(0n, [r(1), r(2), r(3)])).toBe(3n);
  });

  it('stops below a hole', () => {
    expect(advanceCursor(0n, [r(1), r(2), r(4), r(5)])).toBe(2n);
    expect(advanceCursor(5n, [r(7)])).toBe(5n);
  });

  it('ignores order and duplicates', () => {
    expect(advanceCursor(0n, [r(3), r(1), r(2), r(2)])).toBe(3n);
  });

  it('counts a spool_truncated range as filled', () => {
    // 1..9120 were dropped from the spool; 9121.. resent; 9125 reports the loss.
    const stored = [r(9121), r(9122), r(9123), r(9124), r(9125)];
    expect(advanceCursor(0n, stored)).toBe(0n);
    expect(advanceCursor(0n, [...stored, r(1, 9120)])).toBe(9125n);
  });

  it('accepts a truncated range that overlaps the cursor', () => {
    expect(advanceCursor(50n, [r(10, 60), r(61)])).toBe(61n);
  });

  it('never moves backwards', () => {
    expect(advanceCursor(10n, [r(1), r(2)])).toBe(10n);
  });
});

describe('credentials', () => {
  it('generates XXXX-XXXX codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generatePairingCode();
      expect(code).toMatch(PAIRING_CODE_PATTERN);
      for (const ch of code.replace('-', '')) {
        expect(PAIRING_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('normalises a typed-in code and rejects garbage', () => {
    expect(normalizePairingCode('  abcd-efgh ')).toBe('ABCD-EFGH');
    expect(normalizePairingCode('ABCD-EFG0')).toBeNull();
    expect(normalizePairingCode('ABCDEFGH')).toBeNull();
  });

  it('hashes codes deterministically without containing them', () => {
    const hashed = hashPairingCode('ABCD-EFGH');
    expect(hashed).toBe(hashPairingCode('ABCD-EFGH'));
    expect(hashed).not.toContain('ABCD');
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates 43-character base64url tokens with an 8-character prefix', () => {
    const token = generateRunnerToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenPrefix(token)).toBe(token.slice(0, 8));
    expect(generateRunnerToken()).not.toBe(token);
  });

  it('verifies a token against its argon2id hash only', async () => {
    const token = generateRunnerToken();
    const hashed = await hashRunnerToken(token);
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(hashed).not.toContain(token);
    await expect(verifyRunnerToken(hashed, token)).resolves.toBe(true);
    await expect(
      verifyRunnerToken(hashed, generateRunnerToken()),
    ).resolves.toBe(false);
    await expect(verifyRunnerToken('not-a-hash', token)).resolves.toBe(false);
  });

  it('reads a bearer token and nothing else', () => {
    const token = generateRunnerToken();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken(token)).toBeNull();
    expect(bearerToken('Bearer short')).toBeNull();
    expect(bearerToken(`Basic ${token}`)).toBeNull();
  });
});

describe('deriveStatus', () => {
  const now = 1_000_000;
  const stale = 45_000;

  it('is revoked whatever the socket says', () => {
    expect(
      deriveStatus({ revokedAt: new Date(), lastBeatAt: now }, now, stale),
    ).toBe('revoked');
  });

  it('is offline without a socket', () => {
    expect(deriveStatus({ revokedAt: null, lastBeatAt: null }, now, stale)).toBe(
      'offline',
    );
  });

  it('is online under 45 s since the last beat and stale from 45 s', () => {
    const at = (ago: number) =>
      deriveStatus({ revokedAt: null, lastBeatAt: now - ago }, now, stale);
    expect(at(0)).toBe('online');
    expect(at(44_999)).toBe('online');
    expect(at(45_000)).toBe('stale');
  });
});
