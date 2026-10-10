import {
  INBOUND_RATE_PER_HOUR,
  INBOUND_REFILL_INTERVAL_MS,
} from '@agentdock/shared';
import { fullBucket, refill, type TokenBucket, take } from './token-bucket';

const t0 = new Date('2026-10-09T12:00:00Z');
const plus = (ms: number) => new Date(t0.getTime() + ms);

describe('token bucket (spec 26 D6)', () => {
  it('lets 30 through in one hour and refuses the 31st', () => {
    let bucket: TokenBucket = fullBucket(t0);
    for (let i = 0; i < INBOUND_RATE_PER_HOUR; i += 1) {
      const result = take(bucket, plus(i * 1000));
      expect(result.ok).toBe(true);
      bucket = result.bucket;
    }
    expect(take(bucket, plus(INBOUND_RATE_PER_HOUR * 1000)).ok).toBe(false);
  });

  it('gives one token back per refill interval, keeping the partial interval', () => {
    const empty = { tokens: 0, refilledAt: t0 };
    expect(take(empty, plus(INBOUND_REFILL_INTERVAL_MS - 1)).ok).toBe(false);
    const later = refill(empty, plus(INBOUND_REFILL_INTERVAL_MS * 2.5));
    expect(later.tokens).toBe(2);
    expect(later.refilledAt).toEqual(plus(INBOUND_REFILL_INTERVAL_MS * 2));
  });

  it('never holds more than the hourly rate', () => {
    const bucket = refill({ tokens: 29, refilledAt: t0 }, plus(86_400_000));
    expect(bucket).toEqual({
      tokens: INBOUND_RATE_PER_HOUR,
      refilledAt: plus(86_400_000),
    });
  });

  it('ignores a clock that went backwards', () => {
    const bucket = { tokens: 3, refilledAt: t0 };
    expect(refill(bucket, plus(-60_000))).toBe(bucket);
  });
});
