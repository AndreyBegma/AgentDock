import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * GitHub webhook signatures (docs/specs/27-github-app.md D5, D6):
 * `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(webhook secret, raw body)>`.
 * Not #26's scheme — no timestamp, no delivery id in the MAC.
 */

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

/** The header GitHub would send for `rawBody` signed with `secret`. */
export const signGitHubDelivery = (
  secret: string,
  rawBody: Buffer | string,
): string =>
  `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

/** D6: constant-time check of the presented header against the stored secret. */
export const verifyGitHubSignature = (
  header: string | undefined,
  rawBody: Buffer,
  secret: string,
): boolean => {
  if (!header) return false;
  const match = SIGNATURE.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1].toLowerCase(), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
};
