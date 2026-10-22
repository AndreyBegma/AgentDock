import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotpStep,
  otpauthUrl,
  totpCode,
  totpStep,
} from './totp';

// RFC 6238 Appendix B, SHA-1: the ASCII key "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC 6238 vector at %i s', (seconds, code) => {
    expect(totpCode(RFC_SECRET, totpStep(new Date(seconds * 1000)))).toBe(code);
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('makes a 160-bit secret', () => {
    expect(base32Decode(generateTotpSecret())).toHaveLength(20);
  });

  describe('matchTotpStep', () => {
    const at = new Date(1111111111 * 1000);
    const now = totpStep(at);

    it('accepts the current step and one either side', () => {
      for (const step of [now - 1, now, now + 1]) {
        expect(
          matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, step), at, null),
        ).toBe(step);
      }
    });

    it('refuses a code two steps away', () => {
      expect(
        matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, now - 2), at, null),
      ).toBeNull();
    });

    it('refuses a step already used, or one before it', () => {
      const code = totpCode(RFC_SECRET, now);
      expect(matchTotpStep(RFC_SECRET, code, at, now)).toBeNull();
      expect(
        matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, now - 1), at, now),
      ).toBeNull();
      expect(
        matchTotpStep(RFC_SECRET, totpCode(RFC_SECRET, now + 1), at, now),
      ).toBe(now + 1);
    });

    it('refuses anything that is not six digits', () => {
      expect(matchTotpStep(RFC_SECRET, '05047', at, null)).toBeNull();
      expect(matchTotpStep(RFC_SECRET, 'abcdef', at, null)).toBeNull();
    });
  });

  it('builds an otpauth URL authenticator apps read', () => {
    const url = new URL(otpauthUrl('Nautelle', 'a@example.com', 'ABC'));
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe('/Nautelle:a@example.com');
    expect(url.searchParams.get('secret')).toBe('ABC');
    expect(url.searchParams.get('issuer')).toBe('Nautelle');
  });

  describe('recovery codes', () => {
    it('are four groups of four base32 characters', () => {
      expect(generateRecoveryCode()).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    });

    it('hash the same however they are typed', () => {
      expect(hashRecoveryCode('abcd-efgh-ijkl-mnop')).toBe(
        hashRecoveryCode(' ABCD EFGH IJKL MNOP '),
      );
      expect(hashRecoveryCode('ABCD-EFGH-IJKL-MNOP')).not.toBe(
        hashRecoveryCode('ABCD-EFGH-IJKL-MNOQ'),
      );
    });
  });
});
