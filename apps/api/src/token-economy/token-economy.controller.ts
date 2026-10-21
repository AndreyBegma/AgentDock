import type {
  TokenEconomyReport,
  TokenEconomySettingsView,
  TokenEconomyTechniqueView,
} from '@nautelle/shared';
import {
  Body,
  Controller,
  Get,
  Param,
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
import {
  TokenEconomyReportQueryDto,
  UpdateTokenEconomySettingsDto,
  UpdateTokenEconomyTechniqueDto,
} from './dto';
import { TokenEconomyService } from './token-economy.service';
import { TokenEconomyReportService } from './token-economy-report.service';

/**
 * Token economy (#746 "API"): members read the report; a project admin sets
 * the B share and a technique's mode. A project the caller cannot see is 404.
 */
@Controller('projects/:projectId/token-economy')
@UseGuards(ProjectAccessGuard)
export class TokenEconomyController {
  constructor(
    private readonly economy: TokenEconomyService,
    private readonly reports: TokenEconomyReportService,
  ) {}

  @Get('report')
  report(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: TokenEconomyReportQueryDto,
  ): Promise<TokenEconomyReport> {
    return this.reports.report(access.projectId, query.from, query.to);
  }

  @Put('settings')
  @ProjectRole('admin')
  updateSettings(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateTokenEconomySettingsDto,
  ): Promise<TokenEconomySettingsView> {
    return this.economy.updateSettings(access.projectId, dto.bSharePercent, {
      userId: user.id,
      ctx,
    });
  }

  @Put('techniques/:technique')
  @ProjectRole('admin')
  setMode(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('technique') technique: string,
    @Body() dto: UpdateTokenEconomyTechniqueDto,
  ): Promise<TokenEconomyTechniqueView> {
    return this.economy.setMode(access.projectId, technique, dto.mode, {
      userId: user.id,
      ctx,
    });
  }
}
