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
import type { AuthUser } from '../auth';
import { CurrentUser } from '../auth/decorators';
import {
  ProjectAccess,
  ProjectAccessGuard,
  ProjectRole,
  type ResolvedProjectAccess,
} from '../projects';
import type { ActionRequestView } from './action-request-mapper';
import {
  type ActionRequestDecision,
  ActionRequestsService,
} from './action-requests.service';
import { ActionRequestDecisionDto, ActionRequestsListQuery } from './dto';

/**
 * Action requests (spec 201 D18, "API"). Listing needs membership and shows the input to viewers too (ADR-0050); deciding
 * needs operator on the project. A project the caller cannot see is 404.
 */
@Controller('projects/:projectId/action-requests')
@UseGuards(ProjectAccessGuard)
export class ActionRequestsController {
  constructor(private readonly requests: ActionRequestsService) {}

  @Get()
  list(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Query() query: ActionRequestsListQuery,
  ): Promise<ActionRequestView[]> {
    return this.requests.list(access.projectId, query.status);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ProjectRole('operator')
  approve(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('id') id: string,
    @Body() dto: ActionRequestDecisionDto,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ActionRequestView> {
    return this.decide(access, id, 'approve', dto, user, ctx);
  }

  @Post(':id/deny')
  @HttpCode(200)
  @ProjectRole('operator')
  deny(
    @ProjectAccess() access: ResolvedProjectAccess,
    @Param('id') id: string,
    @Body() dto: ActionRequestDecisionDto,
    @CurrentUser() user: AuthUser,
    @AuditCtx() ctx: AuditContext,
  ): Promise<ActionRequestView> {
    return this.decide(access, id, 'deny', dto, user, ctx);
  }

  private decide(
    access: ResolvedProjectAccess,
    id: string,
    decision: ActionRequestDecision,
    dto: ActionRequestDecisionDto,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<ActionRequestView> {
    return this.requests.decide(
      {
        projectId: access.projectId,
        role: access.role,
        user: { id: user.id, email: user.email, role: user.role },
        ctx,
        via: 'web',
      },
      id,
      decision,
      dto.note,
    );
  }
}
