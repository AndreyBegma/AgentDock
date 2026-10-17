import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';

export const HOOK_FAILURE_LIMIT = 10;
export const HOOK_FAILURE_WINDOW_MS = 60_000;
/** An unsigned, badly signed or unknown-trigger delivery: 401, or 404 for an unknown or disabled trigger. */
const REFUSED = new Set([401, 404]);
/** Above this many tracked clients, expired entries are swept on the next hit. */
const SWEEP_AT = 10_000;

interface Bucket {
  failures: number;
  resetAt: number;
}

/** The per-address refusal counts behind `HookFailureThrottleGuard`: one per process, shared by both public hook routes. */
export class HookFailureThrottle {
  private static readonly buckets = new Map<string, Bucket>();

  blocked(key: string, now: number): boolean {
    const bucket = HookFailureThrottle.buckets.get(key);
    return (
      bucket !== undefined &&
      bucket.resetAt > now &&
      bucket.failures >= HOOK_FAILURE_LIMIT
    );
  }

  reset(): void {
    HookFailureThrottle.buckets.clear();
  }

  fail(key: string, now: number): void {
    if (HookFailureThrottle.buckets.size >= SWEEP_AT) this.sweep(now);
    const bucket = HookFailureThrottle.buckets.get(key);
    if (bucket && bucket.resetAt > now) bucket.failures += 1;
    else
      HookFailureThrottle.buckets.set(key, {
        failures: 1,
        resetAt: now + HOOK_FAILURE_WINDOW_MS,
      });
  }

  private sweep(now: number): void {
    for (const [key, bucket] of HookFailureThrottle.buckets)
      if (bucket.resetAt <= now) HookFailureThrottle.buckets.delete(key);
  }
}

/**
 * Pre-signature rate limit for the public `/hooks/*` routes (C-116): a client
 * address gets `HOOK_FAILURE_LIMIT` refused deliveries (401, 404) per window,
 * then 429 until the window ends. Only 401 and 404 count: accepted deliveries, so
 * GitHub or a CI behind one address is unaffected. In memory, per process; the
 * address is `req.ip`, which follows `TRUST_PROXY`.
 */
@Injectable()
export class HookFailureThrottleGuard implements CanActivate {
  private readonly throttle = new HookFailureThrottle();

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const key = req.ip ?? 'unknown';
    if (this.throttle.blocked(key, Date.now())) throw new ThrottlerException();
    res.on('finish', () => {
      if (REFUSED.has(res.statusCode)) this.throttle.fail(key, Date.now());
    });
    return true;
  }
}
