import type {
  PrefixOverlayDetailView,
  PrefixOverlayPullRequestResult,
  PrefixOverlayView,
  PrefixSummaryView,
  ProposePrefixOverlayResult,
} from '@nautelle/shared';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { PrefixSummaryQueryDto, ProposePrefixOverlayDto } from './dto';
import { PrefixOverlaysService } from './prefix-overlays.service';
import { PrefixSummaryService } from './prefix-summary.service';

/**
 * The launch prefix (#751 "API", B13): members read the summary and the
 * overlays' metadata; a project admin reads an overlay's content and
 * proposes, approves, rejects and opens the pull-request card. A project the
 * caller cannot see is 404, its overlays included.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class PrefixController {
  constructor(
    private readonly summaries: PrefixSummaryService,
    private readonly overlays: PrefixOverlaysService,
  ) {}

  @Get('token-saver/prefix')
  summary(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: PrefixSummaryQueryDto,
  ): Promise<PrefixSummaryView> {
    return this.summaries.summary(access.projectId, query.from, query.to);
  }

  @Get('prefix/overlays')
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<PrefixOverlayView[]> {
    return this.overlays.list(access.projectId);
  }

  @Post('prefix/overlays/propose')
  @ProjectRole('admin')
  @HttpCode(202)
  propose(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ProposePrefixOverlayDto,
  ): Promise<ProposePrefixOverlayResult> {
    return this.overlays.propose(access.projectId, dto.part, {
      userId: user.id,
      ctx,
    });
  }

  @Get('prefix/overlays/:overlayId')
  @ProjectRole('admin')
  detail(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('overlayId') overlayId: string,
  ): Promise<PrefixOverlayDetailView> {
    return this.overlays.detail(access.projectId, overlayId);
  }

  @Post('prefix/overlays/:overlayId/approve')
  @ProjectRole('admin')
  @HttpCode(200)
  approve(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('overlayId') overlayId: string,
  ): Promise<PrefixOverlayView> {
    return this.overlays.approve(access.projectId, overlayId, {
      userId: user.id,
      ctx,
    });
  }

  @Post('prefix/overlays/:overlayId/reject')
  @ProjectRole('admin')
  @HttpCode(200)
  reject(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('overlayId') overlayId: string,
  ): Promise<PrefixOverlayView> {
    return this.overlays.reject(access.projectId, overlayId, {
      userId: user.id,
      ctx,
    });
  }

  @Post('prefix/overlays/:overlayId/pull-request')
  @ProjectRole('admin')
  @HttpCode(201)
  pullRequest(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('overlayId') overlayId: string,
  ): Promise<PrefixOverlayPullRequestResult> {
    return this.overlays.pullRequest(access.projectId, overlayId, {
      userId: user.id,
      ctx,
    });
  }
}
