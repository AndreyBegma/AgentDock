import type { DesignTemplatesView, DesignTemplateView } from '@nautelle/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
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
import { DesignTemplatesService } from './design-templates.service';
import { DesignTemplateUpsertDto } from './dto';

/**
 * A project's design frame templates (docs/specs/833-standard-design-frame-templates.md
 * "API", D9, ADR-0082). `ProjectAccessGuard` hides a project the caller
 * cannot see (404) and refuses a write below its role (403): every member
 * reads them, a project admin writes them — like the design settings.
 */
@Controller('projects/:projectId/design/templates')
@UseGuards(ProjectAccessGuard)
export class DesignTemplatesController {
  constructor(private readonly templates: DesignTemplatesService) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
  ): Promise<DesignTemplatesView> {
    return this.templates.list(access.projectId);
  }

  @Put(':key')
  @ProjectRole('admin')
  upsert(
    @ProjectAccess() access: ResolvedProjectAccess,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
    @Param('key') key: string,
    @Body() dto: DesignTemplateUpsertDto,
  ): Promise<DesignTemplateView> {
    return this.templates.upsert(ctx, user.id, access.projectId, key, dto);
  }

  @Delete(':key')
  @ProjectRole('admin')
  @HttpCode(204)
  remove(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
    @Param('key') key: string,
  ): Promise<void> {
    return this.templates.remove(ctx, access.projectId, key);
  }
}
