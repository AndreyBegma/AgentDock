import { randomBytes, randomInt } from 'node:crypto';
import {
  TRIGGER_PUBLIC_ID_LENGTH,
  WEBHOOK_SECRET_BYTES,
  WEBHOOKS_ERROR,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { SecretCipher } from '../../common/crypto';
import { webhooksError } from './webhooks-error';

const PUBLIC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** D1: 24 characters of `[A-Za-z0-9]`, uniformly random (~143 bits). */
export const newTriggerPublicId = (): string => {
  let id = '';
  for (let i = 0; i < TRIGGER_PUBLIC_ID_LENGTH; i += 1)
    id += PUBLIC_ID_ALPHABET[randomInt(PUBLIC_ID_ALPHABET.length)];
  return id;
};

/** D17: 32 random bytes, base64url — the text shown once and used as the HMAC key. */
export const newWebhookSecret = (): string =>
  randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url');

/** A freshly issued secret: the plaintext to show once, the ciphertext to store. */
export interface IssuedSecret {
  secret: string;
  sealed: string;
}

/**
 * Trigger and webhook secrets at rest (D17): sealed with #22's `SecretCipher`
 * (AES-256-GCM, `APP_ENCRYPTION_KEY`). The plaintext leaves this class only
 * in `issue()`'s result — the one response that shows it — and in `open()`,
 * for signing and verifying.
 */
@Injectable()
export class WebhookSecrets {
  constructor(private readonly cipher: SecretCipher) {}

  get available(): boolean {
    return this.cipher.available;
  }

  /** A new secret. 409 `encryption_key_missing` without a usable key (#22). */
  issue(): IssuedSecret {
    if (!this.cipher.available) {
      throw webhooksError(
        409,
        WEBHOOKS_ERROR.encryptionKeyMissing,
        'APP_ENCRYPTION_KEY is not set; secrets cannot be stored',
      );
    }
    const secret = newWebhookSecret();
    return { secret, sealed: this.cipher.encrypt(secret) };
  }

  /** The plaintext of a stored secret. Throws `SecretCipherError`; never logs it. */
  open(sealed: string): string {
    return this.cipher.decrypt(sealed);
  }
}
