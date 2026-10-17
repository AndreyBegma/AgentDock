import { SecretCipher } from '../common/crypto';

/**
 * The master key provider keys are sealed with (ADR-0057 §3): 32 random
 * bytes, base64. Separate from `APP_ENCRYPTION_KEY`, so it can be rotated and
 * kept out of the backups of every other secret on its own.
 */
export const LLM_SECRETS_KEY_ENV = 'LLM_SECRETS_KEY';

/** AES-256-GCM with a random IV per value — `SecretCipher` on `LLM_SECRETS_KEY`. */
export class LlmSecrets {
  private constructor(readonly cipher: SecretCipher) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): LlmSecrets {
    return new LlmSecrets(SecretCipher.fromKeyText(env[LLM_SECRETS_KEY_ENV]));
  }

  get available(): boolean {
    return this.cipher.available;
  }

  get problem(): 'missing' | 'malformed' | null {
    return this.cipher.problem;
  }
}

/** Injection tokens of the gateway. */
export const LLM_ADAPTERS = Symbol('LLM_ADAPTERS');
export const LLM_CLOCK = Symbol('LLM_CLOCK');
export type LlmClock = () => Date;
