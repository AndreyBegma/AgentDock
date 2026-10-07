import {
  effectiveProjectRole,
  type ProjectMemberView,
  type Role,
} from '@agentdock/shared';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuditContext } from '../audit/audit.types';
import { PrismaService } from '../database/prisma.service';
import { projectError } from './project-error';
import { toMemberView } from './project-mapper';

const withUser = {
  user: { select: { email: true, name: true, role: true } },
} as const;

/** Admins bypass membership (D12), so a member row never lowers an admin. */
const roleOf = (globalRole: Role, override: Role | null): Role =>
  globalRole === 'admin' ? 'admin' : effectiveProjectRole(globalRole, override);

const memberNotFound = () => projectError(404, 'not_found', 'Member not found');

/** Spec 10 D11: who may see a project, and with which override. */
@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(projectId: string): Promise<ProjectMemberView[]> {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      include: withUser,
    });
    return members.map((m) =>
      toMemberView(m, roleOf(m.user.role, m.roleOverride)),
    );
  }

  async add(
    projectId: string,
    userId: string,
    roleOverride: Role | null,
    adminId: string,
    ctx: AuditContext,
  ): Promise<ProjectMemberView> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user) throw projectError(422, 'user_not_found', 'User not found');
    if (user.status !== 'active') {
      throw projectError(
        422,
        'user_not_active',
        'Only active users can be added to a project',
      );
    }
    let member: Awaited<ReturnType<typeof this.create>>;
    try {
      member = await this.create(projectId, userId, roleOverride, adminId);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw projectError(
          409,
          'already_member',
          'The user is already a member of this project',
        );
      }
      throw error;
    }
    await this.audit.record({
      ...ctx,
      action: 'project.member_add',
      target: { type: 'user', id: userId },
      projectId,
      after: { userId, roleOverride },
      result: 'ok',
    });
    return toMemberView(member, roleOf(member.user.role, member.roleOverride));
  }

  async update(
    projectId: string,
    userId: string,
    roleOverride: Role | null,
    ctx: AuditContext,
  ): Promise<ProjectMemberView> {
    const where = { projectId_userId: { projectId, userId } };
    const before = await this.prisma.projectMember.findUnique({ where });
    if (!before) throw memberNotFound();
    const member = await this.prisma.projectMember.update({
      where,
      data: { roleOverride },
      include: withUser,
    });
    if (before.roleOverride !== roleOverride) {
      await this.audit.record({
        ...ctx,
        action: 'project.member_update',
        target: { type: 'user', id: userId },
        projectId,
        before: { roleOverride: before.roleOverride },
        after: { roleOverride },
        result: 'ok',
      });
    }
    return toMemberView(member, roleOf(member.user.role, member.roleOverride));
  }

  async remove(
    projectId: string,
    userId: string,
    ctx: AuditContext,
  ): Promise<void> {
    const where = { projectId_userId: { projectId, userId } };
    const before = await this.prisma.projectMember.findUnique({ where });
    if (!before) throw memberNotFound();
    await this.prisma.projectMember.deleteMany({
      where: { projectId, userId },
    });
    await this.audit.record({
      ...ctx,
      action: 'project.member_remove',
      target: { type: 'user', id: userId },
      projectId,
      before: { userId, roleOverride: before.roleOverride },
      result: 'ok',
    });
  }

  private create(
    projectId: string,
    userId: string,
    roleOverride: Role | null,
    adminId: string,
  ) {
    return this.prisma.projectMember.create({
      data: { projectId, userId, roleOverride, addedById: adminId },
      include: withUser,
    });
  }
}
