import type {
  CommandRunView,
  InstalledSkillsView,
  SkillCatalogView,
  SkillInspectView,
  SkillProfileInstallView,
  SkillRunDetail,
  SkillRunView,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser, Roles } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import {
  SkillCatalogQueryDto,
  SkillInspectDto,
  SkillInstallDto,
  SkillRunDto,
} from './dto';
import { SkillInstallService } from './skill-install.service';
import { SkillInventoryService } from './skill-inventory.service';
import { SkillRunService } from './skill-run.service';

/**
 * Catalog search and inspect (spec 24 "API"): an admin, or an operator of a
 * project on that runner. A runner none of whose projects the caller can see
 * is 404.
 */
@Controller('skills')
export class SkillsController {
  constructor(private readonly install: SkillInstallService) {}

  @Get('catalog')
  catalog(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Query() query: SkillCatalogQueryDto,
  ): Promise<SkillCatalogView> {
    return this.install.catalog({ user, ctx }, query.runnerId, query.q);
  }

  @Post('inspect')
  inspect(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: SkillInspectDto,
  ): Promise<SkillInspectView> {
    return this.install.inspect({ user, ctx }, dto);
  }
}

/**
 * Profile-scope install and uninstall (D3, D14): they affect every project on
 * the machine, so admin only. Install checks the role itself through
 * `skillInstallMinRole`, so a refused attempt is audited.
 */
@Controller('runners/:id/profiles/:key/skills')
export class ProfileSkillsController {
  constructor(private readonly install: SkillInstallService) {}

  @Post('install')
  installToProfile(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') runnerId: string,
    @Param('key') profileKey: string,
    @Body() dto: SkillInstallDto,
  ): Promise<SkillProfileInstallView> {
    return this.install.installToProfile(
      { user, ctx },
      runnerId,
      profileKey,
      dto,
    );
  }

  @Delete(':runtime/:name')
  @Roles('admin')
  uninstall(
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('id') runnerId: string,
    @Param('key') profileKey: string,
    @Param('runtime') runtime: string,
    @Param('name') name: string,
  ): Promise<{ removed: true }> {
    return this.install.uninstall({ user, ctx }, runnerId, {
      profileKey,
      runtime,
      name,
    });
  }
}

/**
 * A project's skills and skill runs (spec 24 "API", D14). Reading needs
 * membership; install, rescan, run and cancel need operator. A project the
 * caller cannot see is 404 on every route (#10 D12).
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class ProjectSkillsController {
  constructor(
    private readonly inventory: SkillInventoryService,
    private readonly install: SkillInstallService,
    private readonly skillRuns: SkillRunService,
  ) {}

  @Get('skills')
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<InstalledSkillsView> {
    return this.inventory.list(access.projectId);
  }

  @Post('skills/refresh')
  @HttpCode(200)
  @ProjectRole('operator')
  async refresh(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
  ): Promise<InstalledSkillsView> {
    const project = await this.inventory.project(access.projectId);
    return this.inventory.refresh(project, { role: access.role, ctx });
  }

  @Post('skills/install')
  @HttpCode(202)
  @ProjectRole('operator')
  async installToProject(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: SkillInstallDto,
  ): Promise<CommandRunView> {
    const project = await this.inventory.project(access.projectId);
    return this.install.installToProject(
      { ...access, user, ctx },
      project,
      dto,
    );
  }

  @Post('skill-runs')
  @ProjectRole('operator')
  start(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: SkillRunDto,
  ): Promise<SkillRunView> {
    return this.skillRuns.start(access.projectId, dto, {
      type: 'user',
      id: user.id,
      role: access.role,
      ctx,
    });
  }

  @Post('skill-runs/:runId/cancel')
  @HttpCode(200)
  @ProjectRole('operator')
  cancel(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Param('runId') runId: string,
  ): Promise<SkillRunView> {
    return this.skillRuns.cancel(access.projectId, runId, {
      role: access.role,
      ctx,
    });
  }

  @Get('skill-runs/:runId')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('runId') runId: string,
  ): Promise<SkillRunDetail> {
    return this.skillRuns.detail(access.projectId, runId);
  }
}
