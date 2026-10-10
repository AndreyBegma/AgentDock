import {
  INBOUND_RATE_PER_HOUR,
  INBOUND_REFILL_INTERVAL_MS,
} from '@agentdock/shared';

/** A trigger's D6 bucket, as stored on its row. */
export interface TokenBucket {
  tokens: number;
  refilledAt: Date;
}

export type BucketTake =
  | { ok: true; bucket: TokenBucket }
  | { ok: false; bucket: TokenBucket };

/**
 * D6: the bucket at `now` — one token back per `INBOUND_REFILL_INTERVAL_MS`
 * since `refilledAt`, at most `INBOUND_RATE_PER_HOUR`. `refilledAt` moves by
 * whole intervals only, so a partial interval is not lost; a full bucket
 * restarts its clock at `now`.
 */
export const refill = (bucket: TokenBucket, now: Date): TokenBucket => {
  const elapsed = now.getTime() - bucket.refilledAt.getTime();
  if (elapsed <= 0) return bucket;
  const earned = Math.floor(elapsed / INBOUND_REFILL_INTERVAL_MS);
  const tokens = Math.min(INBOUND_RATE_PER_HOUR, bucket.tokens + earned);
  if (tokens >= INBOUND_RATE_PER_HOUR)
    return { tokens: INBOUND_RATE_PER_HOUR, refilledAt: now };
  return {
    tokens,
    refilledAt: new Date(
      bucket.refilledAt.getTime() + earned * INBOUND_REFILL_INTERVAL_MS,
    ),
  };
};

/** Refills, then takes one token; `ok: false` when none is left (429). */
export const take = (bucket: TokenBucket, now: Date): BucketTake => {
  const current = refill(bucket, now);
  if (current.tokens < 1) return { ok: false, bucket: current };
  return { ok: true, bucket: { ...current, tokens: current.tokens - 1 } };
};

/** A new trigger's bucket: full. */
export const fullBucket = (now: Date): TokenBucket => ({
  tokens: INBOUND_RATE_PER_HOUR,
  refilledAt: now,
});
