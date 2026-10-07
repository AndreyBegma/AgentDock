import { AUTH_ERROR, type Role } from '@agentdock/shared';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { authError } from '../auth-error';
import { getAuth } from '../auth-request';
import { ROLES_KEY } from '../decorators';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!roles || roles.length === 0) return true;

    const auth = getAuth(context.switchToHttp().getRequest<Request>());
    if (!auth || !roles.includes(auth.user.role)) {
      throw authError(403, AUTH_ERROR.forbidden, 'Insufficient role');
    }
    return true;
  }
}
