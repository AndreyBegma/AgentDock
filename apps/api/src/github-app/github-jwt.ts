import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

/**
 * The App JWT (D4): RS256, signed with `node:crypto` — no new dependency. Nine
 * minutes of life (GitHub allows ten), issued 60 s in the past against clock
 * drift, as GitHub recommends.
 */
export const APP_JWT_LIFETIME_SEC = 9 * 60;
const CLOCK_DRIFT_SEC = 60;

const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url');

/** The PEM as a key, or null when it is not an RSA private key. Never logs it. */
export const parseAppPrivateKey = (pem: string): KeyObject | null => {
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' });
    return key.asymmetricKeyType === 'rsa' ? key : null;
  } catch {
    return null;
  }
};

export const signAppJwt = (
  appId: number,
  key: KeyObject,
  now: Date = new Date(),
): string => {
  const iat = Math.floor(now.getTime() / 1000) - CLOCK_DRIFT_SEC;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iat,
      exp: iat + CLOCK_DRIFT_SEC + APP_JWT_LIFETIME_SEC,
      iss: String(appId),
    }),
  );
  const input = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(input).sign(key);
  return `${input}.${base64url(signature)}`;
};
