import { applyDecorators, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { getAuth } from './auth-request';

/** Calls one user may make to one runner-backed read route per window (C-119). */
export const RUNNER_READ_LIMIT = 120;
export const RUNNER_READ_WINDOW_MS = 60_000;

/**
 * Throttles a read route that sends a runner command (C-119): per signed-in
 * user, not per address, so users behind one proxy do not share a budget.
 * Over the limit the route answers 429; the service's own cache still keeps
 * the runner from seeing more than one command per window.
 */
export const RunnerReadThrottle = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    Throttle({
      default: {
        limit: RUNNER_READ_LIMIT,
        ttl: RUNNER_READ_WINDOW_MS,
        getTracker: (req) => {
          const auth = getAuth(req as Request);
          return auth ? `user:${auth.user.id}` : `ip:${(req as Request).ip}`;
        },
      },
    }),
    UseGuards(ThrottlerGuard),
  );
