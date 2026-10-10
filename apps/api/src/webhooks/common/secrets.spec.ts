import { randomBytes } from 'node:crypto';
import { SecretCipher } from '../../common/crypto';
import {
  newTriggerPublicId,
  newWebhookSecret,
  WebhookSecrets,
} from './secrets';
import { WebhooksFailure } from './webhooks-error';

describe('newTriggerPublicId (D1)', () => {
  it('is 24 characters of [A-Za-z0-9], different every time', () => {
    const ids = new Set(Array.from({ length: 200 }, newTriggerPublicId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{24}$/);
  });
});

describe('newWebhookSecret (D17)', () => {
  it('is 32 random bytes as base64url', () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, 'base64url')).toHaveLength(32);
    expect(newWebhookSecret()).not.toBe(secret);
  });
});

describe('WebhookSecrets (D17)', () => {
  const secrets = new WebhookSecrets(
    SecretCipher.fromKeyText(randomBytes(32).toString('base64')),
  );

  it('stores ciphertext and opens it back', () => {
    const { secret, sealed } = secrets.issue();
    expect(SecretCipher.isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain(secret);
    expect(secrets.open(sealed)).toBe(secret);
  });

  it('refuses to issue without APP_ENCRYPTION_KEY: 409 encryption_key_missing', () => {
    const none = new WebhookSecrets(SecretCipher.fromEnv({}));
    expect(none.available).toBe(false);
    let thrown: unknown;
    try {
      none.issue();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WebhooksFailure);
    expect((thrown as WebhooksFailure).getStatus()).toBe(409);
    expect((thrown as WebhooksFailure).getResponse()).toMatchObject({
      error: 'encryption_key_missing',
    });
  });
});
