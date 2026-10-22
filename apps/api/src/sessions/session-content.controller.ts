import type { SessionContentPage } from '@nautelle/shared';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuditContext } from '../audit/audit.types';
import { AuditCtx } from '../audit/audit-context';
import { Roles } from '../auth/decorators';
import {
  ProjectAccess,
  ProjectAccessGuard,
  type ResolvedProjectAccess,
} from '../projects';
import { SessionContentQuery } from './dto';
import { SessionContentService } from './session-content.service';

/**
 * ADR-0021 reads and purge. Every project member, viewers included, reads
 * content (ADR-0050 amends ADR-0021 §5); only admins purge. Project-scoped:
 * non-members get 404, below-role members 403.
 */
@Controller('projects/:projectId')
export class SessionContentController {
  constructor(private readonly content: SessionContentService) {}

  @Get('sessions/:id/content')
  @UseGuards(ProjectAccessGuard)
  page(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('id') id: string,
    @Query() query: SessionContentQuery,
  ): Promise<SessionContentPage> {
    return this.content.page(access.projectId, id, query.cursor);
  }

  @Delete('session-content')
  @HttpCode(204)
  @Roles('admin')
  @UseGuards(ProjectAccessGuard)
  purge(
    @ProjectAccess() access: ResolvedProjectAccess,
    @AuditCtx() ctx: AuditContext,
  ): Promise<void> {
    return this.content.purge(access.projectId, ctx);
  }
}
