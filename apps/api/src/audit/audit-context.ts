import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { getAuth } from '../auth/auth-request';
import {
  ANONYMOUS_ACTOR,
  type AuditContext,
  type RequestOrigin,
  userActor,
} from './audit.types';

export const requestOrigin = (request: Request): RequestOrigin => ({
  ip: request.ip,
  userAgent: request.get('user-agent'),
});

export const auditContextOf = (request: Request): AuditContext => {
  const auth = getAuth(request);
  return {
    actor: auth ? userActor(auth.user.id) : ANONYMOUS_ACTOR,
    origin: requestOrigin(request),
  };
};

/**
 * The caller as the audit log names it: the signed-in user, else anonymous,
 * with the request's IP and user agent (spec D9).
 */
export const AuditCtx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuditContext =>
    auditContextOf(context.switchToHttp().getRequest<Request>()),
);
