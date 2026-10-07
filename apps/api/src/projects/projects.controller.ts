import type {
  ProjectDetail,
  ProjectMemberView,
  ProjectSummary,
} from '@agentdock/shared';
import type { ProjectInspection } from '@agentdock/shared/protocol';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import type { AuthUser } from '../auth/auth-request';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AddProjectMemberDto,
  ConnectProjectDto,
  DocsSourceOverrideDto,
  InspectProjectDto,
  UpdateProjectDto,
  UpdateProjectMemberDto,
} from './dto';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
} from './project-access.guard';
import type { ResolvedProjectAccess } from './project-access.service';
import { ProjectMembersService } from './project-members.service';
import { ProjectsService } from './projects.service';

/** D1, D15: connecting and deleting projects is admin only. */
@Roles('admin')
@Controller('admin/projects')
export class AdminProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post('inspect')
  @HttpCode(200)
  inspect(
    @Body() dto: InspectProjectDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectInspection> {
    return this.projects.inspect(dto.runnerId, dto.path, ctx);
  }

  @Post()
  connect(
    @Body() dto: ConnectProjectDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectDetail> {
    return this.projects.connect(
      dto.runnerId,
      dto.path,
      dto.displayName,
      admin.id,
      ctx,
    );
  }

  @Delete(':projectId')
  @HttpCode(204)
  remove(
    @Param('projectId') projectId: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.projects.remove(projectId, ctx);
  }
}

/**
 * Project-scoped routes (spec 10 "API"). Admin-only writes carry `@Roles`,
 * which the global role guard checks before membership is looked at: a
 * non-admin gets 403 whether or not the project exists.
 */
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly members: ProjectMembersService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<ProjectSummary[]> {
    return this.projects.list(user);
  }

  @Get(':projectId')
  @UseGuards(ProjectAccessGuard)
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<ProjectDetail> {
    return this.projects.detail(access.projectId, access.role);
  }

  @Patch(':projectId')
  @Roles('admin')
  @UseGuards(ProjectAccessGuard)
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Body() dto: UpdateProjectDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectDetail> {
    return this.projects.update(access.projectId, dto, ctx);
  }

  @Post(':projectId/refresh')
  @HttpCode(200)
  @ProjectRole('operator')
  @UseGuards(ProjectAccessGuard)
  refresh(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectDetail> {
    return this.projects.refresh(access.projectId, access.role, ctx);
  }

  @Put(':projectId/docs-source')
  @Roles('admin')
  @UseGuards(ProjectAccessGuard)
  overrideDocsSource(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Body() dto: DocsSourceOverrideDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectDetail> {
    return this.projects.overrideDocsSource(access.projectId, dto, ctx);
  }

  @Delete(':projectId/docs-source')
  @Roles('admin')
  @UseGuards(ProjectAccessGuard)
  resetDocsSource(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectDetail> {
    return this.projects.resetDocsSource(access.projectId, ctx);
  }

  @Get(':projectId/members')
  @UseGuards(ProjectAccessGuard)
  listMembers(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<ProjectMemberView[]> {
    return this.members.list(access.projectId);
  }

  @Post(':projectId/members')
  @Roles('admin')
  @UseGuards(ProjectAccessGuard)
  addMember(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Body() dto: AddProjectMemberDto,
    @CurrentUser() admin: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectMemberView> {
    return this.members.add(
      access.projectId,
      dto.userId,
      dto.roleOverride ?? null,
      admin.id,
      ctx,
    );
  }

  @Patch(':projectId/members/:userId')
  @Roles('admin')
  @UseGuards(ProjectAccessGuard)
  updateMember(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('userId') userId: string,
    @Body() dto: UpdateProjectMemberDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectMemberView> {
    return this.members.update(access.projectId, userId, dto.roleOverride, ctx);
  }

  @Delete(':projectId/members/:userId')
  @HttpCode(204)
  @Roles('admin')
  @UseGuards(ProjectAccessGuard)
  removeMember(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('userId') userId: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.members.remove(access.projectId, userId, ctx);
  }
}
