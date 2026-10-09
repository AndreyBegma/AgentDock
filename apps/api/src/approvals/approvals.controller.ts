import type {
  ApprovalDetail,
  ApprovalItemView,
  ApprovalsView,
} from '@agentdock/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { ApprovalsService } from './approvals.service';
import { ApprovalsQueryService } from './approvals-query.service';
import { ApprovalsListQuery, ApproveDto, RequestChangesDto } from './dto';

/**
 * The merge approval queue (spec 20 "API"). Listing and inspecting need
 * membership; deciding needs operator on the project (D9). A project the
 * caller cannot see is 404, an anonymous caller 401.
 */
@Controller('projects/:projectId/approvals')
@UseGuards(ProjectAccessGuard)
export class ApprovalsController {
  constructor(
    private readonly query: ApprovalsQueryService,
    private readonly approvals: ApprovalsService,
  ) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: ApprovalsListQuery,
  ): Promise<ApprovalsView> {
    return this.query.list(access.projectId, query.status);
  }

  @Get(':pr')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('pr', ParseIntPipe) pr: number,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ApprovalDetail> {
    return this.query.detail({ ...access, ctx }, pr);
  }

  @Post(':pr/approve')
  @HttpCode(200)
  @ProjectRole('operator')
  approve(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('pr', ParseIntPipe) pr: number,
    @Body() dto: ApproveDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ApprovalItemView> {
    return this.approvals.approve({ ...access, ctx }, pr, dto.headSha);
  }

  @Post(':pr/request-changes')
  @HttpCode(200)
  @ProjectRole('operator')
  requestChanges(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('pr', ParseIntPipe) pr: number,
    @Body() dto: RequestChangesDto,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ApprovalItemView> {
    return this.approvals.requestChanges(
      { ...access, ctx },
      pr,
      dto.headSha,
      dto.note,
    );
  }
}
