/**
 * A token bucket: holds at most `burst` tokens, refills `ratePerSecond` of
 * them a second, and each `take` spends one. Starts full.
 */
export class TokenBucket {
  private tokens: number;
  private refilledAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    now = Date.now(),
  ) {
    this.tokens = burst;
    this.refilledAt = now;
  }

  /** Spends one token; false when the bucket is empty. */
  take(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.refilledAt) / 1000;
    this.tokens = Math.min(
      this.burst,
      this.tokens + elapsed * this.ratePerSecond,
    );
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
