import type {
  ProjectRuleImportResult,
  ProjectRuleScanResult,
  ProjectRuleView,
} from '@agentdock/shared';
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
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { InspectProjectDto } from '../projects/dto';
import {
  ProjectRuleAcceptDto,
  ProjectRuleCreateDto,
  ProjectRuleImportDto,
  ProjectRuleReorderDto,
  ProjectRuleUpdateDto,
} from './dto';
import { ProjectRuleScanService } from './project-rule-scan.service';
import { ProjectRulesService } from './project-rules.service';

/**
 * A project's coding rules (#528). Any member reads them; writes need the
 * project admin role, the one that edits the project's other settings. A
 * project the caller cannot see is 404 (#10 D12), an operator writing 403.
 */
@Controller('projects/:projectId/rules')
@UseGuards(ProjectAccessGuard)
export class ProjectRulesController {
  constructor(
    private readonly rules: ProjectRulesService,
    private readonly scans: ProjectRuleScanService,
  ) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<ProjectRuleView[]> {
    return this.rules.list(access.projectId);
  }

  @Post()
  @ProjectRole('admin')
  create(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ProjectRuleCreateDto,
  ): Promise<ProjectRuleView> {
    return this.rules.create(access.projectId, dto, ctx);
  }

  /** Markdown in, one enabled rule per section; duplicates by title skipped. */
  @Post('import')
  @ProjectRole('admin')
  import(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ProjectRuleImportDto,
  ): Promise<ProjectRuleImportResult> {
    return this.rules.import(access.projectId, dto.markdown, ctx);
  }

  /**
   * #584: rule candidates from the project's own docs, read by its runner.
   * Nothing is stored; a candidate whose title is taken is marked.
   */
  @Post('scan')
  @ProjectRole('admin')
  @HttpCode(200)
  scan(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectRuleScanResult> {
    return this.scans.scan(access.projectId, ctx);
  }

  /** #584: the candidates a person accepted become enabled `scanned` rules. */
  @Post('accept')
  @ProjectRole('admin')
  accept(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ProjectRuleAcceptDto,
  ): Promise<ProjectRuleImportResult> {
    return this.scans.accept(access.projectId, dto.candidates, user.id, ctx);
  }

  @Put('order')
  @ProjectRole('admin')
  reorder(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ProjectRuleReorderDto,
  ): Promise<ProjectRuleView[]> {
    return this.rules.reorder(access.projectId, dto.ruleIds, ctx);
  }

  @Patch(':ruleId')
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('ruleId') ruleId: string,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ProjectRuleUpdateDto,
  ): Promise<ProjectRuleView> {
    return this.rules.update(access.projectId, ruleId, dto, ctx);
  }

  @Delete(':ruleId')
  @ProjectRole('admin')
  @HttpCode(204)
  remove(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('ruleId') ruleId: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.rules.remove(access.projectId, ruleId, ctx);
  }
}

/**
 * #584: the connect dialog's scan, before the project exists — admin only,
 * as connecting is (spec 10 D1). Nothing is stored.
 */
@Roles('admin')
@Controller('admin/projects')
export class AdminProjectRulesController {
  constructor(private readonly scans: ProjectRuleScanService) {}

  @Post('rule-candidates')
  @HttpCode(200)
  candidates(
    @Body() dto: InspectProjectDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ProjectRuleScanResult> {
    return this.scans.scanPath(dto.runnerId, dto.path, ctx);
  }
}
