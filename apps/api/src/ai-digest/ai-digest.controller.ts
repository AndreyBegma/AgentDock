import type { AiDigestSettingsView, AiDigestView } from '@nautelle/shared';
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { AiDigestService } from './ai-digest.service';
import { AiDigestSettingsService } from './ai-digest-settings.service';
import { UpdateAiDigestSettingsDto } from './dto';

/**
 * The daily AI digest (#658): members read the setting and the latest digest;
 * a project admin changes the setting. A project the caller cannot see is
 * 404.
 */
@Controller('projects/:projectId/ai/digest')
@UseGuards(ProjectAccessGuard)
export class AiDigestController {
  constructor(
    private readonly digests: AiDigestService,
    private readonly settings: AiDigestSettingsService,
  ) {}

  @Get('latest')
  latest(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<AiDigestView> {
    return this.digests.latest(access.projectId);
  }

  @Get('settings')
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<AiDigestSettingsView> {
    return this.settings.view(access.projectId);
  }

  @Patch('settings')
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateAiDigestSettingsDto,
  ): Promise<AiDigestSettingsView> {
    return this.settings.update(
      access.projectId,
      { enabled: dto.enabled, time: dto.time, timezone: dto.timezone },
      { userId: user.id, ctx },
    );
  }
}
