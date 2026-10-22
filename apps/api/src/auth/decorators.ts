import type { Role } from '@nautelle/shared';
import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AuthenticatedRequest, AuthUser } from './auth-request';

export const IS_PUBLIC_KEY = 'auth:public';
export const ROLES_KEY = 'auth:roles';
export const TWO_FACTOR_SETUP_KEY = 'auth:two-factor-setup';

/** Opts a route (or controller) out of the global `SessionGuard`. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * C-189: open to an admin who still has to set up the two-factor sign-in the
 * instance requires; every other route refuses them until they have.
 */
export const AllowedBeforeTwoFactorSetup = () =>
  SetMetadata(TWO_FACTOR_SETUP_KEY, true);

/** Restricts a route (or controller) to callers holding one of these roles. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** The authenticated caller. Only valid on routes behind `SessionGuard`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().auth.user,
);
