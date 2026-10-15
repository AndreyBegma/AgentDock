import type {
  TextNormalizationsResponse,
  TextSettingsView,
} from '@agentdock/shared';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
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
import { TextNormalizationsQueryDto, UpdateTextSettingsDto } from './dto';
import { TextNormalizer } from './text-normalizer';
import { TextSettingsService } from './text-settings.service';
import { TextViews } from './text-views';

/**
 * Text normalization (issue #271 "API", D13, D14): members read the states
 * and originals of what they may read; operators retry a failed request; a
 * project admin turns it off. A project the caller cannot see is 404.
 */
@Controller('projects/:projectId')
@UseGuards(ProjectAccessGuard)
export class TextController {
  constructor(
    private readonly views: TextViews,
    private readonly normalizer: TextNormalizer,
    private readonly settings: TextSettingsService,
  ) {}

  @Get('text-normalizations')
  normalizations(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Query() query: TextNormalizationsQueryDto,
  ): Promise<TextNormalizationsResponse> {
    if ((query.cardId === undefined) === (query.planId === undefined)) {
      throw new BadRequestException('Give exactly one of cardId and planId');
    }
    return query.cardId !== undefined
      ? this.views.card(access.projectId, query.cardId, access.role)
      : this.views.plan(access.projectId, user.id, query.planId ?? '');
  }

  @Post('text-normalizations/:id/retry')
  @ProjectRole('operator')
  @HttpCode(204)
  async retry(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<void> {
    const row = await this.views.readable(access.projectId, user.id, id);
    if (!(await this.normalizer.retry(row.id))) {
      throw new ConflictException('Only a failed normalization is retried');
    }
  }

  @Get('text-settings')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<TextSettingsView> {
    return this.settings.view(access.projectId);
  }

  @Put('text-settings')
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateTextSettingsDto,
  ): Promise<TextSettingsView> {
    return this.settings.update(access.projectId, dto.normalizeEnabled, {
      userId: user.id,
      ctx,
    });
  }
}
