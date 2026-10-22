import { AUTH_ERROR, SESSION_COOKIE } from '@nautelle/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { authError } from '../auth-error';
import type { AuthenticatedRequest } from '../auth-request';
import { IS_PUBLIC_KEY, TWO_FACTOR_SETUP_KEY } from '../decorators';
import { SessionService } from '../session.service';
import { TwoFactorService } from '../two-factor.service';

/**
 * Global: every route needs an active session unless it is `@Public()`. An
 * admin without the two-factor sign-in the instance requires (C-189) gets only
 * the routes marked `@AllowedBeforeTwoFactorSetup()`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const cookies = request.cookies as Record<string, string | undefined>;
    const token = cookies[SESSION_COOKIE];
    const auth = token ? await this.sessions.resolve(token) : null;
    if (!auth) {
      throw authError(401, AUTH_ERROR.unauthenticated, 'Not signed in');
    }
    (request as AuthenticatedRequest).auth = auth;

    if (
      !auth.user.twoFactorEnabled &&
      !this.reflector.getAllAndOverride<boolean>(TWO_FACTOR_SETUP_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) &&
      (await this.twoFactor.requiredFor(auth.user))
    ) {
      throw authError(
        403,
        AUTH_ERROR.twoFactorSetupRequired,
        'Set up two-factor sign-in under Account first: this server requires it for administrators',
      );
    }
    return true;
  }
}
