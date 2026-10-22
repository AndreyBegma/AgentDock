import { createHash, createHmac, randomBytes } from 'node:crypto';
import { TOTP_DIGITS } from '@nautelle/shared';
import { safeEqual } from './tokens';

/** RFC 6238 defaults, the only ones every authenticator app supports. */
const STEP_SECONDS = 30;
/** RFC 4226 §4: at least 128 bits; 160 is what RFC 6238's SHA-1 vectors use. */
const SECRET_BYTES = 20;
/** One step either side, for a phone clock a little off (RFC 6238 §5.2). */
const DRIFT_STEPS = 1;
/** 80 random bits per recovery code, so its SHA-256 cannot be reversed by search. */
const RECOVERY_CODE_BYTES = 10;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (text: string): Buffer => {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

/** A new secret, base32 as authenticator apps take it. */
export const generateTotpSecret = (): string =>
  base32Encode(randomBytes(SECRET_BYTES));

/** The 30-second step `at` falls in. */
export const totpStep = (at: Date): number =>
  Math.floor(at.getTime() / 1000 / STEP_SECONDS);

/** The code of one step (RFC 4226 §5.3 dynamic truncation). */
export const totpCode = (secret: string, step: number): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
};

/** Whether `code` looks like a TOTP code rather than a recovery code. */
export const isTotpCode = (code: string): boolean =>
  new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code);

/**
 * The step `code` belongs to, within the allowed drift of `at`, or null. Only
 * a step after `lastStep` counts, so an accepted code can never be replayed.
 */
export const matchTotpStep = (
  secret: string,
  code: string,
  at: Date,
  lastStep: number | null,
): number | null => {
  if (!isTotpCode(code)) return null;
  const now = totpStep(at);
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step += 1) {
    if (lastStep !== null && step <= lastStep) continue;
    if (safeEqual(totpCode(secret, step), code)) return step;
  }
  return null;
};

/** What the QR code carries (Key Uri Format, as Google Authenticator reads it). */
export const otpauthUrl = (
  issuer: string,
  account: string,
  secret: string,
): string => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};

/** A recovery code as shown: 16 base32 characters in groups of four. */
export const generateRecoveryCode = (): string =>
  base32Encode(randomBytes(RECOVERY_CODE_BYTES)).match(/.{4}/g)?.join('-') ??
  '';

/** A recovery code as typed → its stored form: no dashes or spaces, upper case. */
export const normalizeRecoveryCode = (code: string): string =>
  code.replace(/[\s-]/g, '').toUpperCase();

export const hashRecoveryCode = (code: string): string =>
  createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
