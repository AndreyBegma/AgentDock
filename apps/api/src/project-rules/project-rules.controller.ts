import type {
  ProjectRuleImportResult,
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
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import {
  ProjectRuleCreateDto,
  ProjectRuleImportDto,
  ProjectRuleReorderDto,
  ProjectRuleUpdateDto,
} from './dto';
import { ProjectRulesService } from './project-rules.service';

/**
 * A project's coding rules (#528). Any member reads them; writes need the
 * project admin role, the one that edits the project's other settings. A
 * project the caller cannot see is 404 (#10 D12), an operator writing 403.
 */
@Controller('projects/:projectId/rules')
@UseGuards(ProjectAccessGuard)
export class ProjectRulesController {
  constructor(private readonly rules: ProjectRulesService) {}

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
