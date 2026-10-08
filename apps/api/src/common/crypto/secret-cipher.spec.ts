import { randomBytes } from 'node:crypto';
import {
  ENCRYPTION_KEY_ENV,
  parseEncryptionKey,
  SecretCipher,
  SecretCipherError,
} from './secret-cipher';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const SECRET = '123456789:AAH-bot-token-of-a-telegram-bot';

/** Every message an error could surface, to check none leaks a secret. */
const thrown = (fn: () => unknown): SecretCipherError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SecretCipherError) return error;
    throw error;
  }
  throw new Error('expected a SecretCipherError');
};

/** Flips one base64 character of part `index` of a sealed value. */
const tamper = (sealed: string, index: number): string => {
  const parts = sealed.split(':');
  const part = parts[index];
  const swap = part[0] === 'A' ? 'B' : 'A';
  parts[index] = swap + part.slice(1);
  return parts.join(':');
};

describe('parseEncryptionKey', () => {
  it('accepts base64 of exactly 32 bytes', () => {
    expect(parseEncryptionKey(KEY).ok).toBe(true);
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['   ', 'missing'],
    [randomBytes(16).toString('base64'), 'malformed'],
    [randomBytes(33).toString('base64'), 'malformed'],
    ['not base64 at all!', 'malformed'],
  ])('refuses %p as %s', (raw, problem) => {
    expect(parseEncryptionKey(raw)).toEqual({ ok: false, problem });
  });
});

describe('SecretCipher', () => {
  const cipher = SecretCipher.fromKeyText(KEY);

  it('round-trips a secret through the v1 format', () => {
    const sealed = cipher.encrypt(SECRET);
    expect(sealed).toMatch(
      /^v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/,
    );
    expect(sealed).not.toContain(SECRET);
    expect(cipher.decrypt(sealed)).toBe(SECRET);
    expect(SecretCipher.isSealed(sealed)).toBe(true);
  });

  it('uses a fresh IV for every value', () => {
    expect(cipher.encrypt(SECRET)).not.toBe(cipher.encrypt(SECRET));
  });

  it('round-trips non-ASCII text and the empty string', () => {
    expect(cipher.decrypt(cipher.encrypt('пароль ✓'))).toBe('пароль ✓');
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
  });

  it.each([
    [1, 'the IV'],
    [2, 'the tag'],
    [3, 'the ciphertext'],
  ])('refuses a value whose %s part (%s) was altered', (index) => {
    const sealed = cipher.encrypt(SECRET);
    const error = thrown(() => cipher.decrypt(tamper(sealed, index)));
    expect(['rejected', 'malformed']).toContain(error.code);
  });

  it('refuses a value sealed with another key', () => {
    const sealed = SecretCipher.fromKeyText(OTHER_KEY).encrypt(SECRET);
    expect(thrown(() => cipher.decrypt(sealed)).code).toBe('rejected');
  });

  it('refuses malformed values and unknown versions', () => {
    const sealed = cipher.encrypt(SECRET);
    expect(thrown(() => cipher.decrypt(SECRET)).code).toBe('malformed');
    expect(thrown(() => cipher.decrypt('v1:a:b')).code).toBe('malformed');
    expect(thrown(() => cipher.decrypt(`v2${sealed.slice(2)}`)).code).toBe(
      'unsupported_version',
    );
  });

  it('is unavailable without a key and refuses both directions', () => {
    const none = SecretCipher.fromEnv({});
    expect(none.available).toBe(false);
    expect(none.problem).toBe('missing');
    expect(thrown(() => none.encrypt(SECRET)).code).toBe('key_unavailable');
    expect(thrown(() => none.decrypt('v1:a:b:c')).code).toBe('key_unavailable');
  });

  it('reads the key from APP_ENCRYPTION_KEY', () => {
    const fromEnv = SecretCipher.fromEnv({ [ENCRYPTION_KEY_ENV]: KEY });
    expect(fromEnv.available).toBe(true);
    expect(fromEnv.decrypt(cipher.encrypt(SECRET))).toBe(SECRET);
  });

  it('never puts the key, the plaintext or the ciphertext in an error', () => {
    const sealed = cipher.encrypt(SECRET);
    const errors = [
      thrown(() => cipher.decrypt(tamper(sealed, 3))),
      thrown(() => SecretCipher.fromKeyText(OTHER_KEY).decrypt(sealed)),
      thrown(() => cipher.decrypt(SECRET)),
      thrown(() => SecretCipher.fromKeyText(undefined).encrypt(SECRET)),
    ];
    const [, iv, tag, ct] = sealed.split(':');
    for (const error of errors) {
      const text = `${error.message} ${error.stack ?? ''}`;
      for (const secret of [KEY, OTHER_KEY, SECRET, iv, tag, ct]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
