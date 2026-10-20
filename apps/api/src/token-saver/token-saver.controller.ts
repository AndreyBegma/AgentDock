import type {
  TokenSaverSettingsView,
  TokenSaverSummary,
} from '@nautelle/shared';
import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { TokenSaverSummaryQueryDto, UpdateTokenSaverSettingsDto } from './dto';
import { TokenSaverService } from './token-saver.service';
import { TokenSaverSummaryService } from './token-saver-summary.service';

/**
 * Token saver (#445 "API"): members read the setting and the summary; a
 * project admin changes the setting. A project the caller cannot see is 404.
 */
@Controller('projects/:projectId/token-saver')
@UseGuards(ProjectAccessGuard)
export class TokenSaverController {
  constructor(
    private readonly settings: TokenSaverService,
    private readonly summaries: TokenSaverSummaryService,
  ) {}

  @Get()
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<TokenSaverSettingsView> {
    return this.settings.view(access.projectId);
  }

  @Put()
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateTokenSaverSettingsDto,
  ): Promise<TokenSaverSettingsView> {
    return this.settings.update(
      access.projectId,
      { enabled: dto.enabled, mcpAllow: dto.mcpAllow },
      { userId: user.id, ctx },
    );
  }

  @Get('summary')
  summary(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: TokenSaverSummaryQueryDto,
  ): Promise<TokenSaverSummary> {
    return this.summaries.summary(access.projectId, query.from, query.to);
  }
}
