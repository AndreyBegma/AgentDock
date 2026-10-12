import { createVerify, generateKeyPairSync } from 'node:crypto';
import {
  APP_JWT_LIFETIME_SEC,
  parseAppPrivateKey,
  signAppJwt,
} from './github-jwt';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('App JWT (spec 27 D4)', () => {
  it('parses an RSA PEM and refuses anything else', () => {
    expect(parseAppPrivateKey(PEM)).not.toBeNull();
    expect(parseAppPrivateKey('not a key')).toBeNull();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(parseAppPrivateKey(ec)).toBeNull();
  });

  it('is RS256, issued by the app id, back-dated 60 s and valid 9 minutes', () => {
    const key = parseAppPrivateKey(PEM);
    if (!key) throw new Error('key');
    const now = new Date('2026-10-10T12:00:00Z');
    const jwt = signAppJwt(4242, key, now);
    const [header, payload, signature] = jwt.split('.');
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const nowSec = now.getTime() / 1000;
    expect(decode(payload)).toEqual({
      iat: nowSec - 60,
      exp: nowSec + APP_JWT_LIFETIME_SEC,
      iss: '4242',
    });
    expect(APP_JWT_LIFETIME_SEC).toBeLessThanOrEqual(600);
    const valid = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(valid).toBe(true);
  });
});
