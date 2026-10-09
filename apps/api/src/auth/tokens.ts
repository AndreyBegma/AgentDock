import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const generateToken = (): string =>
  randomBytes(32).toString('base64url');

/** Only this hash is stored; the token itself lives in the cookie alone. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
