import type {
  ReviewSettingsUpdateResult,
  ReviewSettingsView,
  ReviewStepView,
} from '@nautelle/shared';
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
import { CurrentUser } from '../auth/decorators';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import {
  CreateReviewStepDto,
  ReorderReviewStepsDto,
  UpdateReviewSettingsDto,
  UpdateReviewStepDto,
} from './dto';
import { ReviewService } from './review.service';

/**
 * A project's review configuration (#862, ADR-0084). Any member reads it;
 * writes need the project admin role, the one that edits the project's other
 * settings. A project the caller cannot see is 404 (#10 D12), an operator
 * writing 403.
 */
@Controller('projects/:projectId/review')
@UseGuards(ProjectAccessGuard)
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<ReviewSettingsView> {
    return this.review.view(access.projectId);
  }

  @Put()
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateReviewSettingsDto,
  ): Promise<ReviewSettingsUpdateResult> {
    return this.review.updateSettings(access.projectId, dto, {
      userId: user.id,
      role: access.role,
      ctx,
    });
  }

  @Post('steps')
  @ProjectRole('admin')
  create(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: CreateReviewStepDto,
  ): Promise<ReviewStepView> {
    return this.review.createStep(access.projectId, dto, ctx);
  }

  @Put('steps/order')
  @ProjectRole('admin')
  reorder(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: ReorderReviewStepsDto,
  ): Promise<ReviewStepView[]> {
    return this.review.reorder(access.projectId, dto.stepIds, ctx);
  }

  @Patch('steps/:stepId')
  @ProjectRole('admin')
  updateStep(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('stepId') stepId: string,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateReviewStepDto,
  ): Promise<ReviewStepView> {
    return this.review.updateStep(access.projectId, stepId, dto, ctx);
  }

  @Delete('steps/:stepId')
  @ProjectRole('admin')
  @HttpCode(204)
  remove(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('stepId') stepId: string,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.review.removeStep(access.projectId, stepId, ctx);
  }

  /** Replaces the peer review instructions, edits included. */
  @Post('peer-review/regenerate')
  @ProjectRole('admin')
  @HttpCode(200)
  regenerate(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ReviewStepView> {
    return this.review.regenerate(access.projectId, {
      userId: user.id,
      role: access.role,
      ctx,
    });
  }
}
