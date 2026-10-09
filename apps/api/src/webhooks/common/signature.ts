import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  INBOUND_DELIVERY_ID_MAX_CHARS,
  INBOUND_TIMESTAMP_TOLERANCE_SEC,
} from '@agentdock/shared';

/**
 * Webhook signatures (docs/specs/26-webhooks.md D2, D13). The HMAC key is the
 * secret exactly as shown to the admin (base64url text, used as UTF-8 bytes),
 * so a receiver needs no decoding step.
 */

const SIGNATURE_HEX = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{1,12}$/;
/** Visible ASCII, no spaces: what fits a header and a log line unescaped. */
const DELIVERY_ID = new RegExp(
  `^[\\x21-\\x7e]{1,${INBOUND_DELIVERY_ID_MAX_CHARS}}$`,
);

const hmac = (secret: string, ...parts: (string | Buffer)[]): Buffer => {
  const mac = createHmac('sha256', secret);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

/** Constant-time comparison of a presented hex digest with an expected one. */
const digestMatches = (presentedHex: string, expected: Buffer): boolean => {
  if (!SIGNATURE_HEX.test(presentedHex)) return false;
  const presented = Buffer.from(presentedHex, 'hex');
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
};

const withinTolerance = (
  unixSeconds: number,
  now: Date,
  toleranceSec: number,
) => Math.abs(Math.floor(now.getTime() / 1000) - unixSeconds) <= toleranceSec;

// ─── Inbound (D2) ───────────────────────────────────────────────────────────

/** Why an inbound delivery failed verification. Logged, never sent (D2: 401 with no detail). */
export type InboundSignatureFailure =
  | 'missing_header'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'bad_delivery_id'
  | 'bad_signature';

export type InboundSignatureVerdict =
  | { ok: true }
  | { ok: false; reason: InboundSignatureFailure };

export interface InboundSignatureInput {
  /** `X-AgentDock-Timestamp`. */
  timestamp: string | undefined;
  /** `X-AgentDock-Delivery`. */
  deliveryId: string | undefined;
  /** `X-AgentDock-Signature`. */
  signature: string | undefined;
  /** The body exactly as received, before any JSON parse (D8). */
  rawBody: Buffer;
  /**
   * The plaintext secrets that may have signed it: the current one, and the
   * previous one while its D17 grace period lasts. Each is tried.
   */
  secrets: readonly string[];
  now?: Date;
}

/** `sha256=<hex>` of `HMAC-SHA256(secret, "<timestamp>.<delivery>.<raw body>")`. */
export const signInbound = (
  secret: string,
  timestamp: string,
  deliveryId: string,
  rawBody: Buffer | string,
): string =>
  `sha256=${hmac(secret, `${timestamp}.${deliveryId}.`, rawBody).toString('hex')}`;

/**
 * D2: the headers are present and well-formed, the timestamp is within
 * ±5 minutes, and the signature matches one of `secrets` (constant time). The
 * replay check (`replayed`) is the caller's: it needs the nonce store.
 */
export const verifyInboundSignature = (
  input: InboundSignatureInput,
): InboundSignatureVerdict => {
  const { timestamp, deliveryId, signature, rawBody } = input;
  if (!timestamp || !deliveryId || !signature)
    return { ok: false, reason: 'missing_header' };
  if (!TIMESTAMP.test(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  if (
    !withinTolerance(
      Number(timestamp),
      input.now ?? new Date(),
      INBOUND_TIMESTAMP_TOLERANCE_SEC,
    )
  )
    return { ok: false, reason: 'stale_timestamp' };
  if (!DELIVERY_ID.test(deliveryId))
    return { ok: false, reason: 'bad_delivery_id' };
  if (!signature.startsWith('sha256='))
    return { ok: false, reason: 'bad_signature' };

  const presented = signature.slice('sha256='.length).toLowerCase();
  // Every secret is tried, so the time taken does not say which one matched.
  let matched = false;
  for (const secret of input.secrets) {
    const expected = hmac(secret, `${timestamp}.${deliveryId}.`, rawBody);
    if (digestMatches(presented, expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
};

// ─── Outbound (D13) ─────────────────────────────────────────────────────────

/**
 * `X-AgentDock-Signature` of an outbound delivery: `t=<unix>,v1=<hex>`, hex =
 * `HMAC-SHA256(secret, "<t>.<body>")`. Signed anew on every attempt.
 */
export const signOutbound = (
  secret: string,
  body: string | Buffer,
  now: Date = new Date(),
): string => {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${hmac(secret, `${t}.`, body).toString('hex')}`;
};

/**
 * The receiver's recipe for D13, as documented in security.md: parse `t` and
 * every `v1`, check `t` is recent, recompute and compare in constant time.
 */
export const verifyOutboundSignature = (
  header: string | undefined,
  body: string | Buffer,
  secret: string,
  options: { now?: Date; toleranceSec?: number } = {},
): boolean => {
  if (!header) return false;
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) return false;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') t = value;
    else if (key === 'v1') v1.push(value);
  }
  if (!t || !TIMESTAMP.test(t) || v1.length === 0) return false;
  if (
    !withinTolerance(
      Number(t),
      options.now ?? new Date(),
      options.toleranceSec ?? INBOUND_TIMESTAMP_TOLERANCE_SEC,
    )
  )
    return false;
  const expected = hmac(secret, `${t}.`, body);
  return v1.some((hex) => digestMatches(hex, expected));
};
