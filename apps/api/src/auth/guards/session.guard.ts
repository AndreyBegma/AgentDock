import { AUTH_ERROR, SESSION_COOKIE } from '@agentdock/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { authError } from '../auth-error';
import type { AuthenticatedRequest } from '../auth-request';
import { IS_PUBLIC_KEY } from '../decorators';
import { SessionService } from '../session.service';

/** Global: every route needs an active session unless it is `@Public()`. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
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
    return true;
  }
}
