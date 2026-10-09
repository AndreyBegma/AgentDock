import { AUTH_ERROR, CSRF_HEADER, SESSION_COOKIE } from '@agentdock/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { authError } from '../auth-error';
import { IS_PUBLIC_KEY } from '../decorators';
import { csrfTokenFor } from '../session.service';
import { safeEqual } from '../tokens';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF check (spec D7). On session routes a state-changing
 * request must send, in `X-CSRF-Token`, the value of the `ad_csrf` cookie —
 * which is derived from the session token, so it is checked against that
 * rather than against a cookie an attacker might plant. Public routes have no
 * session, but a state-changing request must be JSON: a cross-site form cannot
 * send that without a CORS preflight.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      if (!request.is('application/json')) {
        throw authError(
          415,
          AUTH_ERROR.unsupportedMediaType,
          'Content-Type must be application/json',
        );
      }
      return true;
    }

    const cookies = request.cookies as Record<string, string | undefined>;
    const sessionToken = cookies[SESSION_COOKIE];
    const header = request.get(CSRF_HEADER);
    if (
      !sessionToken ||
      !header ||
      !safeEqual(header, csrfTokenFor(sessionToken))
    ) {
      throw authError(
        403,
        AUTH_ERROR.csrfFailed,
        'CSRF token missing or invalid',
      );
    }
    return true;
  }
}
