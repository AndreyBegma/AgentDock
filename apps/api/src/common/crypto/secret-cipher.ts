import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** 32 random bytes, base64 — the key secrets at rest are sealed with. */
export const ENCRYPTION_KEY_ENV = 'APP_ENCRYPTION_KEY';

/** The only format written: `v1:<iv>:<tag>:<ciphertext>`, each part base64. */
export const SECRET_FORMAT_VERSION = 'v1';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Why the key cannot be used. Never carries the value itself. */
export type EncryptionKeyProblem = 'missing' | 'malformed';

export type EncryptionKeyParse =
  | { ok: true; key: Buffer }
  | { ok: false; problem: EncryptionKeyProblem };

/** `APP_ENCRYPTION_KEY` → the key; it must be base64 of exactly 32 bytes. */
export const parseEncryptionKey = (
  raw: string | undefined,
): EncryptionKeyParse => {
  const value = raw?.trim();
  if (!value) return { ok: false, problem: 'missing' };
  if (!BASE64.test(value)) return { ok: false, problem: 'malformed' };
  const key = Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) return { ok: false, problem: 'malformed' };
  return { ok: true, key };
};

/**
 * A secret could not be sealed or opened. The message is one of a few fixed
 * strings: it never contains the key, the plaintext or the ciphertext, so it
 * is safe to log and to return.
 */
export class SecretCipherError extends Error {
  constructor(
    readonly code:
      | 'key_unavailable'
      | 'malformed'
      | 'unsupported_version'
      | 'rejected',
  ) {
    super(MESSAGES[code]);
    this.name = 'SecretCipherError';
  }
}

const MESSAGES: Record<SecretCipherError['code'], string> = {
  key_unavailable: `${ENCRYPTION_KEY_ENV} is not configured`,
  malformed: 'the stored secret is not in the v1 format',
  unsupported_version: 'the stored secret has an unknown format version',
  rejected:
    'the stored secret failed authentication — wrong key or altered data',
};

/** A base64 part; `bytes` given: exactly that long, else possibly empty. */
const decodePart = (part: string | undefined, bytes?: number): Buffer => {
  if (
    part === undefined ||
    (bytes !== undefined && part.length === 0) ||
    !BASE64.test(part)
  ) {
    throw new SecretCipherError('malformed');
  }
  const buffer = Buffer.from(part, 'base64');
  if (bytes !== undefined && buffer.length !== bytes) {
    throw new SecretCipherError('malformed');
  }
  return buffer;
};

/**
 * AES-256-GCM sealing of secrets stored by AgentDock (spec 22 D8,
 * security.md "Secrets at rest"). Each value gets a fresh random IV; the GCM
 * tag makes any change to the stored string fail to open. Without a usable key
 * `available` is false and every call throws `key_unavailable` — the features
 * that need it refuse to start rather than store a secret in the clear.
 */
export class SecretCipher {
  private constructor(
    private readonly key: Buffer | null,
    /** Why there is no key; null when there is one. */
    readonly problem: EncryptionKeyProblem | null,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SecretCipher {
    return SecretCipher.fromKeyText(env[ENCRYPTION_KEY_ENV]);
  }

  static fromKeyText(raw: string | undefined): SecretCipher {
    const parsed = parseEncryptionKey(raw);
    return parsed.ok
      ? new SecretCipher(parsed.key, null)
      : new SecretCipher(null, parsed.problem);
  }

  get available(): boolean {
    return this.key !== null;
  }

  /** Whether `value` looks like something `encrypt` wrote. */
  static isSealed(value: string): boolean {
    return value.startsWith(`${SECRET_FORMAT_VERSION}:`);
  }

  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_BYTES,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return [
      SECRET_FORMAT_VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(sealed: string): string {
    const key = this.requireKey();
    const parts = sealed.split(':');
    if (parts.length !== 4) throw new SecretCipherError('malformed');
    const [version, ivPart, tagPart, ctPart] = parts;
    if (version !== SECRET_FORMAT_VERSION) {
      throw new SecretCipherError('unsupported_version');
    }
    const iv = decodePart(ivPart, IV_BYTES);
    const tag = decodePart(tagPart, TAG_BYTES);
    const ciphertext = decodePart(ctPart);
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // OpenSSL's message says nothing secret, but a fixed one is certain not to.
      throw new SecretCipherError('rejected');
    }
  }

  private requireKey(): Buffer {
    if (!this.key) throw new SecretCipherError('key_unavailable');
    return this.key;
  }
}
