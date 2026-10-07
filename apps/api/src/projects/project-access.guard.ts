import { projectRoleAtLeast, type Role } from '@agentdock/shared';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { authError } from '../auth';
import { getAuth } from '../auth/auth-request';
import {
  ProjectAccessService,
  type ResolvedProjectAccess,
} from './project-access.service';
import { projectError, projectNotFound } from './project-error';

export const PROJECT_ROLE_KEY = 'projects:min-role';

/**
 * The lowest effective project role a route needs (spec 10 D12). Without it,
 * `ProjectAccessGuard` lets any member through (viewer).
 */
export const ProjectRole = (role: Role) => SetMetadata(PROJECT_ROLE_KEY, role);

interface ProjectRequest extends Request {
  projectAccess?: ResolvedProjectAccess;
}

/**
 * Authorizes `:projectId` routes (spec 10 D11, D12). A project the caller
 * cannot see is 404, never 403, so its existence is not revealed; a visible
 * one below the route's `@ProjectRole` is 403. Runs after the global session
 * and role guards, so the caller is signed in.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ProjectAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProjectRequest>();
    const auth = getAuth(request);
    if (!auth) throw authError(401, 'unauthenticated', 'Not signed in');
    const projectId = request.params.projectId;
    if (typeof projectId !== 'string' || projectId === '') {
      throw new Error('ProjectAccessGuard needs a :projectId route param');
    }
    const minRole =
      this.reflector.getAllAndOverride<Role | undefined>(PROJECT_ROLE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'viewer';

    const access = await this.access.resolve(auth.user, projectId);
    if (!access) throw projectNotFound();
    if (!projectRoleAtLeast(access.role, minRole)) {
      throw projectError(
        403,
        'forbidden',
        `This needs the ${minRole} role on the project`,
      );
    }
    request.projectAccess = access;
    return true;
  }
}

/** The caller's access, as `ProjectAccessGuard` resolved it. */
export const ProjectAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResolvedProjectAccess => {
    const access = context
      .switchToHttp()
      .getRequest<ProjectRequest>().projectAccess;
    if (!access) {
      throw new Error('@ProjectAccess needs ProjectAccessGuard');
    }
    return access;
  },
);
