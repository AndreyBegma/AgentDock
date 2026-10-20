import type {
  StewardIncidentView,
  StewardSettingsView,
} from '@nautelle/shared';
import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { AuditCtx } from '../audit';
import type { AuditContext } from '../audit/audit.types';
import { type AuthUser, CurrentUser } from '../auth';
import { PrismaService } from '../database/prisma.service';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import { StewardIncidentsQueryDto, UpdateStewardSettingsDto } from './dto';
import { StewardIncidents } from './steward-incidents.service';
import { StewardSettingsService } from './steward-settings.service';

/**
 * Steward (#447 "API"): members read the setting and the incidents; a
 * project admin changes the setting. A project the caller cannot see is
 * 404 — a member of one project never reads another's (e2e).
 */
@Controller('projects/:projectId/steward')
@UseGuards(ProjectAccessGuard)
export class StewardController {
  constructor(
    private readonly settings: StewardSettingsService,
    private readonly incidents: StewardIncidents,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  view(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<StewardSettingsView> {
    return this.settings.view(access.projectId);
  }

  @Put()
  @ProjectRole('admin')
  update(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Body() dto: UpdateStewardSettingsDto,
  ): Promise<StewardSettingsView> {
    return this.settings.update(
      access.projectId,
      {
        enabled: dto.enabled,
        silenceMinutes: dto.silenceMinutes,
        digestTime: dto.digestTime,
        autoNudge: dto.autoNudge,
        autoDismiss: dto.autoDismiss,
        autoResume: dto.autoResume,
        trailerGuard: dto.trailerGuard,
      },
      { userId: user.id, ctx },
    );
  }

  /** Newest first; `card` narrows to one card's rounds (the card sheet, D15). */
  @Get('incidents')
  async list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: StewardIncidentsQueryDto,
  ): Promise<StewardIncidentView[]> {
    let subjectIds: string[] | undefined;
    if (query.card !== undefined) {
      const rounds = await this.prisma.boardCardRound.findMany({
        where: {
          card: { projectId: access.projectId, number: query.card },
        },
        select: { id: true },
      });
      subjectIds = rounds.map((r) => r.id);
    }
    return this.incidents.list(access.projectId, {
      status: query.status,
      from: query.from,
      to: query.to,
      subjectIds,
    });
  }
}
