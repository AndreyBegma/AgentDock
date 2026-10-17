import { Injectable } from '@nestjs/common';

export const SIGNATURE_FAILURE_THRESHOLD = 20;
export const SIGNATURE_FAILURE_WINDOW_MS = 10 * 60_000;
const BUCKET_MS = 60_000;

export interface SignatureFailureSnapshot {
  /** Failures inside the window with no verified delivery since. */
  recent: number;
  lastAt: Date | null;
}

/**
 * C-116: refused `/hooks/github` deliveries, counted in memory in one-minute
 * buckets. A verified delivery clears them. The App row gets at most one write
 * a minute (`takeUnflushed`); health reads the windowed count.
 */
@Injectable()
export class SignatureFailureTracker {
  private buckets = new Map<number, number>();
  private last: Date | null = null;
  private unflushed = 0;
  private flushedAt = 0;
  private logged = 0;
  private loggedAt = 0;

  record(now: Date): void {
    const bucket = Math.floor(now.getTime() / BUCKET_MS);
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
    this.last = now;
    this.unflushed += 1;
    this.logged += 1;
  }

  /** Forgets everything; for tests. */
  reset(): void {
    this.clear();
    this.unflushed = 0;
    this.flushedAt = 0;
    this.logged = 0;
    this.loggedAt = 0;
  }

  /** A verified delivery: earlier failures no longer count against health. */
  clear(): void {
    this.buckets.clear();
    this.last = null;
  }

  snapshot(
    now: Date,
    windowMs = SIGNATURE_FAILURE_WINDOW_MS,
  ): SignatureFailureSnapshot {
    const from = Math.floor((now.getTime() - windowMs) / BUCKET_MS);
    let recent = 0;
    for (const [bucket, count] of this.buckets) {
      if (bucket < from) this.buckets.delete(bucket);
      else recent += count;
    }
    return { recent, lastAt: this.last };
  }

  /** The failures to write now, or null: at most once a minute. */
  takeUnflushed(now: Date): { count: number; at: Date } | null {
    if (this.unflushed === 0 || now.getTime() - this.flushedAt < BUCKET_MS)
      return null;
    const taken = { count: this.unflushed, at: this.last ?? now };
    this.unflushed = 0;
    this.flushedAt = now.getTime();
    return taken;
  }

  /** The count to log now (one line a minute), or 0. */
  takeUnlogged(now: Date): number {
    if (this.logged === 0 || now.getTime() - this.loggedAt < BUCKET_MS)
      return 0;
    const count = this.logged;
    this.logged = 0;
    this.loggedAt = now.getTime();
    return count;
  }
}
