import { effectiveProjectRole, type Role } from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth';
import { PrismaService } from '../database/prisma.service';

/** What the caller may do on one project. */
export interface ResolvedProjectAccess {
  projectId: string;
  /** The caller's effective role on the project (spec 10 D11). */
  role: Role;
}

/**
 * The project authorization rule (spec 10 D11, D12): admins see every project
 * as admin; anyone else sees a project only through a `project_members` row,
 * with `min(global role, override)`. Used by `ProjectAccessGuard`, by the
 * `project:` live topic, and by #11–#13.
 */
@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's access to `projectId`; null when it does not exist or they cannot see it. */
  async resolve(
    user: Pick<AuthUser, 'id' | 'role'>,
    projectId: string,
  ): Promise<ResolvedProjectAccess | null> {
    if (user.role === 'admin') {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      return project ? { projectId, role: 'admin' } : null;
    }
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
      select: { roleOverride: true },
    });
    if (!member) return null;
    return {
      projectId,
      role: effectiveProjectRole(user.role, member.roleOverride),
    };
  }

  /** A `where` on `Project` that keeps only the projects `user` can see. */
  visibleWhere(user: Pick<AuthUser, 'id' | 'role'>): Prisma.ProjectWhereInput {
    return user.role === 'admin'
      ? {}
      : { members: { some: { userId: user.id } } };
  }
}
